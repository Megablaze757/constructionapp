import './pwa.js';
import { api, ready, price, titleCase, esc, ApiError } from './api.js';
import { initPhotos } from './photos.js';
import { processDocument } from './plans.js';

const $ = (id) => document.getElementById(id);
const quoteId = new URLSearchParams(location.search).get('id');

let state = { quote: null, lines: [], totals: null, blockers: [], priceBook: [], template: null };
let attachedPlans = []; // { name, type, mime, b64, text }

/* ---------------------------------------------------------------- banners */

function banner(kind, html) {
  $('banner').innerHTML = `<div class="card"><div class="card-body"><div class="notice notice-${kind}">${html}</div></div></div>`;
}
const clearBanner = () => ($('banner').innerHTML = '');

function reportError(err) {
  if (err instanceof ApiError && err.status === 401) {
    banner('bad', '<strong>Token rejected.</strong> Set the owner token on the <a href="index.html">quotes screen</a>.');
  } else {
    banner('bad', `<strong>Error.</strong> ${esc(err.message)}`);
  }
}

/* ------------------------------------------------------------------- boot */

async function boot() {
  if (!quoteId || !await ready()) {
    return banner('bad', 'Missing configuration or quote id. Go back to the <a href="index.html">quotes screen</a>.');
  }
  try {
    const [loaded, book] = await Promise.all([api.getQuote(quoteId), api.priceBook()]);
    state.priceBook = book.price_book;
    apply(loaded);
    initPhotos({
      quoteId,
      onError: reportError,
      onCount: (n) => {
        const totalAttachments = n + attachedPlans.length;
        $('use-photos-row').hidden = totalAttachments === 0;
        $('photo-count').textContent = totalAttachments ? `(${totalAttachments} files)` : '';
      },
    });
    initPlanDropzone();
    const { templates } = await api.templates();
    state.template = templates.find((t) => t.job_type === state.quote.job_type) || null;
  } catch (err) {
    reportError(err);
  }
}

/** Adopt a server response as the new truth. The server owns all money. */
function apply(payload) {
  state.quote = payload.quote;
  state.lines = payload.lines;
  state.totals = payload.totals;
  state.blockers = payload.blockers || [];
  render();
}

/* ----------------------------------------------------------- plan dropzone */

function initPlanDropzone() {
  const dropzone = $('plan-dropzone');
  const input = $('plan-input');
  const browseBtn = $('plan-browse-btn');

  if (!dropzone || !input) return;

  browseBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    input.click();
  });

  dropzone.addEventListener('click', () => input.click());
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer?.files?.length) {
      await handlePlanFiles(e.dataTransfer.files);
    }
  });

  input.addEventListener('change', async () => {
    if (input.files?.length) {
      await handlePlanFiles(input.files);
      input.value = '';
    }
  });
}

async function handlePlanFiles(files) {
  clearBanner();
  for (const file of files) {
    try {
      const processed = await processDocument(file);
      attachedPlans.push(processed);
    } catch (err) {
      banner('bad', `Failed to read ${esc(file.name)}: ${esc(err.message)}`);
    }
  }
  renderPlanGrid();
}

function renderPlanGrid() {
  const grid = $('plan-grid');
  if (!grid) return;
  grid.innerHTML = attachedPlans.map((p, idx) => `
    <div class="plan-card">
      <button class="remove-btn" data-idx="${idx}" type="button" aria-label="Remove file">×</button>
      <div class="file-icon">${p.mime?.includes('image') ? '🖼️' : '📄'}</div>
      <div class="file-name" title="${esc(p.name)}">${esc(p.name)}</div>
      <div class="file-badge">${esc(p.type)}</div>
    </div>
  `).join('');

  grid.querySelectorAll('.remove-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx, 10);
      attachedPlans.splice(idx, 1);
      renderPlanGrid();
    });
  });

  const photoCount = document.querySelectorAll('#photo-grid .photo-thumb').length;
  const total = photoCount + attachedPlans.length;
  $('use-photos-row').hidden = total === 0;
  $('photo-count').textContent = total ? `(${total} files)` : '';
}

/* ----------------------------------------------------------------- render */

function render() {
  const q = state.quote;
  $('title').textContent = q.status === 'draft' ? 'New Quote' : titleCase(q.status);
  $('job_type_display').value = titleCase(q.job_type);
  syncHeader(q);

  renderAiSummary(q.ai_summary);
  renderLines();
  renderExtras();
  renderTotals();
}

const HEADER_FIELDS = ['client_name', 'site_address', 'description', 'client_summary'];

const touched = new Set();
for (const id of HEADER_FIELDS) {
  $(id)?.addEventListener('input', () => touched.add(id));
}

function syncHeader(q) {
  for (const id of HEADER_FIELDS) {
    if (!touched.has(id)) $(id).value = q[id] || '';
  }
}

function renderAiSummary(summary) {
  const card = $('ai-summary');
  if (!summary) return (card.hidden = true);
  card.hidden = false;

  const list = (items) => items.map((s) => `<li>${esc(s)}</li>`).join('');
  const parts = [];
  if (summary.ai === false) {
    parts.push('<div class="notice notice-bad"><strong>No AI is connected, so your description was not read.</strong>'
      + ' These are the template\'s own default quantities. Check every one against this job.</div>');
  }
  if (summary.flags_for_owner_review?.length) {
    parts.push(`<div class="notice notice-warn"><strong>Check before sending</strong><ul>${list(summary.flags_for_owner_review)}</ul></div>`);
  }
  if (summary.assumptions?.length) {
    parts.push(`<div class="notice notice-warn" style="background:var(--surface-2);color:var(--ink-2)"><strong>Assumptions made</strong><ul>${list(summary.assumptions)}</ul></div>`);
  }
  if (summary.estimating_history?.length) {
    parts.push(`<div class="notice notice-warn"><strong>Learned from past jobs</strong><ul>${list(summary.estimating_history)}</ul></div>`);
  }
  $('ai-summary-body').innerHTML = parts.join('');
}

function renderLines() {
  const base = state.lines.filter((l) => l.kind !== 'extra');
  const host = $('lines');
  if (!host) return;
  if (!base.length) {
    host.innerHTML = '<div class="card-body muted">No line items yet.</div>';
    return;
  }
  host.innerHTML = base.map(lineMarkup).join('');
  host.querySelectorAll('[data-edit]').forEach((btn) =>
    btn.addEventListener('click', () => openLineDialog(btn.dataset.edit)));
  host.querySelectorAll('[data-confirm]').forEach((btn) =>
    btn.addEventListener('click', () => confirmLine(btn.dataset.confirm)));
}

function lineMarkup(l) {
  const tag = l.source === 'photo_inferred' ? '📷 from photo'
    : l.source === 'ai_inferred' ? '🤖 AI est.' : null;
  const unconfirmed = !l.confirmed;
  return `
    <div class="line ${unconfirmed ? 'unconfirmed' : ''}">
      <div class="line-desc">
        ${unconfirmed ? '<span class="dot" title="Not yet confirmed"></span>' : ''}
        <span>${esc(l.description)}</span>
        ${tag ? `<span class="tag tag-ai">${esc(tag)}</span>` : ''}
      </div>
      <div class="line-price">${price(l.line_price)}</div>
      <div class="line-qty">${formatQty(l.quantity)} ${esc(l.unit)}${l.unit_price ? ` @ ${price(l.unit_price)}` : ''}</div>
      ${l.note ? `<div class="line-note">${esc(l.note)}</div>` : ''}
      <div class="line-actions">
        <button class="btn btn-sm" type="button" data-edit="${esc(l.id)}">edit</button>
        ${unconfirmed ? `<button class="btn btn-sm btn-primary" type="button" data-confirm="${esc(l.id)}">Tap to confirm</button>` : ''}
      </div>
    </div>`;
}

const formatQty = (n) => (Number.isInteger(Number(n)) ? String(n) : String(Number(n)));

function renderExtras() {
  const container = $('extras');
  if (!container) return;
  const extras = state.lines.filter((l) => l.is_extra);
  container.innerHTML = extras.map((l) => `
    <div class="extra">
      <input type="checkbox" ${l.selected_by_client ? 'checked' : ''} disabled>
      <div><strong>${esc(l.description)}</strong></div>
      <div class="extra-price">${price(l.amount)}</div>
      <div class="extra-blurb">${esc(l.quantity)} ${esc(l.unit)}</div>
    </div>
  `).join('');
}

function renderTotals() {
  $('total').textContent = price(state.totals.total);
  const m = state.totals.margin;
  const badge = $('margin-badge');
  badge.textContent = `${(m.pct * 100).toFixed(1)}% margin`;
  badge.className = `badge ${m.ok ? 'badge-ok' : 'badge-bad'}`;
  $('margin-line').textContent = `${price(m.amount)} (${(m.pct * 100).toFixed(1)}%)`;
}

/* ------------------------------------------------------------- AI drafting */

$('draft-btn')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  let description = $('description').value.trim();

  // Append plan text extracts if attached
  const planText = attachedPlans.filter((p) => p.text).map((p) => `[Attachment: ${p.name}]
${p.text}`).join('

');
  if (planText) {
    description = description ? `${description}

${planText}` : planText;
  }

  if (!description && !attachedPlans.length) {
    return banner('warn', 'Describe the job or attach a building plan / quote template first.');
  }

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Analyzing plans &amp; drafting…';
  clearBanner();
  try {
    // Send combined description and photo/plan image payloads
    const usePhotos = $('use-photos')?.checked ?? true;
    const extraImages = attachedPlans.filter((p) => p.b64).map((p) => ({
      mime: p.mime,
      b64: p.b64,
    }));

    apply(await api.draft(quoteId, description, usePhotos, extraImages));
    banner('warn', state.quote?.ai_summary?.ai === false
      ? '<strong>Drafted from template.</strong> No AI key connected.'
      : '<strong>Draft ready.</strong> Items marked 🤖 need a tap to confirm before sending.');
  } catch (err) {
    reportError(err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate Draft with AI';
  }
});

boot();
