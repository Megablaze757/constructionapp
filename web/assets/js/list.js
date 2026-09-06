import './pwa.js';
import {
  api, ready, isLocal, ownerToken, API_BASE, price, titleCase, formatDate, esc, ApiError,
} from './api.js';

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
const AI_BASE_KEY = 'builderos.aiBase';
const AI_TOKEN_KEY = 'builderos.aiToken';

$('settings-btn').addEventListener('click', async () => {
  const running = await ready();
  $('api-base-display').value = API_BASE || '(no Worker — running in this browser)';
  $('owner-token').value = ownerToken.get();
  $('ai-base').value = localStorage.getItem(AI_BASE_KEY) || '';
  $('ai-token').value = localStorage.getItem(AI_TOKEN_KEY) || '';
  $('mode-explainer').innerHTML = isLocal()
    ? 'Nothing is deployed, so BuilderOS is running in this browser and storing everything on '
      + 'this device. Deploy the Worker and set its URL to share the data, send client links '
      + 'and give crew their own pages.'
    : `Talking to your Cloudflare Worker. The owner token is the <code>OWNER_TOKEN</code> secret
       you set on it, and is stored only in this browser.${running ? '' : ' Paste it below to start.'}`;
  dialog.showModal();
});

dialog.addEventListener('close', () => {
  if (dialog.returnValue !== 'save') return;
  ownerToken.set($('owner-token').value.trim());
  // Stored here rather than in config.js so it survives a redeploy of the site
  // and can be set from a phone, which is where most of this gets used.
  for (const [key, id] of [[AI_BASE_KEY, 'ai-base'], [AI_TOKEN_KEY, 'ai-token']]) {
    const value = $(id).value.trim().replace(/\/$/, '');
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  }
  location.reload();
});

/* ------------------------------------------------------------------ boot */

async function boot() {
  // In local mode there is no Worker and no token to paste — ready() settles
  // that first, and only then is a missing token actually a problem.
  if (!await ready()) {
    return showBanner('warn', '<strong>Owner token needed.</strong> Open Settings and paste the <code>OWNER_TOKEN</code> you set on the Worker.');
  }

  clearBanner();
  await Promise.all([loadTemplates(), loadQuotes(), loadSuggestions()]);
}

/**
 * "You quote this often — save it as a template?"
 * Only surfaces when the same combination of lines has been assembled by hand
 * enough times to be a habit rather than a coincidence.
 */
async function loadSuggestions() {
  const card = $('suggestions-card');
  try {
    const { suggestions } = await api.templateSuggestions();
    if (!suggestions.length) return (card.hidden = true);
    card.hidden = false;

    $('suggestions').innerHTML = suggestions.map((s, i) => `
      <div class="notice notice-warn">
        <strong>${esc(s.suggested_name)}</strong>
        You've built this ${s.quotes} times by hand${s.examples.length ? ` (${s.examples.map(esc).join(', ')})` : ''}.
        <ul>${s.line_items.map((l) => `<li>${esc(l.description)} — usually ${l.default_quantity} ${esc(l.unit)}</li>`).join('')}</ul>
        <span class="muted">Margin on these: ${s.observed_margin}%</span>
        <button class="btn btn-sm btn-primary" data-accept="${i}" type="button">Save as template</button>
      </div>`).join('');

    $('suggestions').querySelectorAll('[data-accept]').forEach((btn) =>
      btn.addEventListener('click', () => acceptSuggestion(suggestions[btn.dataset.accept], btn)));
  } catch {
    // A suggestion is a nicety; never let it break the quotes screen.
    card.hidden = true;
  }
}

async function acceptSuggestion(s, btn) {
  const name = prompt('Name this template:', s.suggested_name);
  if (!name) return;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Saving…';
  try {
    await api.createTemplate({
      job_type: s.suggested_job_type,
      name: name.trim(),
      // Seeded from what this business actually achieves, with a floor a few
      // points below so the first quote off the template is not born blocked.
      default_margin: s.suggested_margin,
      margin_floor: Math.max(0, s.suggested_margin - 5),
      line_items: s.line_items,
    });
    showBanner('ok', `<strong>Template saved.</strong> "${esc(name)}" is now in the job type list.`);
    await Promise.all([loadTemplates(), loadSuggestions()]);
  } catch (err) {
    reportError(err);
    btn.disabled = false;
    btn.textContent = 'Save as template';
  }
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