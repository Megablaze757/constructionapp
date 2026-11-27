/* ------------------------------------------------------------------------- *
 * GENERATED FILE — DO NOT EDIT.
 * Built by worker/scripts/build-generated.mjs from worker/src/rule-draft.js.
 * Edit the source and run: npm run build:generated
 * ------------------------------------------------------------------------- */

/**
 * The middle rung of the drafting ladder: read the description with patterns,
 * not a model.
 *
 * This exists because the alternatives at zero cost are both bad. A language
 * model small enough to run in a phone browser produces, measurably, the wrong
 * answer — asked to draft from "probably two lifts, they'll be up there about
 * five days" a 0.5B model returned `scaffold_erect: 5 building` and
 * `scaffold_hire: 2 day`, having swapped the two numbers, invented the unit, and
 * labelled both `explicit_in_description` at high confidence. Falling straight
 * through to bare template defaults, meanwhile, ignores a description that
 * plainly contains "five days".
 *
 * So: take the numbers whose units can be matched against the template, and
 * refuse to guess about the rest. The discipline that makes this honest rather
 * than a cheap imitation of estimating is that it never assigns a quantity to a
 * unit it did not read. "Two lifts" is two lifts — it is not 2m² and not 2 days
 * — so it becomes a flag for the owner, not a number on a quote.
 */

/** Spoken numbers, as an owner actually dictates them. */
const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20,
};

/**
 * Unit vocabulary, mapped to the canonical units the price book uses.
 *
 * `job` is deliberately absent: it is a per-job line, not something anyone says
 * a quantity of, and accepting "one job" would only create a way to get it
 * wrong. `multiplier` converts a spoken unit into the canonical one.
 */
const UNITS = [
  { canonical: 'm2', multiplier: 1, pattern: /(?:m2|m²|sqm|sq\.?\s?m|square\s+(?:metres?|meters?|m))\b/i },
  { canonical: 'days', multiplier: 7, pattern: /weeks?\b/i },
  { canonical: 'days', multiplier: 1, pattern: /days?\b/i },
];

const NUMBER = `(?:\\d+(?:\\.\\d+)?|${Object.keys(NUMBER_WORDS).join('|')})`;
/** "a couple of" reads as two everywhere a builder says it. */
const COUPLE = /\ba\s+couple\s+of\s+/gi;

function toNumber(token) {
  const word = NUMBER_WORDS[token.toLowerCase()];
  if (word !== undefined) return word;
  const n = Number(token);
  return Number.isFinite(n) ? n : null;
}

/**
 * Every "<number> <unit>" phrase in the text, with the unit normalised.
 *
 * @returns {Array<{raw: string, value: number, unit: string}>}
 */
export function extractQuantities(text) {
  const prepared = String(text || '').replace(COUPLE, 'two ');
  const found = [];

  for (const { canonical, multiplier, pattern } of UNITS) {
    const re = new RegExp(`\\b(${NUMBER})\\s*(${pattern.source})`, 'gi');
    for (const m of prepared.matchAll(re)) {
      const value = toNumber(m[1]);
      if (value === null || value <= 0) continue;
      found.push({ raw: m[0].trim(), value: value * multiplier, unit: canonical });
    }
  }
  return found;
}

/**
 * Numbers in the text whose unit means nothing to the price book.
 *
 * These are the interesting ones. "Two lifts" is real information the owner
 * said out loud, and the parser cannot price it — so it is surfaced rather than
 * dropped, and rather than being bent into whichever line happens to be next.
 */
export function unmatchedQuantities(text) {
  const prepared = String(text || '').replace(COUPLE, 'two ');
  const re = new RegExp(`\\b(${NUMBER})\\s+([a-z]+)\\b`, 'gi');
  const out = [];

  for (const m of prepared.matchAll(re)) {
    if (toNumber(m[1]) === null) continue;
    const noun = m[2];
    if (UNITS.some((u) => new RegExp(`^${u.pattern.source}`, 'i').test(noun))) continue;
    // Filler like "about five" or "roughly two" is not a quantity of anything.
    if (/^(?:of|and|or|to|the|a|an|in|on|at|for|more|less|other|further)$/i.test(noun)) continue;
    out.push({ raw: m[0].trim(), value: toNumber(m[1]), noun: noun.toLowerCase() });
  }
  return out;
}

/** Words from a line's own description, for telling two same-unit lines apart. */
function keywords(line) {
  return String(line.description || '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 3);
}

/**
 * Which template line a quantity belongs to.
 *
 * Unit match is required, never inferred. Where exactly one line takes that
 * unit the answer is unambiguous. Where several do, the line whose own
 * description is mentioned in the text wins; if none is, the quantity is left
 * unassigned rather than put on whichever line came first.
 */
function assign(quantity, lines, text) {
  const sameUnit = lines.filter((l) => l.unit === quantity.unit);
  if (sameUnit.length === 1) return { line: sameUnit[0], certain: true };
  if (!sameUnit.length) return { line: null, certain: false };

  // Only words that belong to one candidate can tell them apart. On a re-roof
  // both the strip and the re-tile line say "roof", so "roof" decides nothing —
  // "strip" and "tile" do.
  const counts = new Map();
  for (const l of sameUnit) {
    for (const w of new Set(keywords(l))) counts.set(w, (counts.get(w) || 0) + 1);
  }
  const lower = text.toLowerCase();
  const named = sameUnit.filter((l) => keywords(l).some((w) => counts.get(w) === 1 && lower.includes(w)));
  return named.length === 1 ? { line: named[0], certain: false } : { line: null, certain: false };
}

/**
 * Draft from the description using patterns alone.
 *
 * @returns {{ok: true, draft: object, used: number} | {ok: false, error: string}}
 */
export function ruleDraft(description, template) {
  const items = template?.line_items ?? [];
  const compulsory = items.filter((li) => li.always_include);
  const source = compulsory.length ? compulsory : items;
  if (!source.length) {
    return { ok: false, error: 'The template for this job type has no line items to start from.' };
  }

  const text = String(description || '');
  const quantities = extractQuantities(text);
  const taken = new Map();   // line_code → {value, raw, certain}

  for (const q of quantities) {
    const { line, certain } = assign(q, source, text);
    if (!line) continue;
    // First reading of a line wins; a second mention of the same unit is
    // ambiguous, so it is flagged rather than silently overwriting.
    if (!taken.has(line.line_code)) taken.set(line.line_code, { ...q, certain });
  }

  const flags = [];
  const assumptions = [];

  for (const u of unmatchedQuantities(text)) {
    flags.push(`You said "${u.raw}" — nothing in the price book is measured in ${u.noun}, so it is not on the quote. Check the figures below against it.`);
  }

  const lineItems = source.map((li) => {
    const hit = taken.get(li.line_code);
    if (hit) {
      return {
        line_code: li.line_code,
        description: li.description,
        quantity_estimate: hit.value,
        unit: li.unit,
        source: 'explicit_in_description',
        confidence: hit.certain ? 'high' : 'medium',
        note: hit.certain
          ? `Read "${hit.raw}" from your description.`
          : `Read "${hit.raw}" from your description, but more than one line is priced in ${li.unit} — check it is on the right one.`,
      };
    }
    return {
      line_code: li.line_code,
      description: li.description,
      quantity_estimate: Number(li.default_quantity) > 0 ? Number(li.default_quantity) : 1,
      unit: li.unit,
      source: 'template_default',
      confidence: 'medium',
      note: `The template's own figure — your description gave no quantity in ${li.unit}. Check it against the job.`,
    };
  });

  const defaulted = lineItems.filter((l) => l.source === 'template_default');
  if (defaulted.length) {
    assumptions.push(
      `${defaulted.length} of ${lineItems.length} quantities are template defaults: ${defaulted.map((l) => l.description).join(', ')}.`,
    );
  }
  if (taken.size) {
    assumptions.push(`Read from your description: ${[...taken.values()].map((t) => `"${t.raw}"`).join(', ')}.`);
  }
  flags.push('This was matched by pattern, not estimated — nothing read the job the way an estimator would. Check every line.');

  return {
    ok: true,
    used: taken.size,
    draft: {
      job_type: template.job_type,
      confidence: 'medium',
      line_items: lineItems,
      assumptions,
      flags_for_owner_review: flags,
    },
  };
}
