/**
 * Frontend configuration.
 *
 * None of it is required. With `apiBase` empty the app runs entirely in the
 * browser — the Worker's own source against SQLite in WebAssembly, stored in
 * IndexedDB on this device. That is real and usable, but it is one device: no
 * client can open a quote link, no crew member can open their own page, nothing
 * syncs. See docs/deployment.md.
 *
 *   apiBase   the full Worker (Cloudflare + D1). Set this and the app leaves the
 *             browser: shared data, working client and crew links.
 *   aiBase    the small AI-only Worker from worker/paste/ai-worker.js. Set this
 *             on its own to get AI drafting while still running locally — the
 *             Groq key cannot live in a browser, so it has to sit behind
 *             something. Ignored when apiBase is set, because that Worker holds
 *             its own key.
 *
 * Without either, drafting still works: it falls back to the job template with
 * every line marked as needing a check. Nothing is ever presented as an estimate
 * when nothing estimated it.
 *
 * Overridable at runtime with ?api=https://... — handy for pointing the
 * published site at a local `wrangler dev` — and ?local=1 to force local mode.
 */
window.BUILDEROS_CONFIG = {
  apiBase: 'http://127.0.0.1:8787',
  aiBase: '',
  businessName: 'Builder Co.',
};
