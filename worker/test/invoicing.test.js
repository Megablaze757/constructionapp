import test from 'node:test';
import assert from 'node:assert/strict';

import {
  daysBetween, invoiceState, agingBucket, chaseStage,
  summariseInvoices, nextInvoiceNumber, sopProgress,
} from '../src/invoicing.js';

const TODAY = '2026-08-04';

const inv = (over = {}) => ({
  id: 'inv_1',
  number: 'INV-0001',
  client_name: 'Sarah Higgins',
  amount: 1835,
  amount_paid: 0,
  status: 'sent',
  issued_on: '2026-07-01',
  due_on: '2026-07-15',
  paid_on: null,
  ...over,
});

test('day arithmetic ignores time-of-day and bad input', () => {
  assert.equal(daysBetween('2026-07-15', '2026-08-04'), 20);
  assert.equal(daysBetween('2026-08-04', '2026-07-15'), -20);
  assert.equal(daysBetween('2026-07-15T23:59:59Z', '2026-07-16T00:00:01Z'), 1);
  assert.equal(daysBetween(null, TODAY), null);
  assert.equal(daysBetween('not-a-date', TODAY), null);
});

test('a sent invoice past its due date is overdue by the right number of days', () => {
  const s = invoiceState(inv(), TODAY);
  assert.equal(s.outstanding, 1835);
  assert.equal(s.overdue, true);
  assert.equal(s.days_overdue, 20);
  assert.equal(s.bucket, '1-30');
  assert.equal(s.chase_stage, 'firm_reminder');
});

test('a draft is not owed to you, so it never ages', () => {
  const s = invoiceState(inv({ status: 'draft' }), TODAY);
  assert.equal(s.overdue, false);
  assert.equal(s.bucket, null);
  assert.equal(s.chase_stage, null);
});

test('part payment does not count as paid', () => {
  const s = invoiceState(inv({ amount_paid: 800 }), TODAY);
  assert.equal(s.outstanding, 1035);
  assert.equal(s.part_paid, true);
  assert.equal(s.settled, false);
  assert.equal(s.overdue, true, 'the remaining balance is still late');
});

test('paying the balance settles it even if the status was never updated', () => {
  const s = invoiceState(inv({ amount_paid: 1835 }), TODAY);
  assert.equal(s.settled, true);
  assert.equal(s.outstanding, 0);
  assert.equal(s.overdue, false);
  assert.equal(s.bucket, null);
});

test('overpayment does not produce negative outstanding', () => {
  const s = invoiceState(inv({ amount_paid: 2000 }), TODAY);
  assert.equal(s.outstanding, 0);
  assert.equal(s.settled, true);
});

test('an invoice due today is not yet overdue', () => {
  const s = invoiceState(inv({ due_on: TODAY }), TODAY);
  assert.equal(s.days_overdue, 0);
  assert.equal(s.overdue, false);
  assert.equal(s.bucket, 'current');
});

test('a sent invoice with no due date never reads as overdue', () => {
  const s = invoiceState(inv({ due_on: null }), TODAY);
  assert.equal(s.overdue, false);
  assert.equal(s.days_overdue, 0);
});

test('aging buckets', () => {
  assert.equal(agingBucket(0), 'current');
  assert.equal(agingBucket(1), '1-30');
  assert.equal(agingBucket(30), '1-30');
  assert.equal(agingBucket(31), '31-60');
  assert.equal(agingBucket(90), '61-90');
  assert.equal(agingBucket(91), '90+');
});

test('chase stages follow the 7/14/30 cadence in the system spec', () => {
  assert.equal(chaseStage(0), null);
  assert.equal(chaseStage(7), 'friendly_reminder');
  assert.equal(chaseStage(13), 'friendly_reminder');
  assert.equal(chaseStage(14), 'firm_reminder');
  assert.equal(chaseStage(29), 'firm_reminder');
  assert.equal(chaseStage(30), 'escalate_to_owner');
});

test('portfolio summary separates owed, overdue and merely drafted', () => {
  const s = summariseInvoices([
    inv({ id: 'a', number: 'INV-0001', amount: 1000, due_on: '2026-07-01' }),         // 34 days over
    inv({ id: 'b', number: 'INV-0002', amount: 500, due_on: '2026-08-20' }),          // not due yet
    inv({ id: 'c', number: 'INV-0003', amount: 2000, status: 'draft' }),              // not sent
    inv({ id: 'd', number: 'INV-0004', amount: 800, amount_paid: 800, status: 'paid' }),
    inv({ id: 'e', number: 'INV-0005', amount: 600, amount_paid: 200, due_on: '2026-07-30' }), // 5 over
  ], TODAY);

  assert.equal(s.outstanding, 1900, '1000 + 500 + 400 remaining on the part-paid one');
  assert.equal(s.overdue_amount, 1400, 'only the two past their due date');
  assert.equal(s.overdue_count, 2);
  assert.equal(s.draft_count, 1);
  assert.equal(s.paid_amount, 800);
  assert.equal(s.oldest_overdue_days, 34);
  assert.equal(s.aging['31-60'].amount, 1000);
  assert.equal(s.aging['1-30'].amount, 400);
  assert.equal(s.aging.current.amount, 500);
  assert.equal(s.aging['90+'].count, 0);
});

test('the chase list leads with the oldest debt', () => {
  const s = summariseInvoices([
    inv({ id: 'a', number: 'INV-0001', due_on: '2026-08-01' }),
    inv({ id: 'b', number: 'INV-0002', due_on: '2026-05-01' }),
    inv({ id: 'c', number: 'INV-0003', due_on: '2026-07-20' }),
  ], TODAY);
  assert.deepEqual(s.needs_chasing.map((n) => n.number), ['INV-0002', 'INV-0003', 'INV-0001']);
  assert.equal(s.needs_chasing[0].chase_stage, 'escalate_to_owner');
});

test('an empty ledger summarises to zeroes rather than NaN', () => {
  const s = summariseInvoices([], TODAY);
  assert.equal(s.outstanding, 0);
  assert.equal(s.overdue_count, 0);
  assert.equal(s.oldest_overdue_days, 0);
  assert.deepEqual(s.needs_chasing, []);
});

test('invoice numbers continue the sequence', () => {
  assert.equal(nextInvoiceNumber([]), 'INV-0001');
  assert.equal(nextInvoiceNumber(['INV-0001', 'INV-0002']), 'INV-0003');
  assert.equal(nextInvoiceNumber(['INV-0009', 'INV-0011', 'INV-0010']), 'INV-0012');
  // A hand-typed number from the old paper book should not reset the run.
  assert.equal(nextInvoiceNumber(['2024/117', 'INV-0003']), 'INV-0118');
});

/* ------------------------------------------------------------------- SOPs */

test('a step needing photo proof is not done until the photo exists', () => {
  const p = sopProgress([
    { text: 'Walk the site', needs_photo: true, done: true, photo_id: 'ph_1' },
    { text: 'Check PPE', needs_photo: false, done: true },
    { text: 'Separate public access', needs_photo: true, done: true },   // ticked, no photo
    { text: 'First aid kit', needs_photo: false, done: false },
  ]);
  assert.equal(p.total, 4);
  assert.equal(p.done, 2, 'the ticked-but-unphotographed step does not count');
  assert.equal(p.awaiting_photo, 1);
  assert.equal(p.remaining, 2);
  assert.equal(p.percent, 50);
  assert.equal(p.complete, false);
});

test('a fully completed checklist reads complete', () => {
  const p = sopProgress([
    { text: 'a', needs_photo: false, done: true },
    { text: 'b', needs_photo: true, done: true, photo_id: 'ph_2' },
  ]);
  assert.equal(p.percent, 100);
  assert.equal(p.complete, true);
});

test('an empty checklist is not "complete"', () => {
  const p = sopProgress([]);
  assert.equal(p.percent, 0);
  assert.equal(p.complete, false, 'nothing to do is not the same as done');
});
