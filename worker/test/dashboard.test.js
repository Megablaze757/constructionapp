import test from 'node:test';
import assert from 'node:assert/strict';

import { scorePerson, reliabilityBoard, reliabilityConcerns, MIN_SAMPLE } from '../src/reliability.js';
import { atRiskJobs, jobProgress, cashForecast, marginHealth } from '../src/dashboard.js';

const TODAY = '2026-08-04';

const person = (over = {}) => ({ id: 'p1', name: 'Dave Mullen', kind: 'subcontractor', role: 'site lead', ...over });

const task = (over = {}) => ({
  id: 't', status: 'done', due_on: '2026-07-20', completed_at: '2026-07-19T10:00:00Z',
  needs_photo: 0, photo_id: null, grace_days: 2, ...over,
});

/* ---------------------------------------------------------- reliability */

test('a reliable person scores high on what is actually measured', () => {
  const s = scorePerson(person(), [
    task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' }),
    task({ id: 'd', needs_photo: 1, photo_id: 'ph1' }),
  ], TODAY);
  assert.equal(s.tasks_assigned, 4);
  assert.equal(s.on_time_rate, 100);
  assert.equal(s.escalation_rate, 0);
  assert.equal(s.proof_rate, 100);
  assert.equal(s.score, 100);
});

test('missing deadlines is what hurts the score most', () => {
  const s = scorePerson(person(), [
    task({ id: 'a', completed_at: '2026-07-25T10:00:00Z' }),   // 5 days late
    task({ id: 'b', completed_at: '2026-07-28T10:00:00Z' }),   // late
    task({ id: 'c' }),                                          // on time
  ], TODAY);
  assert.equal(s.on_time_rate, 33.3);
  // On-time carries 50 of the weight, so a third of deadlines hit lands well down.
  assert.ok(s.score < 70, `score was ${s.score}`);
});

test('a task ticked without its photo counts as neither done nor proven', () => {
  const s = scorePerson(person(), [
    task({ id: 'a' }), task({ id: 'b' }),
    task({ id: 'c', needs_photo: 1, photo_id: null }),
  ], TODAY);
  assert.equal(s.tasks_done, 2, 'the unproven one is not done');
  assert.equal(s.proof_required, 1);
  assert.equal(s.proof_supplied, 0);
  assert.equal(s.proof_rate, 0);
});

test('a task still sitting open past grace counts as an escalation', () => {
  const s = scorePerson(person(), [
    task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' }),
    task({ id: 'd', status: 'open', due_on: '2026-07-01', completed_at: null }),
  ], TODAY);
  assert.equal(s.escalations, 1);
  assert.equal(s.escalation_rate, 25);
});

test('too small a sample gives no score at all, not an average one', () => {
  const s = scorePerson(person(), [task({ id: 'a' }), task({ id: 'b' })], TODAY);
  assert.equal(s.tasks_assigned, 2);
  assert.equal(s.score, null, 'below the minimum sample');
  assert.match(s.sample_note, new RegExp(`${MIN_SAMPLE} assigned tasks`));
});

test('someone with no deadlines to hit is not scored on guesswork', () => {
  const s = scorePerson(person(), [
    task({ id: 'a', due_on: null }), task({ id: 'b', due_on: null }), task({ id: 'c', due_on: null }),
  ], TODAY);
  assert.equal(s.on_time_rate, null);
  assert.equal(s.score, null);
});

test('never being given a photo-proof task does not penalise anyone', () => {
  const withProof = scorePerson(person(), [
    task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' }),
    task({ id: 'd', needs_photo: 1, photo_id: 'ph' }),
  ], TODAY);
  const withoutProof = scorePerson(person(), [
    task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' }),
  ], TODAY);
  // The weight is re-normalised over the parts that exist.
  assert.equal(withoutProof.score, withProof.score);
  assert.equal(withoutProof.proof_rate, null);
});

test('the board ranks scored people first, unscored after', () => {
  const people = [person({ id: 'p1', name: 'Ann' }), person({ id: 'p2', name: 'Bo' }), person({ id: 'p3', name: 'Cal' })];
  const tasks = new Map([
    ['p1', [task({ id: 'a', completed_at: '2026-07-30T00:00:00Z' }), task({ id: 'b' }), task({ id: 'c' })]],
    ['p2', [task({ id: 'd' }), task({ id: 'e' }), task({ id: 'f' })]],
    ['p3', [task({ id: 'g' })]],                                     // too few
  ]);
  const board = reliabilityBoard(people, tasks, TODAY);
  assert.deepEqual(board.map((r) => r.name), ['Bo', 'Ann', 'Cal']);
  assert.equal(board[2].score, null);
});

test('concerns name people conservatively, with the reasons', () => {
  const board = reliabilityBoard(
    [person({ id: 'p1', name: 'Dave Mullen' })],
    new Map([['p1', [
      task({ id: 'a', completed_at: '2026-07-30T00:00:00Z' }),
      task({ id: 'b', completed_at: '2026-07-29T00:00:00Z' }),
      task({ id: 'c', status: 'open', due_on: '2026-07-01', completed_at: null }),
      task({ id: 'd', needs_photo: 1, photo_id: null }),
    ]]]),
    TODAY,
  );
  const [c] = reliabilityConcerns(board);
  assert.equal(c.name, 'Dave Mullen');
  assert.ok(c.reasons.some((r) => /tasks hit their date/.test(r)));
  assert.ok(c.reasons.some((r) => /escalated to you/.test(r)));
  assert.ok(c.reasons.some((r) => /photo proofs/.test(r)));
});

test('a good record is never flagged as a concern', () => {
  const board = reliabilityBoard(
    [person({ id: 'p1' })],
    new Map([['p1', [task({ id: 'a' }), task({ id: 'b' }), task({ id: 'c' })]]]),
    TODAY,
  );
  assert.deepEqual(reliabilityConcerns(board), []);
});

/* ------------------------------------------------------------- at risk */

const job = (over = {}) => ({
  id: 'j1', client_name: 'R. Patel', site_address: '3 Mill Lane',
  status: 'in_progress', target_end: '2026-08-20', budget_baseline: 4200, cost_baseline: 2900, ...over,
});

const ctx = (over = {}) => ({
  crewByJob: new Map([['j1', [{ person_id: 'p1' }]]]),
  costsByJob: new Map(),
  tasksByJob: new Map(),
  logsByJob: new Map(),
  ...over,
});

test('a healthy job is not at risk', () => {
  assert.deepEqual(atRiskJobs([job()], ctx(), TODAY), []);
});

test('a completed job is never at risk, whatever its dates say', () => {
  assert.deepEqual(atRiskJobs([job({ status: 'complete', target_end: '2026-01-01' })], ctx(), TODAY), []);
});

test('each risk is a separate, actionable reason', () => {
  const [risk] = atRiskJobs([job({ target_end: '2026-07-28' })], ctx({
    crewByJob: new Map(),
    costsByJob: new Map([['j1', [{ amount: 3400 }]]]),
    tasksByJob: new Map([['j1', [{ escalated: true }, { escalated: false }]]]),
    logsByJob: new Map([['j1', [{ kind: 'safety', acknowledged_at: null }]]]),
  }), TODAY);

  const codes = risk.reasons.map((r) => r.code);
  assert.deepEqual(codes.sort(), ['behind_schedule', 'over_budget', 'tasks_escalated', 'unread_problems', 'unstaffed'].sort());
  assert.equal(risk.severity, 5);
  assert.ok(risk.reasons.find((r) => r.code === 'behind_schedule').text.includes('7 days'));
  assert.ok(risk.reasons.find((r) => r.code === 'over_budget').text.includes('500'));
});

test('an acknowledged problem stops counting against the job', () => {
  const risks = atRiskJobs([job()], ctx({
    logsByJob: new Map([['j1', [{ kind: 'issue', acknowledged_at: '2026-08-03' }]]]),
  }), TODAY);
  assert.deepEqual(risks, []);
});

test('an on-hold job is flagged, but not for being unstaffed', () => {
  const [risk] = atRiskJobs([job({ status: 'on_hold' })], ctx({ crewByJob: new Map() }), TODAY);
  const codes = risk.reasons.map((r) => r.code);
  assert.ok(codes.includes('on_hold'));
  assert.ok(!codes.includes('unstaffed'), 'a paused job does not need a crew standing on it');
});

test('risks sort worst-first', () => {
  const jobs = [
    job({ id: 'j1', target_end: '2026-08-01' }),
    job({ id: 'j2', target_end: '2026-08-01', status: 'on_hold' }),
  ];
  const risks = atRiskJobs(jobs, ctx({
    crewByJob: new Map([['j1', [{ person_id: 'p' }]], ['j2', [{ person_id: 'p' }]]]),
  }), TODAY);
  assert.equal(risks[0].job_id, 'j2', 'two reasons beats one');
});

/* ------------------------------------------------------------ progress */

test('progress counts tasks and checklist steps together', () => {
  const p = jobProgress(job(), [{ done: true, status: 'done' }, { done: false, status: 'open' }],
    [{ done: true, needs_photo: false }, { done: true, needs_photo: true, photo_id: null }]);
  // 1 task + 1 step done out of 4; the unproven step does not count.
  assert.equal(p, 50);
});

test('a complete job reads 100% even with loose ends', () => {
  assert.equal(jobProgress(job({ status: 'complete' }), [{ done: false, status: 'open' }], []), 100);
});

/* ------------------------------------------------------------ forecast */

const inv = (over = {}) => ({ id: 'i', status: 'sent', amount: 1000, amount_paid: 0, due_on: '2026-08-20', ...over });

test('unpaid invoices land in the bucket their due date falls in', () => {
  const f = cashForecast([
    inv({ id: 'a', due_on: '2026-08-20' }),                   // 16 days → 30
    inv({ id: 'b', due_on: '2026-09-20' }),                   // 47 days → 60
    inv({ id: 'c', due_on: '2026-10-20' }),                   // 77 days → 90
    inv({ id: 'd', due_on: '2026-07-01' }),                   // already late
  ], [], new Set(), TODAY);
  assert.equal(f.d30, 1000);
  assert.equal(f.d60, 1000);
  assert.equal(f.d90, 1000);
  // Late money is not imminent money; mixing them would flatter the forecast.
  assert.equal(f.overdue, 1000);
  assert.equal(f.next_30, 1000);
});

test('only the unpaid balance is forecast', () => {
  const f = cashForecast([inv({ amount: 1000, amount_paid: 400 })], [], new Set(), TODAY);
  assert.equal(f.d30, 600);
});

test('drafts and settled invoices are not future income', () => {
  const f = cashForecast([
    inv({ id: 'a', status: 'draft' }),
    inv({ id: 'b', status: 'paid', amount_paid: 1000 }),
  ], [], new Set(), TODAY);
  assert.equal(f.total_expected, 0);
});

test('booked work not yet invoiced is forecast at its finish date', () => {
  const f = cashForecast([], [job({ id: 'j1', target_end: '2026-08-25', budget_baseline: 4200 })], new Set(), TODAY);
  assert.equal(f.d30, 4200);
  assert.equal(f.uninvoiced_total, 4200);
  assert.ok(f.assumptions.some((a) => /not yet invoiced/.test(a)));
});

test('a job already invoiced is not counted twice', () => {
  const f = cashForecast(
    [inv({ id: 'a', amount: 4200, due_on: '2026-08-20' })],
    [job({ id: 'j1', budget_baseline: 4200 })],
    new Set(['j1']),
    TODAY,
  );
  assert.equal(f.total_expected, 4200, 'the invoice, not the invoice plus the job');
});

test('the forecast states its assumptions rather than hiding them', () => {
  const f = cashForecast([inv()], [job({ id: 'j2', target_end: '2026-09-01' })], new Set(), TODAY);
  assert.equal(f.assumptions.length, 2);
  assert.ok(f.assumptions.every((a) => typeof a === 'string' && a.length > 20));
});

/* -------------------------------------------------------------- margin */

test('margin health compares cost booked so far against the quoted price', () => {
  const m = marginHealth(
    [job({ id: 'j1', budget_baseline: 4200, cost_baseline: 2900 })],
    new Map([['j1', [{ amount: 1500 }]]]),
  );
  assert.equal(m.jobs, 1);
  assert.equal(m.quoted_margin, 31);
  assert.equal(m.cost_so_far, 1500);
  assert.equal(m.over_budget_jobs, 0);
});

test('margin health counts jobs already past their expected cost', () => {
  const m = marginHealth(
    [job({ id: 'j1', cost_baseline: 2900 })],
    new Map([['j1', [{ amount: 3100 }]]]),
  );
  assert.equal(m.over_budget_jobs, 1);
});

test('no live jobs means no margin figure rather than a zero', () => {
  assert.equal(marginHealth([job({ status: 'complete' })], new Map()), null);
});

test('a job with nothing booked is unmeasured, not 100% margin', () => {
  const m = marginHealth([job({ id: 'j1', budget_baseline: 4200 })], new Map());
  // Reporting 100% here would be the most flattering possible lie, right on
  // the headline of the dashboard.
  assert.equal(m.margin_so_far, null);
  assert.equal(m.cost_so_far, 0);
  assert.equal(m.jobs_with_costs, 0);
  assert.equal(m.quoted_margin, 31, 'the quoted figure is still known and shown');
});

test('margin so far says how much of the picture it covers', () => {
  const m = marginHealth(
    [job({ id: 'j1' }), job({ id: 'j2', budget_baseline: 1000, cost_baseline: 700 })],
    new Map([['j1', [{ amount: 1500 }]]]),
  );
  assert.equal(m.jobs, 2);
  assert.equal(m.jobs_with_costs, 1, 'so the UI can caveat the number');
  assert.ok(m.margin_so_far !== null);
});
