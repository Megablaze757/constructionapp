import './pwa.js';
import { api, ownerToken, API_BASE, price, formatDate, esc, ApiError } from './api.js';

const $ = (id) => document.getElementById(id);
let invoices = [];
let jobs = [];
let payingId = null;

const banner = (kind, html) =>
  ($('banner').innerHTML = `<div class="card"><div class="card-body"><div class="notice notice-${kind}">${html}</div></div></div>`);

function reportError(err) {
  banner('bad', err instanceof ApiError && err.status === 401
    ? '<strong>Token rejected.</strong> Set it on the <a href="index.html">quotes screen</a>.'
    : `<strong>Error.</strong> ${esc(err.message)}`);
}

const CHASE_LABEL = {
  friendly_reminder: 'friendly reminder',
  firm_reminder: 'firmer reminder',
  escalate_to_owner: 'needs you',
};

async function boot() {
  if (!API_BASE || !ownerToken.get()) {
    return banner('bad', 'Not configured. Set your owner token on the <a href="index.html">quotes screen</a>.');
  }
  try {
    [{ jobs }] = await Promise.all([api.listJobs()]);
  } catch { /* the invoice form can still work unlinked */ }
  await load();
}

async function load() {
  try {
    const cash = await api.cash();
    invoices = cash.invoices;
    render(cash);
  } catch (err) {
    reportError(err);
  }
}

function render(cash) {
  const overdue = cash.overdue_amount > 0;
  $('summary').innerHTML = `
    <div class="total-row">
      <span class="label">Owed to you</span>
      <span class="value">${price(cash.outstanding)}</span>
    </div>
    <div class="total-row">
      <span class="label">Overdue</span>
      <span class="badge ${overdue ? 'badge-bad' : 'badge-ok'}">
        ${price(cash.overdue_amount)}${cash.overdue_count ? ` · ${cash.overdue_count} invoice${cash.overdue_count > 1 ? 's' : ''}` : ''}
      </span>
    </div>
    ${cash.oldest_overdue_days
      ? `<div class="notice notice-bad">Your oldest unpaid invoice is <strong style="display:inline">${cash.oldest_overdue_days} days</strong> past its due date.</div>`
      : '<div class="notice notice-ok">Nothing overdue.</div>'}
    <div class="aging">
      ${Object.entries(cash.aging).map(([bucket, b]) => `
        <div class="aging-cell ${b.amount > 0 && bucket !== 'current' ? 'is-late' : ''}">
          <span class="aging-label">${bucket === 'current' ? 'not yet due' : `${bucket} days`}</span>
          <span class="aging-amount">${price(b.amount)}</span>
        </div>`).join('')}
    </div>
    ${cash.draft_count ? `<p class="muted" style="margin:0">${cash.draft_count} draft invoice${cash.draft_count > 1 ? 's' : ''} not sent yet — nobody owes you for those.</p>` : ''}`;

  $('chase-card').hidden = !cash.needs_chasing.length;
  $('chase').innerHTML = cash.needs_chasing.map((n) => `
    <div class="line">
      <div class="line-desc"><span>${esc(n.client_name)}</span>
        <span class="tag tag-ai">${esc(CHASE_LABEL[n.chase_stage] || n.chase_stage)}</span>
      </div>
      <div class="line-price">${price(n.outstanding)}</div>
      <div class="line-qty">${esc(n.number)} · ${n.days_overdue} days overdue</div>
    </div>`).join('');

  $('invoices').innerHTML = invoices.length
    ? invoices.map(invoiceRow).join('')
    : '<div class="card-body muted">No invoices yet.</div>';

  document.querySelectorAll('[data-pay]').forEach((b) =>
    b.addEventListener('click', () => openPayment(b.dataset.pay)));
  document.querySelectorAll('[data-send]').forEach((b) =>
    b.addEventListener('click', () => setStatus(b.dataset.send, 'sent')));
}

function invoiceRow(i) {
  const cls = i.settled ? 'badge-ok' : i.overdue ? 'badge-bad' : 'badge-warn';
  const state = i.settled ? 'paid'
    : i.status === 'draft' ? 'draft'
      : i.overdue ? `${i.days_overdue}d overdue` : 'awaiting payment';
  return `
    <div class="line">
      <div class="line-desc">
        <span>${esc(i.client_name)}</span>
        <span class="badge ${cls}">${esc(state)}</span>
        ${i.part_paid ? '<span class="tag">part paid</span>' : ''}
      </div>
      <div class="line-price">${price(i.outstanding || i.amount)}</div>
      <div class="line-qty">
        ${esc(i.number)} · ${price(i.amount)}
        ${i.due_on ? ` · due ${esc(formatDate(i.due_on))}` : ''}
        ${i.site_address ? ` · ${esc(i.site_address)}` : ''}
      </div>
      <div class="line-actions">
        ${i.status === 'draft' ? `<button class="btn btn-sm btn-primary" data-send="${esc(i.id)}" type="button">Mark sent</button>` : ''}
        ${!i.settled && i.status !== 'draft' ? `<button class="btn btn-sm" data-pay="${esc(i.id)}" type="button">Record payment</button>` : ''}
      </div>
    </div>`;
}

async function setStatus(id, status) {
  try {
    await api.patchInvoice(id, { status });
    await load();
  } catch (err) { reportError(err); }
}

/* ------------------------------------------------------------- payments */

const paymentDialog = $('payment-dialog');

function openPayment(id) {
  payingId = id;
  const i = invoices.find((x) => x.id === id);
  $('pay-detail').textContent = `${i.number} — ${price(i.amount)}, ${price(i.outstanding)} still outstanding.`;
  $('pay-amount').value = i.amount_paid || '';
  paymentDialog.showModal();
}

paymentDialog.addEventListener('close', async () => {
  const action = paymentDialog.returnValue;
  if (action === 'cancel') return;
  try {
    if (action === 'full') await api.patchInvoice(payingId, { status: 'paid' });
    else {
      const amt = Number($('pay-amount').value);
      if (!Number.isFinite(amt) || amt < 0) return banner('bad', 'Enter an amount.');
      await api.patchInvoice(payingId, { amount_paid: amt });
    }
    await load();
  } catch (err) { reportError(err); }
});

/* -------------------------------------------------------------- new invoice */

const invoiceDialog = $('invoice-dialog');

$('add-btn').addEventListener('click', () => {
  $('i-job').innerHTML = '<option value="">Not linked to a job</option>'
    + jobs.map((j) => `<option value="${esc(j.id)}">${esc(j.client_name)} — ${esc(j.site_address || j.job_type)}</option>`).join('');
  $('i-client').value = '';
  $('i-amount').value = '';
  $('i-due').value = '';
  $('i-sent').checked = true;
  invoiceDialog.showModal();
});

// Picking a job fills in the client and the amount still unbilled.
$('i-job').addEventListener('change', () => {
  const job = jobs.find((j) => j.id === $('i-job').value);
  if (!job) return;
  $('i-client').value = job.client_name;
  if (!$('i-amount').value) $('i-amount').value = job.budget_baseline || '';
});

invoiceDialog.addEventListener('close', async () => {
  if (invoiceDialog.returnValue !== 'save') return;
  const amount = Number($('i-amount').value);
  if (!Number.isFinite(amount) || amount <= 0) return banner('bad', 'Enter the invoice amount.');
  if (!$('i-client').value.trim() && !$('i-job').value) return banner('bad', 'Enter a client name.');

  try {
    await api.createInvoice({
      job_id: $('i-job').value || null,
      client_name: $('i-client').value.trim(),
      amount,
      due_on: $('i-due').value.trim() || null,
      status: $('i-sent').checked ? 'sent' : 'draft',
    });
    await load();
  } catch (err) { reportError(err); }
});

boot();
