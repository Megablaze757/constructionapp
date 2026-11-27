/**
 * The rule-based rung of the drafting ladder.
 *
 * Most of what matters here is what it refuses to do. A parser that cheerfully
 * assigns every number it finds to the nearest line is worse than no parser,
 * because it produces a quote that looks estimated and is not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ruleDraft, extractQuantities, unmatchedQuantities } from '../src/rule-draft.js';
import { validateDraft } from '../src/schema.js';

const SCAFFOLD = {
  job_type: 'domestic_scaffold_erect',
  line_items: [
    { line_code: 'scaffold_erect', description: 'Scaffold erect', unit: 'm2', default_quantity: 40, always_include: true },
    { line_code: 'scaffold_hire', description: 'Scaffold hire', unit: 'days', default_quantity: 7, always_include: true },
    { line_code: 'scaffold_dismantle', description: 'Dismantle', unit: 'job', default_quantity: 1, always_include: true },
  ],
};

/** Two m² lines, so a bare "45 m2" is genuinely ambiguous. */
const REROOF = {
  job_type: 'domestic_reroof',
  line_items: [
    { line_code: 'roof_strip', description: 'Strip existing roof covering', unit: 'm2', default_quantity: 60, always_include: true },
    { line_code: 'roof_tile', description: 'Re-tile roof', unit: 'm2', default_quantity: 60, always_include: true },
    { line_code: 'waste_removal', description: 'Waste removal', unit: 'job', default_quantity: 1, always_include: true },
  ],
};

const codes = (t) => new Set(t.line_items.map((li) => li.line_code));
const line = (draft, code) => draft.line_items.find((l) => l.line_code === code);

const SPOKEN = "Right, this is the Elm Street job. Rear of the house, scaffold for "
  + "the roofers, probably two lifts, they'll be up there about five days.";

/* ------------------------------------------------------------- extraction */

test('reads spoken and written numbers with their units', () => {
  assert.deepEqual(
    extractQuantities('about five days').map((q) => [q.value, q.unit]),
    [[5, 'days']],
  );
  assert.deepEqual(
    extractQuantities('45 m2 of scaffold').map((q) => [q.value, q.unit]),
    [[45, 'm2']],
  );
  assert.deepEqual(
    extractQuantities('roughly 32.5 square metres').map((q) => [q.value, q.unit]),
    [[32.5, 'm2']],
  );
});

test('a couple of weeks is fourteen days', () => {
  assert.deepEqual(
    extractQuantities('on for a couple of weeks').map((q) => [q.value, q.unit]),
    [[14, 'days']],
  );
});

test('numbers whose unit means nothing to the price book are kept separate', () => {
  const unmatched = unmatchedQuantities(SPOKEN).map((u) => u.noun);
  assert.ok(unmatched.includes('lifts'), `"two lifts" should be unmatched, got ${JSON.stringify(unmatched)}`);
  assert.ok(!unmatched.includes('days'), 'days is a real unit and must not be reported as unmatched');
});

/* ----------------------------------------------------------------- drafting */

test('it produces something the contract accepts', () => {
  const { ok, draft } = ruleDraft(SPOKEN, SCAFFOLD);
  assert.equal(ok, true);
  const checked = validateDraft(draft, codes(SCAFFOLD), { photosProvided: false });
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
});

test('the stated duration lands on the only line priced in days', () => {
  const { draft } = ruleDraft(SPOKEN, SCAFFOLD);
  const hire = line(draft, 'scaffold_hire');
  assert.equal(hire.quantity_estimate, 5);
  assert.equal(hire.source, 'explicit_in_description');
  assert.equal(hire.confidence, 'high');
  assert.match(hire.note, /five days/);
});

test('"two lifts" never becomes a quantity — the trap a small model fell into', () => {
  const { draft } = ruleDraft(SPOKEN, SCAFFOLD);
  // The 0.5B model turned "two lifts" into scaffold_erect: 5 building and
  // scaffold_hire: 2 day. Neither number may move off its own unit.
  const erect = line(draft, 'scaffold_erect');
  assert.equal(erect.quantity_estimate, 40, 'm² must stay the template default');
  assert.equal(erect.source, 'template_default');
  assert.notEqual(line(draft, 'scaffold_hire').quantity_estimate, 2);
  assert.match(draft.flags_for_owner_review.join(' '), /two lifts/,
    'and the owner is told the phrase was noticed and not used');
});

test('a distinctive word resolves a shared unit, but only at medium confidence', () => {
  // Both m² lines say "roof", so "roof" decides nothing; "strip" and "covering"
  // belong to one line only, so they do.
  const { draft } = ruleDraft('Strip the old covering off the roof, about 45 m2', REROOF);
  const strip = line(draft, 'roof_strip');
  const tile = line(draft, 'roof_tile');
  assert.equal(strip.quantity_estimate, 45, 'the named line takes the figure');
  assert.equal(strip.source, 'explicit_in_description');
  assert.equal(strip.confidence, 'medium', 'but not with high confidence — the unit was shared');
  assert.match(strip.note, /more than one line is priced in m2/);
  assert.equal(tile.quantity_estimate, 60, 'the unnamed one keeps its default');
  assert.equal(tile.source, 'template_default');
});

test('when both same-unit lines are named, it refuses rather than picks', () => {
  const { draft } = ruleDraft('Strip and re-tile, call it 45 m2', REROOF);
  for (const code of ['roof_strip', 'roof_tile']) {
    assert.equal(line(draft, code).source, 'template_default',
      'naming both candidates is ambiguous, so neither takes the figure');
    assert.equal(line(draft, code).quantity_estimate, 60);
  }
});

test('with two same-unit lines and neither named, no figure is assigned', () => {
  const { draft } = ruleDraft('Job is about 45 m2 all in', REROOF);
  for (const code of ['roof_strip', 'roof_tile']) {
    assert.equal(line(draft, code).source, 'template_default');
    assert.equal(line(draft, code).quantity_estimate, 60);
  }
});

test('every unread line says so, and holds the send gate', () => {
  const { draft } = ruleDraft('No numbers in this one at all', SCAFFOLD);
  for (const l of draft.line_items) {
    assert.equal(l.source, 'template_default');
    assert.notEqual(l.confidence, 'high', 'a default cannot be high confidence');
    assert.match(l.note, /template|Check/i);
  }
  assert.equal(validateDraft(draft, codes(SCAFFOLD), {}).ok, true);
});

test('it never claims to have estimated anything', () => {
  const { draft } = ruleDraft(SPOKEN, SCAFFOLD);
  assert.ok(!draft.line_items.some((l) => l.source === 'ai_inferred'),
    'pattern matching is not inference and must not borrow its label');
  assert.ok(!draft.line_items.some((l) => l.source === 'photo_inferred'));
  assert.match(draft.flags_for_owner_review.join(' '), /matched by pattern, not estimated/);
});

test('an empty template is a reported failure, not an empty quote', () => {
  const res = ruleDraft('five days', { job_type: 'x', line_items: [] });
  assert.equal(res.ok, false);
  assert.match(res.error, /no line items/);
});

test('a template with no default is a placeholder, not a figure', () => {
  // The seeded scaffold template stores null for m² on purpose: it depends on
  // the building. 1m² of scaffold prices at £27, so this must not read as the
  // template's opinion of the job.
  const noDefault = {
    job_type: 'domestic_scaffold_erect',
    line_items: [
      { line_code: 'scaffold_erect', description: 'Scaffold erect', unit: 'm2', default_quantity: null, always_include: true },
      { line_code: 'scaffold_hire', description: 'Scaffold hire', unit: 'days', default_quantity: 7, always_include: true },
    ],
  };
  const { draft } = ruleDraft('No numbers here', noDefault);

  const erect = line(draft, 'scaffold_erect');
  assert.equal(erect.quantity_estimate, 1, 'the contract needs a positive quantity');
  assert.match(erect.note, /Placeholder only/);
  assert.match(erect.note, /Measure it before sending/);

  const hire = line(draft, 'scaffold_hire');
  assert.match(hire.note, /template's own figure/, 'a real default is described as one');
  assert.doesNotMatch(hire.note, /Placeholder/);

  assert.match(draft.flags_for_owner_review.join(' '), /No figure at all for Scaffold erect \(m2\)/);
  assert.equal(validateDraft(draft, codes(noDefault), {}).ok, true);
});

test('a line read from the description is never called a placeholder', () => {
  const { draft } = ruleDraft('About 45 m2, on for five days', SCAFFOLD);
  assert.doesNotMatch(draft.flags_for_owner_review.join(' '), /No figure at all/);
  assert.equal(line(draft, 'scaffold_erect').quantity_estimate, 45);
});
