/**
 * Journey: run the business once the work is booked.
 *
 * Team directory, SOP checklists with photo proof, a job created by hand,
 * delegation to a crew member through their own link, the site log, and getting
 * paid. Phases 0 and 1.
 */

import {
  WEB, SHOTS, step, ok, check, openBrowser, ownerPage, selectByText, makePhoto,
  reportConsole, failureCount,
} from './lib.mjs';

export default async function run() {
  const { browser, ctx, errors } = await openBrowser();
  const owner = await ownerPage(ctx, errors);
  const photo = await makePhoto(owner, 'TIES STRUCK', 1600, 1100);

  step('Team directory');
  await owner.goto(`${WEB}/team.html`);
  await owner.waitForSelector('#staff .line, #staff .muted', { timeout: 15000 });
  check(await owner.locator('#staff .line').count() >= 2, 'staff seeded', 'staff missing');
  check(await owner.locator('#subs .line').count() >= 1, 'subcontractors seeded', 'subs missing');

  await owner.click('#add-btn');
  await owner.waitForSelector('#person-dialog[open]');
  await owner.fill('#p-name', 'Tomasz Reed');
  await owner.selectOption('#p-kind', 'subcontractor');
  await owner.fill('#p-role', 'roofer');
  await owner.click('#person-dialog button[value="save"]');
  await owner.waitForFunction(() => document.getElementById('subs').textContent.includes('Tomasz Reed'),
    null, { timeout: 12000 });
  ok('added a subcontractor');

  step('SOP library');
  await owner.goto(`${WEB}/sops.html`);
  await owner.waitForSelector('#sop-list .line', { timeout: 15000 });
  check(await owner.locator('#sop-list .line').count() >= 8, 'starter SOPs present', 'SOPs missing');
  const steps = await owner.locator('#sop-list .sop-steps li').allTextContents();
  check(steps.some((t) => t.startsWith('📷')), 'steps needing photo proof are marked', 'no photo steps');

  await owner.click('#add-btn');
  await owner.waitForSelector('#sop-dialog[open]');
  await owner.fill('#s-title', 'Winter site shutdown');
  await owner.fill('#s-category', 'safety');
  await owner.fill('#s-steps', 'Check all ties are secure\n* Photograph the standing scaffold\nConfirm signage');
  await owner.click('#sop-dialog button[value="save"]');
  await owner.waitForFunction(() => document.getElementById('sop-list').textContent.includes('Winter site shutdown'),
    null, { timeout: 12000 });
  const written = await owner.evaluate(() => {
    const card = [...document.querySelectorAll('#sop-list .line')]
      .find((l) => l.textContent.includes('Winter site shutdown'));
    return [...card.querySelectorAll('.sop-steps li')].map((li) => li.textContent);
  });
  check(written.filter((t) => t.startsWith('📷')).length === 1,
    'the "*" prefix marked exactly one step as needing a photo',
    `parsed wrong: ${JSON.stringify(written)}`);

  step('A job that never came through a quote');
  await owner.goto(`${WEB}/jobs.html`);
  await owner.click('#new-job-btn');
  await owner.waitForSelector('#new-job-dialog[open]');
  await owner.fill('#nj-client', 'R. Patel');
  await owner.fill('#nj-type', 'domestic reroof');
  await owner.fill('#nj-site', '3 Mill Lane');
  await owner.fill('#nj-phone', '07700 900555');
  await owner.fill('#nj-start', '2026-08-01');
  await owner.fill('#nj-end', '2026-08-15');
  await owner.fill('#nj-price', '4200');
  await owner.fill('#nj-cost', '2900');
  await owner.click('#new-job-dialog button[value="save"]');
  await owner.waitForURL('**/jobs.html?id=*', { timeout: 15000 });
  await owner.waitForFunction(() => document.getElementById('job-meta').textContent.trim().length > 0,
    null, { timeout: 15000 });
  const jobUrl = owner.url();
  check(/Domestic Reroof/.test(await owner.textContent('#job-meta')),
    'created without a quote, job type normalised', 'job meta wrong');

  step('Put a crew on it and assign a task needing proof');
  await owner.waitForFunction(() => document.querySelectorAll('#crew-picker option').length > 1,
    null, { timeout: 15000 });
  await selectByText(owner, '#crew-picker', 'Dave Mullen');
  await owner.click('#assign-btn');
  await owner.waitForFunction(() => document.getElementById('crew-list').textContent.includes('Dave Mullen'),
    null, { timeout: 12000 });

  await owner.click('#add-task-btn');
  await owner.waitForSelector('#task-dialog[open]');
  await owner.fill('#t-title', 'Strike the ties on the rear elevation');
  await selectByText(owner, '#t-person', 'Dave Mullen');
  await owner.fill('#t-due', '2026-07-25');          // already well past
  await owner.fill('#t-grace', '2');
  await owner.check('#t-photo');
  await owner.click('#task-dialog button[value="save"]');
  await owner.waitForFunction(() => document.getElementById('task-list').textContent.includes('Strike the ties'),
    null, { timeout: 12000 });
  check((await owner.textContent('#task-badge')).trim() === '0/1', 'task assigned', 'task badge wrong');
  check(await owner.locator('#task-list .dot').count() === 1,
    'past its grace window, so it escalates to the owner', 'no escalation marker');

  step('Attach a checklist — photo proof is enforced');
  await selectByText(owner, '#sop-picker', 'Site safety check');
  await owner.click('#attach-sop-btn');
  await owner.waitForSelector('.sop-check', { timeout: 12000 });
  await owner.locator('.sop-check input').first().check();      // first step needs a photo
  await owner.waitForTimeout(1200);
  check(/still needs a photo|photo needed/.test(await owner.textContent('#sop-list')),
    'ticking a photo step without a photo does not count it',
    'photo-proof step counted without proof');
  check((await owner.locator('#sop-list .badge').first().textContent()).trim().startsWith('0/'),
    'progress stays at zero', 'progress advanced without proof');
  await owner.locator('.sop-check input').nth(1).check();       // this one needs no photo
  await owner.waitForTimeout(1200);
  check((await owner.locator('#sop-list .badge').first().textContent()).trim().startsWith('1/'),
    'a step needing no photo does count', 'non-photo step not counted');

  step('Schedule the client check-ins');
  await owner.click('#schedule-checkins-btn');
  await owner.waitForFunction(() => document.getElementById('checkin-list').textContent.includes('Midway'),
    null, { timeout: 12000 });
  check(await owner.locator('#checkin-list .line').count() === 5,
    'five touchpoints across the life of the job', 'wrong number of check-ins');
  await owner.screenshot({ path: `${SHOTS}/job.png`, fullPage: true });

  step('Hand Dave his own link');
  await owner.goto(`${WEB}/team.html`);
  await owner.waitForSelector('#subs .line', { timeout: 15000 });
  await owner.evaluate(() => [...document.querySelectorAll('[data-edit]')]
    .find((b) => b.closest('.line').textContent.includes('Dave Mullen')).click());
  await owner.waitForSelector('#person-dialog[open]');
  await owner.click('#p-link');
  await owner.waitForSelector('#link-dialog[open]', { timeout: 12000 });
  const crewUrl = (await owner.inputValue('#link-url')).replace('http://127.0.0.1:8788', WEB);
  check(crewUrl.includes('crew.html?t='), 'crew link minted', `link was ${crewUrl}`);

  step('Dave works from his phone — no login');
  const crew = await ctx.newPage();
  crew.on('console', (m) => { if (m.type() === 'error') errors.push(`[crew] ${m.text()}`); });
  await crew.goto(crewUrl);
  await crew.waitForSelector('#jobs .card', { timeout: 15000 });
  check(/Dave/.test(await crew.textContent('#who')), 'greeted by name', 'wrong greeting');
  check(await crew.locator('#tasks .line').count() === 1, 'his one task is listed', 'task list wrong');

  const sopTitles = await crew.locator('.sop-detail summary').allTextContents();
  check(sopTitles.some((t) => t.includes('New job setup')), 'sees his site-lead SOPs', 'role SOP missing');
  check(!sopTitles.some((t) => t.includes('Scaffold erect')),
    'a scaffold SOP is withheld on a re-roof', 'wrong job-type SOP leaked');

  // The camera opens as part of the same tap; the listener must be armed first.
  const [chooser] = await Promise.all([
    crew.waitForEvent('filechooser', { timeout: 20000 }),
    crew.locator('[data-done]').first().click(),
  ]);
  await chooser.setFiles(photo);
  await crew.waitForFunction(() => document.getElementById('banner').textContent.includes('office can see it'),
    null, { timeout: 30000 });
  ok('task completed with photo proof, in one flow');
  check(await crew.locator('#tasks .line').count() === 0, 'and clears from his list', 'task still listed');

  await crew.locator('[data-log]').first().click();
  await crew.waitForSelector('#log-dialog[open]');
  await crew.fill('#log-body', 'Tile delivery did not turn up, lost half a day');
  await crew.selectOption('#log-kind', 'delay');
  await crew.click('#log-dialog button[value="save"]');
  await crew.waitForFunction(() => document.getElementById('banner').textContent.includes('Sent to the office'),
    null, { timeout: 15000 });
  ok('logged a delay without involving the owner');
  await crew.screenshot({ path: `${SHOTS}/crew.png`, fullPage: true });

  step('It lands on the owner');
  await owner.goto(jobUrl);
  await owner.waitForFunction(() => document.getElementById('task-list').textContent.includes('Strike the ties'),
    null, { timeout: 15000 });
  check((await owner.textContent('#task-badge')).trim() === '1/1', 'task now done', 'task badge wrong');
  check(await owner.locator('#task-list .dot').count() === 0, 'escalation cleared', 'still escalated');
  check(/lost half a day/.test(await owner.textContent('#log-list')), 'the delay is on the log', 'log missing');
  check(await owner.locator('#log-list .dot').count() >= 1, 'flagged unread', 'not flagged');
  await owner.locator('[data-ack]').first().click();
  await owner.waitForFunction(() => document.querySelectorAll('#log-list .dot').length === 0,
    null, { timeout: 12000 });
  ok('acknowledging clears it');

  step('A re-issued link kills the old one');
  await owner.goto(`${WEB}/team.html`);
  await owner.waitForSelector('#subs .line', { timeout: 15000 });
  await owner.evaluate(() => [...document.querySelectorAll('[data-edit]')]
    .find((b) => b.closest('.line').textContent.includes('Dave Mullen')).click());
  await owner.waitForSelector('#person-dialog[open]');
  await owner.click('#p-link');
  await owner.waitForSelector('#link-dialog[open]', { timeout: 12000 });
  check((await owner.inputValue('#link-url')) !== crewUrl, 'a different link is issued', 'link unchanged');

  const stale = await ctx.newPage();
  await stale.goto(crewUrl);
  await stale.waitForSelector('#banner .notice-bad', { timeout: 15000 });
  check(/no longer valid/.test(await stale.textContent('#banner')),
    'the old link is dead — rotation revokes access', 'stale link still works');

  step('Get paid');
  await owner.goto(`${WEB}/cash.html`);
  await owner.waitForSelector('#summary .total-row', { timeout: 15000 });
  await owner.click('#add-btn');
  await owner.waitForSelector('#invoice-dialog[open]');
  await selectByText(owner, '#i-job', 'R. Patel');
  check((await owner.inputValue('#i-client')) === 'R. Patel', 'picking a job fills the client in', 'client not filled');
  await owner.fill('#i-amount', '4200');
  await owner.fill('#i-due', '2026-07-20');       // already overdue
  await owner.click('#invoice-dialog button[value="save"]');
  await owner.waitForFunction(() => document.getElementById('invoices').textContent.includes('R. Patel'),
    null, { timeout: 12000 });
  const cash = await owner.textContent('#summary');
  check(/£4,200/.test(cash), 'outstanding reflects it', 'outstanding wrong');
  check(/days past its due date/.test(cash), 'flagged overdue with an age', 'not flagged overdue');
  check(await owner.locator('#chase-card').isVisible(), 'chase list surfaced', 'chase list hidden');

  await owner.click('[data-pay]');
  await owner.waitForSelector('#payment-dialog[open]');
  await owner.fill('#pay-amount', '1500');
  await owner.click('#payment-dialog button[value="save"]');
  await owner.waitForFunction(() => document.getElementById('invoices').textContent.includes('part paid'),
    null, { timeout: 12000 });
  check(/£2,700/.test(await owner.textContent('#summary')),
    'part payment leaves £2,700 owed, not zero', 'part payment wrong');

  await owner.click('[data-pay]');
  await owner.waitForSelector('#payment-dialog[open]');
  await owner.click('#payment-dialog button[value="full"]');
  await owner.waitForFunction(() => document.getElementById('summary').textContent.includes('Nothing overdue'),
    null, { timeout: 15000 });
  ok('settled');
  await owner.screenshot({ path: `${SHOTS}/cash.png`, fullPage: true });

  step('Console');
  reportConsole(errors);

  await browser.close();
  return failureCount();
}
