/**
 * Thin API client shared by the owner screens and the client quote page.
 *
 * Every call goes through `send()`, which is also where the app decides whether
 * there is a Worker to talk to at all. When there is not, the same Worker source
 * runs in this browser instead — see local/backend.js. That decision is made
 * once per tab and is deliberately conservative: a deployment that has ever
 * answered is never quietly swapped for a local copy behind the owner's back,
 * because a quote written into the wrong database is worse than an error.
 */

const cfg = window.BUILDEROS_CONFIG || {};
const params = new URLSearchParams(location.search);
const override = params.has('api') ? params.get('api') : cfg.apiBase;

export const API_BASE = (override || '').replace(/\/$/, '');
export const BUSINESS_NAME = cfg.businessName || 'Builder Co.';

const TOKEN_KEY = 'builderos.ownerToken';
const MODE_KEY = 'builderos.mode';
const SEEN_KEY = 'builderos.reached';

export const ownerToken = {
  get: () => localStorage.getItem(TOKEN_KEY) || '',
  set: (v) => localStorage.setItem(TOKEN_KEY, v),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body || {};
  }
}

/* -------------------------------------------------------- network or local */

const NO_API = 'No API configured. Set apiBase in config.js, or open this page with ?local=1 to work in this browser.';
const UNREACHABLE = 'Could not reach the API. Check the Worker URL, its CORS allowlist, and your connection.';

/**
 * The owner asked for local mode outright — a query flag, or a saved choice.
 * The flag sticks, because navigating from the quote list to the builder would
 * otherwise drop it and land the next page on a different database.
 */
if (params.get('local') === '1') localStorage.setItem(MODE_KEY, 'local');
const forcedLocal = localStorage.getItem(MODE_KEY) === 'local';

/** Has this API base ever answered? If so a failure is a fault, not an absence. */
const everReached = () => (localStorage.getItem(SEEN_KEY) || '') === API_BASE;

let resolving = null;
let local = null;

/** @returns {Promise<'network'|'local'>} decided once, then reused. */
function mode() {
  if (!resolving) resolving = decide();
  return resolving;
}

async function decide() {
  if (forcedLocal || !API_BASE) return goLocal(forcedLocal ? 'chosen' : 'unconfigured');

  try {
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), 5000);
    const res = await fetch(`${API_BASE}/health`, { signal: stop.signal });
    clearTimeout(timer);
    if (res.ok) {
      localStorage.setItem(SEEN_KEY, API_BASE);
      return 'network';
    }
  } catch {
    /* fall through — an unreachable Worker is handled below */
  }

  // A Worker that has answered before is expected to answer again. Silently
  // routing to a local database would split the business's data in two, so this
  // stays on the network, fails loudly, and offers local mode as a choice.
  if (everReached()) {
    banner('down');
    return 'network';
  }
  return goLocal('unreachable');
}

async function goLocal(reason) {
  const { localBackend } = await import('./local/backend.js');
  local = await localBackend();
  banner(reason);
  return 'local';
}

/** Switch to local mode from the banner and keep it that way. */
export function useLocalMode() {
  localStorage.setItem(MODE_KEY, 'local');
  location.reload();
}

/** Go back to trying the configured Worker. */
export function useNetworkMode() {
  localStorage.removeItem(MODE_KEY);
  location.reload();
}

/** True once the app has settled on running in this browser. */
export const isLocal = () => local !== null;

/**
 * Settle on a backend, and say whether the screen can load anything.
 *
 * Every screen awaits this before its first call. It is false only when there is
 * a Worker configured but no owner token to talk to it with — the one setup step
 * the app genuinely cannot do for you. Local mode is never in that state; it
 * mints its own token.
 */
export async function ready() {
  await mode();
  return isLocal() || !!(API_BASE && ownerToken.get());
}

/* ------------------------------------------------------------------ banner */

const BANNERS = {
  unconfigured: {
    tone: '#8a5a00',
    text: '<strong>Running in this browser.</strong> No Worker is configured, so everything is stored on this device only — client links and crew links will not open anywhere else.',
    action: null,
  },
  unreachable: {
    tone: '#8a5a00',
    text: '<strong>Running in this browser.</strong> The Worker at that address is not answering yet, so everything is stored on this device only.',
    action: null,
  },
  chosen: {
    tone: '#8a5a00',
    text: '<strong>Running in this browser</strong> by choice. Everything is stored on this device only.',
    action: { label: 'Use the Worker', fn: () => useNetworkMode() },
  },
  down: {
    tone: '#9b1c1c',
    text: '<strong>The Worker is not answering.</strong> Your data is on it, not here, so nothing has been loaded. This is a connection or deployment problem, not lost work.',
    action: { label: 'Work in this browser instead', fn: () => useLocalMode() },
  },
};

let bannerShown = false;

/**
 * Say which database the screen is talking to.
 *
 * Local mode is genuinely useful and genuinely limited, and the difference is
 * invisible from the screens themselves — they look identical either way. So it
 * is stated once, at the top, on every page, rather than left to be discovered
 * when a client cannot open a quote link.
 */
function banner(state) {
  const spec = BANNERS[state];
  if (!spec || bannerShown) return;
  bannerShown = true;

  const paint = () => {
    if (document.getElementById('builderos-mode-banner')) return;
    const bar = document.createElement('div');
    bar.id = 'builderos-mode-banner';
    bar.style.cssText = `background:${spec.tone};color:#fff;font:500 13px/1.45 system-ui,sans-serif;`
      + 'padding:10px 14px;display:flex;gap:12px;align-items:center;justify-content:space-between;'
      + 'flex-wrap:wrap;position:relative;z-index:50';
    bar.innerHTML = `<span style="min-width:0">${spec.text}</span>`;

    if (spec.action) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = spec.action.label;
      btn.style.cssText = 'background:rgba(255,255,255,.18);color:#fff;border:1px solid rgba(255,255,255,.5);'
        + 'border-radius:6px;padding:6px 12px;font:inherit;cursor:pointer;white-space:nowrap';
      btn.addEventListener('click', spec.action.fn);
      bar.append(btn);
    }
    document.body.prepend(bar);
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', paint);
  else paint();
}

async function send(path, { method = 'GET', headers = {}, body } = {}) {
  const where = await mode();
  const init = { method, headers, body };

  if (where === 'local') return local.handle(path, init);

  if (!API_BASE) throw new ApiError(NO_API, 0);
  try {
    return await fetch(`${API_BASE}${path}`, init);
  } catch {
    // A CORS rejection and an offline device are indistinguishable from here, so
    // name both rather than guessing wrong.
    throw new ApiError(UNREACHABLE, 0);
  }
}

async function request(path, { method = 'GET', body, auth = true } = {}) {
  await mode();

  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    // Local mode mints its own token, so the owner is never asked to set up
    // authentication against their own browser.
    const token = local ? local.token : ownerToken.get();
    if (!token) throw new ApiError('Owner token not set.', 401);
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await send(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 200) };
  }
  if (!res.ok) throw new ApiError(data.error || `Request failed (${res.status})`, res.status, data);
  return data;
}

/* ------------------------------------------------------------------- owner */

export const api = {
  health: () => request('/health', { auth: false }),
  templates: () => request('/api/templates'),
  templateSuggestions: () => request('/api/templates/suggestions'),
  createTemplate: (tpl) => request('/api/templates', { method: 'POST', body: tpl }),
  priceBook: () => request('/api/pricebook'),
  listQuotes: () => request('/api/quotes'),
  createQuote: (data) => request('/api/quotes', { method: 'POST', body: data }),
  getQuote: (id) => request(`/api/quotes/${id}`),
  patchQuote: (id, data) => request(`/api/quotes/${id}`, { method: 'PATCH', body: data }),
  deleteQuote: (id) => request(`/api/quotes/${id}`, { method: 'DELETE' }),
  draft: (id, description, usePhotos = true) =>
    request(`/api/quotes/${id}/draft`, { method: 'POST', body: { description, use_photos: usePhotos } }),
  putLines: (id, lines) => request(`/api/quotes/${id}/lines`, { method: 'PUT', body: { lines } }),
  confirmAll: (id) => request(`/api/quotes/${id}/lines/confirm-all`, { method: 'POST' }),
  send: (id, overrideReason) =>
    request(`/api/quotes/${id}/send`, {
      method: 'POST',
      body: overrideReason ? { override_reason: overrideReason } : {},
    }),

  // Phase D
  listJobs: () => request('/api/jobs'),
  getJob: (id) => request(`/api/jobs/${id}`),
  setJobStatus: (id, status) => request(`/api/jobs/${id}`, { method: 'PATCH', body: { status } }),
  addCost: (id, cost) => request(`/api/jobs/${id}/costs`, { method: 'POST', body: cost }),
  deleteCost: (id, costId) => request(`/api/jobs/${id}/costs/${costId}`, { method: 'DELETE' }),
  variance: () => request('/api/reports/variance'),
  photos: (quoteId) => request(`/api/quotes/${quoteId}/photos`),
  addPhoto: (quoteId, photo) => request(`/api/quotes/${quoteId}/photos`, { method: 'POST', body: photo }),
  deletePhoto: (quoteId, photoId) =>
    request(`/api/quotes/${quoteId}/photos/${photoId}`, { method: 'DELETE' }),

  // Phase 0 — team, SOPs, invoicing
  createJob: (job) => request('/api/jobs', { method: 'POST', body: job }),
  patchJob: (id, data) => request(`/api/jobs/${id}`, { method: 'PATCH', body: data }),
  people: (all = false) => request(`/api/people${all ? '?all' : ''}`),
  addPerson: (p) => request('/api/people', { method: 'POST', body: p }),
  patchPerson: (id, p) => request(`/api/people/${id}`, { method: 'PATCH', body: p }),
  deactivatePerson: (id) => request(`/api/people/${id}`, { method: 'DELETE' }),
  sops: () => request('/api/sops'),
  addSop: (s) => request('/api/sops', { method: 'POST', body: s }),
  assignCrew: (jobId, person_id, role_on_job) =>
    request(`/api/jobs/${jobId}/crew`, { method: 'POST', body: { person_id, role_on_job } }),
  unassignCrew: (jobId, personId) =>
    request(`/api/jobs/${jobId}/crew/${personId}`, { method: 'DELETE' }),
  attachSop: (jobId, sop_id) => request(`/api/jobs/${jobId}/sops`, { method: 'POST', body: { sop_id } }),
  tickSopStep: (jobId, jobSopId, step, done, photo_id) =>
    request(`/api/jobs/${jobId}/sops/${jobSopId}`, { method: 'PATCH', body: { step, done, photo_id } }),
  removeJobSop: (jobId, jobSopId) =>
    request(`/api/jobs/${jobId}/sops/${jobSopId}`, { method: 'DELETE' }),
  invoices: () => request('/api/invoices'),
  createInvoice: (i) => request('/api/invoices', { method: 'POST', body: i }),
  patchInvoice: (id, i) => request(`/api/invoices/${id}`, { method: 'PATCH', body: i }),
  cash: () => request('/api/reports/cash'),

  // Phase 1 — delegation
  attention: () => request('/api/reports/attention'),
  dashboard: () => request('/api/reports/dashboard'),

  // Phase 3 — automation
  automations: () => request('/api/automations'),
  createAutomation: (a) => request('/api/automations', { method: 'POST', body: a }),
  patchAutomation: (id, a) => request(`/api/automations/${id}`, { method: 'PATCH', body: a }),
  deleteAutomation: (id) => request(`/api/automations/${id}`, { method: 'DELETE' }),
  runAutomations: (dry = false) => request(`/api/automations/run${dry ? '?dry=1' : ''}`, { method: 'POST' }),
  outbox: () => request('/api/outbox'),
  crewLink: (personId) => request(`/api/people/${personId}/link`, { method: 'POST' }),
  addTask: (jobId, t) => request(`/api/jobs/${jobId}/tasks`, { method: 'POST', body: t }),
  patchTask: (jobId, taskId, t) =>
    request(`/api/jobs/${jobId}/tasks/${taskId}`, { method: 'PATCH', body: t }),
  addLog: (jobId, l) => request(`/api/jobs/${jobId}/log`, { method: 'POST', body: l }),
  ackLog: (jobId, logId) => request(`/api/jobs/${jobId}/log/${logId}`, { method: 'PATCH' }),
  scheduleCheckins: (jobId) => request(`/api/jobs/${jobId}/checkins`, { method: 'POST' }),
  patchCheckin: (jobId, id, data) =>
    request(`/api/jobs/${jobId}/checkins/${id}`, { method: 'PATCH', body: data }),

  /**
   * Owner-side photo bytes as an object URL.
   * An <img src> cannot carry an Authorization header, so the bytes are fetched
   * here and handed to the tag as a blob — which also means a draft quote's
   * photos never have to be exposed on the public route to be previewed.
   */
  async photoObjectUrl(quoteId, photoId) {
    await mode();
    const res = await send(`/api/quotes/${quoteId}/photos/${photoId}`, {
      headers: { Authorization: `Bearer ${local ? local.token : ownerToken.get()}` },
    });
    if (!res.ok) throw new ApiError(`Could not load photo (${res.status})`, res.status);
    return URL.createObjectURL(await res.blob());
  },

  /** Local mode only: throw the on-device database away and reseed it. */
  async resetLocal() {
    await mode();
    if (!local) throw new ApiError('Not running in local mode.', 400);
    await local.reset();
  },
};

/* ------------------------------------------------------------------ client */

/**
 * A displayable URL for a photo on a capability link.
 *
 * On a Worker this is just an address the <img> can fetch. In local mode the
 * bytes never touch the network, so they are handed over as a blob instead —
 * same tag, same picture, no request.
 */
export async function clientPhotoUrl(token, photoId) {
  await mode();
  const path = `/q/${encodeURIComponent(token)}/photo/${encodeURIComponent(photoId)}`;
  if (!local) return `${API_BASE}${path}`;
  const res = await local.handle(path);
  return res.ok ? URL.createObjectURL(await res.blob()) : '';
}

/** Unauthenticated call on a crew link — same seam, so local mode works too. */
export function crewCall(token, path, { method = 'GET', body } = {}) {
  return request(`/crew/${encodeURIComponent(token)}${path}`, { method, body, auth: false });
}

export const clientApi = {
  get: (token) => request(`/q/${token}`, { auth: false }),
  setExtras: (token, selected) => request(`/q/${token}/extras`, { method: 'POST', body: { selected }, auth: false }),
  accept: (token) => request(`/q/${token}/accept`, { method: 'POST', auth: false }),
  ask: (token, message) => request(`/q/${token}/question`, { method: 'POST', body: { message }, auth: false }),
};

/* ----------------------------------------------------------------- helpers */

export const gbp = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'GBP',
  maximumFractionDigits: 0,
});

export const gbpExact = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });

/** Whole pounds read better on site; pennies only when they actually exist. */
export function price(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? gbp.format(v) : gbpExact.format(v);
}

export function titleCase(slug = '') {
  return slug.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Minimal escaping for the few places we build markup from data. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
