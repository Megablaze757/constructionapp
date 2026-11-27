/**
 * Importing the owner's own quote.
 *
 * This writes to the price book, which every future quote is costed from, so
 * most of what is tested is what it refuses: to invent a cost, to resolve
 * arithmetic that does not add up, or to treat a VAT line as work.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseQuoteLines, applyMargin, validateImport, toTemplateAndPriceBook, jobTypeFrom, KNOWN_UNITS,
} from '../src/quote-import.js';

/** Exactly what web/assets/js/plans.js extracts from e2e/fixtures/their-quote.pdf. */
const THEIR_QUOTE = 'HIGGINS SCAFFOLDING LTD - QUOTATION 1042 '
  + 'Site: 14 Elm Street, Dudley Date: 12 March 2026 '
  + 'Erect access scaffold to rear elevation, two lifts 45 m2 1215.00 '
  + 'Scaffold hire, five days 5 days 340.00 '
  + 'Dismantle and remove from site 1 job 280.00 '
  + 'Debris netting to rear elevation 45 m2 135.00 '
  + 'Subtotal 1970.00 VAT at 20% 394.00 Total 2364.00 '
  + 'Payment due 14 days from invoice. Scaffold remains our property throughout hire. '
  + 'Excludes road closure permits, ground works and out-of-hours access.';

const byDesc = (lines, re) => lines.find((l) => re.test(l.description));

/* ------------------------------------------------------------- parsing */

test('it reads the work items out of a real quote', () => {
  const { lines } = parseQuoteLines(THEIR_QUOTE);
  assert.equal(lines.length, 4, `expected 4 work items, got ${lines.length}: ${lines.map((l) => l.description).join(' | ')}`);

  const erect = byDesc(lines, /Erect access scaffold/);
  assert.equal(erect.quantity, 45);
  assert.equal(erect.unit, 'm2');
  assert.equal(erect.line_total, 1215);
  assert.equal(erect.unit_price, 27, '£1215 over 45m² is £27 a metre');
  assert.equal(erect.consistent, true);
});

test('a quoted duration keeps its own unit', () => {
  const { lines } = parseQuoteLines(THEIR_QUOTE);
  const hire = byDesc(lines, /Scaffold hire/);
  assert.equal(hire.quantity, 5);
  assert.equal(hire.unit, 'days');
  assert.equal(hire.unit_price, 68);
});

test('subtotal, VAT and total are recorded, never treated as work', () => {
  const { lines, totals } = parseQuoteLines(THEIR_QUOTE);
  assert.equal(totals.subtotal, 1970);
  assert.equal(totals.vat, 394);
  assert.equal(totals.total, 2364);
  // Word-bounded: "elevation" contains "vat", which an unanchored test would
  // flag on every scaffold line.
  assert.ok(!lines.some((l) => /\b(?:vat|sub-?total|total)\b/i.test(l.description)),
    `a totals line was imported as work: ${lines.map((l) => l.description).join(' | ')}`);
});

test('the parsed work items add up to the quote\'s own subtotal', () => {
  const { lines, totals } = parseQuoteLines(THEIR_QUOTE);
  const sum = lines.reduce((t, l) => t + l.line_total, 0);
  assert.equal(sum, totals.subtotal, `lines total ${sum}, quote says ${totals.subtotal}`);
});

test('a rate and a total together are read as rate then total', () => {
  const { lines } = parseQuoteLines('Erect scaffold to side elevation 30 m2 27.00 810.00');
  assert.equal(lines[0].unit_price, 27);
  assert.equal(lines[0].line_total, 810);
  assert.equal(lines[0].consistent, true);
});

test('arithmetic that does not add up is reported, not resolved', () => {
  // 30 × 27 is 810, not 1000. Neither figure is silently preferred.
  const { lines } = parseQuoteLines('Erect scaffold to side elevation 30 m2 27.00 1000.00');
  assert.equal(lines[0].consistent, false);
  assert.match(lines[0].note, /Check which is right/);
  assert.equal(lines[0].unit_price, 27, 'what the document said is kept as read');
  assert.equal(lines[0].line_total, 1000);
});

test('an unfamiliar unit is skipped rather than mapped to a familiar one', () => {
  const { lines, skipped } = parseQuoteLines('Supply decorative finials 6 widgets 240.00');
  assert.equal(lines.length, 0);
  assert.equal(skipped.length, 1, 'and the owner is shown what was not understood');
});

test('weeks are read as weeks and stored as days', () => {
  const { lines } = parseQuoteLines('Scaffold hire 2 weeks 952.00');
  assert.equal(lines[0].unit, 'days');
  assert.equal(lines[0].quantity, 14);
  assert.equal(lines[0].unit_price, 68);
});

/* ------------------------------------------------------------- the cost gate */

test('nothing imports with no cost — a quote states price, not cost', () => {
  const { lines } = parseQuoteLines(THEIR_QUOTE);
  assert.ok(lines.every((l) => l.unit_cost === null), 'cost must not be read from a quote');

  const res = validateImport({ job_type: 'domestic_scaffold_erect', name: 'Theirs', lines });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /has no cost/.test(e)), res.errors.join('; '));
});

test('a typical margin fills cost in, and says it was derived', () => {
  const { lines } = parseQuoteLines(THEIR_QUOTE);
  const costed = applyMargin(lines, 30);
  const erect = byDesc(costed, /Erect access scaffold/);
  assert.equal(erect.unit_cost, 18.9, '£27 at 30% margin costs £18.90');
  assert.equal(erect.cost_source, 'derived_from_margin',
    'it came from a figure the owner gave, not from their quote');
  assert.equal(validateImport({ job_type: 'x_job', name: 'Theirs', lines: costed }).ok, true);
});

test('an owner-entered cost is left alone by the margin pass', () => {
  const lines = [{ description: 'Hire', unit: 'days', quantity: 5, unit_price: 68, line_total: 340, unit_cost: 40, cost_source: 'owner_entered' }];
  assert.equal(applyMargin(lines, 30)[0].unit_cost, 40);
});

test('a nonsense margin is refused outright', () => {
  for (const bad of [-5, 100, 120, 'lots', NaN]) {
    assert.throws(() => applyMargin([], bad), /between 0 and 99/);
  }
});

test('a line that costs more than it sells for is refused', () => {
  const lines = [{ description: 'Loss leader', unit: 'job', quantity: 1, unit_price: 100, line_total: 100, unit_cost: 150, cost_source: 'owner_entered' }];
  const res = validateImport({ job_type: 'x_job', name: 'T', lines });
  assert.equal(res.ok, false);
  assert.ok(res.errors.some((e) => /costs more than it sells for/.test(e)));
});

/* ------------------------------------------------- template + price book */

test('it produces a price book and a template that references it', () => {
  const { lines } = parseQuoteLines(THEIR_QUOTE);
  const imported = { job_type: 'domestic_scaffold_erect', name: 'Higgins Scaffold', lines: applyMargin(lines, 30) };
  assert.equal(validateImport(imported).ok, true);

  const { price_book: book, template } = toTemplateAndPriceBook(imported);
  assert.equal(book.length, 4);
  assert.equal(template.line_items.length, 4);

  // Every template line must resolve against the book, or quotes cannot price.
  const codes = new Set(book.map((p) => p.code));
  for (const li of template.line_items) {
    assert.ok(codes.has(li.line_code), `template references ${li.line_code}, not in the book`);
  }
  for (const p of book) assert.ok(KNOWN_UNITS.includes(p.unit));

  const erect = book.find((p) => /Erect access/.test(p.description));
  assert.equal(erect.unit_price, 27);
  assert.equal(erect.unit_cost, 18.9);
  assert.match(erect.code, /^erect_access_scaffold/);
  assert.equal(template.line_items.find((l) => l.line_code === erect.code).default_quantity, 45,
    'their own quantity becomes the template default');
});

test('two lines with the same wording get distinct codes', () => {
  const imported = {
    job_type: 'x_job',
    name: 'T',
    lines: applyMargin(parseQuoteLines('Extra lift 1 job 210.00 Extra lift 1 job 210.00').lines, 25),
  };
  const { price_book: book } = toTemplateAndPriceBook(imported);
  assert.equal(new Set(book.map((p) => p.code)).size, book.length, 'codes must be unique');
});

test('imported lines are not guessed into a category', () => {
  const imported = { job_type: 'x_job', name: 'T', lines: applyMargin(parseQuoteLines(THEIR_QUOTE).lines, 30) };
  const { price_book: book } = toTemplateAndPriceBook(imported);
  assert.ok(book.every((p) => p.category === 'other'),
    'guessing category from wording would skew the cost breakdown silently');
});

/* ------------------------------------------------------------- job type */

test('the job type comes from the quote\'s own wording', () => {
  assert.equal(jobTypeFrom('Domestic re-roof to semi-detached house'), 'domestic_reroof');
  assert.equal(jobTypeFrom('Erect access scaffold, house rear elevation'), 'domestic_scaffold');
  assert.equal(jobTypeFrom('Commercial scaffold, office block'), 'scaffold');
  assert.equal(jobTypeFrom('Miscellaneous works'), 'general_works');
});
