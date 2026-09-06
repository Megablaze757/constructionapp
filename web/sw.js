/**
 * Service worker: app shell only.
 *
 * Deliberately never caches API responses. Quote totals, margins and statuses
 * change from other devices, and a stale price shown as current is worse than
 * no price at all — so /api/ and /q/ always go to the network.
 *
 * The shell includes the local backend — the SQLite engine, the schema, and the
 * Worker's own source — because that is what makes the app work with no network
 * at all rather than merely load and then fail.
 */

const CACHE = 'builderos-shell-v7';
const SHELL = [
  './',
  './index.html',
  './builder.html',
  './quote.html',
  './jobs.html',
  './variance.html',
  './team.html',
  './sops.html',
  './cash.html',
  './crew.html',
  './dashboard.html',
  './automations.html',
  './config.js',
  './manifest.webmanifest',
  './assets/app.css',
  './assets/icon.svg',
  './assets/js/api.js',
  './assets/js/pwa.js',
  './assets/js/list.js',
  './assets/js/builder.js',
  './assets/js/client.js',
  './assets/js/photos.js',
  './assets/js/jobs.js',
  './assets/js/variance.js',
  './assets/js/team.js',
  './assets/js/sops.js',
  './assets/js/cash.js',
  './assets/js/crew.js',
  './assets/js/dashboard.js',
  './assets/js/automations.js',

  // Local mode: the database engine, the schema, and the Worker itself.
  './assets/vendor/sql-wasm.js',
  './assets/vendor/sql-wasm.wasm',
  './assets/schema.sql',
  './assets/js/local/backend.js',
  './assets/js/local/d1.js',
  ...[
    'automation', 'dashboard', 'db', 'delegation', 'fallback-draft', 'groq', 'http',
    'index', 'invoicing', 'messaging', 'pricing', 'reliability', 'schema',
    'templates', 'variance',
  ].map((m) => `./assets/js/worker/${m}.js`),
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // One bad URL must not fail the whole install, so cache what we can.
      .then((cache) => Promise.allSettled(SHELL.map((u) => cache.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;      // the Worker API
  if (url.pathname.includes('/api/') || url.pathname.includes('/q/')) return;

  // Network-first so a deploy is picked up promptly, cache as the offline floor.
  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(request).then((hit) => hit || caches.match('./index.html'))),
  );
});
