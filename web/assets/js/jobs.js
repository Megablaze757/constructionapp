import './pwa.js';
import { api, ready, price, titleCase, formatDate, esc, ApiError } from './api.js';

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
  if (!await ready()) {
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

/* ------------------------------------------------------------- tasks */

function renderTasks() {
  const p = state.task_progress || { total: 0, done: 0, escalated: 0, percent: 0 };
  $('task-badge').className = `badge ${p.escalated ? 'badge-bad' : p.total && p.done === p.total ? 'badge-ok' : 'badge-warn'}`;
  $('task-badge').textContent = p.total ? `${p.done}/${p.total}` : '—';

  const host = $('task-list');
  host.innerHTML = (state.tasks || []).length
    ? state.tasks.map((t) => `
        <div class="line ${t.escalated ? 'unconfirmed' : ''}">
          <div class="line-desc">
            ${t.escalated ? '<span class="dot"></span>' : ''}
            <span${t.done ? ' style="text-decoration:line-through;opacity:.6"' : ''}>${esc(t.title)}</span>
            ${t.needs_photo ? '<span class="tag tag-ai">📷 proof</span>' : ''}
            ${t.awaiting_photo ? '<span class="tag tag-ai">awaiting photo</span>' : ''}
          </div>
          <div class="line-price">${t.escalated ? `<span class="badge badge-bad">${t.days_late}d</span>` : ''}</div>
          <div class="line-qty">
            ${esc(t.person_name || 'nobody assigned')}
            ${t.due_on ? ` · due ${esc(formatDate(t.due_on))}` : ''}
            ${t.status === 'cancelled' ? ' · cancelled' : ''}
          </div>
          <div class="line-actions">
            ${!t.done && t.status !== 'cancelled'
              ? `<button class="btn btn-sm" data-task-done="${esc(t.id)}" type="button">Mark done</button>` : ''}
            ${t.status !== 'cancelled' && !t.done
              ? `<button class="btn btn-sm btn-danger" data-task-cancel="${esc(t.id)}" type="button">Cancel</button>` : ''}
          </div>
        </div>`).join('')
    : '<div class="card-body muted">No tasks yet.</div>';

  host.querySelectorAll('[data-task-done]').forEach((b) =>
    b.addEventListener('click', () => patchTask(b.dataset.taskDone, { status: 'done' })));
  host.querySelectorAll('[data-task-cancel]').forEach((b) =>
    b.addEventListener('click', () => patchTask(b.dataset.taskCancel, { status: 'cancelled' })));
}

async function patchTask(taskId, data) {
  try {
    const res = await api.patchTask(jobId, taskId, data);
    state.tasks = res.tasks;
    state.task_progress = res.task_progress;
    renderTasks();
  } catch (err) { reportError(err); }
}

/* ---------------------------------------------------------- site log */

const LOG_TONE = { issue: 'bad', delay: 'bad', safety: 'bad', delivery: 'warn', progress: '' };

function renderLogs() {
  const host = $('log-list');
  host.innerHTML = (state.logs || []).length
    ? state.logs.map((l) => {
      const needsAck = ['issue', 'delay', 'safety'].includes(l.kind) && !l.acknowledged_at;
      return `
        <div class="line ${needsAck ? 'unconfirmed' : ''}">
          <div class="line-desc">
            ${needsAck ? '<span class="dot"></span>' : ''}
            <span class="tag ${LOG_TONE[l.kind] === 'bad' ? 'tag-ai' : ''}">${esc(l.kind)}</span>
            <span>${esc(l.person_name || 'office')}</span>
          </div>
          <div class="line-price muted" style="font-size:13px">${esc(formatDate(l.created_at))}</div>
          <div class="line-qty" style="color:var(--ink)">${esc(l.body)}</div>
          ${needsAck ? `<div class="line-actions">
            <button class="btn btn-sm btn-primary" data-ack="${esc(l.id)}" type="button">Seen it</button>
          </div>` : ''}
        </div>`;
    }).join('')
    : '<div class="card-body muted">Nothing logged yet. Crew entries land here.</div>';

  host.querySelectorAll('[data-ack]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        state.logs = (await api.ackLog(jobId, b.dataset.ack)).logs;
        renderLogs();
      } catch (err) { reportError(err); }
    }));
}

/* --------------------------------------------------------- check-ins */

function renderCheckins() {
  const host = $('checkin-list');
  const rows = state.checkins || [];
  const overdueIds = new Set((state.overdue_checkins || []).map((c) => c.id));

  host.innerHTML = rows.length
    ? rows.map((c) => `
        <div class="line ${overdueIds.has(c.id) ? 'unconfirmed' : ''}">
          <div class="line-desc">
            ${overdueIds.has(c.id) ? '<span class="dot"></span>' : ''}
            <span${c.status === 'done' ? ' style="text-decoration:line-through;opacity:.6"' : ''}>${esc(c.milestone)}</span>
          </div>
          <div class="line-price"></div>
          <div class="line-qty">${c.due_on ? esc(formatDate(c.due_on)) : 'unscheduled'} · ${esc(c.status)}</div>
          ${c.status === 'due' ? `<div class="line-actions">
            <button class="btn btn-sm btn-primary" data-checkin-done="${esc(c.id)}" type="button">Done</button>
            <button class="btn btn-sm" data-checkin-skip="${esc(c.id)}" type="button">Skip</button>
          </div>` : ''}
        </div>`).join('')
    : '<div class="card-body muted">No check-ins scheduled.</div>';

  $('schedule-checkins-btn').hidden = rows.length > 0;

  const patch = async (id, status) => {
    try {
      const res = await api.patchCheckin(jobId, id, { status });
      state.checkins = res.checkins;
      state.overdue_checkins = res.overdue_checkins;
      renderCheckins();
    } catch (err) { reportError(err); }
  };
  host.querySelectorAll('[data-checkin-done]').forEach((b) =>
    b.addEventListener('click', () => patch(b.dataset.checkinDone, 'done')));
  host.querySelectorAll('[data-checkin-skip]').forEach((b) =>
    b.addEventListener('click', () => patch(b.dataset.checkinSkip, 'skipped')));
}

$('schedule-checkins-btn')?.addEventListener('click', async () => {
  try {
    const res = await api.scheduleCheckins(jobId);
    state.checkins = res.checkins;
    state.overdue_checkins = res.overdue_checkins;
    renderCheckins();
  } catch (err) { reportError(err); }
});

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
  renderTasks();
  renderLogs();
  renderCheckins();

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

/* --------------------------------------------------- task & log dialogs */

const taskDialog = $('task-dialog');
const logDialog = $('log-dialog');

$('add-task-btn')?.addEventListener('click', () => {
  $('t-title').value = '';
  $('t-due').value = '';
  $('t-grace').value = '2';
  $('t-photo').checked = false;
  $('t-person').innerHTML = '<option value="">Nobody yet</option>'
    + state.crew.map((c) => `<option value="${esc(c.person_id)}">${esc(c.name)}</option>`).join('')
    + state.people.filter((p) => !state.crew.some((c) => c.person_id === p.id))
        .map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (not on this job)</option>`).join('');
  taskDialog.showModal();
});

taskDialog?.addEventListener('close', async () => {
  if (taskDialog.returnValue !== 'save') return;
  const title = $('t-title').value.trim();
  if (!title) return banner('bad', 'Say what needs doing.');
  try {
    const res = await api.addTask(jobId, {
      title,
      person_id: $('t-person').value || null,
      due_on: $('t-due').value.trim() || null,
      needs_photo: $('t-photo').checked,
      grace_days: Number($('t-grace').value) || 0,
    });
    state.tasks = res.tasks;
    state.task_progress = res.task_progress;
    renderTasks();
  } catch (err) { reportError(err); }
});

$('add-log-btn')?.addEventListener('click', () => {
  $('l-body').value = '';
  $('l-kind').value = 'progress';
  logDialog.showModal();
});

logDialog?.addEventListener('close', async () => {
  if (logDialog.returnValue !== 'save') return;
  const body = $('l-body').value.trim();
  if (!body) return banner('bad', 'Write what happened.');
  try {
    state.logs = (await api.addLog(jobId, { kind: $('l-kind').value, body })).logs;
    renderLogs();
  } catch (err) { reportError(err); }
});

/* ---------------------------------------------------------- new job */

const newJobDialog = $('new-job-dialog');

$('new-job-btn')?.addEventListener('click', () => {
  for (const id of ['nj-client', 'nj-type', 'nj-site', 'nj-phone', 'nj-start', 'nj-end', 'nj-price', 'nj-cost']) {
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
      client_phone: $('nj-phone').value.trim() || null,
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
