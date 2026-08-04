import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TRIGGERS, planActions, conditionsPass, renderTemplate, validateAutomation,
} from '../src/automation.js';
import { driverName, deliver, resolveRecipient } from '../src/messaging.js';

const TODAY = '2026-08-04';

const world = (over = {}) => ({
  today: TODAY,
  globals: { business_name: 'Higgins Scaffolding' },
  invoices: [],
  jobs: [],
  risks: [],
  checkins: [],
  people: [],
  escalatedTasks: [],
  onboardedPersonIds: new Set(),
  ...over,
});

const rule = (over = {}) => ({
  id: 'r1',
  name: 'Chase at 7 days',
  enabled: 1,
  trigger_type: 'invoice_overdue',
  trigger_config: { days: 7 },
  conditions: [],
  actions: [{ type: 'notify_owner', message: '{client_name} owes {amount}' }],
  ...over,
});

const invoice = (over = {}) => ({
  id: 'i1', number: 'INV-0001', client_name: 'Sarah Higgins',
  amount: 1835, amount_paid: 0, status: 'sent', due_on: '2026-07-20', ...over,
});

/* ------------------------------------------------------------- triggers */

test('invoice_overdue fires on or after the threshold, not only exactly on it', () => {
  const w = world({ invoices: [invoice({ due_on: '2026-07-20' })] });   // 15 days late
  const hits = TRIGGERS.invoice_overdue.find(w, { days: 7 });
  assert.equal(hits.length, 1);
  assert.equal(hits[0].context.days_overdue, 15);
  // A scheduler that misses a day must not skip the chase forever.
  assert.equal(TRIGGERS.invoice_overdue.find(w, { days: 14 }).length, 1);
  assert.equal(TRIGGERS.invoice_overdue.find(w, { days: 30 }).length, 0);
});

test('a settled or drafted invoice is never chased', () => {
  const w = world({
    invoices: [
      invoice({ id: 'a', status: 'paid', amount_paid: 1835 }),
      invoice({ id: 'b', status: 'draft' }),
      invoice({ id: 'c', amount_paid: 1835 }),        // sent but fully paid
    ],
  });
  assert.deepEqual(TRIGGERS.invoice_overdue.find(w, { days: 7 }), []);
});

test('a part-paid invoice is chased for the balance only', () => {
  const w = world({ invoices: [invoice({ amount: 2000, amount_paid: 800 })] });
  const [hit] = TRIGGERS.invoice_overdue.find(w, { days: 7 });
  assert.equal(hit.context.amount, '£1,200');
  assert.equal(hit.context.amount_value, 1200);
});

test('job_at_risk keys on the reasons, so a new problem re-reports', () => {
  const one = TRIGGERS.job_at_risk.find(world({
    risks: [{ job_id: 'j1', client_name: 'R. Patel', site_address: '3 Mill Lane', reasons: [{ code: 'behind_schedule', text: '7 days past its finish date' }] }],
  }));
  const two = TRIGGERS.job_at_risk.find(world({
    risks: [{ job_id: 'j1', client_name: 'R. Patel', site_address: '3 Mill Lane', reasons: [
      { code: 'behind_schedule', text: '7 days past its finish date' },
      { code: 'over_budget', text: '£500 over the expected cost' },
    ] }],
  }));
  assert.notEqual(one[0].bucket, two[0].bucket, 'a job that gets worse must be reported again');
  assert.match(two[0].context.risk_reasons, /past its finish date, £500 over/);
});

test('checkin_due ignores ones that are done or not yet due', () => {
  const hits = TRIGGERS.checkin_due.find(world({
    checkins: [
      { id: 'c1', status: 'due', due_on: '2026-08-01', milestone: 'Midway', job_id: 'j1' },
      { id: 'c2', status: 'due', due_on: '2026-09-01', milestone: 'Handover', job_id: 'j1' },
      { id: 'c3', status: 'done', due_on: '2026-07-01', milestone: 'First day', job_id: 'j1' },
    ],
  }));
  assert.deepEqual(hits.map((h) => h.entity_id), ['c1']);
});

test('person_added skips anyone already onboarded', () => {
  const w = world({
    people: [
      { id: 'p1', name: 'Tomasz Reed', created_at: '2026-08-01 09:00:00', role: 'roofer' },
      { id: 'p2', name: 'Old Hand', created_at: '2026-01-01 09:00:00', role: 'labourer' },
    ],
    onboardedPersonIds: new Set(),
  });
  assert.deepEqual(TRIGGERS.person_added.find(w, { days: 7 }).map((h) => h.entity_id), ['p1']);

  w.onboardedPersonIds = new Set(['p1']);
  assert.deepEqual(TRIGGERS.person_added.find(w, { days: 7 }), []);
});

/* ----------------------------------------------------------- conditions */

test('no conditions means always', () => {
  assert.equal(conditionsPass([], { a: 1 }), true);
  assert.equal(conditionsPass(undefined, {}), true);
});

test('conditions compare against the trigger context', () => {
  const ctx = { amount_value: 1835, client_name: 'Sarah Higgins' };
  assert.equal(conditionsPass([{ field: 'amount_value', op: '>', value: 1000 }], ctx), true);
  assert.equal(conditionsPass([{ field: 'amount_value', op: '>', value: 5000 }], ctx), false);
  assert.equal(conditionsPass([{ field: 'client_name', op: 'contains', value: 'higgins' }], ctx), true);
  assert.equal(conditionsPass([
    { field: 'amount_value', op: '>', value: 1000 },
    { field: 'client_name', op: '!=', value: 'Sarah Higgins' },
  ], ctx), false, 'all conditions must hold');
});

test('an unreadable condition blocks the rule rather than firing it', () => {
  assert.equal(conditionsPass([{ field: 'a', op: 'sort-of-equals', value: 1 }], { a: 1 }), false);
});

/* ------------------------------------------------------------ templates */

test('placeholders are filled from context', () => {
  assert.equal(
    renderTemplate('Hi {client_name}, {amount} was due {due_date}.',
      { client_name: 'Sarah', amount: '£1,835', due_date: '2026-07-20' }),
    'Hi Sarah, £1,835 was due 2026-07-20.',
  );
});

test('an unknown placeholder stays visible instead of blanking', () => {
  // A broken template should look broken, not send half a sentence.
  assert.equal(renderTemplate('Hi {nope}, thanks', {}), 'Hi {nope}, thanks');
});

/* --------------------------------------------------------------- engine */

test('a plan is produced with the message already rendered', () => {
  const { plans } = planActions([rule()], world({ invoices: [invoice()] }), new Set());
  assert.equal(plans.length, 1);
  assert.equal(plans[0].actions[0].message, 'Sarah Higgins owes £1,835');
  assert.equal(plans[0].dedupe_key, 'r1:i1:overdue_7');
});

test('the same thing never fires twice for the same stage', () => {
  const w = world({ invoices: [invoice()] });
  const first = planActions([rule()], w, new Set());
  const fired = new Set(first.plans.map((p) => p.dedupe_key));

  const second = planActions([rule()], w, fired);
  assert.equal(second.plans.length, 0, 'running the engine again chases nobody twice');
  assert.equal(second.skipped, 1);
});

test('but the next stage of the same chase does fire', () => {
  const w = world({ invoices: [invoice({ due_on: '2026-07-01' })] });   // 34 days late
  const day7 = rule({ id: 'r7', trigger_config: { days: 7 } });
  const day14 = rule({ id: 'r14', trigger_config: { days: 14 } });

  const fired = new Set(planActions([day7], w, new Set()).plans.map((p) => p.dedupe_key));
  const next = planActions([day7, day14], w, fired);
  assert.deepEqual(next.plans.map((p) => p.automation_id), ['r14']);
});

test('a disabled rule does nothing', () => {
  const { plans } = planActions([rule({ enabled: 0 })], world({ invoices: [invoice()] }), new Set());
  assert.deepEqual(plans, []);
});

test('an unknown trigger type is ignored rather than crashing the run', () => {
  const { plans } = planActions(
    [rule({ trigger_type: 'when_the_moon_is_full' })],
    world({ invoices: [invoice()] }), new Set(),
  );
  assert.deepEqual(plans, []);
});

test('conditions filter which entities fire', () => {
  const w = world({
    invoices: [invoice({ id: 'small', amount: 200 }), invoice({ id: 'big', amount: 5000 })],
  });
  const r = rule({ conditions: [{ field: 'amount_value', op: '>=', value: 1000 }] });
  const { plans } = planActions([r], w, new Set());
  assert.deepEqual(plans.map((p) => p.entity_id), ['big']);
});

test('global context is available to every template', () => {
  const r = rule({ actions: [{ type: 'notify_owner', message: 'From {business_name}' }] });
  const { plans } = planActions([r], world({ invoices: [invoice()] }), new Set());
  assert.equal(plans[0].actions[0].message, 'From Higgins Scaffolding');
});

/* ----------------------------------------------------------- validation */

test('a rule must be readable before it can be stored', () => {
  assert.deepEqual(validateAutomation(rule()), []);
  assert.ok(validateAutomation(rule({ name: '  ' })).some((e) => /needs a name/.test(e)));
  assert.ok(validateAutomation(rule({ trigger_type: 'nope' })).some((e) => /Unknown trigger/.test(e)));
  assert.ok(validateAutomation(rule({ actions: [] })).some((e) => /at least one action/.test(e)));
  assert.ok(validateAutomation(rule({ actions: [{ type: 'notify_owner', message: '' }] }))
    .some((e) => /needs a message/.test(e)));
  assert.ok(validateAutomation(rule({ actions: [{ type: 'send_carrier_pigeon' }] }))
    .some((e) => /unknown type/.test(e)));
  assert.ok(validateAutomation(rule({ actions: [{ type: 'message_client', channel: 'telepathy', message: 'hi' }] }))
    .some((e) => /unknown channel/.test(e)));
  assert.ok(validateAutomation(rule({ conditions: [{ field: 'a', op: '~=', value: 1 }] }))
    .some((e) => /Unknown condition operator/.test(e)));
});

/* ------------------------------------------------------------ messaging */

test('with no provider configured the driver is simulated', () => {
  assert.equal(driverName({}), 'simulated');
  assert.equal(driverName({ MESSAGING_DRIVER: 'webhook' }), 'simulated',
    'a webhook driver with no URL falls back rather than erroring');
  assert.equal(driverName({ MESSAGING_DRIVER: 'webhook', MESSAGING_WEBHOOK_URL: 'https://x' }), 'webhook');
});

test('a simulated message is never recorded as sent', async () => {
  const res = await deliver({}, { channel: 'sms', recipient: '07700900000', body: 'hi' });
  assert.equal(res.status, 'simulated');
  assert.notEqual(res.status, 'sent', 'claiming to have texted a client would be a lie the owner acts on');
});

test('owner alerts are in-app and need no provider', async () => {
  const res = await deliver({}, { channel: 'owner_alert', body: 'Look at this' });
  assert.equal(res.status, 'sent');
  assert.equal(res.provider, 'in_app');
});

test('a webhook failure is recorded as failed, not downgraded to simulated', async () => {
  const env = { MESSAGING_DRIVER: 'webhook', MESSAGING_WEBHOOK_URL: 'https://example.invalid/hook' };
  const original = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('connection refused'); };
  try {
    const res = await deliver(env, { channel: 'sms', recipient: '07700900000', body: 'hi' });
    // "Not wired up" and "wired up and broken" must look different to the owner.
    assert.equal(res.status, 'failed');
    assert.match(res.error, /connection refused/);
  } finally {
    globalThis.fetch = original;
  }
});

test('a webhook rejection carries the status back', async () => {
  const env = { MESSAGING_DRIVER: 'webhook', MESSAGING_WEBHOOK_URL: 'https://example.invalid/hook' };
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('nope', { status: 502 });
  try {
    const res = await deliver(env, { channel: 'sms', recipient: '1', body: 'hi' });
    assert.equal(res.status, 'failed');
    assert.match(res.error, /502/);
  } finally {
    globalThis.fetch = original;
  }
});

test('a recipient with no contact details is refused, with a reason', () => {
  const withPhone = resolveRecipient({ type: 'message_client', channel: 'sms' },
    { client: { name: 'Sarah', phone: '07700900000' } });
  assert.equal(withPhone.ok, true);
  assert.equal(withPhone.recipient, '07700900000');

  const without = resolveRecipient({ type: 'message_client', channel: 'sms' },
    { client: { name: 'Sarah' } });
  assert.equal(without.ok, false);
  // Otherwise the owner reads "reminder sent" while the invoice sits silently unpaid.
  assert.match(without.reason, /No phone number on file for Sarah/);

  const email = resolveRecipient({ type: 'message_client', channel: 'email' },
    { client: { name: 'Sarah', phone: '07700900000' } });
  assert.equal(email.ok, false, 'a phone number is not an email address');
});
