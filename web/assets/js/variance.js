import './pwa.js';
import { api, ready, price, titleCase, formatDate, esc, ApiError } from './api.js';

const $ = (id) => document.getElementById(id);

const banner = (kind, html) =>
  ($('banner').innerHTML = `<div class="card"><div class="card-body"><div class="notice notice-${kind}">${html}</div></div></div>`);

/** Over budget is bad, under is good — colour follows meaning, not sign. */
const varianceClass = (pct) => (pct > 0 ? 'badge-bad' : pct < 0 ? 'badge-ok' : 'badge-warn');
const signed = (n) => `${n > 0 ? '+' : ''}${n}`;
const signedPrice = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${price(Math.abs(n))}`;

async function boot() {
  if (!await ready()) {
    return banner('bad', 'Not configured. Set your owner token on the <a href="index.html">quotes screen</a>.');
  }
  try {
    render(await api.variance());
  } catch (err) {
    banner('bad', err instanceof ApiError && err.status === 401
      ? '<strong>Token rejected.</strong> Check it on the <a href="index.html">quotes screen</a>.'
      : `<strong>Error.</strong> ${esc(err.message)}`);
  }
}

function render(d) {
  const s = d.summary;

  if (!s.jobs) {
    $('summary').innerHTML = `<div class="notice notice-warn">
      <strong>Nothing to report yet.</strong>
      Mark a job complete and log what it actually cost, and this report fills in.
      ${d.unmeasured_jobs ? `${d.unmeasured_jobs} completed job${d.unmeasured_jobs > 1 ? 's have' : ' has'} no costs logged.` : ''}
    </div>`;
    for (const id of ['bias', 'by-type', 'jobs']) $(id).innerHTML = '';
    return;
  }

  const cls = varianceClass(s.cost_variance_pct);
  $('summary').innerHTML = `
    <div class="total-row"><span class="label">Quoted cost</span><span class="value" style="font-size:20px">${price(s.quoted_cost)}</span></div>
    <div class="total-row"><span class="label">Actual cost</span><span class="value" style="font-size:20px">${price(s.actual_cost)}</span></div>
    <div class="total-row">
      <span class="label">Variance</span>
      <span class="badge ${cls}">${signedPrice(s.cost_variance)} (${signed(s.cost_variance_pct)}%)</span>
    </div>
    <div class="total-row">
      <span class="label">Margin</span>
      <span><span class="badge ${cls}">${s.actual_margin}% actual</span> <span class="muted">quoted ${s.quoted_margin}%</span></span>
    </div>
    <div class="notice ${s.jobs_within_10pct === s.jobs ? 'notice-ok' : 'notice-warn'}">
      <strong>${s.jobs_within_10pct} of ${s.jobs} jobs landed within 10% of the quoted cost.</strong>
      ${s.margin_lost > 0
        ? `Overspend has cost ${s.margin_lost} points of margin across these jobs.`
        : 'Jobs came in at or under the quoted cost.'}
    </div>
    ${d.unmeasured_jobs
      ? `<p class="muted" style="margin:0">${d.unmeasured_jobs} completed job${d.unmeasured_jobs > 1 ? 's are' : ' is'} excluded — no costs logged against ${d.unmeasured_jobs > 1 ? 'them' : 'it'}.</p>`
      : ''}`;

  // Per-line bias — the actionable part, and what the assistant is briefed with.
  $('bias').innerHTML = d.line_code_bias.length
    ? `${d.line_code_bias.map((b) => `
        <div class="total-row">
          <span>
            <strong>${esc(b.description)}</strong>
            <span class="muted" style="display:block;font-size:13px">
              ${price(b.quoted_cost)} quoted vs ${price(b.actual_cost)} actual · ${b.jobs} jobs
            </span>
          </span>
          <span class="badge ${varianceClass(b.variance_pct)}">${signed(b.variance_pct)}%</span>
        </div>`).join('')}
       ${d.assistant_briefing.length ? `
        <div class="notice notice-warn">
          <strong>Fed to the draft assistant</strong>
          <ul>${d.assistant_briefing.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
        </div>` : `
        <p class="muted" style="margin:0">No drift big enough to brief the assistant with — under 5% is noise.</p>`}`
    : '<p class="muted" style="margin:0">Needs at least two completed jobs sharing a line item before a pattern can be called.</p>';

  $('by-type').innerHTML = d.by_job_type.map((g) => `
    <div class="line">
      <div class="line-desc"><span>${esc(titleCase(g.job_type))}</span></div>
      <div class="line-price"><span class="badge ${varianceClass(g.cost_variance_pct)}">${signed(g.cost_variance_pct)}%</span></div>
      <div class="line-qty">
        ${g.jobs} job${g.jobs > 1 ? 's' : ''} · ${price(g.quoted_cost)} → ${price(g.actual_cost)}
        · margin ${g.quoted_margin}% → ${g.actual_margin}%
        · ${g.jobs_over_budget} over budget
      </div>
    </div>`).join('');

  $('jobs').innerHTML = d.jobs.map((j) => `
    <a class="quote-item" href="jobs.html?id=${encodeURIComponent(j.job_id)}">
      <span class="who">${esc(j.client_name)}</span>
      <span class="badge ${varianceClass(j.cost_variance_pct)}">${signed(j.cost_variance_pct)}%</span>
      <span class="meta">
        ${esc(j.site_address || titleCase(j.job_type))}
        · ${price(j.quoted_cost)} → ${price(j.actual_cost)} (${signedPrice(j.cost_variance)})
        · margin ${j.quoted_margin}% → ${j.actual_margin}%
        ${j.completed_at ? `· ${esc(formatDate(j.completed_at))}` : ''}
      </span>
    </a>`).join('');
}

boot();
