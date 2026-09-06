/**
 * Client-facing interactive quote (wireframe §1.2).
 *
 * This page is reached by an unguessable link with no login, so it only ever
 * renders what the API chooses to send. It never sees cost or margin.
 */

import {
  clientApi, clientPhotoUrl, BUSINESS_NAME, price, titleCase, formatDate, esc, ApiError,
} from './api.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const token = params.get('t');
const isPreview = params.get('preview') === '1';

let quote = null;

function banner(kind, html) {
  $('banner').innerHTML = `<div class="card"><div class="card-body"><div class="notice notice-${kind}">${html}</div></div></div>`;
}

async function boot() {
  $('logo').textContent = (BUSINESS_NAME[0] || 'B').toUpperCase();
  if (!token) return fatal('This link is missing its quote reference.');

  try {
    const res = await clientApi.get(token);
    quote = res.quote;
    render();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) {
      return fatal('This quote link is no longer available. Please contact your builder.');
    }
    fatal(err.message);
  }
}

function fatal(message) {
  $('heading').textContent = 'Quote unavailable';
  $('validity').textContent = '';
  banner('bad', esc(message));
}

function render() {
  $('heading').textContent = `Quote for ${quote.client_name}`;
  $('validity').textContent = quote.valid_until ? `Valid until ${formatDate(quote.valid_until)}` : '';
  $('job-title').textContent = titleCase(quote.job_type);
  $('job-summary').textContent = quote.summary || '';
  renderPhotos();

  $('scope').innerHTML = quote.scope
    .map((s) => `<li>${esc(s.description)}${s.quantity ? ` — ${s.quantity} ${esc(s.unit)}` : ''}</li>`)
    .join('');

  $('base-price').textContent = price(quote.base_price);
  renderExtras();
  renderTotal();

  $('content').hidden = false;

  const closed = quote.status === 'accepted' || quote.expired;
  $('actions').hidden = closed || isPreview;

  if (isPreview) {
    banner('warn', '<strong>Preview.</strong> This is exactly what your client sees. Buttons are hidden here.');
  } else if (quote.expired) {
    banner('warn', '<strong>This quote has expired.</strong> Contact your builder for an updated price.');
  }

  if (quote.status === 'accepted') {
    $('accepted-note').innerHTML =
      "<div class='notice notice-ok'><strong>Booked ✅</strong>We'll be in touch to confirm your start date.</div>";
  }
}

/** Real site photos, or nothing — never a placeholder standing in for the client's property. */
function renderPhotos() {
  const host = $('photo');
  const photos = quote.photos || [];
  if (!photos.length) {
    host.hidden = true;
    return;
  }
  host.hidden = false;
  host.innerHTML = photos
    .map((p) => `<img data-photo="${esc(p.id)}" alt="${esc(p.caption || 'Site photo')}" loading="lazy">`)
    .join('');
  host.classList.toggle('photo-multi', photos.length > 1);

  // Resolved rather than templated, because in local mode the bytes come from
  // this browser as a blob and there is no address to point the tag at.
  host.querySelectorAll('img[data-photo]').forEach(async (img) => {
    const src = await clientPhotoUrl(token, img.dataset.photo);
    if (src) img.src = src;
    else img.remove();
  });
}

function renderExtras() {
  const card = $('extras-card');
  if (!quote.extras.length) return (card.hidden = true);
  card.hidden = false;

  const locked = quote.status === 'accepted' || quote.expired || isPreview;
  $('extras').innerHTML = quote.extras
    .map((x) => `
      <label class="extra">
        <input type="checkbox" data-id="${esc(x.id)}" ${x.selected ? 'checked' : ''} ${locked ? 'disabled' : ''}>
        <span>${esc(x.description)}</span>
        <span class="extra-price">+${price(x.price)}</span>
        ${x.blurb ? `<span class="extra-blurb">${esc(x.blurb)}</span>` : ''}
      </label>`)
    .join('');

  $('extras').querySelectorAll('input[data-id]').forEach((box) =>
    box.addEventListener('change', onToggleExtra));
}

/**
 * Update the total immediately, then reconcile with the server. The optimistic
 * number keeps the page feeling live; the server's answer is what counts, and a
 * failure rolls the checkbox back rather than leaving a wrong total on screen.
 */
async function onToggleExtra(ev) {
  const box = ev.currentTarget;
  const extra = quote.extras.find((x) => x.id === box.dataset.id);
  extra.selected = box.checked;
  renderTotal();

  const selected = quote.extras.filter((x) => x.selected).map((x) => x.id);
  try {
    const res = await clientApi.setExtras(token, selected);
    quote = res.quote;
    renderTotal();
  } catch (err) {
    extra.selected = !box.checked;
    box.checked = extra.selected;
    renderTotal();
    banner('bad', `Could not update your quote: ${esc(err.message)}`);
  }
}

function renderTotal() {
  const total = quote.base_price + quote.extras.filter((x) => x.selected).reduce((t, x) => t + x.price, 0);
  $('total').textContent = price(total);
}

/* ------------------------------------------------------------------ accept */

const confirmDialog = $('confirm-dialog');

$('accept-btn').addEventListener('click', () => {
  const total = $('total').textContent;
  $('confirm-detail').textContent = `You're booking ${titleCase(quote.job_type)} at ${total}.`;
  confirmDialog.showModal();
});

confirmDialog.addEventListener('close', async () => {
  if (confirmDialog.returnValue !== 'accept') return;
  const btn = $('accept-btn');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Booking…';
  try {
    const res = await clientApi.accept(token);
    quote.status = 'accepted';
    render();
    banner('ok', `<strong>Booked ✅</strong>${esc(res.message)}`);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    banner('bad', esc(err.message));
    btn.disabled = false;
    btn.innerHTML = '✅ Accept &amp; Book Job';
  }
});

/* --------------------------------------------------------------- questions */

const askDialog = $('ask-dialog');
$('ask-btn').addEventListener('click', () => {
  $('ask-message').value = '';
  askDialog.showModal();
});

askDialog.addEventListener('close', async () => {
  if (askDialog.returnValue !== 'send') return;
  const message = $('ask-message').value.trim();
  if (!message) return;
  try {
    await clientApi.ask(token, message);
    banner('ok', '<strong>Message sent.</strong> Your builder will come back to you.');
  } catch (err) {
    banner('bad', esc(err.message));
  }
});

boot();
