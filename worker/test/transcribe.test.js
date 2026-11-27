/**
 * The Groq rung of the transcription ladder.
 *
 * The behaviour that matters is that it is honest about failing — a transcriber
 * that returns something plausible when it did not hear anything would put
 * invented words in front of an owner about to quote a job.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { transcribe, transcribeModelFor, DEFAULT_TRANSCRIBE_MODEL } from '../src/groq.js';
import handler from '../paste/handler.js';
import generated from '../paste/ai-worker.js';

const env = (over = {}) => ({
  GROQ_API_KEY: 'k',
  GROQ_BASE_URL: 'https://groq.test/v1',
  ALLOWED_ORIGINS: 'https://someone.github.io',
  ...over,
});

const clip = () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' });

/** Swap global fetch, capturing the multipart form it was given. */
async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const form = init.body instanceof FormData ? init.body : null;
    calls.push({
      url: String(url),
      headers: init.headers,
      fields: form ? Object.fromEntries([...form.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : `<file ${v.name}>`])) : null,
    });
    return impl(calls.length);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const jsonRes = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

/* ------------------------------------------------------------ model choice */

test('the cheap Whisper model is the default, and is overridable', () => {
  assert.equal(transcribeModelFor(env()), DEFAULT_TRANSCRIBE_MODEL);
  assert.equal(DEFAULT_TRANSCRIBE_MODEL, 'whisper-large-v3-turbo');
  assert.equal(transcribeModelFor(env({ GROQ_TRANSCRIBE_MODEL: 'whisper-large-v3' })), 'whisper-large-v3');
});

/* ---------------------------------------------------------------- the call */

test('it posts the clip to the transcription endpoint with the trade vocabulary', async () => {
  await withFetch(() => jsonRes({ text: '  Two lifts, five days.  ' }), async (calls) => {
    const res = await transcribe(env(), { audio: clip(), filename: 'note.webm', vocabulary: 'soffit fascia' });
    assert.equal(res.ok, true);
    assert.equal(res.text, 'Two lifts, five days.', 'the transcript is trimmed');
    assert.equal(res.model, 'whisper-large-v3-turbo');

    assert.equal(calls[0].url, 'https://groq.test/v1/audio/transcriptions');
    assert.equal(calls[0].fields.model, 'whisper-large-v3-turbo');
    assert.equal(calls[0].fields.language, 'en');
    assert.equal(calls[0].fields.temperature, '0');
    assert.equal(calls[0].fields.prompt, 'soffit fascia');
    assert.match(calls[0].fields.file, /^<file note\.webm>$/);
  });
});

test('a missing key is unconfigured, not a failure, so a caller can fall back', async () => {
  await withFetch(() => { throw new Error('should not be called'); }, async () => {
    const res = await transcribe({}, { audio: clip() });
    assert.equal(res.ok, false);
    assert.equal(res.unconfigured, true);
  });
});

test('an empty or malformed response is a reported failure, never an empty transcript', async () => {
  await withFetch(() => jsonRes({ nope: true }), async () => {
    const res = await transcribe(env(), { audio: clip() });
    assert.equal(res.ok, false);
    assert.match(res.error, /no transcript/);
  });

  await withFetch(() => jsonRes({ error: 'rate limited' }, 429), async () => {
    const res = await transcribe(env(), { audio: clip() });
    assert.equal(res.ok, false);
    assert.match(res.error, /429/);
  });
});

test('an unreachable Groq is named as such', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  try {
    const res = await transcribe(env(), { audio: clip() });
    assert.equal(res.ok, false);
    assert.match(res.error, /Could not reach Groq/);
  } finally {
    globalThis.fetch = original;
  }
});

/* ------------------------------------------------------- the worker route */

const post = (body, headers = {}) => new Request('https://ai.test/transcribe', {
  method: 'POST',
  headers: { Origin: 'https://someone.github.io', ...headers },
  body,
});

const audioForm = () => {
  const f = new FormData();
  f.append('audio', clip(), 'note.webm');
  return f;
};

for (const [name, worker] of [['module', handler], ['generated', generated]]) {
  test(`${name}: /transcribe returns the text`, async () => {
    await withFetch(() => jsonRes({ text: 'Rear scaffold, two lifts.' }), async (calls) => {
      const res = await worker.fetch(post(audioForm()), env());
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.text, 'Rear scaffold, two lifts.');
      // Primed by default, so a caller that sends no vocabulary still gets it.
      assert.match(calls[0].fields.prompt, /soffit/i);
    });
  });

  test(`${name}: /health names the transcription model`, async () => {
    const body = await (await worker.fetch(new Request('https://ai.test/health'), env())).json();
    assert.equal(body.transcribe_model, 'whisper-large-v3-turbo');
  });

  test(`${name}: it validates the upload`, async () => {
    const empty = new FormData();
    empty.append('note', 'no file here');
    assert.equal((await worker.fetch(post(empty), env())).status, 400);
    assert.equal((await worker.fetch(new Request('https://ai.test/transcribe'), env())).status, 405);
  });

  test(`${name}: a missing key is 503 so the browser drops to on-device`, async () => {
    const res = await worker.fetch(post(audioForm()), { ...env(), GROQ_API_KEY: '' });
    assert.equal(res.status, 503);
  });

  test(`${name}: the shared token guards transcription too`, async () => {
    const e = env({ AI_SHARED_TOKEN: 'sekrit' });
    assert.equal((await worker.fetch(post(audioForm()), e)).status, 401);
    await withFetch(() => jsonRes({ text: 'ok' }), async () => {
      const res = await worker.fetch(post(audioForm(), { Authorization: 'Bearer sekrit' }), e);
      assert.equal(res.status, 200);
    });
  });
}
