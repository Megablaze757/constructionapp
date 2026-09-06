/* ------------------------------------------------------------------------- *
 * GENERATED FILE — DO NOT EDIT.
 * Built by worker/scripts/build-generated.mjs from worker/src/invoicing.js.
 * Edit the source and run: npm run build:generated
 * ------------------------------------------------------------------------- */

/**
 * Invoicing and payment tracking (BuilderOS Phase 0).
 *
 * "Cash is oxygen" is a principle in the system spec, so the arithmetic that
 * decides what is owed and how late it is lives here, tested, rather than being
 * scattered through SQL and templates.
 *
 * One rule shapes the whole module: **overdue is never stored.** It is a fact
 * about today, not about the invoice. Storing it means a row that was written
 * yesterday is wrong today, and every report has to remember to refresh it.
 */

import { money } from './pricing.js';

/** Days between two ISO dates, positive when `later` is after `earlier`. */
export function daysBetween(earlier, later) {
  if (!earlier || !later) return null;
  const a = Date.parse(`${String(earlier).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(later).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * Derive an invoice's live state.
 * @param {object} inv  row from `invoices`
 * @param {string} today ISO date, injected so the maths is testable
 */
export function invoiceState(inv, today) {
  const amount = money(inv.amount);
  const paid = money(inv.amount_paid || 0);
  const outstanding = money(Math.max(0, amount - paid));

  // Part payment is common in construction and must not read as "paid".
  const settled = inv.status === 'paid' || outstanding === 0;
  const chaseable = inv.status === 'sent' && !settled;
  const daysOverdue = chaseable && inv.due_on ? Math.max(0, daysBetween(inv.due_on, today)) : 0;

  return {
    ...inv,
    amount,
    amount_paid: paid,
    outstanding,
    part_paid: paid > 0 && !settled,
    settled,
    overdue: chaseable && daysOverdue > 0,
    days_overdue: daysOverdue,
    // Only sent, unsettled invoices age. A draft is not owed to you yet.
    bucket: chaseable ? agingBucket(daysOverdue) : null,
    // Mirrors the automation cadence in the system spec §4.4: 7 / 14 / 30 days.
    chase_stage: chaseable ? chaseStage(daysOverdue) : null,
  };
}

export function agingBucket(daysOverdue) {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return '1-30';
  if (daysOverdue <= 60) return '31-60';
  if (daysOverdue <= 90) return '61-90';
  return '90+';
}

/** What the payment-chasing automation would be doing at this age. */
export function chaseStage(daysOverdue) {
  if (daysOverdue <= 0) return null;
  if (daysOverdue < 14) return 'friendly_reminder';
  if (daysOverdue < 30) return 'firm_reminder';
  return 'escalate_to_owner';
}

const BUCKETS = ['current', '1-30', '31-60', '61-90', '90+'];

/** Portfolio view: what is owed, how old it is, and what needs chasing. */
export function summariseInvoices(invoices, today) {
  const states = invoices.map((i) => invoiceState(i, today));
  const live = states.filter((s) => s.status === 'sent' && !s.settled);

  const aging = Object.fromEntries(BUCKETS.map((b) => [b, { count: 0, amount: 0 }]));
  for (const s of live) {
    const b = aging[s.bucket];
    b.count += 1;
    b.amount = money(b.amount + s.outstanding);
  }

  const overdue = live.filter((s) => s.overdue);

  return {
    invoices: states,
    outstanding: money(live.reduce((t, s) => t + s.outstanding, 0)),
    overdue_amount: money(overdue.reduce((t, s) => t + s.outstanding, 0)),
    overdue_count: overdue.length,
    draft_count: states.filter((s) => s.status === 'draft').length,
    // Paid in full, however it got there.
    paid_amount: money(states.filter((s) => s.settled).reduce((t, s) => t + s.amount_paid, 0)),
    aging,
    // The single number the owner acts on: the oldest thing owed.
    oldest_overdue_days: overdue.reduce((m, s) => Math.max(m, s.days_overdue), 0),
    needs_chasing: overdue
      .sort((a, b) => b.days_overdue - a.days_overdue)
      .slice(0, 10)
      .map((s) => ({
        id: s.id,
        number: s.number,
        client_name: s.client_name,
        outstanding: s.outstanding,
        days_overdue: s.days_overdue,
        chase_stage: s.chase_stage,
      })),
  };
}

/** Sequential invoice numbers, so they read like a ledger rather than ids. */
export function nextInvoiceNumber(existingNumbers, prefix = 'INV') {
  const highest = existingNumbers.reduce((max, n) => {
    const m = String(n).match(/(\d+)\s*$/);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  return `${prefix}-${String(highest + 1).padStart(4, '0')}`;
}

/* ------------------------------------------------------------------- SOPs */

/**
 * Progress through an attached checklist.
 *
 * A step marked `needs_photo` that has no photo is not done, however it was
 * ticked — that is the whole point of photo proof (system spec §5.2).
 */
export function sopProgress(steps = []) {
  const total = steps.length;
  const done = steps.filter((s) => s.done && (!s.needs_photo || s.photo_id)).length;
  const awaitingPhoto = steps.filter((s) => s.done && s.needs_photo && !s.photo_id).length;
  return {
    total,
    done,
    awaiting_photo: awaitingPhoto,
    remaining: total - done,
    percent: total ? Math.round((done / total) * 100) : 0,
    complete: total > 0 && done === total,
  };
}
