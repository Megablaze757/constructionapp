import test from 'node:test';
import assert from 'node:assert/strict';

import {
  requestDraft, aiConfigured, modelFor, DEFAULT_MODEL, DEFAULT_VISION_MODEL,
} from '../src/groq.js';

const TEMPLATE = {
  job_type: 'domestic_scaffold_erect',
  name: 'Domestic Scaffold Erect',
  line_items: [
    { line_code: 'scaffold_erect', description: 'Scaffold erect', unit: 'm2' },
    { line_code: 'scaffold_hire', description: 'Scaffold hire', unit: 'days' },
  ],
};

const GOOD_DRAFT = {
  job_type: 'domestic_scaffold_erect',
  confidence: 'medium',
  line_items: [
    {
      line_code: 'scaffold_erect',
      description: 'Scaffold erect',
      quantity_estimate: 45,
      unit: 'm2',
      source: 'ai_inferred',
      confidence: 'medium',
      note: 'Estimated from two lifts — confirm on site',
    },
  ],
  assumptions: [],
  flags_for_owner_review: [],
};

const args = (over = {}) => ({
  description: 'Rear scaffold, two lifts',
  template: TEMPLATE,
  priceBook: [{ code: 'scaffold_erect', description: 'Scaffold erect', unit: 'm2', category: 'labour' }],
  similarJobs: [],
  estimatingHistory: [],
  ...over,
});

const env = (over = {}) => ({ GROQ_API_KEY: 'k', GROQ_BASE_URL: 'https://groq.test/v1', ...over });

const jsonResponse = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

const completion = (draft) => jsonResponse({ choices: [{ message: { content: JSON.stringify(draft) } }] });

/** Swap global fetch for the duration of one test. */
async function withFetch(impl, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return impl(calls.length, calls[calls.length - 1]);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/* ------------------------------------------------------------- model choice */

test('photos switch to the vision model, because the text model cannot see', () => {
  assert.equal(modelFor(env()), DEFAULT_MODEL);
  assert.equal(modelFor(env(), { withPhotos: true }), DEFAULT_VISION_MODEL);
  assert.equal(modelFor(env({ GROQ_MODEL: 'my-text' })), 'my-text');
  assert.equal(modelFor(env({ GROQ_VISION_MODEL: 'my-eyes' }), { withPhotos: true }), 'my-eyes');
});

test('with nothing configured it reports itself unconfigured, before any request', async () => {
  await withFetch(() => { throw new Error('should not be called'); }, async () => {
    const res = await requestDraft({}, args());
    assert.equal(res.ok, false);
    // Distinguished from a failure so the caller can fall back to the template
    // rather than showing the owner an error they cannot act on.
    assert.equal(res.unconfigured, true);
    assert.match(res.error, /No AI is connected/);
  });
});

/* ----------------------------------------------------- structured outputs */

test('json_schema is tried first and used when the model serves it', async () => {
  await withFetch(() => completion(GOOD_DRAFT), async (calls) => {
    const res = await requestDraft(env(), args());
    assert.equal(res.ok, true);
    assert.equal(res.mode, 'json_schema');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.response_format.type, 'json_schema');
    assert.equal(calls[0].body.response_format.json_schema.strict, true);
  });
});

test('a model that rejects json_schema falls back to plain JSON mode', async () => {
  await withFetch((n) => (
    n === 1
      ? jsonResponse({ error: { message: 'response_format json_schema is not supported for this model' } }, 400)
      : completion(GOOD_DRAFT)
  ), async (calls) => {
    const res = await requestDraft(env(), args());
    assert.equal(res.ok, true, 'the draft still succeeds');
    assert.equal(res.mode, 'json_object');
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.response_format.type, 'json_object');
    // In json_object mode the provider enforces nothing, so the schema has to
    // travel in the prompt instead.
    assert.match(calls[1].body.messages[0].content, /must match this schema/);
    assert.match(calls[1].body.messages[0].content, /line_code/);
  });
});

test('the fallback loosens generation, never the contract', async () => {
  const violating = structuredClone(GOOD_DRAFT);
  violating.line_items[0].confidence = 'high';        // inferred cannot be high

  await withFetch((n) => (
    n === 1 ? jsonResponse({ error: { message: 'json_schema unsupported' } }, 400) : completion(violating)
  ), async () => {
    const res = await requestDraft(env(), args());
    assert.equal(res.ok, false, 'plain JSON mode is still held to the full contract');
    assert.match(res.detail.join(' '), /cannot claim confidence "high"/);
  });
});

test('a failure that is not about response_format is not retried', async () => {
  await withFetch((n) => {
    assert.equal(n, 1, 'a bad key would fail identically the second time');
    return jsonResponse({ error: { message: 'Invalid API Key' } }, 401);
  }, async (calls) => {
    const res = await requestDraft(env(), args());
    assert.equal(res.ok, false);
    assert.equal(calls.length, 1);
    assert.match(res.error, /Groq returned 401/);
  });
});

test('the mode can be forced when you know what your model supports', async () => {
  await withFetch(() => completion(GOOD_DRAFT), async (calls) => {
    const res = await requestDraft(env({ GROQ_STRUCTURED_OUTPUTS: 'json_object' }), args());
    assert.equal(res.ok, true);
    assert.equal(calls[0].body.response_format.type, 'json_object');
  });

  await withFetch((n) => {
    assert.equal(n, 1, 'forced json_schema must not silently fall back');
    return jsonResponse({ error: { message: 'json_schema unsupported' } }, 400);
  }, async () => {
    const res = await requestDraft(env({ GROQ_STRUCTURED_OUTPUTS: 'json_schema' }), args());
    assert.equal(res.ok, false);
  });
});

/* ------------------------------------------------------------- transport */

test('prose instead of JSON is a failed draft, not a parsed guess', async () => {
  await withFetch(() => jsonResponse({ choices: [{ message: { content: 'Sure! Here you go:' } }] }),
    async () => {
      const res = await requestDraft(env({ GROQ_STRUCTURED_OUTPUTS: 'json_object' }), args());
      assert.equal(res.ok, false);
      assert.match(res.error, /did not return valid JSON/);
    });
});

test('an unreachable API is reported as such', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('getaddrinfo ENOTFOUND'); };
  try {
    const res = await requestDraft(env(), args());
    assert.equal(res.ok, false);
    assert.match(res.error, /Could not reach Groq/);
  } finally {
    globalThis.fetch = original;
  }
});

test('photos are sent as image parts alongside the prompt', async () => {
  await withFetch(() => completion({
    ...GOOD_DRAFT,
    line_items: [{ ...GOOD_DRAFT.line_items[0], source: 'photo_inferred', note: 'Scaled off the door height' }],
  }), async (calls) => {
    const res = await requestDraft(env(), args({
      photos: [{ id: 'p1', mime: 'image/jpeg', b64: 'AAAA' }],
    }));
    assert.equal(res.ok, true);
    assert.equal(res.photos_used, 1);
    assert.equal(res.model, DEFAULT_VISION_MODEL);

    const content = calls[0].body.messages[1].content;
    assert.ok(Array.isArray(content), 'multimodal requests send an array of parts');
    assert.equal(content.filter((c) => c.type === 'image_url').length, 1);
    assert.match(content.find((c) => c.type === 'image_url').image_url.url, /^data:image\/jpeg;base64,/);
    assert.match(content.find((c) => c.type === 'text').text, /site_photos_attached/);
  });
});

test('a text-only draft sends no image parts and no photo claim is allowed', async () => {
  const lying = structuredClone(GOOD_DRAFT);
  lying.line_items[0].source = 'photo_inferred';

  await withFetch(() => completion(lying), async (calls) => {
    const res = await requestDraft(env(), args());
    assert.equal(typeof calls[0].body.messages[1].content, 'string');
    assert.equal(res.ok, false);
    assert.match(res.detail.join(' '), /no photos were supplied/);
  });
});

/* -------------------------------------------------------------- the proxy */

test('aiConfigured is true for either route to a model', () => {
  assert.equal(aiConfigured({}), false);
  assert.equal(aiConfigured({ GROQ_API_KEY: 'k' }), true);
  assert.equal(aiConfigured({ AI_PROXY_URL: 'https://ai.test/draft' }), true);
});

test('AI_PROXY_URL forwards the draft instead of calling Groq, and never sends the key', async () => {
  const proxy = env({ AI_PROXY_URL: 'https://ai.test/draft', AI_PROXY_TOKEN: 'shared' });
  await withFetch(() => jsonResponse({ ok: true, draft: GOOD_DRAFT, model: 'proxied', mode: 'json_schema' }),
    async (calls) => {
      const res = await requestDraft(proxy, args());
      assert.equal(res.ok, true);
      assert.equal(res.model, 'proxied');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://ai.test/draft');
      // The proxy gets the job, not the credentials for Groq.
      assert.equal(calls[0].body.description, 'Rear scaffold, two lifts');
      assert.ok(!JSON.stringify(calls[0].body).includes('GROQ_API_KEY'));
    });
});

test('a proxy is trusted with the key, not with the contract', async () => {
  const invented = structuredClone(GOOD_DRAFT);
  invented.line_items[0].line_code = 'gold_plating';

  await withFetch(() => jsonResponse({ ok: true, draft: invented }), async () => {
    const res = await requestDraft(env({ AI_PROXY_URL: 'https://ai.test/draft' }), args());
    assert.equal(res.ok, false);
    assert.match(res.detail.join(' '), /not in the matched template/);
  });
});

test("a proxy's own failure is reported, not swallowed", async () => {
  await withFetch(() => jsonResponse({ ok: false, error: 'Groq returned 429' }, 502), async () => {
    const res = await requestDraft(env({ AI_PROXY_URL: 'https://ai.test/draft' }), args());
    assert.equal(res.ok, false);
    assert.match(res.error, /429/);
  });
});
