import test from 'node:test';
import assert from 'node:assert/strict';

import {
  variancePct, jobVariance, byJobType, lineCodeBias, biasBriefing, summarise,
} from '../src/variance.js';

const job = (over = {}) => ({
  id: 'job_1',
  client_name: 'M. Okafor',
  site_address: '22 Vine Rd',
  job_type: 'domestic_scaffold_erect',
  status: 'complete',
  completed_at: '2026-05-14',
  budget_baseline: 1780,
  cost_baseline: 1390,
  ...over,
});

const cost = (amount, line_code = null, job_id = 'job_1') => ({ job_id, line_code, amount });

test('variance percentage, including the zero-baseline case', () => {
  assert.equal(variancePct(1000, 1100), 10);
  assert.equal(variancePct(1000, 900), -10);
  assert.equal(variancePct(1390, 1440), 3.6);
  // A £0 baseline has no meaningful percentage; Infinity or "100% over" would be
  // noise on the report rather than signal.
  assert.equal(variancePct(0, 500), null);
});

test('a job that came in over budget loses margin, pound for pound', () => {
  const v = jobVariance(job(), [cost(932), cost(280), cost(228)]);
  assert.equal(v.actual_cost, 1440);
  assert.equal(v.quoted_cost, 1390);
  assert.equal(v.cost_variance, 50);
  assert.equal(v.cost_variance_pct, 3.6);
  assert.equal(v.quoted_margin, 21.9);
  assert.equal(v.actual_margin, 19.1);
  // Price is fixed at acceptance, so the overrun comes straight off the margin.
  assert.equal(v.margin_lost, 2.8);
});

test('a job under budget shows negative variance and gains margin', () => {
  const v = jobVariance(job(), [cost(1200)]);
  assert.equal(v.cost_variance, -190);
  assert.ok(v.cost_variance_pct < 0);
  assert.ok(v.actual_margin > v.quoted_margin);
  assert.ok(v.margin_lost < 0);
});

test('a job with no costs booked reads as zero actual, not as an error', () => {
  const v = jobVariance(job(), []);
  assert.equal(v.actual_cost, 0);
  assert.equal(v.cost_entries, 0);
  // The report filters these out; the function itself stays honest about it.
  assert.equal(v.cost_variance, -1390);
});

test('job-type rollup weights by value, not by count', () => {
  const rows = [
    // One small job wildly over...
    jobVariance(job({ id: 'a', budget_baseline: 200, cost_baseline: 100 }), [cost(180, null, 'a')]),
    // ...and one large job exactly on budget.
    jobVariance(job({ id: 'b', budget_baseline: 20000, cost_baseline: 14000 }), [cost(14000, null, 'b')]),
  ];
  const [group] = byJobType(rows);
  assert.equal(group.jobs, 2);
  assert.equal(group.quoted_cost, 14100);
  assert.equal(group.actual_cost, 14180);
  // A mean of percentages would report (+80% + 0%) / 2 = +40%, which would be a
  // wildly misleading headline for a portfolio that came in 0.6% over.
  assert.equal(group.cost_variance_pct, 0.6);
  assert.equal(group.jobs_over_budget, 1);
});

test('groups sort by the size of the variance, largest first', () => {
  const rows = [
    jobVariance(job({ id: 'a', job_type: 'reroof', cost_baseline: 1000 }), [cost(1050, null, 'a')]),
    jobVariance(job({ id: 'b', job_type: 'scaffold', cost_baseline: 1000 }), [cost(1600, null, 'b')]),
  ];
  assert.deepEqual(byJobType(rows).map((g) => g.job_type), ['scaffold', 'reroof']);
});

test('line-code bias needs repeated observations before it reports', () => {
  const quoted = [
    { job_id: 'j1', line_code: 'scaffold_erect', description: 'Scaffold erect', line_cost: 800 },
    { job_id: 'j2', line_code: 'scaffold_erect', description: 'Scaffold erect', line_cost: 600 },
    { job_id: 'j1', line_code: 'scaffold_hire', description: 'Scaffold hire', line_cost: 280 },
  ];
  const actuals = [
    cost(932, 'scaffold_erect', 'j1'),
    cost(624, 'scaffold_erect', 'j2'),
    cost(300, 'scaffold_hire', 'j1'),
  ];

  const bias = lineCodeBias(quoted, actuals, { minJobs: 2 });
  assert.equal(bias.length, 1, 'hire appears on only one job, so it is not yet a pattern');
  assert.equal(bias[0].line_code, 'scaffold_erect');
  assert.equal(bias[0].jobs, 2);
  assert.equal(bias[0].quoted_cost, 1400);
  assert.equal(bias[0].actual_cost, 1556);
  assert.equal(bias[0].variance_pct, 11.1);
});

test('a job quoted but never costed does not read as a huge underspend', () => {
  const quoted = [
    { job_id: 'j1', line_code: 'scaffold_erect', description: 'Erect', line_cost: 800 },
    { job_id: 'j2', line_code: 'scaffold_erect', description: 'Erect', line_cost: 800 },
    // j3 was quoted but nobody booked costs against it.
    { job_id: 'j3', line_code: 'scaffold_erect', description: 'Erect', line_cost: 800 },
  ];
  const actuals = [cost(820, 'scaffold_erect', 'j1'), cost(830, 'scaffold_erect', 'j2')];

  const [row] = lineCodeBias(quoted, actuals, { minJobs: 2 });
  assert.equal(row.jobs, 2, 'only jobs with both a quote and actuals are counted');
  // Both sides must cover the same two jobs: £1,600 quoted vs £1,650 actual.
  // Including j3's £800 on the quoted side alone would report a fictional 31%
  // underspend instead of the real 3% overrun.
  assert.equal(row.quoted_cost, 1600);
  assert.equal(row.actual_cost, 1650);
  assert.equal(row.variance_pct, 3.1);
});

test('briefing reports only material bias, and reads like site advice', () => {
  const bias = [
    { line_code: 'scaffold_erect', description: 'Scaffold erect', jobs: 4, variance_pct: 11.1 },
    { line_code: 'scaffold_hire', description: 'Scaffold hire', jobs: 3, variance_pct: 1.2 },
  ];
  const brief = biasBriefing(bias, { threshold: 5 });
  assert.equal(brief.length, 1, '1.2% is noise, not a bias worth acting on');
  assert.match(brief[0], /Scaffold erect \(scaffold_erect\) has run 11\.1% over/);
  assert.match(brief[0], /scope this line generously/);
  assert.match(brief[0], /across 4 completed jobs/);
});

test('advice follows the direction of the bias', () => {
  const [under] = biasBriefing([
    { line_code: 'waste_removal', description: 'Waste removal', jobs: 3, variance_pct: -14 },
  ]);
  assert.match(under, /has run 14% under/);
  // Telling the assistant to "scope generously" a line that consistently comes
  // in under would push estimates further from reality.
  assert.match(under, /over-scoped it/);
  assert.doesNotMatch(under, /scope this line generously/);
});

test('portfolio summary tracks the spec target of variance within 10%', () => {
  const rows = [
    jobVariance(job({ id: 'a', cost_baseline: 1000, budget_baseline: 1500 }), [cost(1050, null, 'a')]),  // +5%
    jobVariance(job({ id: 'b', cost_baseline: 1000, budget_baseline: 1500 }), [cost(1400, null, 'b')]),  // +40%
    jobVariance(job({ id: 'c', cost_baseline: 1000, budget_baseline: 1500 }), [cost(920, null, 'c')]),   // −8%
  ];
  const s = summarise(rows);
  assert.equal(s.jobs, 3);
  assert.equal(s.jobs_within_10pct, 2);
  assert.equal(s.jobs_over_budget, 2);
  assert.equal(s.actual_cost, 3370);
  assert.equal(s.cost_variance, 370);
  assert.equal(s.cost_variance_pct, 12.3);
  assert.ok(s.margin_lost > 0, 'cost overruns show as margin lost');
});
