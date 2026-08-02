/**
 * Service worker: app shell only.
 *
 * Deliberately never caches API responses. Quote totals, margins and statuses
 * change from other devices, and a stale price shown as current is worse than
 * no price at all — so /api/ and /q/ always go to the network.
 */

const CACHE = 'builderos-shell-v1';
const SHELL = [
  './',
  './index.html',
  './builder.html',
  './quote.html',
  './config.js',
  './manifest.webmanifest',
  './assets/app.css',
  './assets/icon.svg',
  './assets/js/api.js',
  './assets/js/list.js',
  './assets/js/builder.js',
  './assets/js/client.js',
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
