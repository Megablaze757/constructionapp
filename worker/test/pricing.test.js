import test from 'node:test';
import assert from 'node:assert/strict';

import { priceLine, totalQuote, marginOf, sendBlockers, money } from '../src/pricing.js';

// Mirrors migrations/0002_seed.sql.
const BOOK = new Map([
  ['scaffold_erect',     { code: 'scaffold_erect', description: 'Scaffold erect', category: 'labour', unit: 'm2', unit_cost: 18.5, unit_price: 27 }],
  ['scaffold_hire',      { code: 'scaffold_hire', description: 'Scaffold hire', category: 'plant', unit: 'days', unit_cost: 40, unit_price: 68 }],
  ['scaffold_dismantle', { code: 'scaffold_dismantle', description: 'Dismantle', category: 'labour', unit: 'job', unit_cost: 215, unit_price: 280 }],
  ['gutter_clearance',   { code: 'gutter_clearance', description: 'Gutter clearance', category: 'labour', unit: 'job', unit_cost: 110, unit_price: 180 }],
  ['extra_lift',         { code: 'extra_lift', description: 'Extra lift', category: 'labour', unit: 'job', unit_cost: 140, unit_price: 210 }],
]);

const wireframeQuote = () => [
  { id: 'a', line_code: 'scaffold_erect', quantity: 45, kind: 'base', confirmed: true },
  { id: 'b', line_code: 'scaffold_hire', quantity: 5, kind: 'base', confirmed: true },
  { id: 'c', line_code: 'scaffold_dismantle', quantity: 1, kind: 'base', confirmed: true },
  { id: 'd', line_code: 'gutter_clearance', quantity: 1, kind: 'extra', confirmed: true, selected: false },
  { id: 'e', line_code: 'extra_lift', quantity: 1, kind: 'extra', confirmed: true, selected: false },
].map((l) => priceLine(l, BOOK));

test('seeded demo reproduces the wireframe totals exactly', () => {
  const lines = wireframeQuote();
  const t = totalQuote(lines, { targetMargin: 30, marginFloor: 25 });

  // Wireframe §1.1: £1,215 + £340 + £280 = £1,835 at 32% against a 30% target.
  assert.equal(lines[0].line_price, 1215);
  assert.equal(lines[1].line_price, 340);
  assert.equal(lines[2].line_price, 280);
  assert.equal(t.subtotal_price, 1835);
  assert.equal(t.margin_pct, 32);
  assert.equal(t.meets_target, true);
  assert.equal(t.below_floor, false);
});

test('extras are excluded from the headline total and added live', () => {
  const lines = wireframeQuote();
  let t = totalQuote(lines, { targetMargin: 30, marginFloor: 25 });
  assert.equal(t.subtotal_price, 1835, 'unselected extras must not inflate the base');
  assert.equal(t.total_with_extras, 1835);

  lines.find((l) => l.line_code === 'gutter_clearance').selected = true;
  t = totalQuote(lines, { targetMargin: 30, marginFloor: 25 });
  assert.equal(t.subtotal_price, 1835, 'base price is unchanged by an extra');
  assert.equal(t.total_with_extras, 2015); // 1835 + 180

  lines.find((l) => l.line_code === 'extra_lift').selected = true;
  t = totalQuote(lines, { targetMargin: 30, marginFloor: 25 });
  assert.equal(t.total_with_extras, 2225); // + 210
});

test('a quantity edit reprices from the price book, not from the old total', () => {
  const lines = wireframeQuote();
  lines[0] = priceLine({ ...lines[0], quantity: 60 }, BOOK);
  const t = totalQuote(lines, { targetMargin: 30, marginFloor: 25 });
  assert.equal(lines[0].line_price, 1620); // 60 × 27
  assert.equal(t.subtotal_price, 2240);
});

test('a client-supplied price is ignored — money comes from the price book', () => {
  // The attack this defends against: a tampered request setting its own price.
  const line = priceLine(
    { line_code: 'scaffold_erect', quantity: 45, unit_price: 1, unit_cost: 999, line_price: 1 },
    BOOK,
  );
  assert.equal(line.unit_price, 27);
  assert.equal(line.line_price, 1215);
  assert.equal(line.unit_cost, 18.5);
});

test('an unknown line code is rejected rather than silently priced at zero', () => {
  assert.throws(
    () => priceLine({ line_code: 'helicopter_hire', quantity: 1 }, BOOK),
    /unknown price book code/,
  );
});

test('an owner-entered line with no code carries its own rates', () => {
  const line = priceLine(
    { description: 'Bespoke tower', quantity: 2, unit: 'job', unit_cost: 100, unit_price: 175 },
    BOOK,
  );
  assert.equal(line.line_price, 350);
  assert.equal(line.line_cost, 200);
});

test('margin maths', () => {
  assert.equal(marginOf(1835, 1247.5), 32);
  assert.equal(marginOf(1000, 1000), 0);
  assert.equal(marginOf(1000, 1200), -20);
  assert.equal(marginOf(0, 0), 0, 'an empty quote has no margin rather than NaN');
});

test('money rounds half-up in pennies without float drift', () => {
  assert.equal(money(1.005), 1.01);
  assert.equal(money(0.1 + 0.2), 0.3);
  assert.equal(money(1835.004), 1835);
});

test('send is blocked below the margin floor until an override is recorded', () => {
  const lines = wireframeQuote();
  // A thin-margin bought-in item is what realistically drags a quote under the
  // floor. Every price-book line here carries ~32%, so no change of *quantity*
  // can breach a 25% floor — only a badly-priced line can.
  lines.push(
    priceLine(
      { id: 'f', description: 'Bought-in access platform', quantity: 1, unit: 'job', unit_cost: 800, unit_price: 850, kind: 'base', confirmed: true },
      BOOK,
    ),
  );
  const t = totalQuote(lines, { targetMargin: 30, marginFloor: 25 });
  assert.equal(t.margin_pct, 23.7); // (2685 − 2047.50) / 2685
  assert.equal(t.below_floor, true);

  const quote = { client_name: 'Sarah Higgins' };
  const blocked = sendBlockers(quote, lines, t);
  assert.ok(blocked.some((b) => b.code === 'below_margin_floor'));

  const overridden = sendBlockers({ ...quote, override_reason: 'Repeat client, strategic' }, lines, t);
  assert.equal(overridden.length, 0, 'a recorded reason unblocks the send');
});

test('send is blocked while AI-drafted lines are unconfirmed', () => {
  const lines = wireframeQuote();
  lines[0].confirmed = false;
  const t = totalQuote(lines, { targetMargin: 30, marginFloor: 25 });
  const blockers = sendBlockers({ client_name: 'Sarah Higgins' }, lines, t);
  const blocker = blockers.find((b) => b.code === 'unconfirmed_ai_lines');
  assert.ok(blocker);
  assert.deepEqual(blocker.lines, ['a']);
  assert.equal(blocker.overridable, undefined, 'confirmation is not overridable');
});

test('a below-cost line is named, not just counted', () => {
  const lines = wireframeQuote();
  lines[1] = priceLine(
    { id: 'b', description: 'Discounted hire', quantity: 5, unit_cost: 40, unit_price: 20, kind: 'base', confirmed: true },
    BOOK,
  );
  const t = totalQuote(lines, { targetMargin: 30, marginFloor: 25 });
  assert.deepEqual(t.below_cost_lines, ['Discounted hire']);
});

test('an empty quote cannot be sent', () => {
  const t = totalQuote([], { targetMargin: 30, marginFloor: 25 });
  const blockers = sendBlockers({ client_name: 'X' }, [], t);
  assert.ok(blockers.some((b) => b.code === 'no_line_items'));
});
