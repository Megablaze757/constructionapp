/**
 * Journey: the owner's view of a business with problems in it.
 *
 * Seeds real trouble through the API, then checks the dashboard surfaces exactly
 * that and the automation engine acts on it — without ever claiming to have sent
 * a message it did not send. Phases 2 and 3.
 */

import {
  WEB, SHOTS, api, step, ok, check, openBrowser, ownerPage, reportConsole, failureCount,
} from './lib.mjs';

export default async function run() {
  step('Seed a business with problems in it');

  const good = (await api('/api/jobs', 'POST', {
    client_name: 'A. Healthy', job_type: 'domestic_scaffold_erect', site_address: '1 Fine Way',
    status: 'in_progress', target_start: '2026-08-01', target_end: '2026-12-30',
    budget_baseline: 3000, cost_baseline: 2000,
  })).job;
  await api(`/api/jobs/${good.id}/crew`, 'POST', { person_id: 'per_seed_kaz' });
  await api(`/api/jobs/${good.id}/crew`, 'POST', { person_id: 'per_seed_dave' });

  // Late, over budget, unstaffed, with an unread safety problem.
  const trouble = (await api('/api/jobs', 'POST', {
    client_name: 'B. Trouble', client_phone: '07700 900555', job_type: 'domestic_reroof',
    site_address: '2 Problem St', status: 'in_progress', target_start: '2026-06-01',
    target_end: '2026-07-10', budget_baseline: 5000, cost_baseline: 3000,
  })).job;
  await api(`/api/jobs/${trouble.id}/costs`, 'POST', { description: 'Extra labour', amount: 3600, category: 'labour' });
  await api(`/api/jobs/${trouble.id}/log`, 'POST', { kind: 'safety', body: 'Loose boarding on the second lift' });

  // A client with no phone at all, so the engine has something it cannot reach.
  const silent = (await api('/api/jobs', 'POST', {
    client_name: 'D. Unreachable', job_type: 'domestic_scaffold_erect', site_address: '9 Silent Row',
    status: 'in_progress', target_end: '2026-12-30', budget_baseline: 2000, cost_baseline: 1400,
  })).job;

  // Dave: two late completions on the healthy job, and two outstanding on the
  // troubled one — an escalation and a tick with no photo.
  for (const t of [
    { title: 'Tidy the compound', person_id: 'per_seed_dave', due_on: '2026-07-10' },
    { title: 'Return surplus boards', person_id: 'per_seed_dave', due_on: '2026-07-12' },
  ]) {
    const created = (await api(`/api/jobs/${good.id}/tasks`, 'POST', t)).tasks.slice(-1)[0];
    await api(`/api/jobs/${good.id}/tasks/${created.id}`, 'PATCH', { status: 'done' });
  }
  const unproven = (await api(`/api/jobs/${trouble.id}/tasks`, 'POST', {
    title: 'Photograph the ties', person_id: 'per_seed_dave', due_on: '2026-07-15', needs_photo: true,
  })).tasks.slice(-1)[0];
  await api(`/api/jobs/${trouble.id}/tasks/${unproven.id}`, 'PATCH', { status: 'done' });
  await api(`/api/jobs/${trouble.id}/tasks`, 'POST', {
    title: 'Chase the tile order', person_id: 'per_seed_dave', due_on: '2026-07-01',
  });

  // Kaz: a clean record.
  for (let i = 0; i < 3; i++) {
    const t = (await api(`/api/jobs/${good.id}/tasks`, 'POST', {
      title: `Kaz job ${i + 1}`, person_id: 'per_seed_kaz', due_on: '2026-12-01',
    })).tasks.slice(-1)[0];
    await api(`/api/jobs/${good.id}/tasks/${t.id}`, 'PATCH', { status: 'done' });
  }

  await api('/api/invoices', 'POST', { job_id: trouble.id, amount: 5000, status: 'sent', due_on: '2026-07-05' });
  await api('/api/invoices', 'POST', { job_id: silent.id, amount: 2000, status: 'sent', due_on: '2026-07-05' });
  ok('3 jobs, 7 tasks, 2 overdue invoices, 1 safety issue');

  const { browser, ctx, errors } = await openBrowser();
  const page = await ownerPage(ctx, errors);

  /* ---------------------------------------------------------- dashboard */

  step('The dashboard answers "how is the business"');
  await page.goto(`${WEB}/dashboard.html`);
  await page.waitForSelector('.tile', { timeout: 15000 });

  const tiles = Object.fromEntries(await page.evaluate(() =>
    [...document.querySelectorAll('.tile')].map((t) => [
      t.querySelector('.tile-label').textContent,
      { value: t.querySelector('.tile-value').textContent, sub: t.querySelector('.tile-sub').textContent },
    ])));
  check(tiles.Outstanding?.value === '£7,000', `outstanding ${tiles.Outstanding?.value}`,
    `outstanding was ${tiles.Outstanding?.value}, expected £7,000`);
  check(tiles['Active jobs']?.value === '3', '3 active jobs', `active was ${tiles['Active jobs']?.value}`);
  // B. Trouble on four counts, D. Unreachable because nobody is on it.
  check(tiles['At risk']?.value === '2', '2 jobs at risk', `at risk was ${tiles['At risk']?.value}`);

  const risk = await page.textContent('#risks');
  for (const [what, re] of [
    ['behind schedule', /days past its finish date/],
    ['unstaffed', /Nobody is assigned/],
    ['over budget', /over the expected cost/],
    ['unread problem', /problem.*not yet read/],
  ]) check(re.test(risk), `risk reason named: ${what}`, `missing risk reason: ${what}`);
  check(!/A\. Healthy/.test(risk), 'the healthy job is left alone', 'healthy job flagged');

  const decisions = await page.textContent('#decisions');
  check(/Chase the tile order/.test(decisions), 'escalated task needs a decision', 'escalation missing');
  check(/Loose boarding/.test(decisions), 'unread safety issue needs a decision', 'safety issue missing');
  check(/photo proof is missing/.test(decisions), 'a tick with no proof needs a decision', 'missing proof not shown');

  step('Margin does not flatter itself');
  const margin = await page.textContent('#margin');
  check(/based on 1 of 3 jobs/.test(margin),
    'margin so far says how much of the picture it covers',
    `margin caveat missing: ${margin.replace(/\s+/g, ' ').slice(0, 140)}`);

  step('Reliability is scored, and honest about its limits');
  const rel = await page.textContent('#reliability');
  check(/Worth a conversation/.test(rel), 'the poor record is raised', 'no concern raised');
  const scores = await page.evaluate(() => [...document.querySelectorAll('#reliability .total-row')]
    .map((r) => ({ name: r.querySelector('span').textContent.trim(), score: Number(r.querySelector('.badge')?.textContent) })));
  const dave = scores.find((s) => s.name.startsWith('Dave'));
  const kaz = scores.find((s) => s.name.startsWith('Kaz'));
  check(kaz && dave && kaz.score > dave.score,
    `Kaz (${kaz?.score}) ranks above Dave (${dave?.score})`, `ranking wrong: ${JSON.stringify(scores)}`);
  await page.click('#reliability details summary');
  check(/On-time arrival to site/.test(await page.textContent('#reliability details')),
    'says what it does not measure rather than guessing it', 'unmeasured inputs not disclosed');
  await page.screenshot({ path: `${SHOTS}/dashboard.png`, fullPage: true });

  /* -------------------------------------------------------- automations */

  step('Automations are upfront that nothing is being sent');
  await page.goto(`${WEB}/automations.html`);
  await page.waitForSelector('#rules .line', { timeout: 15000 });
  const driver = await page.textContent('#driver-status');
  check(/No message provider connected/.test(driver), 'the no-provider state is stated plainly', 'not stated');
  check(/nothing is actually sent to anybody/.test(driver), 'and that nothing is sent', 'does not say so');

  const clientRules = await page.evaluate(() => [...document.querySelectorAll('#rules .line')]
    .filter((l) => l.textContent.includes('messages a person'))
    .map((l) => l.querySelector('input').checked));
  check(clientRules.length > 0 && clientRules.every((on) => !on),
    'rules that text a client are off until the owner turns them on',
    `client rules: ${JSON.stringify(clientRules)}`);

  step('A preview changes nothing');
  await page.click('#dry-btn');
  await page.waitForSelector('#run-dialog[open]', { timeout: 15000 });
  check(/nothing was sent or recorded/.test(await page.textContent('#run-results')),
    'the preview says it changed nothing', 'preview did not say so');
  await page.click('#run-dialog button[value="close"]');
  check(/Nothing has gone out yet/.test(await page.textContent('#outbox')),
    'and the outbox is still empty', 'the preview wrote to the outbox');

  step('Run it for real');
  await page.evaluate(() => [...document.querySelectorAll('#rules .line')]
    .find((l) => l.textContent.includes('friendly reminder'))
    .querySelector('input[data-toggle]').click());
  await page.waitForTimeout(1500);
  await page.click('#run-btn');
  await page.waitForSelector('#run-dialog[open]', { timeout: 20000 });
  const result = await page.textContent('#run-results');
  check(/simulated/.test(result), 'messages report as simulated, never as sent', `run said: ${result.slice(0, 140)}`);
  check(/No phone number on file for D\. Unreachable/.test(result),
    'the unreachable client is a reported failure, not a silent skip', 'unreachable client not surfaced');
  await page.click('#run-dialog button[value="close"]');

  await page.waitForFunction(() => !document.getElementById('outbox').textContent.includes('Nothing has gone out'),
    null, { timeout: 15000 });
  const outbox = await page.textContent('#outbox');
  check(/gentle nudge that invoice/.test(outbox), 'the outbox holds the message that would have gone', 'body missing');
  check(/failed/.test(outbox), 'and the failure too', 'failure not shown');
  await page.screenshot({ path: `${SHOTS}/automations.png`, fullPage: true });

  step('Running again chases nobody twice');
  await page.click('#run-btn');
  await page.waitForSelector('#run-dialog[open]', { timeout: 20000 });
  const second = await page.textContent('#run-results');
  check(/0 rules? fired/.test(second), 'deduplicated', `second run said: ${second.slice(0, 120)}`);
  check(/skipped as already done/.test(second), 'and says why', 'no explanation');
  await page.click('#run-dialog button[value="close"]');

  step('Build a rule without writing code');
  await page.click('#new-btn');
  await page.waitForSelector('#rule-dialog[open]');
  await page.fill('#r-name', 'Escalate 21-day debts');
  await page.selectOption('#r-trigger', 'invoice_overdue');
  await page.fill('[data-param="days"]', '21');
  await page.selectOption('#r-action', 'notify_owner');
  await page.fill('#r-message', '{client_name} is {days_overdue} days late on {amount}. Ring them.');
  await page.click('#rule-dialog button[value="save"]');
  await page.waitForFunction(() => document.getElementById('rules').textContent.includes('Escalate 21-day debts'),
    null, { timeout: 15000 });
  await page.click('#run-btn');
  await page.waitForSelector('#run-dialog[open]', { timeout: 20000 });
  check(/days late on £/.test(await page.textContent('#run-results')),
    'the new rule fires with its placeholders filled in', 'custom rule did not fire');
  await page.click('#run-dialog button[value="close"]');

  // Everything after this point deliberately provokes a 400.
  const before = errors.length;

  step('An unreadable rule is refused');
  const rejected = await page.evaluate(async ([base, token]) => {
    const res = await fetch(`${base}/api/automations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Broken', trigger_type: 'when_pigs_fly', actions: [] }),
    });
    return { status: res.status, body: await res.json() };
  }, [process.env.API_BASE || 'http://127.0.0.1:8787', process.env.OWNER_TOKEN || 'dev-owner-token']);
  check(rejected.status === 400, `refused (${rejected.body.error})`, `got ${rejected.status}`);

  step('Console');
  reportConsole(errors, before);

  await browser.close();
  return failureCount();
}
