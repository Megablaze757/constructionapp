/**
 * BuilderOS — AI drafting worker.
 *
 * Paste this whole file into the Cloudflare dashboard and the AI half of
 * BuilderOS works. No build step, no D1, no wrangler, no repository.
 *
 * ── Deploy ──────────────────────────────────────────────────────────────────
 *   1. dash.cloudflare.com → Workers & Pages → Create → Start with Hello World
 *   2. Deploy it, then Edit code, select all, and paste this file over the top.
 *      Deploy again.
 *   3. Settings → Variables and Secrets:
 *        GROQ_API_KEY     (Secret)   from console.groq.com/keys
 *        ALLOWED_ORIGINS  (Variable) https://<you>.github.io
 *      Optional:
 *        AI_SHARED_TOKEN  (Secret)   callers must send it as a Bearer token
 *        GROQ_MODEL       (Variable) default llama-3.3-70b-versatile
 *        GROQ_VISION_MODEL(Variable) default meta-llama/llama-4-maverick-17b-128e-instruct
 *   4. Open https://<your-worker>.workers.dev/health — it should say ai: true.
 *   5. Put that URL in web/config.js as `aiBase`, or paste it into Settings on
 *      the site itself.
 *
 * ── What it does ────────────────────────────────────────────────────────────
 *   GET  /health   { ok, ai, model, vision_model }
 *   POST /draft    { description, template, price_book, similar_jobs,
 *                    estimating_history, photos: [{mime, b64}] }
 *              →   { ok: true, draft, model, mode, photos_used }
 *
 * The model returns quantities and provenance. It is never given a price field
 * to fill in, cannot name a line the template does not offer, cannot claim high
 * confidence on something it inferred, and cannot claim to have read a photo
 * that was not sent. Those rules are enforced in validateDraft() below, after
 * the model has answered — not asked for in the prompt and hoped for.
 */


/* ------------------------------------------------------------------------- *
 * GENERATED FILE — DO NOT EDIT.
 * Built by worker/scripts/build-generated.mjs from worker/src/schema.js, worker/src/groq.js and worker/paste/handler.js.
 * Edit the source and run: npm run build:generated
 * ------------------------------------------------------------------------- */


/* ============================ the draft contract ========================= */

const CONFIDENCE = ['high', 'medium', 'low'];

/**
 * Provenance of a drafted quantity.
 *
 * `photo_inferred` is separate from `ai_inferred` on purpose: "I measured this off
 * a picture" is a different kind of claim from "I worked it out from the wording",
 * and an owner checking a quote on site needs to know which one they are looking
 * at. It is also the only way to catch a model claiming to have read a photo that
 * was never sent.
 */
const AI_SOURCES = [
  'explicit_in_description',
  'ai_inferred',
  'photo_inferred',
  'template_default',
];

/** Sources that are the model's own estimate rather than something it was told. */
const INFERRED_SOURCES = ['ai_inferred', 'photo_inferred'];

/** Sent as response_format.json_schema.schema (strict: true), or described in
 *  the prompt when the model only serves plain JSON mode. */
const WIRE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'job_type',
    'confidence',
    'line_items',
    'assumptions',
    'flags_for_owner_review',
  ],
  properties: {
    job_type: { type: 'string' },
    confidence: { type: 'string', enum: CONFIDENCE },
    line_items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'line_code',
          'description',
          'quantity_estimate',
          'unit',
          'source',
          'confidence',
          'note',
        ],
        properties: {
          line_code: {
            type: 'string',
            description: 'Must be one of the line_code values from the supplied template.',
          },
          description: { type: 'string' },
          quantity_estimate: { type: 'number' },
          unit: { type: 'string' },
          source: { type: 'string', enum: AI_SOURCES },
          confidence: { type: 'string', enum: CONFIDENCE },
          // Nullable rather than absent: strict mode has no optional properties.
          note: { type: ['string', 'null'] },
        },
      },
    },
    assumptions: { type: 'array', items: { type: 'string' } },
    flags_for_owner_review: { type: 'array', items: { type: 'string' } },
  },
};

/**
 * Enforce the canonical contract.
 *
 * @param {unknown} draft         parsed model output
 * @param {Set<string>} allowedCodes  line_codes the matched template permits
 * @returns {{ok: true, value: object} | {ok: false, errors: string[]}}
 */
function validateDraft(draft, allowedCodes, { photosProvided = false } = {}) {
  const errors = [];
  const bad = (m) => errors.push(m);

  if (draft === null || typeof draft !== 'object' || Array.isArray(draft)) {
    return { ok: false, errors: ['draft must be an object'] };
  }

  const allowedTop = new Set([
    'job_type',
    'confidence',
    'line_items',
    'assumptions',
    'flags_for_owner_review',
    'similar_past_jobs_reference',
  ]);
  for (const key of Object.keys(draft)) {
    if (!allowedTop.has(key)) bad(`unexpected top-level property "${key}"`);
  }

  if (typeof draft.job_type !== 'string' || !/^[a-z0-9]+(_[a-z0-9]+)*$/.test(draft.job_type)) {
    bad('job_type must be a snake_case string');
  }
  if (!CONFIDENCE.includes(draft.confidence)) {
    bad(`confidence must be one of ${CONFIDENCE.join('/')}`);
  }

  for (const field of ['assumptions', 'flags_for_owner_review']) {
    if (!Array.isArray(draft[field])) {
      bad(`${field} must be an array`);
    } else if (draft[field].some((s) => typeof s !== 'string' || s.length === 0)) {
      bad(`${field} must contain only non-empty strings`);
    }
  }

  if (!Array.isArray(draft.line_items) || draft.line_items.length === 0) {
    bad('line_items must be a non-empty array');
    return { ok: false, errors };
  }

  const allowedItem = new Set([
    'line_code',
    'description',
    'quantity_estimate',
    'unit',
    'source',
    'confidence',
    'note',
  ]);

  draft.line_items.forEach((item, i) => {
    const at = `line_items[${i}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      bad(`${at} must be an object`);
      return;
    }
    for (const key of Object.keys(item)) {
      // Catches a model trying to price the job: "price", "unit_price", "total"
      // are simply not part of the contract, so they are hard errors, not
      // something we quietly drop.
      if (!allowedItem.has(key)) bad(`${at} has unexpected property "${key}"`);
    }
    if (typeof item.description !== 'string' || !item.description.trim()) {
      bad(`${at}.description must be a non-empty string`);
    }
    if (typeof item.quantity_estimate !== 'number'
        || !Number.isFinite(item.quantity_estimate)
        || item.quantity_estimate <= 0) {
      bad(`${at}.quantity_estimate must be a number greater than 0`);
    }
    if (typeof item.unit !== 'string' || !item.unit.trim()) {
      bad(`${at}.unit must be a non-empty string`);
    }
    if (!AI_SOURCES.includes(item.source)) {
      bad(`${at}.source must be one of ${AI_SOURCES.join('/')}`);
    }
    if (!CONFIDENCE.includes(item.confidence)) {
      bad(`${at}.confidence must be one of ${CONFIDENCE.join('/')}`);
    }
    if (typeof item.line_code !== 'string' || !item.line_code.trim()) {
      bad(`${at}.line_code must be a non-empty string`);
    } else if (allowedCodes && !allowedCodes.has(item.line_code)) {
      // The model cannot invent a line the template does not offer, which is
      // what stops it inventing a price by inventing a product.
      bad(`${at}.line_code "${item.line_code}" is not in the matched template`);
    }

    const hasNote = typeof item.note === 'string' && item.note.trim().length > 0;
    if (item.note != null && typeof item.note !== 'string') {
      bad(`${at}.note must be a string or null`);
    }
    // Guardrail: inference is by definition not stated, so it cannot be high.
    // A quantity scaled off a photograph is an estimate twice over.
    if (INFERRED_SOURCES.includes(item.source) && item.confidence === 'high') {
      bad(`${at} is ${item.source} and cannot claim confidence "high"`);
    }
    // Guardrail: anything the owner has to judge must explain itself.
    if ((item.confidence === 'medium' || item.confidence === 'low') && !hasNote) {
      bad(`${at} has confidence "${item.confidence}" and must carry a note`);
    }
    if (INFERRED_SOURCES.includes(item.source) && !hasNote) {
      bad(`${at} is ${item.source} and must carry a note`);
    }
    // Guardrail: the model cannot claim it measured something off a photograph
    // when no photograph was sent.
    if (item.source === 'photo_inferred' && !photosProvided) {
      bad(`${at} claims photo_inferred but no photos were supplied with this draft`);
    }
  });

  if (draft.similar_past_jobs_reference !== undefined) {
    if (!Array.isArray(draft.similar_past_jobs_reference)) {
      bad('similar_past_jobs_reference must be an array');
    } else {
      draft.similar_past_jobs_reference.forEach((ref, i) => {
        const at = `similar_past_jobs_reference[${i}]`;
        if (ref === null || typeof ref !== 'object') return bad(`${at} must be an object`);
        if (typeof ref.job !== 'string' || !ref.job.trim()) bad(`${at}.job must be a non-empty string`);
        for (const n of ['quoted', 'actual_cost']) {
          if (typeof ref[n] !== 'number' || !Number.isFinite(ref[n]) || ref[n] < 0) {
            bad(`${at}.${n} must be a number >= 0`);
          }
        }
        if (ref.margin_actual !== undefined && !/^-?\d+(\.\d+)?%$/.test(String(ref.margin_actual))) {
          bad(`${at}.margin_actual must look like "22%"`);
        }
      });
    }
  }

  if (errors.length) return { ok: false, errors };

  // Overall confidence must not overstate the weakest line.
  const rank = { low: 0, medium: 1, high: 2 };
  const weakest = draft.line_items.reduce(
    (acc, it) => Math.min(acc, rank[it.confidence]),
    rank[draft.confidence],
  );
  const normalised = { ...draft, confidence: CONFIDENCE[2 - weakest] };

  return { ok: true, value: normalised };
}

/* =============================== the Groq call =========================== */


const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';

/** Text drafting. Long-lived on Groq and reliable at JSON mode. */
const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

/** Used only when site photos are attached — the text model cannot see. */
const DEFAULT_VISION_MODEL = 'meta-llama/llama-4-maverick-17b-128e-instruct';

/** Overridable so the draft path can be exercised against a stub in tests. */
function endpoint(env) {
  return `${(env.GROQ_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '')}/chat/completions`;
}

function modelFor(env, { withPhotos = false } = {}) {
  return withPhotos
    ? (env.GROQ_VISION_MODEL || DEFAULT_VISION_MODEL)
    : (env.GROQ_MODEL || DEFAULT_MODEL);
}

function buildSystemPrompt() {
  return [
    'You are a quoting assistant for a construction business.',
    '',
    "Extract job scope details from the owner's description and map them to the",
    "supplied template's line items. Your job is to draft, not to decide.",
    '',
    'Rules, in order of importance:',
    '1. NEVER output a price, rate, cost, or total. You return quantities only.',
    '   Pricing is applied by the system from the price book after you respond.',
    '2. Only use line_code values that appear in the supplied template. If the job',
    '   seems to need something the template does not offer, do not invent a line —',
    '   raise it in flags_for_owner_review instead.',
    '3. Label every line honestly with `source`:',
    '   - explicit_in_description: the quantity was actually stated in the input',
    '   - ai_inferred: you worked it out from the wording',
    '   - photo_inferred: you scaled it off a site photo',
    '   - template_default: it came from the template, not the input',
    '   Neither ai_inferred nor photo_inferred can ever be confidence "high", and',
    '   you may only use photo_inferred if photos were actually attached.',
    '4. Anything not confidence "high" MUST carry a `note` explaining what you',
    "   inferred it from and what the owner should check. Write the note to the",
    '   owner, in plain site language.',
    '5. Put everything you took for granted in `assumptions`, and everything the',
    '   owner must physically check in `flags_for_owner_review`.',
    '6. Use the recent similar jobs only to sanity-check that your quantities are',
    '   the right order of magnitude. Do not copy their numbers.',
    '7. `estimating_history` reports where this business\'s own past estimates have',
    '   drifted from what jobs actually cost. Where a line is listed as running',
    '   over, scope it generously and say so in the note. It is measured history,',
    '   not a hint — but it is about cost, so it never licenses you to output one.',
    '',
    'If site photos are attached, use them to sanity-check or estimate quantities.',
    'Scale from something of known size in the frame — a storey, a door, a window,',
    'a brick course — and say in the note what you scaled against, so the owner can',
    'check your reasoning on site. A photo shows one elevation and hides the rest:',
    'never assume it covers the whole job, and raise anything it cannot show in',
    'flags_for_owner_review. If the photos are unclear, say so rather than guessing.',
    '',
    'Be conservative. An under-scoped quote costs the business real money, and the',
    'owner reviews every line you produce before a client ever sees it.',
  ].join('\n');
}

function buildUserPrompt({
  description, template, priceBook, similarJobs, estimatingHistory = [], photoCount = 0,
}) {
  const lines = (template.line_items || []).map((li) => ({
    line_code: li.line_code,
    description: li.description,
    unit: li.unit,
    default_quantity: li.default_quantity,
    always_include: !!li.always_include,
  }));

  // Units and descriptions only — the model is shown what exists, not what it costs.
  const catalogue = priceBook.map((p) => ({
    line_code: p.code,
    description: p.description,
    unit: p.unit,
    category: p.category,
  }));

  return JSON.stringify(
    {
      job_description: description,
      matched_template: {
        job_type: template.job_type,
        name: template.name,
        line_items: lines,
      },
      available_line_codes: catalogue,
      recent_similar_jobs: similarJobs,
      estimating_history: estimatingHistory,
      site_photos_attached: photoCount,
    },
    null,
    2,
  );
}

/**
 * The instruction that carries the schema when the model only supports plain
 * JSON mode. In json_schema mode the provider enforces the shape; here the
 * prompt asks for it and `validateDraft` still refuses anything that misses.
 */
function schemaInstruction() {
  return [
    '',
    'Reply with a single JSON object and nothing else. It must match this schema',
    'exactly, with no extra properties:',
    JSON.stringify(WIRE_SCHEMA),
  ].join('\n');
}

function buildBody({ model, systemPrompt, userContent, mode }) {
  return {
    model,
    // Drafting a quote is an extraction task; sampling variance here shows up as
    // inconsistent quantities for the same site, which is exactly what the
    // template system is meant to eliminate.
    temperature: 0.2,
    messages: [
      { role: 'system', content: mode === 'json_object' ? systemPrompt + schemaInstruction() : systemPrompt },
      { role: 'user', content: userContent },
    ],
    response_format: mode === 'json_schema'
      ? { type: 'json_schema', json_schema: { name: 'draft_quote', strict: true, schema: WIRE_SCHEMA } }
      : { type: 'json_object' },
  };
}

/** True when this deployment has some way of reaching a model. */
function aiConfigured(env) {
  return !!(env.GROQ_API_KEY || env.AI_PROXY_URL);
}

/**
 * Ask the model for a draft.
 * @returns {Promise<{ok: true, draft: object, model: string, mode: string, photos_used: number}
 *                  | {ok: false, error: string, detail?: any, unconfigured?: true}>}
 */
async function requestDraft(env, {
  description, template, priceBook, similarJobs, estimatingHistory, photos = [],
}) {
  const args = { description, template, priceBook, similarJobs, estimatingHistory, photos };

  if (env.AI_PROXY_URL) return viaProxy(env, args, template, photos);

  if (!env.GROQ_API_KEY) {
    // Distinguished from a failure so the caller can fall back to the template
    // rather than showing the owner an error they cannot act on yet.
    return {
      ok: false,
      unconfigured: true,
      error: 'No AI is connected — set GROQ_API_KEY or AI_PROXY_URL on the Worker.',
    };
  }

  const withPhotos = photos.length > 0;
  const model = modelFor(env, { withPhotos });
  const systemPrompt = buildSystemPrompt();
  const prompt = buildUserPrompt({
    description, template, priceBook, similarJobs, estimatingHistory,
    photoCount: photos.length,
  });

  // Multimodal only when there is actually something to look at — images cost
  // tokens on every draft, and a text-only call is the cheaper common case.
  const userContent = withPhotos
    ? [
      { type: 'text', text: prompt },
      ...photos.map((p) => ({
        type: 'image_url',
        image_url: { url: `data:${p.mime};base64,${p.b64}` },
      })),
    ]
    : prompt;

  // Preference order. `auto` tries the stronger constraint first and drops to
  // plain JSON mode if this model does not serve it.
  const preference = String(env.GROQ_STRUCTURED_OUTPUTS || 'auto').toLowerCase();
  const modes = preference === 'json_object' ? ['json_object']
    : preference === 'json_schema' ? ['json_schema']
      : ['json_schema', 'json_object'];

  let lastError = null;
  for (const mode of modes) {
    const attempt = await callGroq(env, buildBody({ model, systemPrompt, userContent, mode }));

    if (attempt.ok) {
      const allowed = new Set((template.line_items || []).map((li) => li.line_code));
      const checked = validateDraft(attempt.parsed, allowed, { photosProvided: withPhotos });
      if (!checked.ok) {
        // A contract violation is a failed draft, not something to patch up and
        // show the owner. Silently repairing it would defeat the audit trail.
        return { ok: false, error: 'Model output failed the draft contract', detail: checked.errors };
      }
      return { ok: true, draft: checked.value, model, mode, photos_used: photos.length };
    }

    lastError = attempt;
    // Only a rejection of the response_format is worth retrying differently.
    // Anything else (bad key, rate limit, unknown model) will fail identically.
    if (!attempt.retryWithJsonObject) break;
  }

  return { ok: false, error: lastError?.error || 'Groq request failed', detail: lastError?.detail };
}

/**
 * Hand the draft to another Worker that holds the key (worker/paste/ai-worker.js).
 *
 * The proxy validates before it answers, and this validates again on the way in.
 * That is deliberate: the proxy is trusted with the API key, not with deciding
 * what may appear on a quote.
 */
async function viaProxy(env, args, template, photos) {
  let res;
  try {
    res = await fetch(env.AI_PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(env.AI_PROXY_TOKEN ? { Authorization: `Bearer ${env.AI_PROXY_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        description: args.description,
        template,
        price_book: args.priceBook,
        similar_jobs: args.similarJobs,
        estimating_history: args.estimatingHistory,
        photos,
      }),
    });
  } catch (err) {
    return { ok: false, error: `Could not reach the AI worker: ${err.message}` };
  }

  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.ok) {
    return {
      ok: false,
      error: payload?.error || `AI worker returned ${res.status}`,
      detail: payload?.detail,
    };
  }

  const allowed = new Set((template.line_items || []).map((li) => li.line_code));
  const checked = validateDraft(payload.draft, allowed, { photosProvided: photos.length > 0 });
  if (!checked.ok) {
    return { ok: false, error: 'AI worker output failed the draft contract', detail: checked.errors };
  }
  return {
    ok: true,
    draft: checked.value,
    model: payload.model || 'via AI worker',
    mode: payload.mode || 'proxy',
    photos_used: photos.length,
  };
}

async function callGroq(env, body) {
  let res;
  try {
    res = await fetch(endpoint(env), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: `Could not reach Groq: ${err.message}` };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // Groq answers an unsupported response_format with a 400 naming it. That is
    // the one failure worth retrying in a weaker mode.
    const retryWithJsonObject = res.status === 400
      && body.response_format?.type === 'json_schema'
      && /response_format|json_schema|schema/i.test(detail);
    return {
      ok: false,
      error: `Groq returned ${res.status}`,
      detail: detail.slice(0, 500),
      retryWithJsonObject,
    };
  }

  const payload = await res.json().catch(() => null);
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) {
    return { ok: false, error: 'Groq returned no message content', detail: payload };
  }

  try {
    return { ok: true, parsed: JSON.parse(content) };
  } catch {
    return { ok: false, error: 'Model did not return valid JSON', detail: String(content).slice(0, 500) };
  }
}

/* ============================== the Worker itself ======================== */

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

