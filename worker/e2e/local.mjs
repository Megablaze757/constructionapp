/**
 * Journey: no Worker at all.
 *
 * The point of local mode is that someone can open the published site before
 * they have deployed anything and get real work done. So this drives the whole
 * quoting flow with the API pointed at nothing, then reloads to prove the work
 * survived, then checks the app is honest about what it cannot do — and that
 * the template fallback never dresses itself up as an estimate.
 */

import { WEB, AI, SHOTS, step, ok, check, openBrowser, reportConsole, failureCount } from './lib.mjs';

export default async function run() {
  const { browser, ctx, errors } = await openBrowser();
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  step('Open the site with nothing deployed behind it');
  // ?api= wins over config.js, so an empty value is "no Worker configured" —
  // exactly the state a fresh GitHub Pages deploy is in.
  await page.goto(`${WEB}/index.html?api=&local=1`);
  await page.waitForSelector('#builderos-mode-banner', { timeout: 30000 });
  const bar = await page.textContent('#builderos-mode-banner');
  check(/Running in this browser/.test(bar), 'it says where the data is going', `banner said: ${bar}`);
  check(/will not open anywhere else|this device only/.test(bar),
    'and that links will not work elsewhere', 'the one-device limit is not stated');

  step('The seeded business is there to work with');
  await page.waitForFunction(() => document.querySelectorAll('.quote-row, .row, [data-quote-id]').length > 0
    || document.body.innerText.includes('No quotes'), null, { timeout: 30000 });
  ok('the quote list rendered from SQLite in the browser');

  step('Write a quote');
  await page.fill('#client_name', 'Local Only');
  await page.selectOption('#job_type', 'domestic_scaffold_erect');
  await page.fill('#site_address', '1 Offline Road');
  await page.click('#create-btn');
  await page.waitForURL('**/builder.html?id=*', { timeout: 20000 });
  ok('created without a network call leaving the page');

  step('Drafting falls back to the template, and says so');
  await page.fill('#description', 'Rear scaffold for the roofers, five days or so.');
  await page.click('#draft-btn');
  await page.waitForSelector('.line', { timeout: 30000 });

  const tags = await page.locator('.line .tag-ai').allTextContents();
  check(tags.length === 0, 'nothing is labelled as an AI estimate',
    `lines claimed AI provenance with no AI connected: ${JSON.stringify(tags)}`);

  const summary = await page.textContent('#ai-summary-body');
  check(/no AI is connected|not read/i.test(summary),
    'the summary states the description was never read',
    `summary did not disclose it: ${summary.replace(/\s+/g, ' ').slice(0, 160)}`);

  check(await page.locator('#send-btn').isDisabled(),
    'and every line still has to be confirmed before it can go out',
    'a template draft could be sent unchecked');
  await page.screenshot({ path: `${SHOTS}/local-builder.png`, fullPage: true });

  step('Confirm the lines and send');
  const unconfirmed = await page.locator('.line button[data-confirm]').count();
  check(unconfirmed > 0, `${unconfirmed} line(s) waiting on the owner`, 'nothing needed confirming');
  for (let i = 0; i < unconfirmed; i++) {
    await page.locator('.line button[data-confirm]').first().click();
    await page.waitForTimeout(400);
  }
  await page.fill('#client_summary', 'Rear scaffold, roofer access.');
  await page.waitForFunction(() => !document.getElementById('send-btn').disabled, null, { timeout: 15000 });
  const quoted = (await page.textContent('#total')).trim();
  await page.click('#send-btn');
  await page.waitForSelector('#sent-dialog[open]', { timeout: 20000 });
  const link = (await page.inputValue('#sent-link')).replace(/^https?:\/\/[^/]+/, WEB);
  await page.click('#sent-dialog button[value="close"]');
  ok(`sent at ${quoted}`);

  step('The client link opens — in this browser, and only this browser');
  const client = await ctx.newPage();
  client.on('console', (m) => { if (m.type() === 'error') errors.push(`[client] ${m.text()}`); });
  await client.goto(link);
  await client.waitForSelector('#content:not([hidden])', { timeout: 30000 });
  check((await client.textContent('#base-price')).trim() === quoted,
    'the client sees the price that was quoted', 'client price does not match');

  const leaked = await client.evaluate(() => document.body.innerText);
  check(!/margin|ai_inferred|template_default/i.test(leaked),
    'no cost, margin or provenance reaches the client, same as on a Worker',
    'internal detail leaked into the client view');
  await client.close();

  step('Close the tab and come back');
  const returning = await ctx.newPage();
  returning.on('console', (m) => { if (m.type() === 'error') errors.push(`[return] ${m.text()}`); });
  await returning.goto(`${WEB}/index.html?api=`);
  await returning.waitForFunction(
    () => document.body.innerText.includes('Local Only'), null, { timeout: 30000 });
  ok('the quote survived a reload — it is in IndexedDB, not memory');

  step('The rest of the business runs too');
  await returning.goto(`${WEB}/dashboard.html?api=`);
  await returning.waitForSelector('.tile', { timeout: 30000 });
  const tiles = await returning.locator('.tile').count();
  check(tiles >= 3, `${tiles} dashboard tiles computed on device`, `only ${tiles} tiles`);
  await returning.screenshot({ path: `${SHOTS}/local-dashboard.png`, fullPage: true });

  /* ------------------------------------- still local, but with AI connected */

  step('Point Settings at the paste-in AI worker');
  await returning.goto(`${WEB}/index.html?api=`);
  await returning.waitForSelector('#settings-btn');
  await returning.click('#settings-btn');
  await returning.waitForSelector('#settings-dialog[open]');
  await returning.fill('#ai-base', AI);
  await returning.click('#settings-dialog button[value="save"]');
  await returning.waitForFunction(
    () => document.body.innerText.includes('Local Only'), null, { timeout: 30000 });
  ok(`AI worker set to ${AI} without editing a file`);

  step('Now the same draft is a real estimate');
  await returning.click('a[href^="builder.html"]');
  await returning.waitForURL('**/builder.html?id=*', { timeout: 20000 });
  await returning.waitForSelector('#draft-btn', { timeout: 20000 });
  await returning.fill('#description', 'Rear scaffold, two lifts, roofers on for five days.');
  await returning.click('#draft-btn');
  await returning.waitForSelector('.line .tag-ai', { timeout: 30000 });

  const aiTags = await returning.locator('.line .tag-ai').allTextContents();
  check(aiTags.length > 0, `${aiTags.length} line(s) now carry the AI estimate tag`,
    'the AI worker did not produce an estimate');
  const body = await returning.textContent('#ai-summary-body');
  check(!/No AI is connected/.test(body), 'the template-fallback warning is gone',
    'still claiming no AI after one was connected');
  check(/llama/i.test(body), 'and it names the model that drafted it',
    `no model named: ${body.replace(/\s+/g, ' ').slice(-120)}`);
  await returning.screenshot({ path: `${SHOTS}/local-ai.png`, fullPage: true });

  step('Console');
  reportConsole(errors);

  await browser.close();
  return failureCount();
}
