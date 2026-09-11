import './pwa.js';
import { api, ready, price, esc, ApiError } from './api.js';

const $ = (id) => document.getElementById(id);
let people = [];
let editingId = null;

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
    ({ people } = await api.people($('show-inactive').checked));
    render();
  } catch (err) {
    reportError(err);
  }
}

function render() {
  for (const [kind, host] of [['staff', $('staff')], ['subcontractor', $('subs')]]) {
    const rows = people.filter((p) => p.kind === kind);
    host.innerHTML = rows.length
      ? rows.map(personRow).join('')
      : '<div class="card-body muted">Nobody here yet.</div>';
  }
  document.querySelectorAll('[data-edit]').forEach((b) =>
    b.addEventListener('click', () => openDialog(b.dataset.edit)));
}

function personRow(p) {
  const detail = [p.role, p.trade].filter(Boolean).join(' · ');
  return `
    <div class="line ${p.active ? '' : 'unconfirmed'}">
      <div class="line-desc">
        <span>${esc(p.name)}</span>
        ${p.active ? '' : '<span class="tag">left</span>'}
        ${p.active_jobs > 0 ? `<span class="tag">${p.active_jobs} job${p.active_jobs > 1 ? 's' : ''}</span>` : ''}
      </div>
      <div class="line-price">${p.day_rate ? `${price(p.day_rate)}/day` : ''}</div>
      <div class="line-qty">${esc(detail || '—')}${p.phone ? ` · <a href="tel:${esc(p.phone)}">${esc(p.phone)}</a>` : ''}</div>
      <div class="line-actions">
        ${p.phone ? `<a class="btn btn-sm btn-whatsapp" href="https://wa.me/${esc(p.phone.replace(/[^0-9]/g, ''))}" target="_blank" rel="noopener" style="padding:4px 10px; font-size:12px; min-height:36px;">💬 WhatsApp</a>` : ''}
        <button class="btn btn-sm" type="button" data-edit="${esc(p.id)}">edit</button>
      </div>
    </div>`;
}

/* ---------------------------------------------------------------- dialog */

const dialog = $('person-dialog');

function openDialog(id) {
  editingId = id || null;
  const p = id ? people.find((x) => x.id === id) : null;
  $('person-title').textContent = p ? `Edit ${p.name}` : 'Add someone';
  $('p-name').value = p?.name || '';
  $('p-kind').value = p?.kind || 'staff';
  $('p-trade').value = p?.trade || '';
  $('p-role').value = p?.role || '';
  $('p-phone').value = p?.phone || '';
  $('p-rate').value = p?.day_rate ?? '';
  // Only offer "mark as left" for someone currently active.
  $('p-deactivate').hidden = !p || !p.active;
  // A crew link only makes sense for someone who is still working here.
  $('p-link').hidden = !p || !p.active;
  dialog.showModal();
}

$('add-btn').addEventListener('click', () => openDialog(null));
$('show-inactive').addEventListener('change', load);

dialog.addEventListener('close', async () => {
  const action = dialog.returnValue;
  if (action === 'cancel') return;

  try {
    if (action === 'link') {
      const { url, token } = await api.crewLink(editingId);
      // PUBLIC_APP_URL may not be set locally, so fall back to this origin.
      const full = url && url.startsWith('http')
        ? url
        : `${location.origin}${location.pathname.replace(/team\.html$/, '')}crew.html?t=${token}`;
      $('link-url').value = full;
      $('open-link').href = full;
      $('link-dialog').showModal();
      return;
    }
    if (action === 'deactivate') {
      await api.deactivatePerson(editingId);
      banner('ok', 'Marked as left. Their past jobs keep their name on them.');
      return load();
    }

    const name = $('p-name').value.trim();
    if (!name) return banner('bad', 'A name is required.');
    const payload = {
      name,
      kind: $('p-kind').value,
      trade: $('p-trade').value.trim() || null,
      role: $('p-role').value.trim() || null,
      phone: $('p-phone').value.trim() || null,
      day_rate: $('p-rate').value === '' ? null : Number($('p-rate').value),
    };
    if (editingId) await api.patchPerson(editingId, payload);
    else await api.addPerson(payload);
    await load();
  } catch (err) {
    reportError(err);
  }
});

$('copy-link').addEventListener('click', async (e) => {
  try {
    await navigator.clipboard.writeText($('link-url').value);
    e.currentTarget.textContent = 'Copied ✓';
  } catch {
    $('link-url').select();
    e.currentTarget.textContent = 'Press ⌘/Ctrl+C';
  }
});

boot();
