/**
 * Journey: quote a job and get it accepted.
 *
 * Covers the auto-quoting module end to end — AI draft, the guardrails that make
 * the draft safe, photo estimating, the send gate, and what the client sees.
 */

import { WEB, SHOTS, step, ok, bad, check, openBrowser, ownerPage, makePhoto, reportConsole, failureCount } from './lib.mjs';

export default async function run() {
  const { browser, ctx, errors } = await openBrowser();
  const page = await ownerPage(ctx, errors);
  const photo = await makePhoto(page, '14 ELM ST');

  step('Start a quote');
  await page.goto(`${WEB}/index.html`);
  await page.fill('#client_name', 'Sarah Higgins');
  await page.selectOption('#job_type', 'domestic_scaffold_erect');
  await page.fill('#site_address', '14 Elm St');
  await page.click('#create-btn');
  await page.waitForURL('**/builder.html?id=*', { timeout: 15000 });
  ok('quote created from a template');

  step('Draft it from a spoken description');
  await page.fill('#description',
    "Right, this is the Elm Street job. Rear of the house, scaffold for the roofers, "
    + "probably two lifts, they'll be up there about five days.");
  await page.click('#draft-btn');
  await page.waitForSelector('.line .tag-ai', { timeout: 20000 });

  const total = (await page.textContent('#total')).trim();
  const badge = (await page.textContent('#margin-badge')).trim();
  check(total === '£1,835', `total ${total}`, `total was ${total}, expected £1,835`);
  check(badge.startsWith('32%'), `margin ${badge}`, `margin badge was ${badge}`);

  const tags = await page.locator('.line .tag-ai').allTextContents();
  check(tags.length === 1 && tags[0].includes('AI est.'),
    'only the inferred line is tagged — the stated 5 days is not an estimate',
    `tags were ${JSON.stringify(tags)}`);

  step('The learning loop briefs the assistant');
  const brief = await page.evaluate(() =>
    [...document.querySelectorAll('#ai-summary-body li')].map((li) => li.textContent));
  check(brief.some((b) => /has run .*% (over|under) the quoted cost/.test(b)),
    'past jobs told it where this business over-runs',
    `no estimating history in ${JSON.stringify(brief).slice(0, 160)}`);

  step('An AI estimate cannot be sent unreviewed');
  check(await page.locator('.line .dot').count() === 1, 'amber dot on the inferred line', 'no amber dot');
  check(await page.locator('#send-btn').isDisabled(), 'Send is blocked', 'Send was not blocked');

  step('Add a site photo and re-draft from it');
  await page.setInputFiles('#photo-input', photo);
  await page.waitForSelector('.photo-thumb img', { timeout: 25000 });
  await page.waitForFunction(() => {
    const img = document.querySelector('.photo-thumb img');
    return img && img.complete && img.naturalWidth > 0;
  }, null, { timeout: 20000 }).catch(() => {});

  const thumb = await page.evaluate(() => {
    const img = document.querySelector('.photo-thumb img');
    return img?.naturalWidth ? { w: img.naturalWidth } : null;
  });
  check(thumb && thumb.w <= 1600, `photo downscaled in the browser to ${thumb?.w}px`,
    `photo width was ${thumb?.w}`);

  // Guards the D1 BLOB round-trip: a stringified byte array still arrives as
  // 200 image/jpeg, three times the size and undecodable.
  const bytes = await page.evaluate(async () => {
    const res = await fetch(document.querySelector('.photo-thumb img').src);
    const buf = new Uint8Array(await res.arrayBuffer());
    return { size: buf.length, jpeg: buf[0] === 0xFF && buf[1] === 0xD8 };
  });
  check(bytes.jpeg, `served bytes are a real JPEG (${Math.round(bytes.size / 1024)}KB)`,
    `served bytes are not a JPEG (${bytes.size} bytes)`);

  await page.click('#draft-btn');
  await page.waitForFunction(
    () => [...document.querySelectorAll('.line .tag-ai')].some((t) => t.textContent.includes('from photo')),
    null, { timeout: 25000 },
  ).catch(() => {});
  const photoTags = await page.locator('.line .tag-ai').allTextContents();
  check(photoTags.some((t) => t.includes('from photo')),
    'the scaffold line is now scaled off the photo, tagged separately from a wording guess',
    `tags after re-draft: ${JSON.stringify(photoTags)}`);
  const note = (await page.locator('.line-note').first().textContent()).trim();
  check(/scaled off/i.test(note), 'and the note says what it scaled against',
    `note did not explain the scaling: "${note}"`);

  await page.screenshot({ path: `${SHOTS}/quote-builder.png`, fullPage: true });

  step('Confirm and send');
  await page.fill('#client_summary', 'Rear scaffold — 2 lifts, roofer access.');
  await page.click('.line button[data-confirm]');
  await page.waitForTimeout(1000);
  check(!await page.locator('#send-btn').isDisabled(), 'Send unlocks once confirmed', 'Send still blocked');
  // The photo re-draft moved the quantities, so what the client should see is
  // whatever the builder is showing now — not the number from the first draft.
  const quoted = (await page.textContent('#total')).trim();
  await page.click('#send-btn');
  await page.waitForSelector('#sent-dialog[open]', { timeout: 15000 });
  const link = (await page.inputValue('#sent-link')).replace('http://127.0.0.1:8788', WEB);
  await page.click('#sent-dialog button[value="close"]');
  ok('sent');

  step('What the client gets');
  const client = await ctx.newPage();
  client.on('console', (m) => { if (m.type() === 'error') errors.push(`[client] ${m.text()}`); });
  await client.goto(link);
  await client.waitForSelector('#content:not([hidden])', { timeout: 15000 });

  check((await client.textContent('#heading')).trim() === 'Quote for Sarah Higgins',
    'addressed to the client', 'wrong heading');
  const basePrice = (await client.textContent('#base-price')).trim();
  check(basePrice === quoted, `base price matches what was quoted (${quoted})`,
    `client sees ${basePrice}, the builder quoted ${quoted}`);
  check(/^Rear scaffold/.test((await client.textContent('#job-summary')).trim()),
    "shows the owner's client-facing summary, not their dictated notes",
    `summary was "${(await client.textContent('#job-summary')).trim()}"`);

  const text = await client.evaluate(() => document.body.innerText);
  const leaks = [
    ['cost', /18\.50|1,?247/], ['margin', /margin/i],
    ['AI provenance', /ai_inferred|photo_inferred|confidence/i],
    ["the owner's brief", /Right, this is the Elm Street job/],
  ].filter(([, re]) => re.test(text)).map(([n]) => n);
  check(leaks.length === 0, 'no cost, margin, provenance or internal notes reach the client',
    `leaked: ${leaks.join(', ')}`);

  step('Extras update the total live, then Accept & Book');
  const before = (await client.textContent('#total')).trim();
  const extraPrice = (await client.textContent('.extra .extra-price')).trim();
  const expected = `£${(
    Number(before.replace(/[^0-9.]/g, '')) + Number(extraPrice.replace(/[^0-9.]/g, ''))
  ).toLocaleString('en-GB')}`;
  await client.click('.extra input[type="checkbox"]');
  await client.waitForFunction(
    (want) => document.getElementById('total').textContent.trim() === want, expected, { timeout: 12000 });
  ok(`${before} ${extraPrice} → ${expected} without a reload`);
  await client.screenshot({ path: `${SHOTS}/client-quote.png`, fullPage: true });

  await client.click('#accept-btn');
  await client.waitForSelector('#confirm-dialog[open]');
  await client.click('#confirm-dialog button[value="accept"]');
  await client.waitForSelector('.notice-ok', { timeout: 15000 });
  check(/start date/.test(await client.textContent('.notice-ok')),
    'booked, with the confirmation the spec asks for', 'no booking confirmation');

  step('Console');
  reportConsole(errors);

  await browser.close();
  return failureCount();
}
