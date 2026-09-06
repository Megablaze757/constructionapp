/* ------------------------------------------------------------------------- *
 * GENERATED FILE — DO NOT EDIT.
 * Built by worker/scripts/build-generated.mjs from worker/src/schema.js.
 * Edit the source and run: npm run build:generated
 * ------------------------------------------------------------------------- */

/**
 * The AI draft assistant's output contract.
 *
 * There are two schemas here, deliberately:
 *
 *   WIRE_SCHEMA      what we constrain the model to via the provider's structured
 *                    outputs. Strict mode is OpenAI-flavoured: no
 *                    if/then/allOf, every property must appear in `required`,
 *                    and "optional" has to be expressed as a nullable union.
 *
 *   validateDraft()  the canonical contract from
 *                    docs/auto-quoting/schemas/draft-quote.schema.json, including
 *                    the conditional guardrails that strict mode cannot express
 *                    ("an inferred quantity is never high confidence", "anything
 *                    below high confidence must explain itself").
 *
 * So the model is constrained to the shape, and we enforce the rules. A model
 * that satisfies the wire schema can still violate the contract; that is exactly
 * what the second pass is for, and it is the reason the guardrails live in code
 * rather than in the prompt.
 */

export const CONFIDENCE = ['high', 'medium', 'low'];

/**
 * Provenance of a drafted quantity.
 *
 * `photo_inferred` is separate from `ai_inferred` on purpose: "I measured this off
 * a picture" is a different kind of claim from "I worked it out from the wording",
 * and an owner checking a quote on site needs to know which one they are looking
 * at. It is also the only way to catch a model claiming to have read a photo that
 * was never sent.
 */
export const AI_SOURCES = [
  'explicit_in_description',
  'ai_inferred',
  'photo_inferred',
  'template_default',
];

/** Sources that are the model's own estimate rather than something it was told. */
export const INFERRED_SOURCES = ['ai_inferred', 'photo_inferred'];

/** Sent as response_format.json_schema.schema (strict: true), or described in
 *  the prompt when the model only serves plain JSON mode. */
export const WIRE_SCHEMA = {
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
export function validateDraft(draft, allowedCodes, { photosProvided = false } = {}) {
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
