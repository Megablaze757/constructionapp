import './pwa.js';
import { api, ready, price, titleCase, esc, ApiError } from './api.js';
import { initPhotos } from './photos.js';

const $ = (id) => document.getElementById(id);
const quoteId = new URLSearchParams(location.search).get('id');

let state = { quote: null, lines: [], totals: null, blockers: [], priceBook: [], template: null };

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
    // The photo toggle only appears once there is something to look at, and
    // stays in sync as photos are added or removed.
    initPhotos({
      quoteId,
      onError: reportError,
      onCount: (n) => {
        $('use-photos-row').hidden = n === 0;
        $('photo-count').textContent = n ? `(${n})` : '';
      },
    });
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

/** Fields the owner has typed into since they were last saved. */
const touched = new Set();
for (const id of HEADER_FIELDS) {
  $(id).addEventListener('input', () => touched.add(id));
}

/**
 * Refresh the header fields without throwing away unsaved typing.
 *
 * Almost everything on this screen saves through the API and re-renders —
 * confirming a line, editing a quantity, adding a photo. Each of those used to
 * wipe whatever had been typed but not yet saved, so a client summary written
 * before tapping "confirm" was gone by the time Send was pressed. Nobody notices
 * that until the client asks what the job actually involves.
 *
 * Typing wins until it has been saved; after that the server's copy is the truth
 * again.
 */
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
  // A template draft is not an estimate, and must not be allowed to look like
  // one just because it appears in the same card.
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
    // What the business's own completed jobs taught the assistant. The owner
    // should see the same brief the model got, not just its output.
    parts.push(`<div class="notice notice-warn"><strong>Your own job history says</strong><ul>${list(summary.estimating_history)}</ul>
      <a href="variance.html">See the full quote-vs-actual report →</a></div>`);
  }
  if (summary.similar_past_jobs_reference?.length) {
    const rows = summary.similar_past_jobs_reference
      .map((r) => `<li>${esc(r.job)} — quoted ${price(r.quoted)}, cost ${price(r.actual_cost)} (${esc(r.margin_actual || '')})</li>`)
      .join('');
    parts.push(`<div class="notice" style="background:var(--surface-2);color:var(--ink-2)"><strong>Checked against past jobs</strong><ul>${rows}</ul></div>`);
  }
  parts.push(`<p class="muted" style="margin:0">Drafted ${summary.ai === false ? 'from' : 'by'} ${esc(summary.model || 'AI')} · overall confidence ${esc(summary.confidence || '—')}</p>`);
  $('ai-summary-body').innerHTML = parts.join('');
}

function renderLines() {
  const base = state.lines.filter((l) => l.kind !== 'extra');
  const host = $('lines');
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
  // "AI est." means the quantity is the AI's estimate. A quantity the owner
  // actually stated is not an estimate just because the AI transcribed it, so
  // only inferred lines carry a tag — matching the wireframe, where hire
  // (5 days, stated) is untagged and erect (45m², inferred) is tagged.
  // Photo-scaled lines get their own tag: "measured off a picture" is a
  // different claim from "worked out from the wording", and the owner checking
  // this on site needs to know which one they are looking at.
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
  const extras = state.lines.filter((l) => l.kind === 'extra');
  const host = $('extras');
  if (!extras.length) {
    host.innerHTML = '<div class="card-body muted">This template offers no optional extras.</div>';
    return;
  }
  host.innerHTML = extras
    .map((l) => `
      <label class="extra">
        <input type="checkbox" data-extra="${esc(l.id)}" ${l.selected ? 'checked' : ''}>
        <span>${esc(l.description)}</span>
        <span class="extra-price">+${price(l.line_price)}</span>
        ${l.blurb ? `<span class="extra-blurb">${esc(l.blurb)}</span>` : ''}
      </label>`)
    .join('');
  // Owner-side toggling is a preview of the client's choice; the authoritative
  // selection is whatever the client does on their own page.
  host.querySelectorAll('[data-extra]').forEach((box) =>
    box.addEventListener('change', () => {
      const line = state.lines.find((l) => l.id === box.dataset.extra);
      line.selected = box.checked;
      saveLines();
    }));
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

  const sendBtn = $('send-btn');
  const hard = state.blockers.filter((b) => !b.overridable);
  sendBtn.disabled = state.quote.status === 'accepted' || hard.length > 0;
  sendBtn.textContent =
    state.quote.status === 'accepted' ? 'Accepted' :
    hard.length ? hard[0].message :
    state.quote.status === 'draft' ? 'Send Quote →' : 'Re-send Quote →';
}

/* ------------------------------------------------------------------ saving */

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
    site_address: $('site_address').value.trim(),
    description: $('description').value,
    client_summary: $('client_summary').value.trim(),
  });
  touched.clear();
  return saved;
}

$('save-btn').addEventListener('click', async (e) => {
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

/* ------------------------------------------------------------- AI drafting */

$('draft-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  const description = $('description').value.trim();
  if (!description) return banner('warn', 'Describe the job first — record a voice note or type it.');

  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Drafting…';
  clearBanner();
  try {
    apply(await api.draft(quoteId, description, $('use-photos').checked));
    banner('warn', state.quote?.ai_summary?.ai === false
      ? '<strong>Drafted from the template.</strong> No AI is connected, so nothing was read from your description — confirm every line before you can send.'
      : '<strong>Draft ready.</strong> Items marked 🤖 need a tap to confirm before you can send.');
  } catch (err) {
    if (err instanceof ApiError && err.status === 502) {
      const detail = Array.isArray(err.body.detail) ? `<ul>${err.body.detail.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>` : '';
      banner('bad', `<strong>AI draft rejected.</strong> ${esc(err.message)}${detail}<p style="margin:0">Nothing was changed — build the quote manually or try again.</p>`);
    } else {
      reportError(err);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generate Draft with AI';
  }
});

/* ------------------------------------------------------- voice note → text */

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
const recordBtn = $('record-btn');
let recogniser = null;

if (!SpeechRecognition) {
  // Firefox has no Web Speech API. Say so plainly rather than offering a button
  // that silently does nothing.
  recordBtn.disabled = true;
  recordBtn.textContent = '🎙️ Voice notes not supported in this browser';
  $('record-hint').textContent = 'Type the description below instead.';
} else {
  recordBtn.addEventListener('click', () => {
    if (recogniser) return stopRecording();
    recogniser = new SpeechRecognition();
    recogniser.lang = 'en-GB';
    recogniser.continuous = true;
    recogniser.interimResults = true;

    const before = $('description').value;
    recogniser.addEventListener('result', (ev) => {
      let text = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) text += ev.results[i][0].transcript;
      $('description').value = (before ? `${before} ` : '') + text;
    });
    recogniser.addEventListener('error', (ev) => {
      banner('bad', `Voice note failed: ${esc(ev.error)}. Type the description instead.`);
      stopRecording();
    });
    recogniser.addEventListener('end', stopRecording);

    recogniser.start();
    recordBtn.classList.add('recording');
    recordBtn.textContent = '● Recording — tap to stop';
  });
}

function stopRecording() {
  if (recogniser) {
    try { recogniser.stop(); } catch { /* already stopped */ }
    recogniser = null;
  }
  recordBtn.classList.remove('recording');
  recordBtn.textContent = '● Hold to record voice note';
}

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

$('line-code').addEventListener('change', () => {
  const entry = state.priceBook.find((p) => p.code === $('line-code').value);
  if (entry && !$('line-desc').value.trim()) $('line-desc').value = entry.description;
  updateLinePreview();
});
$('line-qty').addEventListener('input', updateLinePreview);

lineDialog.addEventListener('close', async () => {
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

$('add-line-btn').addEventListener('click', () => openLineDialog(null));

/* -------------------------------------------------------------- preview */

$('preview-btn').addEventListener('click', () => {
  window.open(`quote.html?t=${encodeURIComponent(state.quote.public_token)}&preview=1`, '_blank', 'noopener');
});

/* ----------------------------------------------------------------- sending */

const overrideDialog = $('override-dialog');
const sentDialog = $('sent-dialog');

$('send-btn').addEventListener('click', () => trySend());

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

overrideDialog.addEventListener('close', () => {
  if (overrideDialog.returnValue !== 'override') return;
  const reason = $('override-reason').value.trim();
  if (!reason) return banner('bad', 'A reason is required to send below the margin floor.');
  trySend(reason);
});

$('copy-link').addEventListener('click', async (e) => {
  try {
    await navigator.clipboard.writeText($('sent-link').value);
    e.currentTarget.textContent = 'Copied ✓';
  } catch {
    $('sent-link').select();
    e.currentTarget.textContent = 'Press ⌘/Ctrl+C';
  }
});

boot();