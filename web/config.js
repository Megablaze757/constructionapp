/**
 * Frontend configuration.
 *
 * `apiBase` must point at your deployed Cloudflare Worker, because GitHub Pages
 * serves static files only — there is no server here to proxy through. Set it
 * once after deploying the Worker (see docs/deployment.md).
 *
 * Overridable at runtime with ?api=https://... which is handy for pointing the
 * published site at a local `wrangler dev` while developing.
 */
window.BUILDEROS_CONFIG = {
  apiBase: 'http://127.0.0.1:8787',
  businessName: 'Builder Co.',
};
