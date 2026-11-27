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

const HEADER_FIELDS = ['client_name', 'client_phone', 'site_address', 'description', 'client_summary'];

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
  // None of the lower rungs is an estimate, and none may be allowed to look
  // like one just because it appears in the same card. Each says exactly how
  // much of the job was actually read.
  if (summary.ai === false) {
    const why = summary.fell_back_from
      ? `<p style="margin:6px 0 0">AI was configured but did not answer: ${esc(summary.fell_back_from)}</p>`
      : '';
    parts.push(summary.method === 'rules'
      ? `<div class="notice notice-warn"><strong>Read by pattern, not by AI.</strong>
         Figures your description stated in a unit the price book uses have been applied.
         Everything else is the template's own default. Check every line.${why}</div>`
      : `<div class="notice notice-bad"><strong>Your description was not read.</strong>
         Nothing in it gave a quantity in a unit the price book uses, so these are the
         template's own defaults. Check every one against this job.${why}</div>`);
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
  // What drafted this, and how sure it was. Without it the owner cannot tell a
  // real estimate from a template default once the banner has been dismissed.
  parts.push(`<p class="muted" style="margin:0">Drafted ${summary.ai === false ? 'from' : 'by'} ${esc(summary.model || 'AI')} · overall confidence ${esc(summary.confidence || '—')}</p>`);
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
  const extras = state.lines.filter((l) => l.kind === 'extra');
  container.innerHTML = extras.length
    ? extras.map((l) => `
    <div class="extra">
      <input type="checkbox" ${l.selected ? 'checked' : ''} disabled>
      <div><strong>${esc(l.description)}</strong></div>
      <div class="extra-price">${price(l.line_price)}</div>
      ${l.blurb ? `<div class="extra-blurb">${esc(l.blurb)}</div>` : ''}
    </div>
  `).join('')
    : '<div class="card-body muted">No optional extras on this template.</div>';
}

/**
 * Where the cost actually goes, as a proportion of the quote's own cost.
 *
 * Priced off `line_cost` rather than `line_price`, because the question this
 * answers is "what is this job made of" — a quote that is mostly plant hire is a
 * different risk from one that is mostly your own labour.
 */
function renderCostSplit() {
  const bars = { labour: $('bar-labour'), material: $('bar-material'), plant: $('bar-plant') };
  if (!bars.labour) return;

  const base = state.lines.filter((l) => l.kind !== 'extra');
  const cost = base.reduce((t, l) => t + (Number(l.line_cost) || 0), 0);
  const by = (cat) => base
    .filter((l) => (cat === 'plant' ? l.category !== 'labour' && l.category !== 'material' : l.category === cat))
    .reduce((t, l) => t + (Number(l.line_cost) || 0), 0);

  for (const [cat, el] of Object.entries(bars)) {
    const share = cost ? (by(cat) / cost) * 100 : 0;
    el.style.width = `${share.toFixed(1)}%`;
    el.title = `${titleCase(cat)} — ${price(by(cat))} of ${price(cost)}`;
  }
}

function renderTotals() {
  const t = state.totals;
  $('total').textContent = price(t.subtotal_price);

  const cls = t.below_floor ? 'badge-bad' : t.meets_target ? 'badge-ok' : 'badge-warn';
  const mark = t.below_floor ? '⛔' : t.meets_target ? '✅' : '⚠️';
  $('margin-badge').className = `badge ${cls}`;
  $('margin-badge').textContent = `${t.margin_pct}% ${mark}`;
  $('margin-line').innerHTML =
    `<span class="badge ${cls}">${t.margin_pct}% ${mark}</span> <span class="muted">target ${t.target_margin}% · floor ${t.margin_floor}%</span>`;
  $('cost-split-margin').textContent = `${t.margin_pct}% margin`;

  renderCostSplit();

  const notes = [];
  if (t.below_cost_lines?.length) {
    notes.push(`<div class="notice notice-bad"><strong>Priced at or below cost</strong><ul>${t.below_cost_lines.map((d) => `<li>${esc(d)}</li>`).join('')}</ul></div>`);
  }
  for (const b of state.blockers) {
    notes.push(`<div class="notice notice-${b.code === 'below_margin_floor' ? 'bad' : 'warn'}">${esc(b.message)}</div>`);
  }
  if (state.quote.override_reason) {
    notes.push(`<div class="notice notice-warn"><strong>Margin override logged</strong>${esc(state.quote.override_reason)}</div>`);
  }
  $('blockers').innerHTML = notes.join('');

  // The send gate. The API refuses these too (422) — this is so the owner can
  // see what is holding the quote up instead of pressing Send and being told.
  const sendBtn = $('send-btn');
  const hard = state.blockers.filter((b) => !b.overridable);
  sendBtn.disabled = state.quote.status === 'accepted' || hard.length > 0;
  sendBtn.textContent =
    state.quote.status === 'accepted' ? 'Accepted' :
    hard.length ? hard[0].message :
    state.quote.status === 'draft' ? 'Send Quote →' : 'Re-send Quote →';
}

/* ------------------------------------------------------------- AI drafting */

$('draft-btn')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  let description = $('description').value.trim();

  // Append plan text extracts if attached
  const planText = attachedPlans.filter((p) => p.text).map((p) => `[Attachment: ${p.name}]
${p.text}`).join('\n\n');
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
    banner('warn', {
      ai: '<strong>Draft ready.</strong> Items marked 🤖 need a tap to confirm before sending.',
      rules: '<strong>Drafted from your wording.</strong> Figures it could match are in; the rest are template defaults — confirm every line before sending.',
      template: '<strong>Drafted from the template.</strong> Nothing measurable was found in your description — confirm every line before sending.',
    }[state.quote?.ai_summary?.method || 'ai']);
  } catch (err) {
    reportError(err);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate Draft with AI';
  }
});

/* -------------------------------------------------------- voice recording */

/**
 * Press to record, release to transcribe.
 *
 * Replaces the browser's Web Speech API, which never worked in Firefox and
 * could not work offline. Recording goes through assets/js/transcribe.js, which
 * tries Groq Whisper when an AI worker is configured and falls back to Whisper
 * running on this device — free, and the only option with no signal.
 *
 * The transcript is appended to the description for the owner to read and fix.
 * It is never drafted from directly: a misheard "ten lifts" would otherwise
 * become a quantity on a quote a client pays.
 */
function initVoiceNotes() {
  const btn = $('record-btn');
  const hint = $('record-hint');
  if (!btn) return;

  const supported = !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  if (!supported) {
    btn.disabled = true;
    btn.textContent = '● Voice notes need a newer browser';
    if (hint) hint.textContent = 'Type the description below instead.';
    return;
  }

  const IDLE = '● Hold / Tap to speak quote';
  let recorder = null;
  let chunks = [];
  let stream = null;
  const say = (m) => { if (hint) hint.textContent = m; };

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // A refused microphone is a decision, not a fault — say what to do.
      say('Microphone blocked. Allow it in your browser settings, or type below.');
      return;
    }
    chunks = [];
    // Held in the closure as well as in `recorder`, because stop() clears that
    // reference immediately while the 'stop' event arrives a tick later.
    const rec = new MediaRecorder(stream);
    recorder = rec;
    rec.addEventListener('dataavailable', (e) => e.data.size && chunks.push(e.data));
    rec.addEventListener('stop', () => {
      stream.getTracks().forEach((t) => t.stop());
      finish(new Blob(chunks, { type: rec.mimeType || 'audio/webm' }));
    });
    rec.start();
    btn.classList.add('recording');
    btn.textContent = '🔴 Recording — release to transcribe';
    say('Describe the job out loud. Numbers and units help.');
  }

  function stop() {
    if (recorder?.state === 'recording') recorder.stop();
    recorder = null;
    btn.classList.remove('recording');
    btn.textContent = IDLE;
  }

  async function finish(blob) {
    if (!blob.size) return say('Nothing was recorded. Try holding the button a little longer.');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Transcribing…';
    try {
      const { transcribe } = await import('./transcribe.js');
      const cfg = window.BUILDEROS_CONFIG || {};
      const out = await transcribe(blob, {
        aiBase: localStorage.getItem('builderos.aiBase') || cfg.aiBase || '',
        aiToken: localStorage.getItem('builderos.aiToken') || cfg.aiToken || '',
        onStage: (rung) => say(rung === 'groq'
          ? 'Transcribing…'
          : 'Transcribing on this device — the first time downloads a 41 MB model, then it works offline.'),
        onProgress: (p) => {
          if (typeof p.progress === 'number') say(`Downloading the speech model — ${Math.round(p.progress)}%`);
          else if (p.note) say(p.note);
        },
      });

      const desc = $('description');
      desc.value = desc.value.trim() ? `${desc.value.trim()} ${out.text}` : out.text;
      touched.add('description');
      desc.focus();
      say(out.via === 'groq'
        ? 'Transcribed. Read it over — then Generate Draft.'
        : `Transcribed on this device${out.fellBackFrom ? ' (the AI worker did not answer)' : ''}. Read it over — then Generate Draft.`);
    } catch (err) {
      say(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = IDLE;
    }
  }

  // Press-and-hold on a phone, click-to-toggle on a desktop: both, because the
  // same screen is used with gloves on and at a desk.
  btn.addEventListener('pointerdown', (e) => { e.preventDefault(); start(); });
  btn.addEventListener('pointerup', stop);
  btn.addEventListener('pointercancel', stop);
  btn.addEventListener('pointerleave', () => { if (recorder?.state === 'recording') stop(); });
}

initVoiceNotes();

/* --------------------------------------------------- whatsapp & link share */

/**
 * The link the client opens.
 *
 * It carries the quote's unguessable `public_token`, never the internal id — the
 * client route only answers to the token, and an id in a message that gets
 * forwarded is an internal handle leaving the building for nothing. The path is
 * derived from this page rather than from the origin, because on GitHub Pages
 * the app lives under /<repo>/ and an origin-rooted link lands on a 404.
 */
function publicQuoteUrl({ preview = false } = {}) {
  const base = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}quote.html`;
  const token = state.quote?.public_token;
  if (!token) return '';
  return `${base}?t=${encodeURIComponent(token)}${preview ? '&preview=1' : ''}`;
}

/**
 * A draft quote's public link answers 404 by design, so that it cannot be used
 * to probe which tokens are real. Sharing one would send the client a dead
 * link, so say so rather than letting them find out.
 */
function shareableUrl() {
  if (state.quote?.status === 'draft') {
    banner('warn', '<strong>Send the quote first.</strong> The client link only opens once the quote has been sent.');
    return '';
  }
  const url = publicQuoteUrl();
  if (!url) banner('bad', 'This quote has no client link yet.');
  return url;
}

function shareQuoteWhatsApp() {
  const q = state.quote;
  const clientName = $('client_name')?.value.trim() || q?.client_name || '';
  const clientPhone = $('client_phone')?.value.trim() || q?.client_phone || '';
  const siteAddr = $('site_address')?.value.trim() || q?.site_address || '';
  const quoteUrl = shareableUrl();
  if (!quoteUrl) return;

  const message = `Hi ${clientName ? clientName : 'there'}, here is your quote for ${siteAddr ? siteAddr : 'your job'}:
${quoteUrl}

Please review and let me know if you have any questions!`;

  let waUrl = '';
  const cleanPhone = clientPhone.replace(/[^0-9]/g, '');
  if (cleanPhone) {
    waUrl = `https://wa.me/${cleanPhone}?text=${encodeURIComponent(message)}`;
  } else {
    waUrl = `https://wa.me/?text=${encodeURIComponent(message)}`;
  }

  window.open(waUrl, '_blank', 'noopener,noreferrer');
}

async function copyQuoteLink() {
  const quoteUrl = shareableUrl();
  if (!quoteUrl) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(quoteUrl);
      banner('warn', '<strong>Quote link copied!</strong> Link copied to clipboard.');
    } else if (navigator.share) {
      await navigator.share({ title: 'Quote', url: quoteUrl });
    } else {
      prompt('Copy quote link below:', quoteUrl);
    }
  } catch (err) {
    console.error('Copy/Share failed:', err);
  }
}

$('whatsapp-share-btn')?.addEventListener('click', shareQuoteWhatsApp);
$('copy-link-btn')?.addEventListener('click', copyQuoteLink);

/* ------------------------------------------------------------------ saving */

/**
 * Replace the line items wholesale. The server reprices every one from the
 * price book on the way in, so nothing here sets money — it sends quantities
 * and provenance and adopts whatever comes back.
 */
async function saveLines() {
  try {
    apply(await api.putLines(quoteId, state.lines.map((l) => ({
      id: l.id,
      line_code: l.line_code,
      description: l.description,
      quantity: l.quantity,
      unit: l.unit,
      unit_cost: l.unit_cost,
      unit_price: l.unit_price,
      kind: l.kind,
      blurb: l.blurb,
      selected: l.selected,
      source: l.source,
      confidence: l.confidence,
      note: l.note,
      confirmed: l.confirmed,
      locked: l.locked,
    }))));
    clearBanner();
  } catch (err) {
    reportError(err);
  }
}

/** The tap-to-confirm gate: the owner saying they have looked at this number. */
async function confirmLine(id) {
  const line = state.lines.find((l) => l.id === id);
  if (!line) return;
  line.confirmed = true;
  await saveLines();
}

/** The header fields, as typed. Shared by Save Draft and Send. */
async function saveHeader() {
  const saved = await api.patchQuote(quoteId, {
    client_name: $('client_name').value.trim(),
    client_phone: $('client_phone')?.value.trim() || '',
    site_address: $('site_address').value.trim(),
    description: $('description').value,
    client_summary: $('client_summary').value.trim(),
  });
  touched.clear();
  return saved;
}

$('save-btn')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  try {
    apply(await saveHeader());
    btn.textContent = 'Saved ✓';
    setTimeout(() => (btn.textContent = 'Save Draft'), 1400);
  } catch (err) {
    reportError(err);
  } finally {
    btn.disabled = false;
  }
});

/* -------------------------------------------------------- line item dialog */

const lineDialog = $('line-dialog');
let editingId = null;

function openLineDialog(id) {
  editingId = id;
  const line = id ? state.lines.find((l) => l.id === id) : null;

  $('line-dialog-title').textContent = line ? 'Edit line item' : 'Add line item';
  $('line-code').innerHTML = state.priceBook
    .map((p) => `<option value="${esc(p.code)}">${esc(p.description)} (per ${esc(p.unit)})</option>`)
    .join('');
  $('line-code').value = line?.line_code || state.priceBook[0]?.code || '';
  $('line-desc').value = line?.description || '';
  $('line-qty').value = line?.quantity ?? 1;
  $('line-delete').hidden = !line;
  updateLinePreview();
  lineDialog.showModal();
}

function updateLinePreview() {
  const entry = state.priceBook.find((p) => p.code === $('line-code').value);
  const qty = Number($('line-qty').value) || 0;
  $('line-unit').textContent = entry ? `(${entry.unit})` : '';
  $('line-price-preview').textContent = entry
    ? `${qty} × ${price(entry.unit_price)} = ${price(qty * entry.unit_price)}`
    : '';
}

$('line-code')?.addEventListener('change', () => {
  const entry = state.priceBook.find((p) => p.code === $('line-code').value);
  if (entry && !$('line-desc').value.trim()) $('line-desc').value = entry.description;
  updateLinePreview();
});
$('line-qty')?.addEventListener('input', updateLinePreview);

lineDialog?.addEventListener('close', async () => {
  const action = lineDialog.returnValue;
  if (action === 'cancel') return;

  if (action === 'delete') {
    state.lines = state.lines.filter((l) => l.id !== editingId);
    return saveLines();
  }

  const qty = Number($('line-qty').value);
  if (!Number.isFinite(qty) || qty <= 0) return banner('bad', 'Quantity must be greater than zero.');

  const entry = state.priceBook.find((p) => p.code === $('line-code').value);
  const patch = {
    line_code: entry?.code,
    description: $('line-desc').value.trim() || entry?.description || 'Line item',
    quantity: qty,
    unit: entry?.unit || 'job',
    // Editing is a confirmation: the owner has looked at this number.
    confirmed: true,
  };

  if (editingId) {
    const line = state.lines.find((l) => l.id === editingId);
    Object.assign(line, patch, { source: line.source === 'ai_inferred' ? 'ai_inferred' : line.source });
  } else {
    state.lines.push({ ...patch, id: '', kind: 'base', source: 'owner_entered', confidence: 'high', selected: false, locked: false });
  }
  await saveLines();
});

$('add-line-btn')?.addEventListener('click', () => openLineDialog(null));

/* ----------------------------------------------------------------- preview */

$('preview-btn')?.addEventListener('click', () => {
  window.open(publicQuoteUrl({ preview: true }), '_blank', 'noopener');
});

/* ----------------------------------------------------------------- sending */

const overrideDialog = $('override-dialog');
const sentDialog = $('sent-dialog');

$('send-btn')?.addEventListener('click', () => trySend());

async function trySend(overrideReason) {
  const btn = $('send-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Sending…';
  try {
    // Send is the only button most owners press, so anything typed into the
    // header goes with it — otherwise the client-facing summary they just wrote
    // is silently dropped for want of a Save Draft.
    await saveHeader();
    const res = await api.send(quoteId, overrideReason);
    const url = res.public_url?.startsWith('http')
      ? res.public_url
      : `${location.origin}${location.pathname.replace(/builder\.html$/, '')}quote.html?t=${res.token}`;
    $('sent-link').value = url;
    $('open-link').href = url;
    sentDialog.showModal();
    apply(await api.getQuote(quoteId));
  } catch (err) {
    if (err instanceof ApiError && err.status === 422) {
      const floor = (err.body.blockers || []).find((b) => b.code === 'below_margin_floor');
      if (floor) {
        $('override-detail').textContent = floor.message;
        $('override-reason').value = '';
        overrideDialog.showModal();
      } else {
        apply(await api.getQuote(quoteId));
        banner('bad', `<strong>Not ready to send.</strong><ul>${(err.body.blockers || []).map((b) => `<li>${esc(b.message)}</li>`).join('')}</ul>`);
      }
    } else {
      reportError(err);
    }
  } finally {
    renderTotals();
  }
}

overrideDialog?.addEventListener('close', () => {
  if (overrideDialog.returnValue !== 'override') return;
  const reason = $('override-reason').value.trim();
  if (!reason) return banner('bad', 'A reason is required to send below the margin floor.');
  trySend(reason);
});

$('copy-link')?.addEventListener('click', async (e) => {
  try {
    await navigator.clipboard.writeText($('sent-link').value);
    e.currentTarget.textContent = 'Copied ✓';
  } catch {
    $('sent-link').select();
    e.currentTarget.textContent = 'Press ⌘/Ctrl+C';
  }
});

boot();

