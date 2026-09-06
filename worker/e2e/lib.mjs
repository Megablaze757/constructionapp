/**
 * Shared harness for the end-to-end journeys.
 *
 * These drive the real stack — Worker on local D1, the static site, and the Groq
 * stub — through a browser, exactly as a person would. They exist to answer one
 * question the unit tests cannot: does the thing actually run?
 */

import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const WEB = process.env.WEB_BASE || 'http://127.0.0.1:8788';
export const API = process.env.API_BASE || 'http://127.0.0.1:8787';
/** The paste-into-the-dashboard AI worker, run locally by dev/ai-worker-server.mjs. */
export const AI = process.env.AI_BASE || 'http://127.0.0.1:8790';
export const TOKEN = process.env.OWNER_TOKEN || 'dev-owner-token';

export const SHOTS = fileURLToPath(new URL('./screenshots/', import.meta.url));
const WORKER_DIR = fileURLToPath(new URL('../', import.meta.url));

let failures = 0;
export const step = (m) => console.log(`\n▶ ${m}`);
export const ok = (m) => console.log(`  ✅ ${m}`);
export const bad = (m) => { console.log(`  ❌ ${m}`); failures += 1; };
export const failureCount = () => failures;
/** Journeys share this module, so each one has to start its own count at zero. */
export const resetFailures = () => { failures = 0; };

export function check(condition, good, badMsg) {
  condition ? ok(good) : bad(badMsg);
  return condition;
}

/** Authenticated API call, for setting a journey up quickly. */
export async function api(pathname, method = 'GET', body) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${pathname} → ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

/**
 * Wipe and reseed between journeys.
 *
 * Each journey starts from the same known state, so a failure means that
 * journey broke rather than that a previous one left something behind.
 */
export function resetDatabase() {
  execFileSync('npm', ['run', 'db:local'], { cwd: WORKER_DIR, stdio: 'ignore' });
}

export async function openBrowser({ width = 420, height = 1100 } = {}) {
  // In CI Playwright installs its own browser; locally CHROMIUM_PATH points at
  // whatever is already on the machine.
  const browser = await chromium.launch(
    process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
  );
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const errors = [];
  ctx.on('weberror', (e) => errors.push(String(e.error())));
  return { browser, ctx, errors };
}

/** A page already carrying the owner token, as Settings would have stored it. */
export async function ownerPage(ctx, errors) {
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${WEB}/index.html`);
  await page.evaluate((t) => localStorage.setItem('builderos.ownerToken', t), TOKEN);
  return page;
}

/** Pick an <option> by a substring of its text — labels are regex-unfriendly. */
export async function selectByText(page, selector, text) {
  const value = await page.evaluate(([sel, t]) => {
    const opt = [...document.querySelector(sel).options].find((o) => o.textContent.includes(t));
    return opt ? opt.value : null;
  }, [selector, text]);
  if (!value) throw new Error(`no option matching "${text}" in ${selector}`);
  await page.selectOption(selector, value);
}

/** Generate a JPEG on disk for the photo-upload paths. */
export async function makePhoto(page, label = 'SITE PHOTO', w = 2400, h = 1600) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const dataUrl = await page.evaluate(([text, width, height]) => {
    const c = document.createElement('canvas');
    c.width = width; c.height = height;
    const g = c.getContext('2d');
    const grad = g.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, '#4a5a72'); grad.addColorStop(1, '#8fa5b8');
    g.fillStyle = grad; g.fillRect(0, 0, width, height);
    g.fillStyle = '#fff'; g.font = `bold ${Math.round(height / 10)}px sans-serif`;
    g.fillText(text, width * 0.1, height * 0.55);
    return c.toDataURL('image/jpeg', 0.92);
  }, [label, w, h]);

  mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, 'site.jpg');
  writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return file;
}

/**
 * Anything logged from `allowedFrom` onwards was provoked on purpose — the
 * journeys end by poking the API with bad input to prove it says no.
 */
export function reportConsole(errors, allowedFrom = errors.length) {
  const unexpected = [...new Set(errors.slice(0, allowedFrom))];
  check(unexpected.length === 0, 'no unexpected page errors',
    `page errors:\n    ${unexpected.join('\n    ')}`);
}
