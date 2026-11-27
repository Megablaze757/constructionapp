# Vendored third-party code

## sql.js 1.13.0 — MIT

`sql-wasm.js` (48,788 bytes) and `sql-wasm.wasm` (659,806 bytes), copied verbatim
from the published npm tarball:

    https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/sql-wasm.js
    https://cdn.jsdelivr.net/npm/sql.js@1.13.0/dist/sql-wasm.wasm

    sha256  694ca5b36aa3e6e71f417819d7df390b65343665fcfa5c69015ca33d93d291b3  sql-wasm.js
    sha256  0734155c83e493983d1f2ff5b09a4fab6e35a32e9449c7e4e545756439f62d73  sql-wasm.wasm

    npm dist.integrity  sha512-RJbVP1HRDlUUXahJ7VMTcu9Rm1Nzw+EBpoPr94vnbD4LwR715F3CcxE2G2k45PewcaZ57pjetYa+LoSJLAASgA==

SQLite compiled to WebAssembly. It is what makes `assets/js/local/` possible: the
browser fallback runs the Worker's real source against a real SQLite database
rather than a hand-written imitation of one, so on-device behaviour matches the
deployed Worker instead of approximating it.

Vendored rather than pulled from a CDN so the published site depends on nothing
but itself — it keeps working offline as a PWA, survives a CDN outage, and sends
no request to a third party when someone opens the app.

To upgrade: download both files at the new version, update the sizes and hashes
above, and run `npm run e2e` in `worker/` — the local-mode journey exercises it.

## pdf.js 6.5.438 — Apache-2.0

`pdf.min.mjs` (474,284 bytes) and `pdf.worker.min.mjs` (1,271,915 bytes), copied
verbatim from the published npm tarball:

    https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/build/pdf.min.mjs
    https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/build/pdf.worker.min.mjs

    sha256  3a88402882cfa3e7e72c2c9b5149f52f0f88baf1c5b62aa11a41abdbc2072440  pdf.min.mjs
    sha256  1e64c8240e54735ec5913b37acd5134747799cb8c6bb3777c70adbc01232d2aa  pdf.worker.min.mjs

Mozilla's PDF reader. `assets/js/plans.js` uses it for the two things an
attachment can be: `getTextContent()` pulls the real words out of a typed
document — their own quote, a spec, a schedule of works — and `render()` draws a
drawing to a canvas for the vision model, because an elevation is geometry
rather than prose.

Vendored rather than pulled from a CDN so a plan can be read on a site with no
signal, which is where plans get read. The worker file is the larger of the two
and does the parsing; it is loaded off the main thread so a big plan set does
not freeze the page.

To upgrade: download both files at the new version, update the sizes and hashes
above, and run `npm run e2e` in `worker/` — the quoting journey reads a typed
quote and a vector drawing and asserts what comes out of each.
