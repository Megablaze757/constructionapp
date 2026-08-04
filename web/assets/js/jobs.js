import './pwa.js';
import { api, ownerToken, API_BASE, price, titleCase, formatDate, esc, ApiError } from './api.js';

const $ = (id) => document.getElementById(id);
const jobId = new URLSearchParams(location.search).get('id');

let state = { job: null, costs: [], variance: null, quotedLines: [], crew: [], sops: [], people: [], library: [] };

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
    // The Phase 0 success criterion: every job and who is on it, in one place.
    host.innerHTML = jobs.map((j) => {
      const actual = Number(j.actual_cost) || 0;
      const over = j.cost_entries > 0 && actual > j.cost_baseline;
      const crew = j.crew.length
        ? j.crew.map((c) => esc(c.name)).join(', ')
        : '<em>nobody assigned</em>';
      const sop = j.sop_progress && j.sop_progress.total
        ? ` · checklist ${j.sop_progress.done}/${j.sop_progress.total}`
        : '';
      return `
        <a class="quote-item" href="jobs.html?id=${encodeURIComponent(j.id)}">
          <span class="who">${esc(j.client_name)}</span>
          <span class="status status-${j.status === 'complete' ? 'accepted' : 'sent'}">${esc(j.status.replace('_', ' '))}</span>
          <span class="meta">
            ${esc(j.site_address || titleCase(j.job_type))}
            ${j.target_start ? ` · from ${esc(formatDate(j.target_start))}` : ''}${sop}
          </span>
          <span class="meta">👷 ${crew}</span>
          <span class="meta">
            ${price(j.budget_baseline)}
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
    const [res, { people }, { sops: library }] = await Promise.all([
      api.getJob(jobId), api.people(), api.sops(),
    ]);
    state = { ...state, ...res, people, library };

    // The quote's own lines are what a cost gets booked against, so an owner
    // picks a real line rather than typing a code. A manually created job has
    // no quote, which is fine — costs just go in unallocated.
    if (res.job.quote_id) {
      try {
        const q = await api.getQuote(res.job.quote_id);
        state.quotedLines = q.lines.filter((l) => l.kind !== 'extra' || l.selected);
      } catch {
        state.quotedLines = [];
      }
    } else {
      state.quotedLines = [];
    }
    renderJob();
  } catch (err) {
    reportError(err);
  }
}

/* -------------------------------------------------------------- crew */

function renderCrew() {
  const host = $('crew-list');
  host.innerHTML = state.crew.length
    ? state.crew.map((c) => `
        <div class="line">
          <div class="line-desc"><span>${esc(c.name)}</span>
            <span class="tag">${esc(c.kind === 'subcontractor' ? 'sub' : 'staff')}</span>
          </div>
          <div class="line-price"></div>
          <div class="line-qty">${esc(c.role_on_job || c.trade || '—')}${c.phone ? ` · <a href="tel:${esc(c.phone)}">${esc(c.phone)}</a>` : ''}</div>
          <div class="line-actions">
            <button class="btn btn-sm btn-danger" data-unassign="${esc(c.person_id)}" type="button">Remove</button>
          </div>
        </div>`).join('')
    : '<div class="card-body muted">Nobody assigned yet.</div>';

  const assigned = new Set(state.crew.map((c) => c.person_id));
  const available = state.people.filter((p) => !assigned.has(p.id));
  $('crew-picker').innerHTML = available.length
    ? available.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}${p.role ? ` — ${esc(p.role)}` : ''}</option>`).join('')
    : '<option value="">Everyone is already on this job</option>';
  $('assign-btn').disabled = !available.length;

  host.querySelectorAll('[data-unassign]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        state.crew = (await api.unassignCrew(jobId, b.dataset.unassign)).crew;
        renderCrew();
      } catch (err) { reportError(err); }
    }));
}

/* -------------------------------------------------------------- SOPs */

function renderSops() {
  const host = $('sop-list');
  host.innerHTML = state.sops.length
    ? state.sops.map((s) => `
        <div class="card-body" style="border-top:1px solid var(--line)">
          <div class="total-row">
            <span><strong>${esc(s.title)}</strong></span>
            <span class="badge ${s.progress.complete ? 'badge-ok' : 'badge-warn'}">${s.progress.done}/${s.progress.total}</span>
          </div>
          <div class="progress"><span style="width:${s.progress.percent}%"></span></div>
          ${s.progress.awaiting_photo
            ? `<div class="notice notice-warn">${s.progress.awaiting_photo} step${s.progress.awaiting_photo > 1 ? 's are' : ' is'} ticked but still needs a photo before it counts.</div>`
            : ''}
          <div>
            ${s.steps.map((st, i) => {
              const awaiting = st.done && st.needs_photo && !st.photo_id;
              return `
                <label class="sop-check ${awaiting ? 'awaiting' : ''}">
                  <input type="checkbox" data-sop="${esc(s.id)}" data-step="${i}" ${st.done ? 'checked' : ''}>
                  <span>${st.needs_photo ? '📷 ' : ''}${esc(st.text)}${awaiting ? ' — photo needed' : ''}</span>
                </label>`;
            }).join('')}
          </div>
          <button class="btn btn-sm btn-danger" data-drop-sop="${esc(s.id)}" type="button">Remove checklist</button>
        </div>`).join('')
    : '<div class="card-body muted">No checklists attached.</div>';

  const attached = new Set(state.sops.map((s) => s.sop_id));
  const available = state.library.filter((s) => !attached.has(s.id));
  $('sop-picker').innerHTML = available.length
    ? available.map((s) => `<option value="${esc(s.id)}">${esc(s.title)}</option>`).join('')
    : '<option value="">All checklists attached</option>';
  $('attach-sop-btn').disabled = !available.length;

  host.querySelectorAll('[data-sop]').forEach((box) =>
    box.addEventListener('change', async () => {
      try {
        // Photo proof isn't wired to the camera on this screen yet, so a step
        // that needs one stays "awaiting photo" until it is attached.
        const res = await api.tickSopStep(jobId, box.dataset.sop, Number(box.dataset.step), box.checked);
        state.sops = res.sops;
        renderSops();
      } catch (err) { reportError(err); }
    }));

  host.querySelectorAll('[data-drop-sop]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        state.sops = (await api.removeJobSop(jobId, b.dataset.dropSop)).sops;
        renderSops();
      } catch (err) { reportError(err); }
    }));
}

$('assign-btn')?.addEventListener('click', async () => {
  const personId = $('crew-picker').value;
  if (!personId) return;
  try {
    state.crew = (await api.assignCrew(jobId, personId)).crew;
    renderCrew();
  } catch (err) { reportError(err); }
});

$('attach-sop-btn')?.addEventListener('click', async () => {
  const sopId = $('sop-picker').value;
  if (!sopId) return;
  try {
    state.sops = (await api.attachSop(jobId, sopId)).sops;
    renderSops();
  } catch (err) { reportError(err); }
});

function renderJob() {
  const { job, costs, variance: v } = state;
  $('job-title').textContent = `${job.client_name} — ${job.site_address || titleCase(job.job_type)}`;
  const dates = job.target_start || job.target_end
    ? ` · ${formatDate(job.target_start) || '?'} → ${formatDate(job.target_end) || '?'}`
    : '';
  $('job-meta').textContent = `${titleCase(job.job_type)}${dates} · booked ${formatDate(job.created_at)}${job.completed_at ? ` · completed ${formatDate(job.completed_at)}` : ''}`;
  $('job-status').value = job.status;
  renderCrew();
  renderSops();

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

/* ---------------------------------------------------------- new job */

const newJobDialog = $('new-job-dialog');

$('new-job-btn')?.addEventListener('click', () => {
  for (const id of ['nj-client', 'nj-type', 'nj-site', 'nj-start', 'nj-end', 'nj-price', 'nj-cost']) {
    $(id).value = '';
  }
  newJobDialog.showModal();
});

newJobDialog?.addEventListener('close', async () => {
  if (newJobDialog.returnValue !== 'save') return;
  const client = $('nj-client').value.trim();
  const type = $('nj-type').value.trim().toLowerCase().replace(/\s+/g, '_');
  if (!client) return banner('bad', 'A client name is required.');
  if (!type) return banner('bad', 'A job type is required.');

  try {
    const { job } = await api.createJob({
      client_name: client,
      job_type: type,
      site_address: $('nj-site').value.trim() || null,
      target_start: $('nj-start').value.trim() || null,
      target_end: $('nj-end').value.trim() || null,
      budget_baseline: Number($('nj-price').value) || 0,
      cost_baseline: Number($('nj-cost').value) || 0,
    });
    location.href = `jobs.html?id=${encodeURIComponent(job.id)}`;
  } catch (err) {
    reportError(err);
  }
});

boot();
