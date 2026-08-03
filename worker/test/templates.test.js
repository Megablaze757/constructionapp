import test from 'node:test';
import assert from 'node:assert/strict';

import { suggestTemplates, signatureOf, median } from '../src/templates.js';

const line = (code, quantity, price, cost) => ({
  line_code: code,
  description: code.replace(/_/g, ' '),
  unit: 'm2',
  quantity,
  kind: 'base',
  line_price: price,
  line_cost: cost,
});

const quote = (id, codes, client = 'A. Client', job_type = 'ad_hoc') => ({
  id,
  job_type,
  client_name: client,
  lines: codes.map(([c, q]) => line(c, q, q * 30, q * 20)),
});

const EXISTING = [{
  name: 'Domestic Scaffold Erect',
  job_type: 'domestic_scaffold_erect',
  line_items: [
    { line_code: 'scaffold_erect', always_include: true },
    { line_code: 'scaffold_hire', always_include: true },
    { line_code: 'scaffold_dismantle', always_include: true },
    { line_code: 'permit_road', always_include: false },
  ],
}];

test('signature ignores order and duplicates', () => {
  assert.equal(signatureOf(['b', 'a']), signatureOf(['a', 'b']));
  assert.equal(signatureOf(['a', 'a', 'b']), 'a+b');
  assert.equal(signatureOf([null, undefined, 'a']), 'a');
  assert.equal(signatureOf([]), '');
});

test('median resists one freak job', () => {
  assert.equal(median([40, 45, 50]), 45);
  assert.equal(median([40, 45, 50, 200]), 47.5);
  assert.equal(median([]), 0);
});

test('a repeated shape with no template becomes a suggestion', () => {
  const quotes = [
    quote('1', [['roof_strip', 60], ['roof_tile', 60], ['waste_removal', 1]]),
    quote('2', [['roof_strip', 50], ['roof_tile', 50], ['waste_removal', 1]]),
    quote('3', [['roof_strip', 70], ['roof_tile', 70], ['waste_removal', 1]]),
  ];
  const [s] = suggestTemplates(quotes, EXISTING);
  assert.ok(s, 'expected a suggestion');
  assert.equal(s.quotes, 3);
  assert.equal(s.signature, 'roof_strip+roof_tile+waste_removal');
  assert.equal(s.line_items.length, 3);
  const strip = s.line_items.find((l) => l.line_code === 'roof_strip');
  assert.equal(strip.default_quantity, 60, 'median of 50/60/70');
  assert.equal(strip.always_include, true);
});

test('a shape an existing template already produces is not suggested', () => {
  const codes = [['scaffold_erect', 45], ['scaffold_hire', 5], ['scaffold_dismantle', 1]];
  const quotes = [quote('1', codes), quote('2', codes), quote('3', codes), quote('4', codes)];
  assert.deepEqual(suggestTemplates(quotes, EXISTING), []);
});

test('a shape is only "covered" by a template\'s always-include lines', () => {
  // Adding the template's optional permit line makes a genuinely different shape,
  // so it is fair to suggest it as its own template.
  const codes = [
    ['scaffold_erect', 45], ['scaffold_hire', 5], ['scaffold_dismantle', 1], ['permit_road', 1],
  ];
  const quotes = [quote('1', codes), quote('2', codes), quote('3', codes)];
  const [s] = suggestTemplates(quotes, EXISTING);
  assert.ok(s);
  assert.ok(s.signature.includes('permit_road'));
});

test('an occasional combination is not a pattern', () => {
  const quotes = [
    quote('1', [['roof_strip', 60], ['roof_tile', 60]]),
    quote('2', [['roof_strip', 50], ['roof_tile', 50]]),
  ];
  assert.deepEqual(suggestTemplates(quotes, EXISTING), [], 'two quotes is a coincidence');
  assert.equal(suggestTemplates(quotes, EXISTING, { minQuotes: 2 }).length, 1);
});

test('extras do not change a quote\'s shape', () => {
  const withExtra = (id) => {
    const q = quote(id, [['roof_strip', 60], ['roof_tile', 60]]);
    q.lines.push({ ...line('gutter_clearance', 1, 180, 110), kind: 'extra' });
    return q;
  };
  const [s] = suggestTemplates([withExtra('1'), withExtra('2'), withExtra('3')], EXISTING);
  assert.equal(s.signature, 'roof_strip+roof_tile');
  assert.ok(!s.line_items.some((l) => l.line_code === 'gutter_clearance'));
});

test('suggested margin comes from what the business actually achieves', () => {
  // 30/unit price against 20/unit cost is a 33.3% margin.
  const quotes = [
    quote('1', [['roof_strip', 60], ['roof_tile', 60]]),
    quote('2', [['roof_strip', 50], ['roof_tile', 50]]),
    quote('3', [['roof_strip', 70], ['roof_tile', 70]]),
  ];
  const [s] = suggestTemplates(quotes, EXISTING);
  assert.equal(s.observed_margin, 33.3);
  // Floored, so the target is not set to an unrepeatable best case.
  assert.equal(s.suggested_margin, 33);
});

test('suggestions are ranked by how often the shape recurs', () => {
  const common = [['roof_strip', 60], ['roof_tile', 60]];
  const rarer = [['labourer_day', 2], ['waste_removal', 1]];
  const quotes = [
    ...[1, 2, 3, 4, 5].map((i) => quote(`c${i}`, common)),
    ...[1, 2, 3].map((i) => quote(`r${i}`, rarer)),
  ];
  const s = suggestTemplates(quotes, EXISTING);
  assert.equal(s.length, 2);
  assert.equal(s[0].quotes, 5);
  assert.equal(s[1].quotes, 3);
});

test('a suggestion carries names an owner will recognise', () => {
  const quotes = [1, 2, 3].map((i) =>
    quote(String(i), [['roof_strip', 60], ['roof_tile', 60]], `Client ${i}`));
  const [s] = suggestTemplates(quotes, EXISTING);
  assert.equal(s.suggested_name, 'roof strip + roof tile');
  assert.match(s.suggested_job_type, /^[a-z0-9_]+$/);
  assert.deepEqual(s.examples, ['Client 1', 'Client 2', 'Client 3']);
});

test('quotes with no priced lines are ignored rather than grouped as empty', () => {
  const empty = { id: 'x', job_type: 'ad_hoc', client_name: 'X', lines: [] };
  assert.deepEqual(suggestTemplates([empty, empty, empty], EXISTING), []);
});
