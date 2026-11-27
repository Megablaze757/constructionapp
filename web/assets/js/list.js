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
  $('backup-section').hidden = !isLocal();
  $('mode-explainer').innerHTML = isLocal()
    ? 'Nothing is deployed, so BuilderOS is running in this browser and storing everything on '
      + 'this device. Deploy the Worker and set its URL to share the data, send client links '
      + 'and give crew their own pages.'
    : `Talking to your Cloudflare Worker. The owner token is the <code>OWNER_TOKEN</code> secret
       you set on it, and is stored only in this browser.${running ? '' : ' Paste it below to start.'}`;
  dialog.showModal();
});

/* --------------------------------------------- import their own quote */

/**
 * Turning a quote they have already sent into a template and a price book.
 *
 * Nothing is saved until this dialog is confirmed, because committing writes to
 * the price book and every future quote is costed from it. The review shows the
 * figures as read, says where each cost came from, and cross-checks the line
 * totals against the quote's own subtotal — if those disagree, a line was
 * missed, and the owner needs to know that before their rates come from it.
 */
const importDialog = $('import-dialog');
let importParsed = null;

const importSay = (m) => ($('import-status').textContent = m);
const money = (n) => `£${Number(n).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

$('import-btn')?.addEventListener('click', () => $('import-input').click());

$('import-input')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;

  importSay(`Reading ${file.name}…`);
  try {
    const { processDocument } = await import('./plans.js');
    const doc = await processDocument(file);
    if (!doc.text || doc.text.length < 40) {
      importSay(doc.images.length
        ? `${file.name} is a drawing, not a quote — there is no text in it to read line items from.`
        : `There was not enough readable text in ${file.name}.`);
      return;
    }
    const { parsed } = await api.importPreview(doc.text, file.name.replace(/\.[^.]+$/, ''));
    importParsed = { ...parsed, source_name: file.name };
    openImportDialog();
    importSay('');
  } catch (err) {
    importSay(err.message);
  }
});

function openImportDialog() {
  const p = importParsed;
  $('import-source').textContent = `Read from ${p.source_name} — ${p.lines.length} work item${p.lines.length === 1 ? '' : 's'}.`;
  $('import-name').value = p.name;
  $('import-jobtype').value = p.job_type;
  $('import-margin').value = 30;

  // Each check is reported on its own, pass or fail. The subtotal check is the
  // one that says whether the whole quote was read, so it is never hidden
  // behind another warning — a clean total is as much information as a warning.
  const checks = [];
  const sum = p.lines.reduce((t, l) => t + l.line_total, 0);

  if (p.totals?.subtotal) {
    const matches = Math.abs(sum - p.totals.subtotal) <= 0.02;
    checks.push({
      ok: matches,
      html: matches
        ? `These lines add up to ${money(sum)}, matching your quote's own subtotal — so nothing was missed.`
        : `These lines add up to ${money(sum)}, but your quote says the subtotal is `
          + `${money(p.totals.subtotal)}. That gap is ${money(Math.abs(sum - p.totals.subtotal))} of work `
          + 'not read — check what is missing below before saving.',
    });
  }

  for (const l of p.lines.filter((x) => !x.consistent)) {
    checks.push({ ok: false, html: `<strong>${esc(l.description)}</strong> — ${esc(l.note)}` });
  }

  if (p.skipped?.length) {
    checks.push({
      ok: false,
      html: `${p.skipped.length} priced line${p.skipped.length === 1 ? '' : 's'} could not be read as work: `
        + `${p.skipped.slice(0, 4).map((t) => `<code>${esc(t)}</code>`).join(', ')}`,
    });
  }

  const failed = checks.filter((c) => !c.ok);
  $('import-warnings').innerHTML = checks.length
    ? `<div class="notice notice-${failed.length ? 'warn' : 'ok'}">
         <strong>${failed.length ? 'Worth checking before you save' : 'This adds up'}</strong>
         <ul>${checks.map((c) => `<li>${failed.length && c.ok ? '✅ ' : ''}${c.html}</li>`).join('')}</ul>
       </div>`
    : '';

  renderImportLines();
  updateImportCosts();
  importDialog.showModal();
}

function renderImportLines() {
  $('import-lines').innerHTML = importParsed.lines.map((l, i) => `
    <div class="line ${l.consistent ? '' : 'unconfirmed'}">
      <div class="line-desc">
        ${l.consistent ? '' : '<span class="dot" title="The arithmetic does not add up"></span>'}
        <input type="text" class="import-desc" data-i="${i}" value="${esc(l.description)}" aria-label="Description">
      </div>
      <div class="line-qty">
        <input type="number" class="import-qty" data-i="${i}" value="${l.quantity}" step="any" min="0" aria-label="Quantity">
        ${esc(l.unit)} @
        <input type="number" class="import-price" data-i="${i}" value="${l.unit_price}" step="0.01" min="0" aria-label="Price each">
      </div>
      <div class="line-price">${money(l.line_total)}</div>
      <div class="line-note" data-cost="${i}"></div>
    </div>`).join('');

  for (const [cls, field, cast] of [
    ['import-desc', 'description', String],
    ['import-qty', 'quantity', Number],
    ['import-price', 'unit_price', Number],
  ]) {
    $('import-lines').querySelectorAll(`.${cls}`).forEach((el) => {
      el.addEventListener('input', () => {
        importParsed.lines[Number(el.dataset.i)][field] = cast(el.value);
        updateImportCosts();
      });
    });
  }
}

/**
 * Show the cost each line would be saved at, and say where it came from.
 *
 * Recomputed live rather than on save, so the owner sees what a margin of 30%
 * actually means in pounds for their own rates before committing to it.
 */
function updateImportCosts() {
  const pct = Number($('import-margin').value);
  const valid = Number.isFinite(pct) && pct >= 0 && pct < 100;
  $('import-lines').querySelectorAll('[data-cost]').forEach((el) => {
    const l = importParsed.lines[Number(el.dataset.cost)];
    el.textContent = valid
      ? `Cost ${money(l.unit_price * (1 - pct / 100))} each, worked back from the ${pct}% margin you gave — not read from your quote.`
      : 'Give a margin between 0 and 99 to work the cost out.';
  });
  $('import-cost-note').textContent = valid
    ? `Every line will be saved at ${pct}% margin. Edit a price above and the cost follows.`
    : 'A typical margin must be between 0 and 99 per cent.';
}

$('import-margin')?.addEventListener('input', updateImportCosts);

importDialog?.addEventListener('close', async () => {
  if (importDialog.returnValue !== 'save' || !importParsed) return;
  importSay('Saving…');
  try {
    const res = await api.importCommit({
      job_type: $('import-jobtype').value.trim(),
      name: $('import-name').value.trim(),
      // Line totals are recomputed from whatever the owner left in the fields,
      // so an edited quantity or rate is saved consistently rather than against
      // the figure originally read.
      lines: importParsed.lines.map((l) => ({
        ...l,
        line_total: Math.round(l.quantity * l.unit_price * 100) / 100,
        consistent: true,
      })),
      margin_pct: Number($('import-margin').value),
      source_name: importParsed.source_name,
    });
    importSay(`Saved "${res.template.name}" — ${res.price_book_rows} rates added to your price book. `
      + 'Pick it under Job type above.');
    await loadTemplates();
  } catch (err) {
    const detail = Array.isArray(err.body?.detail) ? ` ${err.body.detail.join(' ')}` : '';
    importSay(`${err.message}${detail}`);
  }
});

/* ------------------------------------------------------------ on-device backup */

const backupSay = (m) => ($('backup-status').textContent = m);

$('backup-btn')?.addEventListener('click', async () => {
  try {
    const bytes = await api.exportLocal();
    const stamp = new Date().toISOString().slice(0, 10);
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `builderos-backup-${stamp}.sqlite`;
    a.click();
    // Revoked on a delay: Safari has not necessarily started the download by
    // the time click() returns, and revoking early cancels it.
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    backupSay(`Saved builderos-backup-${stamp}.sqlite — ${Math.round(bytes.length / 1024)}KB.`);
  } catch (err) {
    backupSay(err.message);
  }
});

$('restore-btn')?.addEventListener('click', () => $('restore-input').click());

$('restore-input')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;

  // Restoring is not undoable and takes everything with it, so it is asked
  // rather than assumed — and the file is validated before anything is written.
  if (!window.confirm(
    `Restore from ${file.name}?

Everything currently on this device will be replaced. `
    + 'If you have not backed it up, cancel and do that first.',
  )) return;

  backupSay('Checking the file…');
  try {
    await api.restoreLocal(await file.arrayBuffer());
    backupSay('Restored. Reloading…');
    setTimeout(() => location.reload(), 600);
  } catch (err) {
    backupSay(err.message);
  }
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
        <div class="quote-row" style="display:flex; align-items:center; gap:8px; border-bottom:1px solid var(--line); padding:8px 0;">
          <a class="quote-item" href="builder.html?id=${encodeURIComponent(q.id)}" style="flex:1; text-decoration:none; color:inherit;">
            <span class="who" style="font-weight:700;">${esc(q.client_name || 'Unnamed Client')}</span>
            <span class="status status-${esc(q.status)}">${esc(q.status)}</span>
            <span class="meta" style="display:block; font-size:12px; color:var(--ink-2);">
              ${esc(titleCase(q.job_type))}${q.site_address ? ` · ${esc(q.site_address)}` : ''}
              · ${price(q.subtotal_price)}${q.status !== 'draft' ? ` · ${q.margin_pct}% margin` : ''}
              · ${esc(formatDate(q.created_at))}
            </span>
          </a>
          <button class="btn btn-sm btn-whatsapp" data-share-wa="${esc(q.id)}" data-client="${esc(q.client_name || '')}" data-site="${esc(q.site_address || '')}" type="button" style="padding:6px 10px; font-size:13px;" title="Share quote via WhatsApp">💬 WhatsApp</button>
        </div>`)
      .join('');

    list.querySelectorAll('[data-share-wa]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const qId = btn.dataset.shareWa;
        const client = btn.dataset.client;
        const site = btn.dataset.site;
        const quoteUrl = `${location.origin}/quote.html?id=${encodeURIComponent(qId)}`;
        const msg = `Hi ${client ? client : 'there'}, here is your quote for ${site ? site : 'your job'}:
${quoteUrl}

Please review and let me know if you have any questions!`;
        window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank', 'noopener,noreferrer');
      });
    });
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