/**
 * The Worker, running in this browser.
 *
 * BuilderOS normally talks to a Cloudflare Worker over the network. Until that
 * Worker exists there is nothing to talk to, and "deploy some infrastructure
 * first" is a poor answer to someone who wants to write a quote. So the same
 * Worker source runs here instead, against SQLite compiled to WebAssembly, with
 * the database kept in IndexedDB.
 *
 * It is the real thing, not a mock: the same router, the same SQL, the same send
 * gates, the same guardrails on what the AI is allowed to claim. What it is not
 * is shared. Everything lives in one browser on one device — no client can open
 * a quote link, no crew member can open their own page, nothing syncs. That is
 * the honest limit of local mode and the app says so on every screen rather than
 * letting someone discover it when a client cannot open a link.
 *
 * AI still works in local mode if `aiBase` in config.js points at the small
 * paste-into-the-dashboard Worker (worker/paste/ai-worker.js), because the API
 * key cannot live in a browser. Without it, drafting falls back to the template.
 */

import { LocalD1 } from './d1.js';

const SQL_JS = new URL('../../vendor/sql-wasm.js', import.meta.url);
const SQL_WASM = new URL('../../vendor/sql-wasm.wasm', import.meta.url);
const SCHEMA = new URL('../../schema.sql', import.meta.url);
const WORKER = new URL('../worker/index.js', import.meta.url);

const DB_NAME = 'builderos-local';
const STORE = 'sqlite';
const KEY = 'db';
const TOKEN_KEY = 'builderos.localOwnerToken';

let booting = null;

/** Boot once per page; every caller shares the same database. */
export function localBackend() {
  if (!booting) booting = boot();
  return booting;
}

async function boot() {
  const [SQLModule, worker, schema] = await Promise.all([
    loadSqlJs(),
    import(WORKER),
    fetch(SCHEMA).then((r) => {
      if (!r.ok) throw new Error(`schema.sql is missing (${r.status})`);
      return r.text();
    }),
  ]);

  const saved = await idbGet();
  const sqlite = saved ? new SQLModule.Database(saved) : new SQLModule.Database();
  // D1 enforces foreign keys, and the migrations lean on ON DELETE CASCADE to
  // keep a deleted job from leaving costs and tasks behind. Match it.
  sqlite.run('PRAGMA foreign_keys = ON');
  if (!saved) sqlite.run(schema);

  // Writes are flushed once per request rather than per statement: a request
  // that touches six tables should cost one export, and it must be on disk
  // before the response is returned. Creating a quote navigates straight to the
  // builder, which reloads the page — anything still queued at that moment is
  // simply gone, and the owner sees "quote not found" for a quote they just
  // watched being created.
  let dirty = !saved;
  const db = new LocalD1(sqlite, () => { dirty = true; });
  const flush = async () => {
    if (!dirty) return;
    dirty = false;
    await idbPut(sqlite.export()).catch(() => {});
  };
  await flush();

  const env = buildEnv(db);

  const backend = {
    token: env.OWNER_TOKEN,

    /** Same contract as `fetch`, so api.js can use it in place of the network. */
    async handle(path, init = {}) {
      const request = new Request(`https://local.builderos${path}`, init);
      const res = await worker.default.fetch(request, env, { waitUntil() {} });
      await flush();
      return res;
    },

    /** Throw the local database away and start from the seed data again. */
    async reset() {
      sqlite.run('PRAGMA foreign_keys = OFF');
      sqlite.run(schema);
      sqlite.run('PRAGMA foreign_keys = ON');
      await idbPut(sqlite.export());
    },

    /** Everything held on this device, for backing up or moving to a Worker. */
    export: () => sqlite.export(),
  };

  return backend;
}

function buildEnv(db) {
  const cfg = window.BUILDEROS_CONFIG || {};
  const base = location.origin + location.pathname.replace(/[^/]*$/, '');
  const aiBase = (cfg.aiBase || localStorage.getItem('builderos.aiBase') || '').replace(/\/$/, '');

  return {
    DB: db,
    OWNER_TOKEN: localOwnerToken(),
    PUBLIC_APP_URL: base,
    BUSINESS_NAME: cfg.businessName || 'Builder Co.',
    // Local mode calls the Worker directly, so nothing is cross-origin and the
    // allowlist has no work to do.
    ALLOWED_ORIGINS: '*',
    // The Groq key cannot live in a browser. If the small AI worker has been
    // deployed, drafts go through it; if not, requestDraft reports itself
    // unconfigured and the API falls back to the template.
    AI_PROXY_URL: aiBase ? `${aiBase}/draft` : '',
    AI_PROXY_TOKEN: cfg.aiToken || localStorage.getItem('builderos.aiToken') || '',
  };
}

/**
 * The owner token for local mode.
 *
 * It guards nothing — anything that can call the backend can also read this out
 * of localStorage — but the Worker requires one, and inventing it here means the
 * owner is not asked to set up authentication against their own browser.
 */
function localOwnerToken() {
  let token = localStorage.getItem(TOKEN_KEY);
  if (!token) {
    token = `local-${crypto.randomUUID()}`;
    localStorage.setItem(TOKEN_KEY, token);
  }
  return token;
}

/* --------------------------------------------------------------- sql.js */

function loadSqlJs() {
  if (window.initSqlJs) return window.initSqlJs({ locateFile: () => String(SQL_WASM) });
  return new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = String(SQL_JS);
    el.onload = () => window.initSqlJs({ locateFile: () => String(SQL_WASM) }).then(resolve, reject);
    el.onerror = () => reject(new Error('Could not load the local database engine.'));
    document.head.append(el);
  });
}

/* ------------------------------------------------------------ IndexedDB */

function openIdb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet() {
  try {
    const idb = await openIdb();
    return await new Promise((resolve, reject) => {
      const req = idb.transaction(STORE, 'readonly').objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Private browsing can refuse IndexedDB outright. Losing persistence is
    // survivable; refusing to start is not.
    return null;
  }
}

async function idbPut(bytes) {
  const idb = await openIdb();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(bytes, KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
