/* ------------------------------------------------------------------------- *
 * GENERATED FILE — DO NOT EDIT.
 * Built by worker/scripts/build-generated.mjs from worker/src/variance.js.
 * Edit the source and run: npm run build:generated
 * ------------------------------------------------------------------------- */

/**
 * Quote-vs-actual variance (docs/auto-quoting/README.md §9, Phase D).
 *
 * This is the module that lets the system get better rather than merely faster.
 * Everything else in the quoting module makes an estimate quickly; this one
 * measures whether the estimate was any good, and hands that back to the
 * assistant as its `recent_similar_jobs` reference.
 *
 * Sign convention throughout: **positive means over budget** — the job cost more
 * than quoted. It reads the way a builder says it ("we ran £200 over").
 */

import { money, marginOf } from './pricing.js';

/** Percentage change from `baseline` to `actual`, one decimal place. */
export function variancePct(baseline, actual) {
  // A job with no quoted cost has no meaningful percentage — reporting "100%
  // over" or Infinity for a £0 baseline would be noise, not signal.
  if (!baseline) return null;
  return Math.round(((actual - baseline) / baseline) * 1000) / 10;
}

/**
 * Variance for a single job.
 *
 * @param {object} job    row from `jobs` (budget_baseline, cost_baseline)
 * @param {Array}  costs  rows from `job_costs`
 */
export function jobVariance(job, costs) {
  const actual_cost = money(costs.reduce((t, c) => t + (Number(c.amount) || 0), 0));
  const quoted_price = money(job.budget_baseline);
  const quoted_cost = money(job.cost_baseline);

  const quoted_margin = marginOf(quoted_price, quoted_cost);
  const actual_margin = marginOf(quoted_price, actual_cost);

  return {
    job_id: job.id,
    client_name: job.client_name,
    site_address: job.site_address,
    job_type: job.job_type,
    status: job.status,
    completed_at: job.completed_at,
    quoted_price,
    quoted_cost,
    actual_cost,
    // Price is fixed once the client accepts, so every pound of cost overrun
    // comes straight out of margin. That is the whole point of the report.
    cost_variance: money(actual_cost - quoted_cost),
    cost_variance_pct: variancePct(quoted_cost, actual_cost),
    quoted_margin,
    actual_margin,
    margin_lost: Math.round((quoted_margin - actual_margin) * 10) / 10,
    cost_entries: costs.length,
  };
}

/** Roll up job variances by job type. */
export function byJobType(variances) {
  const groups = new Map();
  for (const v of variances) {
    if (!groups.has(v.job_type)) groups.set(v.job_type, []);
    groups.get(v.job_type).push(v);
  }

  return [...groups.entries()]
    .map(([job_type, rows]) => {
      const quoted_cost = money(rows.reduce((t, r) => t + r.quoted_cost, 0));
      const actual_cost = money(rows.reduce((t, r) => t + r.actual_cost, 0));
      const quoted_price = money(rows.reduce((t, r) => t + r.quoted_price, 0));
      return {
        job_type,
        jobs: rows.length,
        quoted_price,
        quoted_cost,
        actual_cost,
        cost_variance: money(actual_cost - quoted_cost),
        // Weighted by value, not a mean of percentages: one small job running
        // 80% over should not outweigh five large ones landing on budget.
        cost_variance_pct: variancePct(quoted_cost, actual_cost),
        quoted_margin: marginOf(quoted_price, quoted_cost),
        actual_margin: marginOf(quoted_price, actual_cost),
        jobs_over_budget: rows.filter((r) => r.cost_variance > 0).length,
      };
    })
    .sort((a, b) => Math.abs(b.cost_variance) - Math.abs(a.cost_variance));
}

/**
 * Per-line-code estimating bias.
 *
 * This is the actionable part: not "the job ran over" but *which line* ran over,
 * and consistently enough to trust. Requires `minJobs` observations before
 * reporting, because one bad week is not a bias.
 */
export function lineCodeBias(quotedLines, actualCosts, { minJobs = 2 } = {}) {
  // Totals are accumulated per (line_code, job) so the two sides can be compared
  // over exactly the same set of jobs. Summing quoted cost across every job while
  // counting only the costed ones would report a job nobody booked costs against
  // as a large underspend — the opposite of the truth.
  const quoted = new Map();   // line_code -> { description, byJob: Map<job_id, cost> }
  for (const l of quotedLines) {
    if (!l.line_code) continue;
    const e = quoted.get(l.line_code) || { description: l.description, byJob: new Map() };
    e.byJob.set(l.job_id, (e.byJob.get(l.job_id) || 0) + (Number(l.line_cost) || 0));
    quoted.set(l.line_code, e);
  }

  const actual = new Map();   // line_code -> Map<job_id, cost>
  for (const c of actualCosts) {
    if (!c.line_code) continue;
    const e = actual.get(c.line_code) || new Map();
    e.set(c.job_id, (e.get(c.job_id) || 0) + (Number(c.amount) || 0));
    actual.set(c.line_code, e);
  }

  const rows = [];
  for (const [line_code, q] of quoted) {
    const a = actual.get(line_code);
    if (!a) continue;

    const shared = [...q.byJob.keys()].filter((id) => a.has(id));
    if (shared.length < minJobs) continue;

    const quoted_cost = money(shared.reduce((t, id) => t + q.byJob.get(id), 0));
    const actual_cost = money(shared.reduce((t, id) => t + a.get(id), 0));
    const pct = variancePct(quoted_cost, actual_cost);
    if (pct === null) continue;

    rows.push({
      line_code,
      description: q.description,
      jobs: shared.length,
      quoted_cost,
      actual_cost,
      variance_pct: pct,
    });
  }

  return rows.sort((x, y) => Math.abs(y.variance_pct) - Math.abs(x.variance_pct));
}

/**
 * Turn bias rows into a short brief for the draft assistant.
 *
 * Only material, reliable bias is worth sending: below the threshold it is noise,
 * and telling a model "this line runs 1% over" invites it to fiddle with numbers
 * for no reason.
 */
export function biasBriefing(bias, { threshold = 5 } = {}) {
  return bias
    .filter((b) => Math.abs(b.variance_pct) >= threshold)
    .slice(0, 5)
    .map((b) => {
      const pct = Math.abs(b.variance_pct);
      // The advice has to follow the direction. Telling the assistant to "scope
      // generously" a line that consistently comes in *under* would push
      // estimates further from reality, not closer.
      const advice = b.variance_pct > 0
        ? 'over the quoted cost — scope this line generously'
        : 'under the quoted cost — past quotes have over-scoped it';
      return `${b.description} (${b.line_code}) has run ${pct}% ${advice}, across ${b.jobs} completed jobs.`;
    });
}

/** Portfolio headline for the top of the report. */
export function summarise(variances) {
  const quoted_price = money(variances.reduce((t, v) => t + v.quoted_price, 0));
  const quoted_cost = money(variances.reduce((t, v) => t + v.quoted_cost, 0));
  const actual_cost = money(variances.reduce((t, v) => t + v.actual_cost, 0));

  return {
    jobs: variances.length,
    quoted_price,
    quoted_cost,
    actual_cost,
    cost_variance: money(actual_cost - quoted_cost),
    cost_variance_pct: variancePct(quoted_cost, actual_cost),
    quoted_margin: marginOf(quoted_price, quoted_cost),
    actual_margin: marginOf(quoted_price, actual_cost),
    margin_lost: Math.round((marginOf(quoted_price, quoted_cost) - marginOf(quoted_price, actual_cost)) * 10) / 10,
    jobs_over_budget: variances.filter((v) => v.cost_variance > 0).length,
    // The spec's success metric: quoted-vs-actual variance per job under 10%.
    jobs_within_10pct: variances.filter(
      (v) => v.cost_variance_pct !== null && Math.abs(v.cost_variance_pct) <= 10,
    ).length,
  };
}
