/**
 * The crew view.
 *
 * Reached by an unguessable per-person link, so there is no login. Built for
 * someone standing on a site: big targets, few words, and the camera one tap
 * away because half of what this screen exists to capture is photo proof.
 */

import { crewCall, formatDate, esc, ApiError } from './api.js';
import { downscale } from './photos.js';

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get('t');

let data = { person: null, jobs: [], tasks: [] };
let pendingPhoto = null;      // photo_id captured for the dialog currently open
let photoTarget = null;       // what the next capture belongs to

const banner = (kind, html) =>
  ($('banner').innerHTML = `<div class="card"><div class="card-body"><div class="notice notice-${kind}">${html}</div></div></div>`);
const clearBanner = () => ($('banner').innerHTML = '');

const call = (path, options) => crewCall(token, path, options);

async function boot() {
  if (!token) return banner('bad', 'This link is missing its code. Ask for a new one.');
  try {
    data = await call('');
    render();
  } catch (err) {
    $('who').textContent = 'Link not valid';
    banner('bad', err.status === 404
      ? 'This link is no longer valid. Ask your office for a new one.'
      : esc(err.message));
  }
}

function render() {
  $('who').textContent = data.person.name.split(' ')[0] ? `Hi ${data.person.name.split(' ')[0]}` : 'My jobs';
  renderTasks();
  renderJobs();
}

/* ------------------------------------------------------------------ tasks */

function renderTasks() {
  const open = data.tasks.filter((t) => !t.done);
  $('tasks-card').hidden = open.length === 0;
  if (!open.length) {
    // Clear as well as hide: leaving the old rows in the DOM means they flash
    // back the moment the card is shown again.
    $('tasks').innerHTML = '';
    return;
  }

  $('tasks').innerHTML = open.map((t) => `
    <div class="line ${t.overdue ? 'unconfirmed' : ''}">
      <div class="line-desc">
        ${t.overdue ? '<span class="dot"></span>' : ''}
        <span>${esc(t.title)}</span>
        ${t.needs_photo ? '<span class="tag tag-ai">📷 photo needed</span>' : ''}
      </div>
      <div class="line-price"></div>
      <div class="line-qty">
        ${esc(t.site_address || t.client_name || '')}
        ${t.due_on ? ` · due ${esc(formatDate(t.due_on))}` : ''}
        ${t.overdue ? ` · <strong>${t.days_late} days late</strong>` : ''}
      </div>
      ${t.detail ? `<div class="line-note">${esc(t.detail)}</div>` : ''}
      <div class="line-actions">
        <button class="btn btn-sm btn-accept" data-done="${esc(t.id)}" data-photo="${t.needs_photo ? '1' : ''}" type="button">
          ${t.needs_photo ? '📷 Photo & done' : 'Mark done'}
        </button>
      </div>
    </div>`).join('');

  $('tasks').querySelectorAll('[data-done]').forEach((b) =>
    b.addEventListener('click', () => completeTask(b.dataset.done, b.dataset.photo === '1', b)));
}

async function completeTask(taskId, needsPhoto, btn) {
  clearBanner();
  try {
    let photoId = null;
    if (needsPhoto) {
      // Ask for the photo while the person is still standing in front of it.
      photoId = await capturePhoto(jobIdForTask(taskId), btn);
      if (!photoId) return;
    }
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Saving…';
    const res = await call(`/tasks/${encodeURIComponent(taskId)}`, {
      method: 'POST',
      body: { done: true, photo_id: photoId },
    });
    data.tasks = res.tasks;
    renderTasks();
    banner('ok', 'Done — the office can see it.');
  } catch (err) {
    banner('bad', esc(err.message));
    btn.disabled = false;
    btn.textContent = needsPhoto ? '📷 Photo & done' : 'Mark done';
  }
}

const jobIdForTask = (taskId) => data.tasks.find((t) => t.id === taskId)?.job_id;

/* ------------------------------------------------------------------- jobs */

function renderJobs() {
  if (!data.jobs.length) {
    $('jobs').innerHTML = '<div class="card"><div class="card-body muted">You are not on any jobs right now.</div></div>';
    return;
  }

  $('jobs').innerHTML = data.jobs.map((j) => `
    <div class="card">
      <h2>${esc(j.client_name)} <span class="status status-sent">${esc(j.status.replace('_', ' '))}</span></h2>
      <div class="card-body">
        <p class="muted" style="margin:0">
          ${esc(j.site_address || '')}${j.target_end ? ` · finish by ${esc(formatDate(j.target_end))}` : ''}
        </p>
        <button class="btn btn-primary" data-log="${esc(j.id)}" type="button">✍️ Log an update</button>
      </div>

      ${j.checklists.length ? j.checklists.map((c) => `
        <div class="card-body" style="border-top:1px solid var(--line)">
          <div class="total-row">
            <span><strong>${esc(c.title)}</strong></span>
            <span class="badge ${c.progress.complete ? 'badge-ok' : 'badge-warn'}">${c.progress.done}/${c.progress.total}</span>
          </div>
          <div class="progress"><span style="width:${c.progress.percent}%"></span></div>
          ${c.steps.map((st, i) => {
            const awaiting = st.done && st.needs_photo && !st.photo_id;
            return `
              <label class="sop-check ${awaiting ? 'awaiting' : ''}">
                <input type="checkbox" data-checklist="${esc(c.id)}" data-step="${i}"
                       data-job="${esc(j.id)}" data-needsphoto="${st.needs_photo ? '1' : ''}"
                       ${st.done && !awaiting ? 'checked' : ''}>
                <span>${st.needs_photo ? '📷 ' : ''}${esc(st.text)}${awaiting ? ' — photo still needed' : ''}</span>
              </label>`;
          }).join('')}
        </div>`).join('') : ''}

      ${j.sops.length ? `
        <div class="card-body" style="border-top:1px solid var(--line)">
          <p class="muted" style="margin:0"><strong>How we do it</strong></p>
          ${j.sops.map((s) => `
            <details class="sop-detail">
              <summary>${esc(s.title)}</summary>
              <ul class="sop-steps">${s.steps.map((st) => `<li>${st.needs_photo ? '📷 ' : ''}${esc(st.text)}</li>`).join('')}</ul>
            </details>`).join('')}
        </div>` : ''}

      ${j.recent_log.length ? `
        <div class="card-body" style="border-top:1px solid var(--line)">
          <p class="muted" style="margin:0"><strong>Recent updates</strong></p>
          ${j.recent_log.map((l) => `
            <div class="line-qty" style="padding:4px 0">
              <span class="tag">${esc(l.kind)}</span> ${esc(l.body)}
              <span class="muted">— ${esc(l.person_name || 'office')}</span>
            </div>`).join('')}
        </div>` : ''}
    </div>`).join('');

  $('jobs').querySelectorAll('[data-log]').forEach((b) =>
    b.addEventListener('click', () => openLog(b.dataset.log)));

  $('jobs').querySelectorAll('[data-checklist]').forEach((box) =>
    box.addEventListener('change', () => tickStep(box)));
}

async function tickStep(box) {
  clearBanner();
  const { checklist, step, job, needsphoto } = box.dataset;
  try {
    let photoId = null;
    if (needsphoto === '1' && box.checked) {
      photoId = await capturePhoto(job, box);
      if (!photoId) { box.checked = false; return; }
    }
    const res = await call(`/checklists/${encodeURIComponent(checklist)}`, {
      method: 'PATCH',
      body: { step: Number(step), done: box.checked, photo_id: photoId },
    });
    const j = data.jobs.find((x) => x.id === job);
    j.checklists = res.checklists;
    renderJobs();
  } catch (err) {
    box.checked = !box.checked;
    banner('bad', esc(err.message));
  }
}

/* ------------------------------------------------------------------ photo */

const photoInput = $('photo-input');

/** Opens the camera and resolves with a stored photo id, or null if cancelled. */
function capturePhoto(jobId, statusEl) {
  return new Promise((resolve) => {
    photoTarget = { jobId, resolve, statusEl };
    photoInput.value = '';
    photoInput.click();
    // A cancelled file picker fires no event at all, so nothing resolves until
    // the user tries again — deliberate, rather than guessing with a timeout.
  });
}

photoInput.addEventListener('change', async () => {
  const file = photoInput.files[0];
  const target = photoTarget;
  photoTarget = null;
  if (!file || !target) return target?.resolve(null);

  try {
    if (target.statusEl && target.statusEl.tagName === 'BUTTON') {
      target.statusEl.innerHTML = '<span class="spinner"></span> Uploading photo…';
    }
    const photo = await downscale(file);
    const res = await call('/photo', { method: 'POST', body: { ...photo, job_id: target.jobId } });
    target.resolve(res.photo_id);
  } catch (err) {
    banner('bad', `Could not upload the photo: ${esc(err.message)}`);
    target.resolve(null);
  }
});

/* -------------------------------------------------------------- site log */

const logDialog = $('log-dialog');
let logJobId = null;

function openLog(jobId) {
  logJobId = jobId;
  pendingPhoto = null;
  $('log-body').value = '';
  $('log-kind').value = 'progress';
  $('log-photo-status').textContent = '';
  const job = data.jobs.find((j) => j.id === jobId);
  $('log-title').textContent = `Update — ${job ? job.client_name : ''}`;
  logDialog.showModal();
}

$('log-photo-btn').addEventListener('click', async () => {
  const id = await capturePhoto(logJobId, null);
  pendingPhoto = id;
  $('log-photo-status').textContent = id ? '📷 Photo attached' : 'No photo attached';
});

logDialog.addEventListener('close', async () => {
  if (logDialog.returnValue !== 'save') return;
  const body = $('log-body').value.trim();
  if (!body) return banner('bad', 'Write what happened first.');

  try {
    await call('/log', {
      method: 'POST',
      body: { job_id: logJobId, kind: $('log-kind').value, body, photo_id: pendingPhoto },
    });
    banner('ok', 'Sent to the office.');
    data = await call('');
    render();
  } catch (err) {
    banner('bad', esc(err.message));
  }
});

boot();
