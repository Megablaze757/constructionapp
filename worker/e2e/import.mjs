/**
 * Journey: make the app quote in their shape, at their rates.
 *
 * A builder already has a quote they send. Until it is in here, every quote
 * comes out in a shape I invented, costed from a seeded price book with
 * fictional rates. This is the import that fixes that — and because it writes to
 * the price book, which every future quote is costed from, most of what is
 * checked here is what it refuses to do.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { WEB, SHOTS, step, ok, check, openBrowser, ownerPage, reportConsole, failureCount } from './lib.mjs';

const fixture = (f) => fileURLToPath(new URL(`./fixtures/${f}`, import.meta.url));

export default async function run() {
  const { browser, ctx, errors } = await openBrowser({ height: 1000 });
  const page = await ownerPage(ctx, errors);

  step('Upload the quote they already send');
  await page.goto(`${WEB}/index.html`);
  await page.waitForFunction(() => document.querySelectorAll('#job_type option').length > 1, null, { timeout: 30000 });
  const before = await page.locator('#job_type option').count();

  await page.setInputFiles('#import-input', fixture('their-quote.pdf'));
  await page.waitForSelector('#import-dialog[open]', { timeout: 30000 });
  ok('read, and held for review rather than saved');

  step('It checks itself against their own bottom line');
  const warn = (await page.textContent('#import-warnings')).replace(/\s+/g, ' ');
  check(/£1,970.00, matching your quote's own subtotal/.test(warn),
    'the line totals reconcile to the subtotal printed on their quote',
    `subtotal check missing: ${warn.slice(0, 180)}`);
  check(!/could not be read as work/.test(warn),
    "and the letterhead is not reported as a missing work item",
    `header lines reported as misses: ${warn.slice(0, 200)}`);

  step('Their figures, as read');
  const rows = await page.evaluate(() => [...document.querySelectorAll('#import-lines .line')].map((l) => ({
    desc: l.querySelector('.import-desc')?.value,
    qty: Number(l.querySelector('.import-qty')?.value),
    price: Number(l.querySelector('.import-price')?.value),
    cost: l.querySelector('.line-note')?.textContent || '',
  })));
  check(rows.length === 4, `${rows.length} work items`, `expected 4, got ${rows.length}`);
  const erect = rows.find((r) => /Erect access/.test(r.desc));
  check(erect?.qty === 45 && erect?.price === 27,
    `their own rate read correctly (${erect?.qty} m² @ £${erect?.price})`,
    `read ${erect?.qty} @ ${erect?.price}`);

  step('Cost is never presented as something read from their quote');
  check(/not read from your quote/.test(erect.cost),
    'each cost says it was worked back from the margin they gave',
    `cost note did not disclose its source: ${erect.cost}`);
  await page.fill('#import-margin', '25');
  await page.waitForFunction(
    () => /25% margin/.test(document.getElementById('import-cost-note').textContent), null, { timeout: 10000 });
  const recosted = await page.evaluate(() =>
    document.querySelector('#import-lines .line-note').textContent);
  check(/£20\.25/.test(recosted), 'and it follows the margin live (£27 at 25% is £20.25)',
    `cost did not track the margin: ${recosted}`);

  step('A margin that cannot mean anything is refused');
  await page.fill('#import-margin', '150');
  check(/between 0 and 99/.test(await page.textContent('#import-cost-note')),
    'an impossible margin is rejected before saving', 'a 150% margin was accepted');
  await page.fill('#import-margin', '30');

  await page.screenshot({ path: `${SHOTS}/import-review.png`, fullPage: true });

  step('Save it');
  await page.fill('#import-name', 'Higgins Scaffold');
  await page.click('#import-dialog button[value="save"]');
  await page.waitForFunction(
    () => /Saved|not ready/i.test(document.getElementById('import-status').textContent), null, { timeout: 30000 });
  const status = await page.textContent('#import-status');
  check(/Saved "Higgins Scaffold"/.test(status) && /4 rates/.test(status),
    `saved with their rates: ${status.trim().slice(0, 90)}`, `save failed: ${status}`);

  step('It is now a template they can pick');
  await page.waitForFunction((n) => document.querySelectorAll('#job_type option').length > n,
    before, { timeout: 20000 });
  const options = await page.locator('#job_type option').allTextContents();
  check(options.some((o) => /Higgins Scaffold/.test(o)), 'listed under Job type',
    `not in the list: ${options.join(' | ')}`);

  step('And a quote on it comes out at their numbers');
  await page.fill('#client_name', 'Uses Their Shape');
  await page.selectOption('#job_type', { label: 'Higgins Scaffold' });
  await page.fill('#site_address', '9 Import Way');
  await page.click('#create-btn');
  await page.waitForURL('**/builder.html?id=*', { timeout: 30000 });
  await page.waitForFunction(() => {
    const t = document.getElementById('total');
    return t && t.textContent.trim() !== '—' && t.textContent.trim() !== '';
  }, null, { timeout: 30000 });

  const total = (await page.textContent('#total')).trim();
  check(total === '£1,970', `priced at their own subtotal: ${total}`, `expected £1,970, got ${total}`);
  const descs = await page.locator('.line .line-desc').allTextContents();
  check(descs.some((d) => /Erect access scaffold/.test(d)),
    'in their own wording, not the seeded template\'s',
    `lines read: ${descs.join(' | ').slice(0, 120)}`);
  const margin = (await page.textContent('#margin-badge')).trim();
  check(/^30%/.test(margin), `and at the margin they gave (${margin})`, `margin badge: ${margin}`);

  step('Console');
  reportConsole(errors);

  await browser.close();
  return failureCount();
}
