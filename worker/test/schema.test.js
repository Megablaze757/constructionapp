import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// The 2020-12 build specifically — the default ajv entry point is draft-07 and
// silently fails to resolve the published schema's $schema.
import Ajv from 'ajv/dist/2020.js';

import { validateDraft, WIRE_SCHEMA } from '../src/schema.js';

const CODES = new Set(['scaffold_erect', 'scaffold_hire', 'scaffold_dismantle']);

const canonicalSchema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../docs/auto-quoting/schemas/draft-quote.schema.json', import.meta.url)),
    'utf8',
  ),
);

/** The example published in the spec — the two must never drift apart. */
const SPEC_EXAMPLE = {
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
      note: "Estimated from '2 lifts, rear of property' — confirm actual measurement on site",
    },
    {
      line_code: 'scaffold_hire',
      description: 'Scaffold hire',
      quantity_estimate: 5,
      unit: 'days',
      source: 'explicit_in_description',
      confidence: 'high',
    },
    {
      line_code: 'scaffold_dismantle',
      description: 'Dismantle',
      quantity_estimate: 1,
      unit: 'job',
      source: 'template_default',
      confidence: 'high',
    },
  ],
  assumptions: ['Assumed standard domestic access scaffold, not industrial'],
  flags_for_owner_review: ['Scaffold m² is an estimate — confirm before sending'],
  similar_past_jobs_reference: [
    { job: '22 Vine Rd, scaffold erect', quoted: 1780, actual_cost: 1390, margin_actual: '22%' },
  ],
};

const clone = (o) => structuredClone(o);

test('the example published in the spec passes the validator', () => {
  const res = validateDraft(SPEC_EXAMPLE, CODES);
  assert.equal(res.ok, true, JSON.stringify(res.errors));
});

test('the example also validates against the published JSON Schema', () => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  assert.equal(ajv.validate(canonicalSchema, SPEC_EXAMPLE), true, ajv.errorsText());
});

test('validator agrees with the published JSON Schema across the case corpus', () => {
  const ajv = new Ajv({ strict: false, allErrors: true });
  const check = ajv.compile(canonicalSchema);

  // Cases the published schema can decide on its own. Guardrails that depend on
  // the template (line_code membership) are excluded — the schema cannot know
  // the template, which is precisely why that check lives in the validator.
  const cases = [
    ['baseline', SPEC_EXAMPLE],
    ['inferred claiming high confidence', mutate((d) => { d.line_items[0].confidence = 'high'; })],
    ['a price field smuggled onto a line', mutate((d) => { d.line_items[1].unit_price = 27; })],
    ['medium confidence with no note', mutate((d) => { d.line_items[1].confidence = 'medium'; })],
    ['unknown source value', mutate((d) => { d.line_items[0].source = 'vibes'; })],
    ['zero quantity', mutate((d) => { d.line_items[0].quantity_estimate = 0; })],
    ['negative quantity', mutate((d) => { d.line_items[0].quantity_estimate = -5; })],
    ['missing flags_for_owner_review', mutate((d) => { delete d.flags_for_owner_review; })],
    ['missing line_code', mutate((d) => { delete d.line_items[0].line_code; })],
    ['non-snake_case job_type', mutate((d) => { d.job_type = 'Domestic Scaffold'; })],
    ['empty line_items', mutate((d) => { d.line_items = []; })],
    ['margin_actual missing its % sign', mutate((d) => { d.similar_past_jobs_reference[0].margin_actual = '22'; })],
    ['unexpected top-level key', mutate((d) => { d.total_price = 1835; })],
    ['assumptions containing a non-string', mutate((d) => { d.assumptions = [42]; })],
    ['photo-derived line', mutate((d) => { d.line_items[0] = photoLine(); })],
    ['photo-derived line claiming high confidence',
      mutate((d) => { d.line_items[0] = photoLine({ confidence: 'high' }); })],
    ['photo-derived line with no note',
      mutate((d) => { d.line_items[0] = photoLine({ note: null }); })],
    // The wire schema makes `note` nullable because strict mode has no optional
    // properties, so a high-confidence line really does come back as null. The
    // published contract must accept that without letting null count as a note
    // where one is required.
    ['null note on a high-confidence line', mutate((d) => { d.line_items[1].note = null; })],
    ['null note on a medium-confidence line',
      mutate((d) => { d.line_items[1].confidence = 'medium'; d.line_items[1].note = null; })],
    ['empty-string note where one is required',
      mutate((d) => { d.line_items[0].note = ''; })],
  ];

  for (const [name, doc] of cases) {
    const bySchema = check(doc);
    // Photos-provided, because "did a photo exist" is context the published
    // schema cannot know — the same reason line_code membership is excluded.
    const byValidator = validateDraft(doc, CODES, { photosProvided: true }).ok;
    assert.equal(
      byValidator,
      bySchema,
      `disagreement on "${name}": schema=${bySchema} validator=${byValidator}`,
    );
  }

  function mutate(fn) {
    const d = clone(SPEC_EXAMPLE);
    fn(d);
    return d;
  }
});

/* ------------------------------------------------- photo-based estimating */

const photoLine = (over = {}) => ({
  line_code: 'scaffold_erect',
  description: 'Scaffold erect',
  quantity_estimate: 48,
  unit: 'm2',
  source: 'photo_inferred',
  confidence: 'medium',
  note: 'Scaled off the rear elevation photo against the door height — confirm on site',
  ...over,
});

const withPhotoLine = (over = {}) => {
  const d = clone(SPEC_EXAMPLE);
  d.line_items[0] = photoLine(over);
  return d;
};

test('a photo-derived quantity is accepted when photos were supplied', () => {
  const res = validateDraft(withPhotoLine(), CODES, { photosProvided: true });
  assert.equal(res.ok, true, JSON.stringify(res.errors));
});

test('the model cannot claim it read a photo that was never sent', () => {
  // Without this, a text-only draft could launder a guess as a measurement.
  const res = validateDraft(withPhotoLine(), CODES, { photosProvided: false });
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /no photos were supplied/);
});

test('photos default to absent, so photo_inferred is refused unless asked for', () => {
  assert.equal(validateDraft(withPhotoLine(), CODES).ok, false);
});

test('a quantity scaled off a photo can never be high confidence', () => {
  const res = validateDraft(
    withPhotoLine({ confidence: 'high' }), CODES, { photosProvided: true },
  );
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /photo_inferred and cannot claim confidence "high"/);
});

test('a photo-derived line must say what it was scaled against', () => {
  const res = validateDraft(
    withPhotoLine({ note: null }), CODES, { photosProvided: true },
  );
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /photo_inferred and must carry a note/);
});

test('supplying photos does not weaken any other rule', () => {
  const res = validateDraft(
    withPhotoLine({ line_code: 'helicopter_hire' }), CODES, { photosProvided: true },
  );
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /not in the matched template/);
});

test('the model cannot price a line just because it saw a photo', () => {
  const d = withPhotoLine();
  d.line_items[0].unit_price = 27;
  const res = validateDraft(d, CODES, { photosProvided: true });
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /unexpected property "unit_price"/);
});

/* ------------------------------------------------------------------------ */

test('the model cannot invent a line the template does not offer', () => {
  const d = clone(SPEC_EXAMPLE);
  d.line_items[0].line_code = 'helicopter_hire';
  const res = validateDraft(d, CODES);
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /not in the matched template/);
});

test('an ai_inferred line must carry a note', () => {
  const d = clone(SPEC_EXAMPLE);
  delete d.line_items[0].note;
  const res = validateDraft(d, CODES);
  assert.equal(res.ok, false);
  assert.match(res.errors.join(' '), /must carry a note/);
});

test('overall confidence is capped at the weakest line', () => {
  const d = clone(SPEC_EXAMPLE);
  d.confidence = 'high';                    // model overstating itself
  d.line_items[0].confidence = 'low';
  const res = validateDraft(d, CODES);
  assert.equal(res.ok, true);
  assert.equal(res.value.confidence, 'low');
});

test('null note is accepted where the contract does not require one', () => {
  // The wire schema makes `note` nullable because strict mode has no optional
  // properties; a high-confidence line legitimately comes back with note: null.
  const d = clone(SPEC_EXAMPLE);
  d.line_items[1].note = null;
  assert.equal(validateDraft(d, CODES).ok, true);
});

test('wire schema is strict-mode compatible', () => {
  // Provider strict mode requires: no conditionals, additionalProperties false
  // on every object, and every property listed in `required`.
  const walk = (node, path = '$') => {
    if (!node || typeof node !== 'object') return;
    for (const banned of ['if', 'then', 'else', 'allOf', 'anyOf', 'oneOf', 'not', '$ref']) {
      assert.ok(!(banned in node), `${path} uses "${banned}", unsupported in strict mode`);
    }
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false, `${path} must set additionalProperties:false`);
      const props = Object.keys(node.properties ?? {});
      assert.deepEqual(
        [...(node.required ?? [])].sort(),
        props.sort(),
        `${path} must list every property in "required"`,
      );
    }
    for (const [k, v] of Object.entries(node.properties ?? {})) walk(v, `${path}.${k}`);
    if (node.items) walk(node.items, `${path}[]`);
  };
  walk(WIRE_SCHEMA);
});

test('wire schema offers the model no field to put a price in', () => {
  const json = JSON.stringify(WIRE_SCHEMA);
  for (const word of ['price', 'cost', 'rate', 'total', 'amount', 'margin']) {
    assert.ok(!json.includes(`"${word}`), `wire schema exposes a "${word}" field to the model`);
  }
});
