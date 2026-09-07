/* ------------------------------------------------------------------------- *
 * GENERATED FILE — DO NOT EDIT.
 * Built by worker/scripts/build-generated.mjs from worker/src/dashboard.js.
 * Edit the source and run: npm run build:generated
 * ------------------------------------------------------------------------- */

/**
 * Owner dashboard (BuilderOS Phase 2, system spec §3).
 *
 * The success criterion is that the owner checks one dashboard instead of five
 * conversations. Two principles follow from that, and they pull against each
 * other:
 *
 *   - it has to be complete enough to trust, or they go back to ringing people;
 *   - it has to be short enough to read, or they stop opening it.
 *
 * So everything here is either a number they act on or a thing that needs a
 * decision. Anything that is merely interesting belongs on its own screen.
 */

import { money, marginOf } from './pricing.js';
import { daysBetween } from './invoicing.js';

/**
 * Why a job is at risk, in the owner's language.
 *
 * Each reason is something they could act on this afternoon. "Behind schedule"
 * is actionable; "72% complete" is not.
 */
export function atRiskJobs(jobs, { crewByJob, costsByJob, tasksByJob, logsByJob }, today) {
  const risks = [];

  for (const job of jobs) {
    if (job.status === 'complete') continue;
    const reasons = [];

    const overdueBy = job.target_end ? daysBetween(job.target_end, today) : null;
    if (overdueBy !== null && overdueBy > 0) {
      reasons.push({ code: 'behind_schedule', text: `${overdueBy} days past its finish date` });
    }

    const crew = crewByJob.get(job.id) ?? [];
    if (!crew.length && job.status !== 'on_hold') {
      reasons.push({ code: 'unstaffed', text: 'Nobody is assigned to it' });
    }

    const actual = money((costsByJob.get(job.id) ?? []).reduce((t, c) => t + (Number(c.amount) || 0), 0));
    if (job.cost_baseline > 0 && actual > job.cost_baseline) {
      const over = money(actual - job.cost_baseline);
      reasons.push({
        code: 'over_budget',
        text: `£${over.toLocaleString('en-GB')} over the expected cost`,
      });
    }

    const escalated = (tasksByJob.get(job.id) ?? []).filter((t) => t.escalated);
    if (escalated.length) {
      reasons.push({
        code: 'tasks_escalated',
        text: `${escalated.length} task${escalated.length > 1 ? 's' : ''} overdue past their grace window`,
      });
    }

    const unread = (logsByJob.get(job.id) ?? [])
      .filter((l) => ['issue', 'delay', 'safety'].includes(l.kind) && !l.acknowledged_at);
    if (unread.length) {
      reasons.push({
        code: 'unread_problems',
        text: `${unread.length} problem${unread.length > 1 ? 's' : ''} logged and not yet read`,
      });
    }

    if (job.status === 'on_hold') {
      reasons.push({ code: 'on_hold', text: 'On hold' });
    }

    if (reasons.length) {
      risks.push({
        job_id: job.id,
        client_name: job.client_name,
        site_address: job.site_address,
        status: job.status,
        target_end: job.target_end,
        reasons,
        // Severity is just how many independent things are wrong. A job that is
        // late AND unstaffed AND over budget genuinely is worse than one that is
        // only late, and it needs no cleverer model than that.
        severity: reasons.length,
      });
    }
  }

  return risks.sort((a, b) => b.severity - a.severity);
}

/** Percentage of a job's checklist and task work that is finished. */
export function jobProgress(job, tasks, sopSteps) {
  const liveTasks = (tasks ?? []).filter((t) => t.status !== 'cancelled');
  const doneTasks = liveTasks.filter((t) => t.done).length;
  const doneSteps = (sopSteps ?? []).filter((s) => s.done && (!s.needs_photo || s.photo_id)).length;

  const total = liveTasks.length + (sopSteps ?? []).length;
  const done = doneTasks + doneSteps;
  if (job.status === 'complete') return 100;
  return total ? Math.round((done / total) * 100) : 0;
}

/**
 * Cash in, 30/60/90 days out.
 *
 * Built only from money that has a date attached:
 *   - unpaid sent invoices, expected on their due date;
 *   - active jobs with nothing invoiced yet, expected at their target end.
 *
 * A quote that has not been accepted is not in here. Forecasting from a pipeline
 * of maybes is how a cash flow forecast becomes a wish, and this number is meant
 * to be one the owner can plan a wage run against.
 */
export function cashForecast(invoices, jobs, invoicedJobIds, today) {
  const buckets = { d30: 0, d60: 0, d90: 0, later: 0, overdue: 0 };
  const assumptions = [];

  const place = (amount, dateIso) => {
    if (!amount) return;
    const days = dateIso ? daysBetween(today, dateIso) : null;
    if (days === null) { buckets.later = money(buckets.later + amount); return; }
    if (days < 0) buckets.overdue = money(buckets.overdue + amount);
    else if (days <= 30) buckets.d30 = money(buckets.d30 + amount);
    else if (days <= 60) buckets.d60 = money(buckets.d60 + amount);
    else if (days <= 90) buckets.d90 = money(buckets.d90 + amount);
    else buckets.later = money(buckets.later + amount);
  };

  let invoiced = 0;
  for (const inv of invoices) {
    if (inv.status !== 'sent') continue;
    const outstanding = money(Math.max(0, inv.amount - (inv.amount_paid || 0)));
    if (!outstanding) continue;
    invoiced = money(invoiced + outstanding);
    place(outstanding, inv.due_on);
  }
  if (invoiced) assumptions.push('Unpaid invoices are assumed to be paid on their due date.');

  let uninvoiced = 0;
  for (const job of jobs) {
    if (job.status === 'complete' || invoicedJobIds.has(job.id)) continue;
    const value = money(job.budget_baseline || 0);
    if (!value) continue;
    uninvoiced = money(uninvoiced + value);
    place(value, job.target_end);
  }
  if (uninvoiced) {
    assumptions.push('Booked work not yet invoiced is assumed to be invoiced and paid at the job\'s target finish.');
  }

  return {
    ...buckets,
    invoiced_total: invoiced,
    uninvoiced_total: uninvoiced,
    next_30: buckets.d30,
    // Overdue money is shown separately rather than inside the 30-day figure —
    // it is late, not imminent, and mixing them flatters the forecast.
    total_expected: money(buckets.overdue + buckets.d30 + buckets.d60 + buckets.d90 + buckets.later),
    assumptions,
  };
}

/** Live margin health across running jobs. */
export function marginHealth(jobs, costsByJob) {
  const live = jobs.filter((j) => j.status !== 'complete' && j.budget_baseline > 0);
  if (!live.length) return null;

  const quotedPrice = money(live.reduce((t, j) => t + j.budget_baseline, 0));
  const quotedCost = money(live.reduce((t, j) => t + j.cost_baseline, 0));
  const actualCost = money(live.reduce(
    (t, j) => t + (costsByJob.get(j.id) ?? []).reduce((s, c) => s + (Number(c.amount) || 0), 0), 0,
  ));

  const withCosts = live.filter((j) => (costsByJob.get(j.id) ?? []).length > 0);

  return {
    jobs: live.length,
    jobs_with_costs: withCosts.length,
    quoted_price: quotedPrice,
    quoted_cost: quotedCost,
    cost_so_far: actualCost,
    quoted_margin: marginOf(quotedPrice, quotedCost),
    // Cost booked so far against the full quoted price. Mid-job this is
    // optimistic by construction, which is why it is labelled "so far" — and
    // why it is null when nothing has been booked at all. A job with no costs
    // recorded is not a 100% margin job; it is an unmeasured one, and putting
    // "100%" on the dashboard would be the most flattering possible lie.
    margin_so_far: actualCost > 0 ? marginOf(quotedPrice, actualCost) : null,
    over_budget_jobs: live.filter(
      (j) => j.cost_baseline > 0
        && (costsByJob.get(j.id) ?? []).reduce((s, c) => s + (Number(c.amount) || 0), 0) > j.cost_baseline,
    ).length,
  };
}
