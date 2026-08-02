import './pwa.js';
import { api, ownerToken, API_BASE, price, titleCase, formatDate, esc, ApiError } from './api.js';

const $ = (id) => document.getElementById(id);
const banner = $('banner');

function showBanner(kind, html) {
  banner.innerHTML = `<div class="card"><div class="card-body"><div class="notice notice-${kind}">${html}</div></div></div>`;
}

function clearBanner() {
  banner.innerHTML = '';
}

/* --------------------------------------------------------------- settings */

const dialog = $('settings-dialog');
$('settings-btn').addEventListener('click', () => {
  $('api-base-display').value = API_BASE || '(not configured)';
  $('owner-token').value = ownerToken.get();
  dialog.showModal();
});
dialog.addEventListener('close', () => {
  if (dialog.returnValue === 'save') {
    ownerToken.set($('owner-token').value.trim());
    location.reload();
  }
});

/* ------------------------------------------------------------------ boot */

async function boot() {
  if (!API_BASE) {
    return showBanner('bad', '<strong>No API configured.</strong> Set <code>apiBase</code> in <code>config.js</code> to your Worker URL.');
  }
  if (!ownerToken.get()) {
    return showBanner('warn', '<strong>Owner token needed.</strong> Open Settings and paste the <code>OWNER_TOKEN</code> you set on the Worker.');
  }

  clearBanner();
  await Promise.all([loadTemplates(), loadQuotes()]);
}

async function loadTemplates() {
  const select = $('job_type');
  try {
    const { templates } = await api.templates();
    select.innerHTML = templates
      .map((t) => `<option value="${esc(t.job_type)}">${esc(t.name)}</option>`)
      .join('') || '<option value="">No templates found</option>';
  } catch (err) {
    select.innerHTML = '<option value="">Could not load templates</option>';
    reportError(err);
  }
}

async function loadQuotes() {
  const list = $('quote-list');
  try {
    const { quotes } = await api.listQuotes();
    if (!quotes.length) {
      list.innerHTML = '<div class="card-body muted">No quotes yet. Start one above.</div>';
      return;
    }
    list.innerHTML = quotes
      .map((q) => `
        <a class="quote-item" href="builder.html?id=${encodeURIComponent(q.id)}">
          <span class="who">${esc(q.client_name)}</span>
          <span class="status status-${esc(q.status)}">${esc(q.status)}</span>
          <span class="meta">
            ${esc(titleCase(q.job_type))}${q.site_address ? ` · ${esc(q.site_address)}` : ''}
            · ${price(q.subtotal_price)}${q.status !== 'draft' ? ` · ${q.margin_pct}% margin` : ''}
            · ${esc(formatDate(q.created_at))}
          </span>
        </a>`)
      .join('');
  } catch (err) {
    list.innerHTML = '<div class="card-body muted">Could not load quotes.</div>';
    reportError(err);
  }
}

function reportError(err) {
  if (err instanceof ApiError && err.status === 401) {
    showBanner('bad', '<strong>Token rejected.</strong> Check the owner token in Settings.');
  } else {
    showBanner('bad', `<strong>Error.</strong> ${esc(err.message)}`);
  }
}

/* ------------------------------------------------------------------ create */

$('create-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const jobType = $('job_type').value;
  if (!jobType) return showBanner('bad', 'Pick a job type first.');

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Creating…';
  try {
    const created = await api.createQuote({
      job_type: jobType,
      client_name: $('client_name').value.trim(),
      site_address: $('site_address').value.trim(),
    });
    location.href = `builder.html?id=${encodeURIComponent(created.quote.id)}`;
  } catch (err) {
    reportError(err);
    btn.disabled = false;
    btn.textContent = 'Start quote →';
  }
});

boot();