/** Small HTTP helpers: JSON responses, CORS, and owner auth. */

export function corsHeaders(env, request) {
  // ALLOWED_ORIGINS is a comma-separated allowlist (the GitHub Pages origin, plus
  // localhost for development). We echo the caller's origin only when it matches,
  // so the API is never wildcard-open to any site that fancies calling it.
  const allowed = (env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const origin = request.headers.get('Origin');
  const headers = {
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
  if (origin && allowed.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

export function json(data, { status = 200, env, request, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(env && request ? corsHeaders(env, request) : {}),
      ...headers,
    },
  });
}

export function fail(status, message, extra = {}, ctx = {}) {
  return json({ error: message, ...extra }, { status, ...ctx });
}

/** Length-independent comparison, so a wrong token leaks no timing signal. */
export function safeEqual(a = '', b = '') {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

/** Owner endpoints require the shared owner token. */
export function requireOwner(request, env) {
  const expected = env.OWNER_TOKEN;
  if (!expected) return 'Worker has no OWNER_TOKEN configured.';
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return safeEqual(token, expected) ? null : 'Unauthorized.';
}

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'; // no look-alike characters

/** URL-safe random token; 26 chars ≈ 130 bits, fine for an unguessable link. */
export function randomToken(length = 26) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

export function newId(prefix) {
  return `${prefix}_${randomToken(16)}`;
}
