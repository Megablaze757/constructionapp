/**
 * OpenRouter client for the AI draft assistant.
 *
 * Scope discipline (docs/auto-quoting/README.md §11): this module turns a
 * description into *quantities and provenance*. It is never given the authority
 * to price, to send, or to accept. The price book is passed in as reference so
 * the model knows what lines exist and what units they take — the returned
 * object has no price field for the model to fill in even if it wanted to.
 */

import { WIRE_SCHEMA, validateDraft } from './schema.js';

const DEFAULT_BASE_URL = 'https://openrouter.ai/api/v1';
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5';

/** Overridable so the draft path can be exercised against a stub in tests. */
function endpoint(env) {
  return `${(env.OPENROUTER_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '')}/chat/completions`;
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
 * Ask the model for a draft.
 * @returns {Promise<{ok: true, draft: object, model: string} | {ok: false, error: string, detail?: any}>}
 */
export async function requestDraft(env, {
  description, template, priceBook, similarJobs, estimatingHistory, photos = [],
}) {
  if (!env.OPENROUTER_API_KEY) {
    return { ok: false, error: 'OPENROUTER_API_KEY is not configured on the Worker.' };
  }

  const model = env.OPENROUTER_MODEL || DEFAULT_MODEL;

  const prompt = buildUserPrompt({
    description, template, priceBook, similarJobs, estimatingHistory,
    photoCount: photos.length,
  });

  // Multimodal only when there is actually something to look at — images cost
  // tokens on every draft, and a text-only call is the cheaper common case.
  const userContent = photos.length
    ? [
      { type: 'text', text: prompt },
      ...photos.map((p) => ({
        type: 'image_url',
        image_url: { url: `data:${p.mime};base64,${p.b64}` },
      })),
    ]
    : prompt;
  const body = {
    model,
    // Drafting a quote is an extraction task; sampling variance here shows up as
    // inconsistent quantities for the same site, which is exactly what the
    // template system is meant to eliminate.
    temperature: 0.2,
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: userContent },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'draft_quote', strict: true, schema: WIRE_SCHEMA },
    },
  };

  let res;
  try {
    res = await fetch(endpoint(env), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        // OpenRouter attribution headers; harmless if unset.
        'HTTP-Referer': env.PUBLIC_APP_URL || 'https://example.invalid',
        'X-Title': 'BuilderOS Auto-Quoting',
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return { ok: false, error: `Could not reach OpenRouter: ${err.message}` };
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    return { ok: false, error: `OpenRouter returned ${res.status}`, detail: detail.slice(0, 500) };
  }

  const payload = await res.json().catch(() => null);
  const content = payload?.choices?.[0]?.message?.content;
  if (!content) {
    return { ok: false, error: 'OpenRouter returned no message content', detail: payload };
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, error: 'Model did not return valid JSON', detail: content.slice(0, 500) };
  }

  const allowed = new Set((template.line_items || []).map((li) => li.line_code));
  const checked = validateDraft(parsed, allowed, { photosProvided: photos.length > 0 });
  if (!checked.ok) {
    // A contract violation is a failed draft, not something to patch up and show
    // the owner. Silently repairing it would defeat the audit trail.
    return { ok: false, error: 'Model output failed the draft contract', detail: checked.errors };
  }

  return { ok: true, draft: checked.value, model, photos_used: photos.length };
}
