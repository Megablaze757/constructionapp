/**
 * Runs every journey against a live stack, resetting the database between them.
 *
 *   npm run e2e
 *
 * Expects the Worker on :8787, the site on :8788 and the Groq stub on :8799 —
 * see the Quick start in the README, or .github/workflows/ci.yml for the same
 * thing wired up in CI.
 */

import { resetDatabase, resetFailures, API, WEB, AI } from './lib.mjs';

const JOURNEYS = [
  ['Quoting — draft, guardrails, photos, send, accept', './quoting.mjs'],
  ['Operations — team, SOPs, delegation, site log, cash', './operations.mjs'],
  ['Oversight — dashboard, reliability, automations', './oversight.mjs'],
  ['Local mode — the whole app with no Worker at all', './local.mjs'],
];

const only = process.argv[2];

async function preflight() {
  for (const [name, url] of [
    ['API', `${API}/health`],
    ['web', `${WEB}/index.html`],
    ['AI worker', `${AI}/health`],
  ]) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.error(`\nCannot reach the ${name} at ${url} — ${err.message}`);
      console.error('Start the stack first (see the Quick start in the README).\n');
      process.exit(1);
    }
  }
}

await preflight();

const results = [];
for (const [name, file] of JOURNEYS) {
  if (only && !file.includes(only)) continue;

  console.log(`\n${'═'.repeat(66)}\n  ${name}\n${'═'.repeat(66)}`);
  // Each journey starts from the same known state, so a failure means that
  // journey broke rather than that a previous one left something behind.
  resetDatabase();
  resetFailures();

  const { default: run } = await import(file);
  let failures;
  try {
    failures = await run();
  } catch (err) {
    console.error(`\n  ❌ threw: ${err.message}`);
    failures = 1;
  }
  results.push({ name, failures });
}

console.log(`\n${'═'.repeat(66)}`);
for (const r of results) {
  console.log(`  ${r.failures ? '❌' : '✅'}  ${r.name}${r.failures ? ` — ${r.failures} failed` : ''}`);
}

const total = results.reduce((t, r) => t + r.failures, 0);
console.log(`${'═'.repeat(66)}\n${total ? `  ${total} check(s) failed\n` : '  Everything passed\n'}`);
process.exit(total ? 1 : 0);
