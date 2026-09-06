/**
 * The paste-into-the-dashboard AI worker.
 *
 * Both copies are exercised — the module the repo develops against and the
 * generated single file a person actually pastes — because the thing that would
 * hurt is the generated one drifting silently. The last test is the drift guard.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import handler from '../paste/handler.js';
import generated from '../paste/ai-worker.js';

const WORKER = fileURLToPath(new URL('../', import.meta.url));

const TEMPLATE = {
  job_type: 'domestic_scaffold_erect',
  name: 'Domestic Scaffold Erect',
  line_items: [
    { line_code: 'scaffold_erect', description: 'Scaffold erect', unit: 'm2', default_quantity: 40, always_include: true },
    { line_code: 'scaffold_hire', description: 'Scaffold hire', unit: 'days', default_quantity: 7 },
  ],
};

const DRAFT = {
  job_type: 'domestic_scaffold_erect',
  confidence: 'medium',
  line_items: [{
    line_code: 'scaffold_erect',
    description: 'Scaffold erect',
    quantity_estimate: 45,
    unit: 'm2',
    source: 'ai_inferred',
    confidence: 'medium',
    note: 'Two lifts implied by "roof height" — measure on site',
  }],
  assumptions: [],
  flags_for_owner_review: [],
};

const env = (over = {}) => ({
  GROQ_API_KEY: 'k',
  GROQ_BASE_URL: 'https://groq.test/v1',
  ALLOWED_ORIGINS: 'https://someone.github.io',
  ...over,
});

const post = (body, headers = {}) => new Request('https://ai.test/draft', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: 'https://someone.github.io', ...headers },
  body: JSON.stringify(body),
});

const goodBody = (over = {}) => ({
  description: 'Rear scaffold to roof height, roofers on for a week',
  template: TEMPLATE,
  price_book: [{ code: 'scaffold_erect', description: 'Scaffold erect', unit: 'm2', category: 'labour' }],
  ...over,
});

/** Answer the Groq call with `content`, whatever was asked. */
async function withGroq(content, fn) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/* Every behavioural test runs against both copies. */
for (const [name, worker] of [['module', handler], ['generated', generated]]) {
  test(`${name}: /health reports whether the key landed, and never the key`, async () => {
    const res = await worker.fetch(new Request('https://ai.test/health'), env());
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.ai, true);
    assert.equal(body.model, 'llama-3.3-70b-versatile');
    assert.match(body.vision_model, /llama-4/);
    assert.ok(!JSON.stringify(body).includes('"k"'), 'the key must not appear in the response');

    const blind = await (await worker.fetch(new Request('https://ai.test/health'), { ...env(), GROQ_API_KEY: '' })).json();
    assert.equal(blind.ai, false);
  });

  test(`${name}: drafts, and returns quantities rather than prices`, async () => {
    await withGroq(DRAFT, async (calls) => {
      const res = await worker.fetch(post(goodBody()), env());
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.draft.line_items[0].quantity_estimate, 45);
      assert.ok(!('price' in body.draft.line_items[0]));
      assert.equal(calls.length, 1);
      assert.match(calls[0].url, /groq\.test/);
    });
  });

  test(`${name}: refuses a line the template does not offer`, async () => {
    const invented = {
      ...DRAFT,
      line_items: [{ ...DRAFT.line_items[0], line_code: 'gold_plating' }],
    };
    await withGroq(invented, async () => {
      const res = await worker.fetch(post(goodBody()), env());
      assert.equal(res.status, 502);
      const body = await res.json();
      assert.equal(body.ok, false);
      assert.match(JSON.stringify(body.detail), /not in the matched template/);
    });
  });

  test(`${name}: refuses a photo claim when no photo was sent`, async () => {
    const lying = {
      ...DRAFT,
      line_items: [{ ...DRAFT.line_items[0], source: 'photo_inferred' }],
    };
    await withGroq(lying, async () => {
      const res = await worker.fetch(post(goodBody()), env());
      assert.equal(res.status, 502);
      assert.match(JSON.stringify((await res.json()).detail), /no photos were supplied/);
    });
  });

  test(`${name}: a missing key is 503, not a bad request`, async () => {
    const res = await worker.fetch(post(goodBody()), { ...env(), GROQ_API_KEY: '' });
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /No AI is connected/);
  });

  test(`${name}: validates its own input`, async () => {
    assert.equal((await worker.fetch(post({ template: TEMPLATE }), env())).status, 400);
    assert.equal((await worker.fetch(post({ description: 'x' }), env())).status, 400);
    assert.equal((await worker.fetch(new Request('https://ai.test/draft'), env())).status, 405);
    assert.equal((await worker.fetch(new Request('https://ai.test/nope'), env())).status, 404);
  });

  test(`${name}: only the allowlisted origin gets CORS headers back`, async () => {
    const mine = await worker.fetch(
      new Request('https://ai.test/health', { headers: { Origin: 'https://someone.github.io' } }), env());
    assert.equal(mine.headers.get('Access-Control-Allow-Origin'), 'https://someone.github.io');

    const theirs = await worker.fetch(
      new Request('https://ai.test/health', { headers: { Origin: 'https://evil.example' } }), env());
    assert.equal(theirs.headers.get('Access-Control-Allow-Origin'), null);

    const wild = await worker.fetch(
      new Request('https://ai.test/health', { headers: { Origin: 'https://evil.example' } }),
      env({ ALLOWED_ORIGINS: '*' }));
    assert.equal(wild.headers.get('Access-Control-Allow-Origin'), 'https://evil.example');
  });

  test(`${name}: the shared token, when set, is required`, async () => {
    const e = env({ AI_SHARED_TOKEN: 'sekrit' });
    assert.equal((await worker.fetch(post(goodBody()), e)).status, 401);
    assert.equal((await worker.fetch(post(goodBody(), { Authorization: 'Bearer wrong' }), e)).status, 401);
    await withGroq(DRAFT, async () => {
      const res = await worker.fetch(post(goodBody(), { Authorization: 'Bearer sekrit' }), e);
      assert.equal(res.status, 200);
    });
  });

  test(`${name}: preflight is answered without touching Groq`, async () => {
    const res = await worker.fetch(
      new Request('https://ai.test/draft', { method: 'OPTIONS', headers: { Origin: 'https://someone.github.io' } }),
      env());
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('Access-Control-Allow-Methods'), 'GET,POST,OPTIONS');
  });
}

test('the generated file is what the generator produces right now', () => {
  const before = readFileSync(`${WORKER}paste/ai-worker.js`, 'utf8');
  execFileSync('node', ['scripts/build-generated.mjs'], { cwd: WORKER, stdio: 'ignore' });
  assert.equal(
    readFileSync(`${WORKER}paste/ai-worker.js`, 'utf8'),
    before,
    'worker/src changed without regenerating — run: npm run build:generated',
  );
});

test('the generated file is standalone: nothing left to import', () => {
  const src = readFileSync(`${WORKER}paste/ai-worker.js`, 'utf8');
  assert.ok(!/^import\s/m.test(src), 'a paste target cannot import anything');
  assert.equal((src.match(/^export /gm) || []).length, 1, 'exactly one export, the default handler');
});
