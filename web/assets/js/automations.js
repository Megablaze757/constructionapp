import './pwa.js';
import { api, ownerToken, API_BASE, formatDate, esc, ApiError } from './api.js';

const $ = (id) => document.getElementById(id);
let catalogue = { triggers: [], actions: [] };
let messaging = { driver: 'simulated' };

const banner = (kind, html) =>
  ($('banner').innerHTML = `<div class="card"><div class="card-body"><div class="notice notice-${kind}">${html}</div></div></div>`);

function reportError(err) {
  banner('bad', err instanceof ApiError && err.status === 401
    ? '<strong>Token rejected.</strong> Set it on the <a href="index.html">quotes screen</a>.'
    : `<strong>Error.</strong> ${esc(err.message)}`);
}

async function boot() {
  if (!API_BASE || !ownerToken.get()) {
    return banner('bad', 'Not configured. Set your owner token on the <a href="index.html">quotes screen</a>.');
  }
  await Promise.all([loadRules(), loadOutbox()]);
}

/* ------------------------------------------------------------------ rules */

async function loadRules() {
  try {
    const d = await api.automations();
    catalogue = d.catalogue;
    messaging = d.messaging;
    renderDriver();
    renderRules(d.automations);
  } catch (err) { reportError(err); }
}

function renderDriver() {
  const simulated = messaging.driver === 'simulated';
  $('driver-status').innerHTML = simulated
    ? `<div class="notice notice-warn">
         <strong>No message provider connected.</strong>
         Rules still run, and every message is recorded in the outbox marked
         <strong style="display:inline">simulated</strong> so you can read exactly what would
         have gone out — but nothing is actually sent to anybody. Connect a provider and the
         same rules start sending for real.
       </div>`
    : `<div class="notice notice-ok"><strong>Messages are being sent</strong> via the
         <code>${esc(messaging.driver)}</code> provider.</div>`;
}

function renderRules(rules) {
  $('rules').innerHTML = rules.map((r) => {
    const trigger = catalogue.triggers.find((t) => t.type === r.trigger_type);
    const params = Object.entries(r.trigger_config || {}).map(([k, v]) => `${k}: ${v}`).join(', ');
    const sends = r.actions.some((a) => a.type === 'message_client' || a.type === 'message_person');
    return `
      <div class="line ${r.enabled ? '' : 'muted'}">
        <div class="line-desc">
          <span>${esc(r.name)}</span>
          ${sends ? '<span class="tag tag-ai">messages a person</span>' : '<span class="tag">alerts you</span>'}
        </div>
        <div class="line-price">
          <label class="inline-check" style="justify-content:flex-end">
            <input type="checkbox" data-toggle="${esc(r.id)}" ${r.enabled ? 'checked' : ''}>
          </label>
        </div>
        <div class="line-qty">
          WHEN ${esc(trigger ? trigger.label : r.trigger_type)}${params ? ` (${esc(params)})` : ''}
          · THEN ${r.actions.map((a) => esc(a.type.replace(/_/g, ' '))).join(' + ')}
          ${r.times_fired ? ` · fired ${r.times_fired}× (last ${esc(formatDate(r.last_fired))})` : ' · never fired'}
        </div>
        ${r.actions.filter((a) => a.message).map((a) => `<div class="line-note">${esc(a.message)}</div>`).join('')}
        ${!r.template_key ? `<div class="line-actions">
          <button class="btn btn-sm btn-danger" data-delete="${esc(r.id)}" type="button">Delete</button>
        </div>` : ''}
      </div>`;
  }).join('');

  $('rules').querySelectorAll('[data-toggle]').forEach((box) =>
    box.addEventListener('change', async () => {
      try {
        await api.patchAutomation(box.dataset.toggle, { enabled: box.checked });
        await loadRules();
      } catch (err) { reportError(err); box.checked = !box.checked; }
    }));

  $('rules').querySelectorAll('[data-delete]').forEach((b) =>
    b.addEventListener('click', async () => {
      try {
        await api.deleteAutomation(b.dataset.delete);
        await loadRules();
      } catch (err) { reportError(err); }
    }));
}

/* ----------------------------------------------------------------- outbox */

const STATUS_TONE = { sent: 'badge-ok', simulated: 'badge-warn', failed: 'badge-bad', queued: 'badge-warn' };

async function loadOutbox() {
  try {
    const { outbox } = await api.outbox();
    $('outbox').innerHTML = outbox.length
      ? outbox.map((o) => `
          <div class="line">
            <div class="line-desc">
              <span>${esc(o.recipient_name || o.recipient || 'Owner')}</span>
              <span class="tag">${esc(o.channel.replace('_', ' '))}</span>
            </div>
            <div class="line-price"><span class="badge ${STATUS_TONE[o.status] || ''}">${esc(o.status)}</span></div>
            <div class="line-qty" style="color:var(--ink)">${esc(o.body)}</div>
            <div class="line-qty">
              ${esc(o.automation_name || 'manual')} · ${esc(formatDate(o.created_at))}
              ${o.error ? ` · <span style="color:var(--bad)">${esc(o.error)}</span>` : ''}
            </div>
          </div>`).join('')
      : '<div class="card-body muted">Nothing has gone out yet.</div>';
  } catch (err) { reportError(err); }
}

/* -------------------------------------------------------------- run / dry */

async function run(dry) {
  const btn = dry ? $('dry-btn') : $('run-btn');
  const original = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Working…';
  try {
    const res = await api.runAutomations(dry);
    $('run-title').textContent = dry ? 'What would happen' : 'Run finished';
    $('run-results').innerHTML = `
      <p class="muted" style="margin:0">
        ${res.fired} rule${res.fired === 1 ? '' : 's'} fired,
        ${res.skipped_already_done} skipped as already done.
        Provider: <code>${esc(res.driver)}</code>.
      </p>
      ${res.results.length ? res.results.map((r) => `
        <div class="notice ${r.actions.some((a) => a.status === 'failed') ? 'notice-bad' : 'notice-warn'}">
          <strong>${esc(r.automation)}</strong>
          <ul>${r.actions.map((a) => `
            <li>${esc(a.type.replace(/_/g, ' '))} — <strong>${esc(a.status.replace(/_/g, ' '))}</strong>
            ${a.error ? ` — ${esc(a.error)}` : ''}
            ${a.body ? `<br><span class="muted">${esc(a.body)}</span>` : ''}</li>`).join('')}
          </ul>
        </div>`).join('')
      : '<div class="notice notice-ok">Nothing needed doing.</div>'}
      ${dry ? '<p class="muted" style="margin:0">This was a preview — nothing was sent or recorded.</p>' : ''}`;
    $('run-dialog').showModal();
    if (!dry) await Promise.all([loadRules(), loadOutbox()]);
  } catch (err) {
    reportError(err);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

$('dry-btn').addEventListener('click', () => run(true));
$('run-btn').addEventListener('click', () => run(false));

/* ----------------------------------------------------------- rule builder */

const ruleDialog = $('rule-dialog');

$('new-btn').addEventListener('click', () => {
  $('r-name').value = '';
  $('r-message').value = '';
  $('r-title').value = '';
  $('r-trigger').innerHTML = catalogue.triggers
    .map((t) => `<option value="${esc(t.type)}">${esc(t.label)}</option>`).join('');
  $('r-action').innerHTML = catalogue.actions
    .map((a) => `<option value="${esc(a.type)}">${esc(a.label)}</option>`).join('');
  syncTrigger();
  syncAction();
  ruleDialog.showModal();
});

function syncTrigger() {
  const t = catalogue.triggers.find((x) => x.type === $('r-trigger').value);
  $('r-params').innerHTML = (t?.params || []).map((p) => `
    <label>${esc(p.label)}
      <input type="number" data-param="${esc(p.key)}" value="${esc(p.default)}" inputmode="numeric">
    </label>`).join('');
  $('r-placeholders').textContent = t
    ? `Fires on: ${t.entity}. Use placeholders like {client_name} — the preview shows what they fill in with.`
    : '';
}

function syncAction() {
  const type = $('r-action').value;
  const needsChannel = type === 'message_client' || type === 'message_person';
  const isTask = type === 'create_task';
  $('r-channel-row').hidden = !needsChannel;
  $('r-message-row').hidden = isTask;
  $('r-title-row').hidden = !isTask;
}

$('r-trigger').addEventListener('change', syncTrigger);
$('r-action').addEventListener('change', syncAction);

ruleDialog.addEventListener('close', async () => {
  if (ruleDialog.returnValue !== 'save') return;
  const type = $('r-action').value;
  const action = { type };
  if (type === 'create_task') action.title = $('r-title').value.trim();
  else action.message = $('r-message').value.trim();
  if (type === 'message_client' || type === 'message_person') action.channel = $('r-channel').value;

  const trigger_config = {};
  document.querySelectorAll('[data-param]').forEach((i) => {
    trigger_config[i.dataset.param] = Number(i.value);
  });

  try {
    await api.createAutomation({
      name: $('r-name').value.trim(),
      trigger_type: $('r-trigger').value,
      trigger_config,
      actions: [action],
    });
    banner('ok', '<strong>Rule created.</strong> Preview it before you let it loose.');
    await loadRules();
  } catch (err) { reportError(err); }
});

boot();
