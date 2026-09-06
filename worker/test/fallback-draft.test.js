/**
 * The template fallback exists so the app works before any AI is connected.
 * Its whole value depends on it never being mistaken for an estimate, so most
 * of what is tested here is what it refuses to claim.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { templateDraft } from '../src/fallback-draft.js';
import { validateDraft } from '../src/schema.js';

const TEMPLATE = {
  job_type: 'domestic_scaffold_erect',
  line_items: [
    { line_code: 'scaffold_erect', description: 'Scaffold erect', unit: 'm2', default_quantity: 40, always_include: true },
    { line_code: 'scaffold_hire', description: 'Scaffold hire', unit: 'days', default_quantity: 7, always_include: true },
    { line_code: 'debris_netting', description: 'Debris netting', unit: 'm2', default_quantity: 40 },
  ],
};

const codes = (t) => new Set(t.line_items.map((li) => li.line_code));

test('it produces something the same contract accepts', () => {
  const { ok, draft } = templateDraft(TEMPLATE);
  assert.equal(ok, true);
  const checked = validateDraft(draft, codes(TEMPLATE), { photosProvided: false });
  assert.equal(checked.ok, true, JSON.stringify(checked.errors));
});

test('every line is template_default — nothing claims to have been estimated', () => {
  const { draft } = templateDraft(TEMPLATE);
  for (const li of draft.line_items) {
    assert.equal(li.source, 'template_default');
    assert.notEqual(li.confidence, 'high', 'an unread description cannot be high confidence');
    assert.match(li.note, /not read|no AI/i, 'each line says why it is a guess');
  }
});

test('it says plainly that the description was never read', () => {
  const { draft } = templateDraft(TEMPLATE);
  assert.match(draft.assumptions.join(' '), /Nothing was read from your description/);
  assert.match(draft.flags_for_owner_review.join(' '), /no AI/i);
});

test('optional lines are left out — that is the estimator\'s call, not a default', () => {
  const { draft } = templateDraft(TEMPLATE);
  assert.deepEqual(draft.line_items.map((l) => l.line_code), ['scaffold_erect', 'scaffold_hire']);
});

test('a template with nothing compulsory falls back to all of it', () => {
  const optional = { ...TEMPLATE, line_items: TEMPLATE.line_items.map((li) => ({ ...li, always_include: false })) };
  const { draft } = templateDraft(optional);
  assert.equal(draft.line_items.length, 3);
});

test('a missing or zero default quantity becomes one, never zero', () => {
  const thin = {
    job_type: 'x_job',
    line_items: [
      { line_code: 'a', description: 'A', unit: 'ea', always_include: true },
      { line_code: 'b', description: 'B', unit: 'ea', default_quantity: 0, always_include: true },
    ],
  };
  const { draft } = templateDraft(thin);
  assert.deepEqual(draft.line_items.map((l) => l.quantity_estimate), [1, 1]);
  // A zero-quantity line is rejected by the contract, so this is what stops an
  // incomplete template producing an unusable draft.
  assert.equal(validateDraft(draft, codes(thin), {}).ok, true);
});

test('an empty template is a reported failure, not an empty quote', () => {
  const res = templateDraft({ job_type: 'x', line_items: [] });
  assert.equal(res.ok, false);
  assert.match(res.error, /no line items/);
});
