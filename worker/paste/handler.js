/**
 * The AI worker's request handling, kept as a normal module so it can be tested.
 *
 * worker/scripts/build-generated.mjs inlines this together with schema.js and
 * groq.js to produce worker/paste/ai-worker.js — the single self-contained file
 * you paste into the Cloudflare dashboard. Nothing below may import anything the
 * generated file will not have, which is why the CORS and JSON helpers are
 * spelled out here rather than pulled from src/http.js.
 */

import { requestDraft, modelFor } from '../src/groq.js';

/**
 * Browsers send the draft directly from the quote builder, so the allowlist is
 * what stops any other site spending this key. `*` is accepted because a first
 * deploy needs to work before the Pages URL is known, but it is a deliberate
 * choice the deployer has to type.
 */
function allowOrigin(env, request) {
  const origin = request.headers.get('Origin') || '';
  const list = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!list.length) return '';
  if (list.includes('*')) return origin || '*';
  return list.includes(origin) ? origin : '';
}

function cors(env, request) {
  const origin = allowOrigin(env, request);
  return origin
    ? {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    }
    : {};
}

function reply(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

export default {
  async fetch(request, env) {
    const headers = cors(env, request);
    const { pathname } = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    if (pathname === '/' || pathname === '/health') {
      return reply({
        service: 'builderos-ai',
        ok: true,
        // Says whether the secret actually landed, without ever echoing it.
        ai: !!env.GROQ_API_KEY,
        model: modelFor(env),
        vision_model: modelFor(env, { withPhotos: true }),
      }, 200, headers);
    }

    if (pathname !== '/draft') return reply({ error: 'Not found' }, 404, headers);
    if (request.method !== 'POST') return reply({ error: 'POST only' }, 405, headers);

    // Optional shared secret. Without it the endpoint is open to anyone who
    // knows the URL, which is fine for a personal deploy behind a tight
    // ALLOWED_ORIGINS and not fine for anything else.
    if (env.AI_SHARED_TOKEN
        && request.headers.get('Authorization') !== `Bearer ${env.AI_SHARED_TOKEN}`) {
      return reply({ error: 'Unauthorized' }, 401, headers);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return reply({ error: 'Body must be JSON' }, 400, headers);
    }

    const description = String(body.description || '').trim();
    const template = body.template;
    if (!description) return reply({ error: 'description is required' }, 400, headers);
    if (!template || !Array.isArray(template.line_items) || !template.line_items.length) {
      return reply({ error: 'template.line_items[] is required' }, 400, headers);
    }

    const result = await requestDraft(env, {
      description,
      template,
      priceBook: body.price_book || [],
      similarJobs: body.similar_jobs || [],
      estimatingHistory: body.estimating_history || [],
      photos: Array.isArray(body.photos) ? body.photos : [],
    });

    if (!result.ok) {
      // A missing key is the deployer's problem, not a bad request, and it is
      // worth a different status so the caller can tell them apart.
      return reply(
        { ok: false, error: result.error, detail: result.detail },
        result.unconfigured ? 503 : 502,
        headers,
      );
    }

    return reply(result, 200, headers);
  },
};
