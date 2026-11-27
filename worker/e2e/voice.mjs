/**
 * Journey: speak the job instead of typing it.
 *
 * Drives the real recorder with a fake microphone, through the transcription
 * ladder, into the description box — then proves the ladder is a ladder by
 * breaking the top rung and watching it reach for the next one.
 *
 * The on-device Whisper rung is NOT exercised here: it pulls a 41MB model from
 * the Hugging Face CDN, which would make every CI run slow and dependent on a
 * third party. What is covered is that the app reaches for it, and says so.
 * Verified by hand on a real browser: model ready ~5s, ~3x faster than
 * real-time on CPU with no WebGPU.
 */

import { WEB, AI, SHOTS, step, ok, check, openBrowser, reportConsole, failureCount } from './lib.mjs';
import { fileURLToPath } from 'node:url';

const CLIP = fileURLToPath(new URL('./fixtures/voice-note.wav', import.meta.url));

export default async function run() {
  // A fake mic, so the recorder is the real one and only the audio is staged.
  const { browser, ctx, errors } = await openBrowser({
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      `--use-file-for-fake-audio-capture=${CLIP}`,
    ],
    permissions: ['microphone'],
  });

  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${WEB}/index.html`);
  await page.evaluate(([t, ai]) => {
    localStorage.setItem('builderos.ownerToken', t);
    localStorage.setItem('builderos.aiBase', ai);
  }, ['dev-owner-token', AI]);

  step('Start a quote to speak into');
  await page.goto(`${WEB}/index.html`);
  await page.waitForFunction(() => document.querySelectorAll('#job_type option').length > 1, null, { timeout: 20000 });
  await page.fill('#client_name', 'Spoken Job');
  await page.selectOption('#job_type', 'domestic_scaffold_erect');
  await page.fill('#site_address', '3 Voice Lane');
  await page.click('#create-btn');
  await page.waitForURL('**/builder.html?id=*', { timeout: 20000 });
  ok('builder open with an empty description');

  step('Hold the button and talk');
  const btn = page.locator('#record-btn');
  check(!await btn.isDisabled(), 'the record button is available', 'recording is not supported here');
  await btn.dispatchEvent('pointerdown');
  await page.waitForFunction(() => document.getElementById('record-btn').classList.contains('recording'),
    null, { timeout: 10000 });
  ok('recording started');
  await page.waitForTimeout(1500);
  await btn.dispatchEvent('pointerup');

  step('It comes back as text in the description, not as a quote');
  await page.waitForFunction(() => document.getElementById('description').value.trim().length > 0,
    null, { timeout: 30000 });
  const spoken = await page.inputValue('#description');
  check(/scaffold/i.test(spoken), `transcript landed: "${spoken.slice(0, 70)}…"`, `unexpected transcript: "${spoken}"`);
  check(await page.locator('.line .tag-ai').count() === 0,
    'nothing was drafted off the back of it — the owner reads it first',
    'transcription drafted a quote on its own');
  const hint = await page.textContent('#record-hint');
  check(/read it over/i.test(hint), 'and the owner is told to check it', `hint said: ${hint}`);
  await page.screenshot({ path: `${SHOTS}/voice-note.png`, fullPage: true });

  step('Draft from the spoken description');
  await page.click('#draft-btn');
  await page.waitForSelector('.line', { timeout: 30000 });
  const total = (await page.textContent('#total')).trim();
  check(total !== '—' && total !== '£0', `priced from what was said: ${total}`, `total was ${total}`);

  // Everything after this point deliberately provokes network failures.
  const before = errors.length;

  step('Break the top rung and watch it reach for the next');
  // The AI worker is now unreachable, and the model CDN is blocked, so the
  // on-device rung cannot load either. Both failures must be reported — a
  // ladder that runs out of rungs says so rather than going quiet.
  await ctx.route('**/cdn.jsdelivr.net/**', (r) => r.abort());
  await page.evaluate(() => localStorage.setItem('builderos.aiBase', 'http://127.0.0.1:9123/not-a-worker'));
  await page.reload();
  await page.waitForSelector('#record-btn', { timeout: 20000 });
  await page.locator('#record-btn').dispatchEvent('pointerdown');
  await page.waitForTimeout(1200);
  await page.locator('#record-btn').dispatchEvent('pointerup');

  await page.waitForFunction(
    () => /could not transcribe|on-device|device/i.test(document.getElementById('record-hint').textContent),
    null, { timeout: 45000 },
  ).catch(() => {});
  const fallbackHint = await page.textContent('#record-hint');
  check(/on-device|device/i.test(fallbackHint),
    'it tried this device after the worker failed',
    `never mentioned the on-device rung: ${fallbackHint}`);

  step('Console');
  reportConsole(errors, before);

  await browser.close();
  return failureCount();
}
