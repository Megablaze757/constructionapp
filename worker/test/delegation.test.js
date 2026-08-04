import test from 'node:test';
import assert from 'node:assert/strict';

import {
  taskState, ownerAttention, taskProgress,
  plannedCheckins, overdueCheckins, addDays, visibleSops,
} from '../src/delegation.js';

const TODAY = '2026-08-04';

const task = (over = {}) => ({
  id: 't1',
  job_id: 'job1',
  person_id: 'per_dave',
  title: 'Strike the ties on the rear elevation',
  due_on: '2026-08-01',
  needs_photo: 0,
  photo_id: null,
  status: 'open',
  grace_days: 2,
  ...over,
});

/* ----------------------------------------------------------------- tasks */

test('an open task past its due date is late but not yet the owner\'s problem', () => {
  const s = taskState(task({ due_on: '2026-08-03' }), TODAY);   // 1 day late, grace 2
  assert.equal(s.overdue, true);
  assert.equal(s.days_late, 1);
  assert.equal(s.escalated, false, 'inside the grace window it stays with the assignee');
});

test('past the grace window it escalates to the owner', () => {
  const s = taskState(task({ due_on: '2026-08-01' }), TODAY);   // 3 days late, grace 2
  assert.equal(s.days_late, 3);
  assert.equal(s.escalated, true);
});

test('grace is per task, so a safety job can escalate immediately', () => {
  const s = taskState(task({ due_on: '2026-08-03', grace_days: 0 }), TODAY);
  assert.equal(s.escalated, true, 'one day late with no grace is already the owner\'s');
});

test('a task with no due date never goes late', () => {
  const s = taskState(task({ due_on: null }), TODAY);
  assert.equal(s.overdue, false);
  assert.equal(s.escalated, false);
  assert.equal(s.days_late, 0);
});

test('a done task stops ageing even if its due date passed', () => {
  const s = taskState(task({ due_on: '2026-06-01', status: 'done' }), TODAY);
  assert.equal(s.done, true);
  assert.equal(s.overdue, false);
  assert.equal(s.escalated, false);
});

test('photo proof: ticked without a photo is not done, and keeps ageing', () => {
  const s = taskState(task({ status: 'done', needs_photo: 1, due_on: '2026-08-01' }), TODAY);
  assert.equal(s.done, false, 'the claim is not the proof');
  assert.equal(s.awaiting_photo, true);
  assert.equal(s.overdue, true);
  assert.equal(s.escalated, true, 'and it still reaches the owner once past grace');
});

test('photo proof: with a photo it is genuinely done', () => {
  const s = taskState(task({ status: 'done', needs_photo: 1, photo_id: 'ph_1' }), TODAY);
  assert.equal(s.done, true);
  assert.equal(s.awaiting_photo, false);
});

test('a cancelled task is neither done nor chased', () => {
  const s = taskState(task({ status: 'cancelled', due_on: '2026-06-01' }), TODAY);
  assert.equal(s.done, false);
  assert.equal(s.escalated, false);
});

test('a task nobody owns is flagged as unassigned', () => {
  assert.equal(taskState(task({ person_id: null }), TODAY).unassigned, true);
  assert.equal(taskState(task(), TODAY).unassigned, false);
});

/* ------------------------------------------------------- owner attention */

test('the owner sees only what actually needs them', () => {
  const tasks = [
    task({ id: 'a', due_on: '2026-07-25' }),                                  // 10 days late
    task({ id: 'b', due_on: '2026-08-03' }),                                  // 1 day, in grace
    task({ id: 'c', due_on: '2026-08-01', status: 'done' }),                  // done
    task({ id: 'd', person_id: null, due_on: null }),                         // unowned
    task({ id: 'e', status: 'done', needs_photo: 1, due_on: '2026-08-20' }),  // proof missing
  ];
  const logs = [
    { id: 'l1', kind: 'progress', body: 'Second lift up', acknowledged_at: null, created_at: '2026-08-03' },
    { id: 'l2', kind: 'issue', body: 'Neighbour blocking access', acknowledged_at: null, created_at: '2026-08-04' },
    { id: 'l3', kind: 'delay', body: 'Materials late', acknowledged_at: '2026-08-02', created_at: '2026-08-01' },
    { id: 'l4', kind: 'safety', body: 'Loose board', acknowledged_at: null, created_at: '2026-08-02' },
  ];

  const a = ownerAttention(tasks, logs, TODAY);
  assert.deepEqual(a.escalated.map((t) => t.id), ['a'], 'only the one past grace');
  assert.deepEqual(a.unassigned.map((t) => t.id), ['d']);
  assert.deepEqual(a.awaiting_photo.map((t) => t.id), ['e']);
  // Routine progress is the record, not a request; an acknowledged delay is handled.
  assert.deepEqual(a.unread_issues.map((l) => l.id), ['l2', 'l4'], 'newest first');
});

test('task progress counts photo-blocked work as still open', () => {
  const p = taskProgress([
    task({ id: 'a', status: 'done' }),
    task({ id: 'b', status: 'done', needs_photo: 1 }),      // no photo
    task({ id: 'c', due_on: '2026-07-01' }),                // very late
    task({ id: 'd', status: 'cancelled' }),                 // ignored entirely
  ], TODAY);
  assert.equal(p.total, 3, 'cancelled work is not part of the job');
  assert.equal(p.done, 1);
  assert.equal(p.open, 2);
  assert.equal(p.escalated, 2, 'the late one and the photo-blocked one');
  assert.equal(p.percent, 33);
});

/* ---------------------------------------------------------- client care */

test('check-ins are scheduled across the life of the job, not just its ends', () => {
  const c = plannedCheckins({ target_start: '2026-08-10', target_end: '2026-08-20' });
  assert.equal(c.length, 5);
  assert.equal(c[0].due_on, '2026-08-07', 'three days before start');
  assert.equal(c[1].due_on, '2026-08-10');
  assert.equal(c[2].due_on, '2026-08-15', 'midpoint');
  assert.equal(c[3].due_on, '2026-08-20');
  assert.equal(c[4].due_on, '2026-08-27', 'a week after completion');
});

test('a job with no dates still gets its milestones, just undated', () => {
  const c = plannedCheckins({});
  assert.equal(c.length, 5);
  assert.ok(c.every((x) => x.due_on === null));
  // Better an unscheduled reminder than silently skipping client contact.
  assert.ok(c.every((x) => x.milestone));
});

test('overdue check-ins surface oldest first, and done ones never do', () => {
  const rows = [
    { id: 'a', status: 'due', due_on: '2026-08-01' },
    { id: 'b', status: 'due', due_on: '2026-07-20' },
    { id: 'c', status: 'done', due_on: '2026-07-01' },
    { id: 'd', status: 'due', due_on: '2026-08-30' },
    { id: 'e', status: 'skipped', due_on: '2026-07-01' },
  ];
  assert.deepEqual(overdueCheckins(rows, TODAY).map((c) => c.id), ['b', 'a']);
  assert.equal(overdueCheckins(rows, TODAY)[0].days_late, 15);
});

test('addDays handles negatives and rejects nonsense', () => {
  assert.equal(addDays('2026-08-10', -3), '2026-08-07');
  assert.equal(addDays('2026-08-30', 7), '2026-09-06');
  assert.equal(addDays('nope', 1), null);
});

/* ------------------------------------------------------- role-based SOPs */

const LIBRARY = [
  { id: '1', title: 'Site safety check', role: null, job_type: null },
  { id: '2', title: 'New job setup', role: 'site lead', job_type: null },
  { id: '3', title: 'Scaffold handover', role: null, job_type: 'domestic_scaffold_erect' },
  { id: '4', title: 'Office invoicing run', role: 'office admin', job_type: null },
  { id: '5', title: 'Re-roof strip check', role: null, job_type: 'domestic_reroof' },
];

test('a site lead on a scaffold job sees their SOPs, not the whole manual', () => {
  const v = visibleSops(LIBRARY, { role: 'site lead', jobType: 'domestic_scaffold_erect' });
  assert.deepEqual(v.map((s) => s.id), ['1', '2', '3']);
});

test('a labourer on the same job does not see the site lead\'s SOPs', () => {
  const v = visibleSops(LIBRARY, { role: 'labourer', jobType: 'domestic_scaffold_erect' });
  assert.deepEqual(v.map((s) => s.id), ['1', '3']);
});

test('SOPs for another job type are never shown', () => {
  const v = visibleSops(LIBRARY, { role: 'site lead', jobType: 'domestic_reroof' });
  assert.ok(!v.some((s) => s.id === '3'));
  assert.ok(v.some((s) => s.id === '5'));
});

test('role matching ignores case and stray whitespace', () => {
  const v = visibleSops(LIBRARY, { role: '  Site Lead ', jobType: 'domestic_scaffold_erect' });
  assert.ok(v.some((s) => s.id === '2'));
});

test('with no role recorded, only universal SOPs show', () => {
  // Guessing a specialism from nothing would put the wrong checklist in
  // somebody's hands, which is worse than showing them fewer.
  const v = visibleSops(LIBRARY, { role: null, jobType: 'domestic_scaffold_erect' });
  assert.deepEqual(v.map((s) => s.id), ['1', '3']);
});

test('outside any job, job-specific SOPs are withheld', () => {
  const v = visibleSops(LIBRARY, { role: 'site lead' });
  assert.deepEqual(v.map((s) => s.id), ['1', '2']);
});
