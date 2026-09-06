import './pwa.js';
import { api, ready, titleCase, esc, ApiError } from './api.js';

const $ = (id) => document.getElementById(id);

const banner = (kind, html) =>
  ($('banner').innerHTML = `<div class="card"><div class="card-body"><div class="notice notice-${kind}">${html}</div></div></div>`);

function reportError(err) {
  banner('bad', err instanceof ApiError && err.status === 401
    ? '<strong>Token rejected.</strong> Set it on the <a href="index.html">quotes screen</a>.'
    : `<strong>Error.</strong> ${esc(err.message)}`);
}

async function boot() {
  if (!await ready()) {
    return banner('bad', 'Not configured. Set your owner token on the <a href="index.html">quotes screen</a>.');
  }
  await load();
}

async function load() {
  try {
    const { sops } = await api.sops();
    render(sops);
  } catch (err) {
    reportError(err);
  }
}

function render(sops) {
  if (!sops.length) {
    $('sop-list').innerHTML = '<div class="card"><div class="card-body muted">No SOPs yet.</div></div>';
    return;
  }

  // Grouped by category, because an owner looks for "the safety one" rather
  // than scrolling an undifferentiated list.
  const byCategory = new Map();
  for (const s of sops) {
    if (!byCategory.has(s.category)) byCategory.set(s.category, []);
    byCategory.get(s.category).push(s);
  }

  $('sop-list').innerHTML = [...byCategory.entries()].map(([category, rows]) => `
    <div class="card">
      <h2>${esc(titleCase(category))}</h2>
      <div class="lines">
        ${rows.map((s) => `
          <div class="line">
            <div class="line-desc"><span>${esc(s.title)}</span>
              ${s.job_type ? `<span class="tag">${esc(titleCase(s.job_type))}</span>` : ''}
              ${s.role ? `<span class="tag">${esc(s.role)}</span>` : ''}
            </div>
            <div class="line-price">${s.steps.length} steps</div>
            <ul class="sop-steps">
              ${s.steps.map((st) => `<li>${st.needs_photo ? '📷 ' : ''}${esc(st.text)}</li>`).join('')}
            </ul>
          </div>`).join('')}
      </div>
    </div>`).join('');
}

/* ---------------------------------------------------------------- dialog */

const dialog = $('sop-dialog');
$('add-btn').addEventListener('click', () => {
  $('s-title').value = '';
  $('s-category').value = '';
  $('s-steps').value = '';
  dialog.showModal();
});

dialog.addEventListener('close', async () => {
  if (dialog.returnValue !== 'save') return;
  const title = $('s-title').value.trim();
  if (!title) return banner('bad', 'Give the SOP a title.');

  // "* " prefix marks a step that needs photo proof — quicker to type on a
  // phone than a checkbox per line.
  const steps = $('s-steps').value
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (l.startsWith('*')
      ? { text: l.replace(/^\*\s*/, ''), needs_photo: true }
      : { text: l, needs_photo: false }))
    .filter((s) => s.text);

  if (!steps.length) return banner('bad', 'Add at least one step.');

  try {
    await api.addSop({ title, category: $('s-category').value.trim() || 'general', steps });
    banner('ok', `<strong>Saved.</strong> "${esc(title)}" can now be attached to a job.`);
    await load();
  } catch (err) {
    reportError(err);
  }
});

boot();
