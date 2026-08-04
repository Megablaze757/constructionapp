/** Thin API client shared by the owner screens and the client quote page. */

const cfg = window.BUILDEROS_CONFIG || {};
const override = new URLSearchParams(location.search).get('api');

export const API_BASE = (override || cfg.apiBase || '').replace(/\/$/, '');
export const BUSINESS_NAME = cfg.businessName || 'Builder Co.';

const TOKEN_KEY = 'builderos.ownerToken';

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

async function request(path, { method = 'GET', body, auth = true } = {}) {
  if (!API_BASE) {
    throw new ApiError('No API configured. Set apiBase in config.js.', 0);
  }
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (auth) {
    const token = ownerToken.get();
    if (!token) throw new ApiError('Owner token not set.', 401);
    headers.Authorization = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // A CORS rejection and an offline device are indistinguishable from here, so
    // name both rather than guessing wrong.
    throw new ApiError('Could not reach the API. Check the Worker URL, its CORS allowlist, and your connection.', 0);
  }

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
    const res = await fetch(`${API_BASE}/api/quotes/${quoteId}/photos/${photoId}`, {
      headers: { Authorization: `Bearer ${ownerToken.get()}` },
    });
    if (!res.ok) throw new ApiError(`Could not load photo (${res.status})`, res.status);
    return URL.createObjectURL(await res.blob());
  },
};

/* ------------------------------------------------------------------ client */

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
