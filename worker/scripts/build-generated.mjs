/**
 * Regenerate the files that are copies of something else.
 *
 *   npm run build:generated
 *
 * Three things in this repo have to exist in two places at once, and the only
 * safe way to keep two copies honest is to make one of them derived:
 *
 *   worker/paste/ai-worker.js   a single self-contained file for the Cloudflare
 *                               dashboard editor, which cannot import anything.
 *   web/assets/schema.sql       the migrations, where GitHub Pages can serve
 *                               them — Pages publishes web/ and nothing else.
 *   web/assets/js/worker/       the Worker's own source, so the browser fallback
 *                               runs the real thing rather than a re-write of it.
 *
 * CI runs this and fails on a diff, so an edit to worker/src that never reaches
 * the copies is caught at the pull request rather than in production.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const WORKER = fileURLToPath(new URL('../', import.meta.url));
const ROOT = path.join(WORKER, '..');
const read = (p) => readFileSync(path.join(WORKER, p), 'utf8');

const BANNER = (from) => `/* ------------------------------------------------------------------------- *
 * GENERATED FILE — DO NOT EDIT.
 * Built by worker/scripts/build-generated.mjs from ${from}.
 * Edit the source and run: npm run build:generated
 * ------------------------------------------------------------------------- */
`;

const written = [];
function write(rel, body) {
  const file = path.join(ROOT, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
  written.push(rel);
}

/* ------------------------------------------- 1. the paste-in-the-dashboard AI */

/**
 * Flatten a module so it can be concatenated with its siblings.
 *
 * These two files only ever import from each other, so dropping the relative
 * imports and the `export` keywords is enough — no bundler, and the output stays
 * readable, which matters for something a person is going to paste by hand.
 */
function flatten(source) {
  return source
    .replace(/^import\s[\s\S]*?from\s+'\.\/[^']+';\n/gm, '')
    .replace(/^export\s+(?=(const|function|async function|class)\b)/gm, '')
    .trimEnd();
}

const handler = read('paste/handler.js')
  .replace(/^\/\*[\s\S]*?\*\/\n\n/, '')          // the source file's own header
  .replace(/^import\s[\s\S]*?from\s+'[^']+';\n/gm, '')
  .trimStart();

write('worker/paste/ai-worker.js', [
  read('paste/preamble.txt'),
  BANNER("worker/src/schema.js, worker/src/groq.js and worker/paste/handler.js"),
  '',
  '/* ============================ the draft contract ========================= */',
  '',
  flatten(read('src/schema.js').replace(/^\/\*\*[\s\S]*?\*\/\n\n/, '')),
  '',
  '/* =============================== the Groq call =========================== */',
  '',
  flatten(read('src/groq.js').replace(/^\/\*\*[\s\S]*?\*\/\n\n/, '')),
  '',
  '/* ============================== the Worker itself ======================== */',
  '',
  handler,
  '',
].join('\n'));

/* ------------------------------------------------- 2. the schema, for the web */

const migrations = readdirSync(path.join(WORKER, 'migrations')).filter((f) => f.endsWith('.sql')).sort();
write('web/assets/schema.sql', [
  `-- GENERATED FILE — DO NOT EDIT. Built from worker/migrations/ by`,
  `-- worker/scripts/build-generated.mjs. Run: npm run build:generated`,
  `--`,
  `-- GitHub Pages publishes web/ only, so the browser fallback cannot reach the`,
  `-- migrations where they live. This is the same SQL, concatenated in order.`,
  '',
  ...migrations.map((f) => `-- ===== ${f} =====\n${read(`migrations/${f}`).trimEnd()}\n`),
].join('\n'));

/* --------------------------------------- 3. the Worker source, for the web */

const dest = path.join(ROOT, 'web/assets/js/worker');
rmSync(dest, { recursive: true, force: true });
for (const file of readdirSync(path.join(WORKER, 'src')).filter((f) => f.endsWith('.js')).sort()) {
  write(`web/assets/js/worker/${file}`, `${BANNER(`worker/src/${file}`)}\n${read(`src/${file}`)}`);
}

console.log(`Wrote ${written.length} generated files:`);
for (const f of written) console.log(`  ${f}`);
