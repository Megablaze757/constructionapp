/**
 * Groq client for the AI draft assistant.
 *
 * Scope discipline (docs/auto-quoting/README.md §11): this module turns a
 * description into *quantities and provenance*. It is never given the authority
 * to price, to send, or to accept. The price book is passed in as reference so
 * the model knows what lines exist and what units they take — the returned
 * object has no price field for the model to fill in even if it wanted to.
 *
 * Two Groq-specific things shape this file:
 *
 *   1. Structured outputs vary by model. Groq serves `response_format:
 *      json_schema` on some models and only `json_object` (plain JSON mode) on
 *      others. Rather than pinning the app to one model's capabilities, the
 *      request tries json_schema and falls back to json_object with the schema
 *      described in the prompt. Either way the response is validated against the
 *      canonical contract afterwards, so the fallback loosens *generation*, never
 *      the guarantee.
 *
 *   2. The best text model is not the vision model. Reading a site photo needs a
 *      multimodal model, so photos switch to GROQ_VISION_MODEL for that call.
 *
 * The key never has to live here. Set AI_PROXY_URL and the draft request is
 * forwarded to another Worker that holds it — the small paste-into-the-dashboard
 * one in worker/paste/, or a shared internal one. Whatever comes back is put
 * through `validateDraft` again on this side, so trusting the proxy with the key
 * is not the same as trusting it with the contract.
 */

import { WIRE_SCHEMA, validateDraft } from './schema.js';

const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';

/** Text drafting. Long-lived on Groq and reliable at JSON mode. */
export const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

/** Used only when site photos are attached — the text model cannot see. */
export const DEFAULT_VISION_MODEL = 'meta-llama/llama-4-maverick-17b-128e-instruct';

/** Overridable so the draft path can be exercised against a stub in tests. */
function endpoint(env) {
  return `${(env.GROQ_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '')}/chat/completions`;
}

export function modelFor(env, { withPhotos = false } = {}) {
  return withPhotos
    ? (env.GROQ_VISION_MODEL || DEFAULT_VISION_MODEL)
    : (env.GROQ_MODEL || DEFAULT_MODEL);
}

export function buildSystemPrompt() {
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

export function buildUserPrompt({
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
export function aiConfigured(env) {
  return !!(env.GROQ_API_KEY || env.AI_PROXY_URL);
}

/**
 * Ask the model for a draft.
 * @returns {Promise<{ok: true, draft: object, model: string, mode: string, photos_used: number}
 *                  | {ok: false, error: string, detail?: any, unconfigured?: true}>}
 */
export async function requestDraft(env, {
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
