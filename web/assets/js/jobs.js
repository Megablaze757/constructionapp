import './pwa.js';
import { api, ownerToken, API_BASE, price, titleCase, formatDate, esc, ApiError } from './api.js';

const $ = (id) => document.getElementById(id);
const jobId = new URLSearchParams(location.search).get('id');

let state = { job: null, costs: [], variance: null, quotedLines: [] };

function banner(kind, html) {
  $('banner').innerHTML = `<div class="card"><div class="card-body"><div class="notice notice-${kind}">${html}</div></div></div>`;
}

function reportError(err) {
  banner('bad', err instanceof ApiError && err.status === 401
    ? '<strong>Token rejected.</strong> Set it on the <a href="index.html">quotes screen</a>.'
    : `<strong>Error.</strong> ${esc(err.message)}`);
}

async function boot() {
  if (!API_BASE || !ownerToken.get()) {
    return banner('bad', 'Not configured. Go to the <a href="index.html">quotes screen</a> and set your owner token.');
  }
  return jobId ? loadJob() : loadList();
}

/* ------------------------------------------------------------------- list */

async function loadList() {
  try {
    const { jobs } = await api.listJobs();
    const host = $('job-list');
    if (!jobs.length) {
      host.innerHTML = '<div class="card-body muted">No jobs yet. A job is created when a client accepts a quote.</div>';
      return;
    }
    host.innerHTML = jobs.map((j) => {
      const actual = Number(j.actual_cost) || 0;
      const over = j.cost_entries > 0 && actual > j.cost_baseline;
      return `
        <a class="quote-item" href="jobs.html?id=${encodeURIComponent(j.id)}">
          <span class="who">${esc(j.client_name)}</span>
          <span class="status status-${j.status === 'complete' ? 'accepted' : 'sent'}">${esc(j.status.replace('_', ' '))}</span>
          <span class="meta">
            ${esc(j.site_address || titleCase(j.job_type))}
            · quoted ${price(j.budget_baseline)}
            · ${j.cost_entries > 0
                ? `cost ${price(actual)} <span style="color:var(--${over ? 'bad' : 'ok'})">${over ? '▲' : '▼'} vs ${price(j.cost_baseline)}</span>`
                : '<em>no costs logged</em>'}
          </span>
        </a>`;
    }).join('');
  } catch (err) {
    reportError(err);
  }
}

/* ----------------------------------------------------------------- detail */

async function loadJob() {
  $('list-view').hidden = true;
  $('detail-view').hidden = false;
  try {
    const res = await api.getJob(jobId);
    state = { ...state, ...res };
    // The quote's own lines are what a cost gets booked against, so an owner
    // picks a real line rather than typing a code.
    try {
      const q = await api.getQuote(res.job.quote_id);
      state.quotedLines = q.lines.filter((l) => l.kind !== 'extra' || l.selected);
    } catch {
      state.quotedLines = [];
    }
    renderJob();
  } catch (err) {
    reportError(err);
  }
}

function renderJob() {
  const { job, costs, variance: v } = state;
  $('job-title').textContent = `${job.client_name} — ${job.site_address || titleCase(job.job_type)}`;
  $('job-meta').textContent = `${titleCase(job.job_type)} · booked ${formatDate(job.created_at)}${job.completed_at ? ` · completed ${formatDate(job.completed_at)}` : ''}`;
  $('job-status').value = job.status;

  const measured = costs.length > 0;
  const over = v.cost_variance > 0;
  const cls = !measured ? 'badge-warn' : over ? 'badge-bad' : 'badge-ok';

  $('job-variance').innerHTML = `
    <div class="total-row"><span class="label">Quoted price</span><span class="value">${price(v.quoted_price)}</span></div>
    <div class="total-row"><span class="label">Quoted cost</span><span class="value" style="font-size:20px">${price(v.quoted_cost)}</span></div>
    <div class="total-row"><span class="label">Actual cost</span><span class="value" style="font-size:20px">${measured ? price(v.actual_cost) : '—'}</span></div>
    ${measured ? `
      <div class="total-row">
        <span class="label">Variance</span>
        <span class="badge ${cls}">${over ? '+' : ''}${price(v.cost_variance)} (${v.cost_variance_pct > 0 ? '+' : ''}${v.cost_variance_pct}%)</span>
      </div>
      <div class="total-row">
        <span class="label">Margin</span>
        <span><span class="badge ${cls}">${v.actual_margin}% actual</span> <span class="muted">quoted ${v.quoted_margin}%</span></span>
      </div>
      ${v.margin_lost > 0
        ? `<div class="notice notice-bad">Overspend cost you <strong style="display:inline">${v.margin_lost} points</strong> of margin. The client price was fixed at acceptance, so every pound over comes out of profit.</div>`
        : '<div class="notice notice-ok">Came in under the quoted cost — margin better than quoted.</div>'}
    ` : '<div class="notice notice-warn">No costs logged yet, so this job cannot feed the variance report or improve future estimates.</div>'}`;

  const host = $('cost-list');
  host.innerHTML = costs.length
    ? costs.map((c) => `
        <div class="line">
          <div class="line-desc"><span>${esc(c.description)}</span><span class="tag">${esc(c.category)}</span></div>
          <div class="line-price">${price(c.amount)}</div>
          <div class="line-qty">${esc(formatDate(c.incurred_on))}${c.line_code ? ` · ${esc(c.line_code)}` : ' · unallocated'}</div>
          <div class="line-actions"><button class="btn btn-sm btn-danger" data-del="${esc(c.id)}" type="button">Remove</button></div>
        </div>`).join('')
    : '<div class="card-body muted">Nothing logged yet.</div>';

  host.querySelectorAll('[data-del]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        state = { ...state, ...(await api.deleteCost(jobId, b.dataset.del)) };
        renderJob();
      } catch (err) { reportError(err); }
    }));
}

$('job-status')?.addEventListener('change', async (e) => {
  try {
    state = { ...state, ...(await api.setJobStatus(jobId, e.target.value)) };
    renderJob();
  } catch (err) { reportError(err); }
});

/* -------------------------------------------------------------- log a cost */

const dialog = $('cost-dialog');

$('add-cost-btn')?.addEventListener('click', () => {
  $('cost-line').innerHTML =
    '<option value="">Unallocated (counts toward the job total only)</option>' +
    state.quotedLines
      .map((l) => `<option value="${esc(l.line_code || '')}">${esc(l.description)} — quoted ${price(l.line_cost)}</option>`)
      .join('');
  $('cost-desc').value = '';
  $('cost-amount').value = '';
  $('cost-date').value = '';
  dialog.showModal();
});

$('cost-line')?.addEventListener('change', () => {
  const line = state.quotedLines.find((l) => l.line_code === $('cost-line').value);
  if (line && !$('cost-desc').value.trim()) $('cost-desc').value = line.description;
  if (line && line.category) $('cost-category').value = line.category;
});

dialog?.addEventListener('close', async () => {
  if (dialog.returnValue !== 'save') return;
  const amount = Number($('cost-amount').value);
  if (!Number.isFinite(amount) || amount < 0) return banner('bad', 'Enter a cost amount.');
  if (!$('cost-desc').value.trim()) return banner('bad', 'Give the cost a description.');

  try {
    state = { ...state, ...(await api.addCost(jobId, {
      line_code: $('cost-line').value || null,
      description: $('cost-desc').value.trim(),
      amount,
      category: $('cost-category').value,
      incurred_on: $('cost-date').value.trim() || null,
    })) };
    renderJob();
    banner('ok', 'Cost logged. It now feeds the variance report and future estimates.');
  } catch (err) {
    reportError(err);
  }
});

boot();
