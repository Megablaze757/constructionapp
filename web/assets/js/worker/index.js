/* ------------------------------------------------------------------------- *
 * GENERATED FILE — DO NOT EDIT.
 * Built by worker/scripts/build-generated.mjs from worker/src/index.js.
 * Edit the source and run: npm run build:generated
 * ------------------------------------------------------------------------- */

/**
 * BuilderOS — Auto-Quoting API (Cloudflare Worker).
 *
 * Two audiences, two very different trust levels:
 *   /api/*  owner + estimator. Bearer token. Sees cost, margin, AI provenance.
 *   /q/*    the client. Unguessable link, no login. Sees prices and scope only —
 *           never cost, never margin, never the AI's notes to the owner.
 */

import { json, fail, requireOwner, corsHeaders, newId, randomToken } from './http.js';
import { priceLine, totalQuote, sendBlockers, money } from './pricing.js';
import { requestDraft, aiConfigured } from './groq.js';
import { templateDraft } from './fallback-draft.js';
import {
  jobVariance, byJobType, lineCodeBias, biasBriefing, summarise,
} from './variance.js';
import { suggestTemplates } from './templates.js';
import {
  invoiceState, summariseInvoices, nextInvoiceNumber, sopProgress,
} from './invoicing.js';
import {
  taskState, ownerAttention, taskProgress, plannedCheckins, overdueCheckins,
  visibleSops, addDays,
} from './delegation.js';

import { atRiskJobs, jobProgress, cashForecast, marginHealth } from './dashboard.js';
import {
  reliabilityBoard, reliabilityConcerns, MEASURED, NOT_MEASURED,
} from './reliability.js';
import {
  TRIGGERS, ACTIONS, planActions, validateAutomation,
} from './automation.js';
import { deliver, driverName, resolveRecipient, DRIVERS } from './messaging.js';

/** Cap on a job photo, after the browser has downscaled it. */
const MAX_JOB_PHOTO_BYTES = 1_000_000;

/** Today as an ISO date. Injected into the money maths so it stays testable. */
const today = () => new Date().toISOString().slice(0, 10);
import * as db from './db.js';

/** Cap on a single uploaded photo, after the browser has downscaled it. */
const MAX_PHOTO_BYTES = 1_000_000;

export default {
  /**
   * Cloudflare cron trigger. This is what makes the engine automation rather
   * than a button: the same runAutomations() the API calls, on a schedule.
   */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      runAutomations(env).then(
        (r) => console.log(`automations: fired ${r.fired}, skipped ${r.skipped_already_done}, driver ${r.driver}`),
        (err) => console.error('automation run failed', err?.stack || err),
      ),
    );
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }

    const ctxo = { env, request };
    try {
      if (path === '/' || path === '/health') {
        return json(
          {
            service: 'builderos-auto-quoting',
            ok: true,
            ai: aiConfigured(env),
            // Which of the three ways of reaching a model is in play, so a
            // misconfigured deployment is diagnosable without reading logs.
            ai_mode: env.AI_PROXY_URL ? 'proxy' : env.GROQ_API_KEY ? 'groq' : 'template',
          },
          ctxo,
        );
      }
      if (path.startsWith('/api/')) return await ownerRoutes(path, request, env, ctxo);
      if (path.startsWith('/crew/')) return await crewRoutes(path, request, env, ctxo);
      if (path.startsWith('/q/')) return await clientRoutes(path, request, env, ctxo);
      return fail(404, 'Not found', {}, ctxo);
    } catch (err) {
      console.error('unhandled', err?.stack || err);
      return fail(500, 'Internal error', { detail: String(err?.message || err) }, ctxo);
    }
  },
};

/* ------------------------------------------------------------------ owner */

async function ownerRoutes(path, request, env, ctxo) {
  const authError = requireOwner(request, env);
  if (authError) return fail(401, authError, {}, ctxo);

  const D1 = env.DB;
  const seg = path.split('/').filter(Boolean); // ['api', ...]
  const [, resource, id, action, subId] = seg;
  const method = request.method;

  if (resource === 'templates' && !id && method === 'GET') {
    return json({ templates: await db.getTemplates(D1) }, ctxo);
  }

  if (resource === 'templates' && id === 'suggestions' && method === 'GET') {
    const [quotes, templates] = await Promise.all([
      db.quotesWithLines(D1),
      db.getTemplates(D1),
    ]);
    return json({ suggestions: suggestTemplates(quotes, templates) }, ctxo);
  }

  // Accept a suggestion (or create a template outright).
  if (resource === 'templates' && !id && method === 'POST') {
    const body = await readJson(request);
    const jobType = String(body.job_type || '').trim();
    const name = String(body.name || '').trim();
    if (!/^[a-z0-9]+(_[a-z0-9]+)*$/.test(jobType)) {
      return fail(400, 'job_type must be snake_case', {}, ctxo);
    }
    if (!name) return fail(400, 'name is required', {}, ctxo);
    if (!Array.isArray(body.line_items) || !body.line_items.length) {
      return fail(400, 'line_items[] is required', {}, ctxo);
    }
    if (await db.getTemplate(D1, jobType)) {
      return fail(409, `A template for "${jobType}" already exists.`, {}, ctxo);
    }

    // Every line must resolve to the price book, for the same reason the AI's
    // line_code is checked: a template is what the assistant is allowed to draw
    // on, so an unknown code here would become an unpriceable quote later.
    const book = db.priceBookMap(await db.getPriceBook(D1));
    const unknown = body.line_items.filter((li) => !book.has(li.line_code));
    if (unknown.length) {
      return fail(400, `Unknown price book codes: ${unknown.map((u) => u.line_code).join(', ')}`, {}, ctxo);
    }

    const margin = Number(body.default_margin);
    const floor = Number(body.margin_floor);
    if (!Number.isFinite(margin) || !Number.isFinite(floor) || floor > margin) {
      return fail(400, 'default_margin and margin_floor must be numbers, with the floor at or below the target', {}, ctxo);
    }

    const tpl = {
      id: newId('tpl'),
      job_type: jobType,
      name,
      default_margin: margin,
      margin_floor: floor,
      validity_days: Number(body.validity_days) || 30,
      terms: body.terms ?? '',
      exclusions: body.exclusions ?? '',
      line_items: body.line_items.map((li) => ({
        line_code: li.line_code,
        description: li.description || book.get(li.line_code).description,
        unit: li.unit || book.get(li.line_code).unit,
        default_quantity: li.default_quantity ?? null,
        always_include: li.always_include !== false,
        locked: !!li.locked,
      })),
      optional_extras: body.optional_extras ?? [],
    };
    await db.createTemplate(D1, tpl);
    return json({ template: tpl }, { ...ctxo, status: 201 });
  }

  if (resource === 'pricebook' && method === 'GET') {
    return json({ price_book: await db.getPriceBook(D1) }, ctxo);
  }

  if (resource === 'quotes' && !id && method === 'GET') {
    return json({ quotes: await db.listQuotes(D1) }, ctxo);
  }

  if (resource === 'quotes' && !id && method === 'POST') {
    return createQuote(request, env, ctxo);
  }

  if (resource === 'reports' && id === 'variance' && method === 'GET') {
    return varianceReport(env, ctxo);
  }

  if (resource === 'reports' && id === 'cash' && method === 'GET') {
    const invoices = await db.listInvoices(D1);
    return json(summariseInvoices(invoices, today()), ctxo);
  }

  // The single pane of glass (system spec §3).
  if (resource === 'reports' && id === 'dashboard' && method === 'GET') {
    return dashboardReport(env, ctxo);
  }

  // What the owner actually needs to look at, across every running job.
  if (resource === 'reports' && id === 'attention' && method === 'GET') {
    const [tasks, logs, checkins] = await Promise.all([
      db.allOpenTasks(D1), db.recentSiteLogs(D1), db.allCheckins(D1),
    ]);
    const a = ownerAttention(tasks, logs, today());
    return json({ ...a, overdue_checkins: overdueCheckins(checkins, today()) }, ctxo);
  }

  if (resource === 'automations') return automationRoutes(id, action, request, env, ctxo);

  if (resource === 'outbox' && method === 'GET') {
    const { results } = await D1.prepare(
      `SELECT o.*, a.name AS automation_name FROM outbox o
    LEFT JOIN automations a ON a.id = o.automation_id
       ORDER BY o.created_at DESC, o.rowid DESC LIMIT 100`,
    ).all();
    return json({ outbox: results ?? [], driver: driverName(env) }, ctxo);
  }

  if (resource === 'people') return peopleRoutes(id, action, request, env, ctxo);
  if (resource === 'sops') return sopRoutes(id, request, env, ctxo);
  if (resource === 'invoices') return invoiceRoutes(id, request, env, ctxo);
  if (resource === 'jobs') return jobRoutes(id, action, subId, request, env, ctxo);

  if (resource !== 'quotes' || !id) return fail(404, 'Not found', {}, ctxo);

  const row = await db.getQuoteRow(D1, id);
  if (!row) return fail(404, 'Quote not found', {}, ctxo);

  if (!action && method === 'GET') {
    const loaded = await db.loadQuote(D1, row);
    return json(
      {
        ...loaded,
        blockers: sendBlockers(loaded.quote, loaded.lines, loaded.totals),
        events: await db.getEvents(D1, id),
      },
      ctxo,
    );
  }

  if (!action && method === 'PATCH') return patchQuote(row, request, env, ctxo);
  if (!action && method === 'DELETE') {
    await D1.prepare('DELETE FROM quotes WHERE id = ?1').bind(id).run();
    return json({ deleted: id }, ctxo);
  }

  if (action === 'photos' && method === 'GET' && !subId) {
    return json({ photos: await db.listPhotos(D1, id) }, ctxo);
  }
  // Owner-side photo bytes. The public route deliberately 404s a draft quote, so
  // the builder cannot use it to show the owner their own photos before sending.
  if (action === 'photos' && method === 'GET' && subId) {
    const owned = await D1.prepare('SELECT id FROM quote_photos WHERE id = ?1 AND quote_id = ?2')
      .bind(subId, id)
      .first();
    if (!owned) return fail(404, 'Photo not found', {}, ctxo);
    const photo = await db.getPhotoBytes(D1, subId);
    return new Response(photo.bytes, {
      headers: {
        'Content-Type': photo.mime,
        'Cache-Control': 'private, max-age=3600',
        ...corsHeaders(env, request),
      },
    });
  }
  if (action === 'photos' && method === 'POST') return addPhoto(row, request, env, ctxo);
  if (action === 'photos' && method === 'DELETE' && subId) {
    await D1.prepare('DELETE FROM quote_photos WHERE id = ?1 AND quote_id = ?2')
      .bind(subId, id)
      .run();
    return json({ deleted: subId }, ctxo);
  }

  if (action === 'draft' && method === 'POST') return draftQuote(row, request, env, ctxo);
  if (action === 'lines' && method === 'PUT') return putLines(row, request, env, ctxo);
  if (action === 'lines' && method === 'POST' && subId === 'confirm-all') {
    return confirmAll(row, env, ctxo);
  }
  if (action === 'send' && method === 'POST') return sendQuote(row, request, env, ctxo);

  return fail(404, 'Not found', {}, ctxo);
}

async function createQuote(request, env, ctxo) {
  const D1 = env.DB;
  const body = await readJson(request);
  const jobType = body.job_type;
  if (!jobType) return fail(400, 'job_type is required', {}, ctxo);

  const template = await db.getTemplate(D1, jobType);
  if (!template) return fail(400, `No template for job_type "${jobType}"`, {}, ctxo);

  const id = newId('q');
  const validUntil = new Date(Date.now() + template.validity_days * 864e5)
    .toISOString()
    .slice(0, 10);

  await D1.prepare(
    `INSERT INTO quotes
       (id, public_token, template_id, job_type, client_name, client_email,
        site_address, description, margin_floor, target_margin, valid_until)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
  )
    .bind(
      id,
      randomToken(26),
      template.id,
      jobType,
      (body.client_name || '').trim() || 'Unnamed client',
      body.client_email || null,
      body.site_address || null,
      body.description || '',
      template.margin_floor,
      template.default_margin,
      validUntil,
    )
    .run();

  // Seed the always-include template lines so a manual quote (Phase A) works with
  // no AI involved at all — the AI is an accelerator, never a dependency.
  const book = db.priceBookMap(await db.getPriceBook(D1));
  const seeded = template.line_items
    .filter((li) => li.always_include)
    .map((li) => ({
      id: newId('li'),
      line_code: li.line_code,
      description: li.description,
      quantity: li.default_quantity ?? 1,
      unit: li.unit,
      kind: 'base',
      source: 'template_default',
      confidence: 'high',
      confirmed: true,
      locked: !!li.locked,
    }))
    .map((l) => ({ ...l, ...priceLine(l, book) }));

  const extras = template.optional_extras.map((ex) => ({
    id: newId('li'),
    line_code: ex.line_code,
    description: ex.description,
    blurb: ex.blurb,
    quantity: 1,
    kind: 'extra',
    source: 'template_default',
    confidence: 'high',
    confirmed: true,
    selected: false,
  })).map((l) => ({ ...l, ...priceLine(l, book) }));

  await db.replaceLines(D1, id, [...seeded, ...extras]);
  await db.logEvent(D1, id, 'created', { job_type: jobType });

  const loaded = await db.loadQuote(D1, await db.getQuoteRow(D1, id));
  await db.saveTotals(D1, id, loaded.totals);
  return json({ ...loaded, blockers: sendBlockers(loaded.quote, loaded.lines, loaded.totals) }, { ...ctxo, status: 201 });
}

async function patchQuote(row, request, env, ctxo) {
  const body = await readJson(request);
  const fields = ['client_name', 'client_email', 'site_address', 'description', 'client_summary', 'override_reason'];
  const sets = [];
  const binds = [row.id];
  for (const f of fields) {
    if (body[f] !== undefined) {
      binds.push(body[f]);
      sets.push(`${f} = ?${binds.length}`);
    }
  }
  if (!sets.length) return fail(400, 'No updatable fields supplied', {}, ctxo);

  await env.DB.prepare(`UPDATE quotes SET ${sets.join(', ')} WHERE id = ?1`).bind(...binds).run();
  if (body.override_reason) {
    await db.logEvent(env.DB, row.id, 'margin_override', { reason: body.override_reason });
  }
  const loaded = await db.loadQuote(env.DB, await db.getQuoteRow(env.DB, row.id));
  return json({ ...loaded, blockers: sendBlockers(loaded.quote, loaded.lines, loaded.totals) }, ctxo);
}

/** Generate Draft with AI (wireframe §1.1). */
async function draftQuote(row, request, env, ctxo) {
  const D1 = env.DB;
  const body = await readJson(request);
  const description = (body.description ?? row.description ?? '').trim();
  if (!description) return fail(400, 'A job description is required to draft.', {}, ctxo);

  const template = await db.getTemplate(D1, row.job_type);
  if (!template) return fail(400, 'Template missing for this quote.', {}, ctxo);

  // Photos cost tokens on every draft, so the owner decides per draft. Default is
  // on when photos exist — having uploaded them, that is the expected behaviour.
  const usePhotos = body.use_photos !== false;

  const [book, similar, quotedLines, actualCosts, photos] = await Promise.all([
    db.getPriceBook(D1),
    db.similarPastJobs(D1, row.job_type),
    db.quotedLinesForCompletedJobs(D1),
    db.allActualCosts(D1),
    usePhotos ? db.getPhotosForDraft(D1, row.id) : Promise.resolve([]),
  ]);

  // The learning loop: measured drift between what this business quoted and what
  // its jobs actually cost, fed back in as scoping guidance.
  const estimatingHistory = biasBriefing(lineCodeBias(quotedLines, actualCosts));

  let result = await requestDraft(env, {
    description,
    template,
    priceBook: book,
    similarJobs: similar,
    estimatingHistory,
    photos,
  });

  // No AI connected yet is not an error the owner can act on. Start them from
  // the template instead, labelled as such — see fallback-draft.js.
  if (!result.ok && result.unconfigured) {
    const fallback = templateDraft(template);
    if (!fallback.ok) return fail(502, fallback.error, {}, ctxo);
    result = {
      ok: true, ai: false, draft: fallback.draft, model: 'template defaults (no AI connected)',
      mode: 'template', photos_used: 0,
    };
    await db.logEvent(D1, row.id, 'template_drafted', { lines: fallback.draft.line_items.length });
  } else if (!result.ok) {
    await db.logEvent(D1, row.id, 'ai_draft_failed', { error: result.error });
    return fail(502, result.error, { detail: result.detail }, ctxo);
  }

  const map = db.priceBookMap(book);
  const existing = await db.getLines(D1, row.id);
  // Owner-locked lines survive a redraft untouched (§4.3), as do the extras,
  // which belong to the template rather than to the AI.
  const kept = existing.filter((l) => l.locked || l.kind === 'extra');
  const keptCodes = new Set(kept.filter((l) => l.kind === 'base').map((l) => l.line_code));

  const drafted = result.draft.line_items
    .filter((li) => !keptCodes.has(li.line_code))
    .map((li, i) => ({
      id: newId('li'),
      line_code: li.line_code,
      description: li.description,
      quantity: li.quantity_estimate,
      unit: li.unit,
      kind: 'base',
      source: li.source,
      confidence: li.confidence,
      note: li.note ?? null,
      // The tap-to-confirm gate: anything the AI inferred — from the wording or
      // from a photo — lands unconfirmed and shows an amber dot until tapped.
      confirmed: !['ai_inferred', 'photo_inferred'].includes(li.source) && li.confidence === 'high',
      locked: false,
      position: i,
    }))
    .map((l) => ({ ...l, ...priceLine(l, map) }));

  const lines = [...kept.filter((l) => l.kind === 'base'), ...drafted, ...kept.filter((l) => l.kind === 'extra')];
  await db.replaceLines(D1, row.id, lines);

  const summary = {
    confidence: result.draft.confidence,
    assumptions: result.draft.assumptions,
    flags_for_owner_review: result.draft.flags_for_owner_review,
    similar_past_jobs_reference: similar,
    estimating_history: estimatingHistory,
    photos_used: result.photos_used,
    model: result.model,
    // The builder reads this to decide whether to call the result an estimate.
    ai: result.ai !== false,
    drafted_at: new Date().toISOString(),
  };
  await D1.prepare('UPDATE quotes SET description = ?2, ai_summary = ?3 WHERE id = ?1')
    .bind(row.id, description, JSON.stringify(summary))
    .run();
  if (result.ai !== false) {
    await db.logEvent(D1, row.id, 'ai_drafted', { model: result.model, lines: drafted.length });
  }

  const loaded = await db.loadQuote(D1, await db.getQuoteRow(D1, row.id));
  await db.saveTotals(D1, row.id, loaded.totals);
  return json({ ...loaded, blockers: sendBlockers(loaded.quote, loaded.lines, loaded.totals) }, ctxo);
}

/** Replace the line items wholesale (the builder screen saves the whole list). */
async function putLines(row, request, env, ctxo) {
  const body = await readJson(request);
  if (!Array.isArray(body.lines)) return fail(400, 'lines[] is required', {}, ctxo);

  const map = db.priceBookMap(await db.getPriceBook(env.DB));
  let priced;
  try {
    priced = body.lines.map((l, i) => {
      const qty = Number(l.quantity);
      if (!Number.isFinite(qty) || qty <= 0) {
        throw new Error(`"${l.description || 'line ' + (i + 1)}" needs a quantity greater than 0`);
      }
      return {
        ...priceLine({ ...l, quantity: qty }, map),
        id: l.id || newId('li'),
        position: i,
        // Editing an AI line is itself a confirmation — the owner has looked at it.
        confirmed: l.confirmed === undefined ? true : !!l.confirmed,
      };
    });
  } catch (err) {
    return fail(400, err.message, {}, ctxo);
  }

  await db.replaceLines(env.DB, row.id, priced);
  const loaded = await db.loadQuote(env.DB, await db.getQuoteRow(env.DB, row.id));
  await db.saveTotals(env.DB, row.id, loaded.totals);
  return json({ ...loaded, blockers: sendBlockers(loaded.quote, loaded.lines, loaded.totals) }, ctxo);
}

async function confirmAll(row, env, ctxo) {
  await env.DB.prepare('UPDATE quote_line_items SET confirmed = 1 WHERE quote_id = ?1')
    .bind(row.id)
    .run();
  await db.logEvent(env.DB, row.id, 'lines_confirmed', {});
  const loaded = await db.loadQuote(env.DB, await db.getQuoteRow(env.DB, row.id));
  return json({ ...loaded, blockers: sendBlockers(loaded.quote, loaded.lines, loaded.totals) }, ctxo);
}

async function sendQuote(row, request, env, ctxo) {
  const D1 = env.DB;
  const body = await readJson(request);
  if (body.override_reason) {
    await D1.prepare('UPDATE quotes SET override_reason = ?2 WHERE id = ?1')
      .bind(row.id, body.override_reason)
      .run();
    await db.logEvent(D1, row.id, 'margin_override', { reason: body.override_reason });
    row = await db.getQuoteRow(D1, row.id);
  }

  const loaded = await db.loadQuote(D1, row);
  const blockers = sendBlockers(loaded.quote, loaded.lines, loaded.totals);
  if (blockers.length) {
    // The margin floor is a hard block, enforced here and not only in the UI —
    // a client of this API cannot send an underpriced quote by skipping the app.
    return fail(422, 'Quote cannot be sent yet.', { blockers }, ctxo);
  }

  await D1.prepare("UPDATE quotes SET status = 'sent', sent_at = datetime('now') WHERE id = ?1")
    .bind(row.id)
    .run();
  await db.saveTotals(D1, row.id, loaded.totals);
  await db.logEvent(D1, row.id, 'sent', { margin_pct: loaded.totals.margin_pct });

  return json(
    {
      sent: true,
      public_url: `${env.PUBLIC_APP_URL || ''}/quote.html?t=${row.public_token}`,
      token: row.public_token,
    },
    ctxo,
  );
}

/* ------------------------------------------- Phase 3: automation engine */

/**
 * Build the snapshot the engine reasons over.
 *
 * The engine is a pure function of this, which is what makes a dry run and a
 * real run the same code path.
 */
async function buildWorld(env) {
  const D1 = env.DB;
  const now = today();
  const [d, checkins] = await Promise.all([db.dashboardData(D1), db.allCheckins(D1)]);

  const tasksByJob = new Map();
  for (const [jobId, rows] of d.rawTasksByJob) {
    tasksByJob.set(jobId, rows.map((t) => taskState(t, now)));
  }

  const risks = atRiskJobs(d.jobs, {
    crewByJob: d.crewByJob,
    costsByJob: d.costsByJob,
    tasksByJob,
    logsByJob: d.logsByJob,
  }, now);

  const jobById = new Map(d.jobs.map((j) => [j.id, j]));
  const peopleById = new Map(d.people.map((p) => [p.id, p]));

  const escalatedTasks = [];
  for (const [jobId, rows] of tasksByJob) {
    for (const t of rows) {
      if (!t.escalated) continue;
      const job = jobById.get(jobId);
      escalatedTasks.push({
        ...t,
        person_name: peopleById.get(t.person_id)?.name || null,
        client_name: job?.client_name,
        site_address: job?.site_address,
      });
    }
  }

  // "Onboarded" means somebody has actually been given work. It is a real
  // signal, and it stops the rule pestering an owner about people who were
  // already up and running before the automation existed.
  const onboardedPersonIds = new Set(d.allTasks.map((t) => t.person_id).filter(Boolean));

  return {
    world: {
      today: now,
      globals: { business_name: env.BUSINESS_NAME || 'the office' },
      invoices: d.invoices,
      jobs: d.jobs,
      risks,
      checkins,
      people: d.people,
      escalatedTasks,
      onboardedPersonIds,
    },
    jobById,
    peopleById,
  };
}

/**
 * Execute planned actions.
 *
 * `dryRun` short-circuits every write, including the dedupe record, so a preview
 * shows exactly what a real run would do and changes nothing.
 */
async function runAutomations(env, { dryRun = false } = {}) {
  const D1 = env.DB;
  const { world, jobById, peopleById } = await buildWorld(env);

  const [{ results: rules }, { results: runs }] = await Promise.all([
    D1.prepare('SELECT * FROM automations WHERE enabled = 1').all(),
    D1.prepare('SELECT dedupe_key FROM automation_runs').all(),
  ]);

  const parsed = (rules ?? []).map((r) => ({
    ...r,
    enabled: !!r.enabled,
    trigger_config: safeJson(r.trigger_config, {}),
    conditions: safeJson(r.conditions, []),
    actions: safeJson(r.actions, []),
  }));

  const firedKeys = new Set((runs ?? []).map((r) => r.dedupe_key));
  const { plans, skipped } = planActions(parsed, world, firedKeys);

  const performed = [];
  for (const plan of plans) {
    const job = plan.context.job_id ? jobById.get(plan.context.job_id) : null;
    const person = plan.context.person_id ? peopleById.get(plan.context.person_id) : null;
    const ctx = {
      client: job ? { name: job.client_name, phone: job.client_phone, email: job.client_email } : { name: plan.context.client_name },
      person: person ? { name: person.name, phone: person.phone, email: person.email } : null,
    };

    const taken = [];
    for (const action of plan.actions) {
      taken.push(await performAction(env, { action, plan, ctx, job, person, dryRun }));
    }

    if (!dryRun) {
      await D1.prepare(
        `INSERT OR IGNORE INTO automation_runs (id, automation_id, dedupe_key, entity_type, entity_id, actions_taken)
         VALUES (?1,?2,?3,?4,?5,?6)`,
      ).bind(newId('run'), plan.automation_id, plan.dedupe_key, plan.entity_type,
        plan.entity_id, JSON.stringify(taken)).run();
    }

    performed.push({
      automation: plan.automation_name,
      entity_type: plan.entity_type,
      entity_id: plan.entity_id,
      actions: taken,
    });
  }

  return {
    dry_run: dryRun,
    ran_at: new Date().toISOString(),
    driver: driverName(env),
    fired: performed.length,
    skipped_already_done: skipped,
    results: performed,
  };
}

async function performAction(env, { action, plan, ctx, job, person, dryRun }) {
  const D1 = env.DB;

  if (action.type === 'create_task') {
    const due = action.due_in_days != null
      ? addDays(today(), Number(action.due_in_days) || 0)
      : null;
    if (!dryRun && job) {
      await D1.prepare(
        `INSERT INTO tasks (id, job_id, person_id, title, due_on, needs_photo)
         VALUES (?1,?2,?3,?4,?5,?6)`,
      ).bind(newId('task'), job.id, person?.id || null, action.title, due,
        action.needs_photo ? 1 : 0).run();
    }
    return {
      type: 'create_task',
      title: action.title,
      due_on: due,
      // An onboarding rule fires on a person, who may not be on a job yet.
      status: job ? (dryRun ? 'would_create' : 'created') : 'skipped_no_job',
    };
  }

  if (action.type === 'flag_job') {
    if (!dryRun && job) {
      await D1.prepare(
        'INSERT INTO site_logs (id, job_id, kind, body) VALUES (?1,?2,?3,?4)',
      ).bind(newId('log'), job.id, 'issue', action.message).run();
    }
    return { type: 'flag_job', message: action.message, status: job ? (dryRun ? 'would_flag' : 'flagged') : 'skipped_no_job' };
  }

  // Messaging actions.
  const to = resolveRecipient(action, ctx);
  if (!to.ok) {
    // Recorded as a failure with the reason, so the owner does not read
    // "reminder sent" while an invoice sits silently unpaid.
    if (!dryRun) await writeOutbox(D1, { plan, to, action, status: 'failed', error: to.reason });
    return { type: action.type, channel: to.channel, status: 'failed', error: to.reason };
  }

  if (dryRun) {
    // The preview must predict what a real run would actually do. An owner
    // alert is delivered in-app whatever the messaging driver is, so calling it
    // "would simulate" would understate it just as badly as the reverse.
    const wouldBe = to.channel === 'owner_alert'
      ? 'would_alert'
      : driverName(env) === 'simulated' ? 'would_simulate' : 'would_send';
    return {
      type: action.type, channel: to.channel, to: to.recipient_name,
      status: wouldBe, body: action.message,
    };
  }

  const delivery = await deliver(env, {
    channel: to.channel,
    recipient: to.recipient,
    recipient_name: to.recipient_name,
    body: action.message,
    entity_type: plan.entity_type,
    entity_id: plan.entity_id,
  });
  await writeOutbox(D1, { plan, to, action, ...delivery });

  return {
    type: action.type, channel: to.channel, to: to.recipient_name,
    status: delivery.status, provider: delivery.provider, error: delivery.error,
    body: action.message,
  };
}

async function writeOutbox(D1, { plan, to, action, status, provider, error }) {
  await D1.prepare(
    `INSERT INTO outbox (id, automation_id, channel, recipient, recipient_name, body,
                         status, provider, error, entity_type, entity_id)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`,
  ).bind(
    newId('out'), plan.automation_id, to.channel, to.recipient, to.recipient_name,
    action.message, status, provider || null, error || null,
    plan.entity_type, plan.entity_id,
  ).run();
}

async function automationRoutes(id, action, request, env, ctxo) {
  const D1 = env.DB;
  const method = request.method;

  if (!id && method === 'GET') {
    const { results } = await D1.prepare('SELECT * FROM automations ORDER BY name').all();
    const [{ results: runs }] = await Promise.all([
      D1.prepare('SELECT automation_id, COUNT(*) AS n, MAX(fired_at) AS last FROM automation_runs GROUP BY automation_id').all(),
    ]);
    const stats = new Map((runs ?? []).map((r) => [r.automation_id, r]));

    return json({
      automations: (results ?? []).map((r) => ({
        ...r,
        enabled: !!r.enabled,
        trigger_config: safeJson(r.trigger_config, {}),
        conditions: safeJson(r.conditions, []),
        actions: safeJson(r.actions, []),
        times_fired: stats.get(r.id)?.n ?? 0,
        last_fired: stats.get(r.id)?.last ?? null,
      })),
      // The catalogue drives the rule builder, so the UI can never offer a
      // trigger or action the engine does not implement.
      catalogue: {
        triggers: Object.entries(TRIGGERS).map(([type, t]) => ({
          type, label: t.label, entity: t.entity, params: t.params,
        })),
        actions: Object.entries(ACTIONS).map(([type, a]) => ({ type, label: a.label, fields: a.fields })),
      },
      messaging: { driver: driverName(env), drivers: DRIVERS },
    }, ctxo);
  }

  if (id === 'run' && method === 'POST') {
    const url = new URL(request.url);
    return json(await runAutomations(env, { dryRun: url.searchParams.has('dry') }), ctxo);
  }

  if (!id && method === 'POST') {
    const body = await readJson(request);
    const rule = {
      name: String(body.name || '').trim(),
      trigger_type: body.trigger_type,
      trigger_config: body.trigger_config || {},
      conditions: body.conditions || [],
      actions: body.actions || [],
    };
    const errors = validateAutomation(rule);
    if (errors.length) return fail(400, errors[0], { errors }, ctxo);

    const autoId = newId('auto');
    await D1.prepare(
      `INSERT INTO automations (id, name, enabled, trigger_type, trigger_config, conditions, actions)
       VALUES (?1,?2,?3,?4,?5,?6,?7)`,
    ).bind(autoId, rule.name, body.enabled === false ? 0 : 1, rule.trigger_type,
      JSON.stringify(rule.trigger_config), JSON.stringify(rule.conditions),
      JSON.stringify(rule.actions)).run();
    return json({ id: autoId }, { ...ctxo, status: 201 });
  }

  if (id && method === 'PATCH') {
    const body = await readJson(request);
    const existing = await D1.prepare('SELECT * FROM automations WHERE id = ?1').bind(id).first();
    if (!existing) return fail(404, 'Automation not found', {}, ctxo);

    const merged = {
      name: body.name ?? existing.name,
      trigger_type: body.trigger_type ?? existing.trigger_type,
      trigger_config: body.trigger_config ?? safeJson(existing.trigger_config, {}),
      conditions: body.conditions ?? safeJson(existing.conditions, []),
      actions: body.actions ?? safeJson(existing.actions, []),
    };
    const errors = validateAutomation(merged);
    if (errors.length) return fail(400, errors[0], { errors }, ctxo);

    await D1.prepare(
      `UPDATE automations SET name = ?2, enabled = ?3, trigger_type = ?4,
              trigger_config = ?5, conditions = ?6, actions = ?7
        WHERE id = ?1`,
    ).bind(id, merged.name, body.enabled === undefined ? existing.enabled : (body.enabled ? 1 : 0),
      merged.trigger_type, JSON.stringify(merged.trigger_config),
      JSON.stringify(merged.conditions), JSON.stringify(merged.actions)).run();
    return json({ updated: id }, ctxo);
  }

  if (id && method === 'DELETE') {
    await D1.prepare('DELETE FROM automations WHERE id = ?1').bind(id).run();
    return json({ deleted: id }, ctxo);
  }

  return fail(404, 'Not found', {}, ctxo);
}

function safeJson(text, fallback) {
  try {
    const v = typeof text === 'string' ? JSON.parse(text) : text;
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

/* ---------------------------------------------- Phase 2: owner dashboard */

async function dashboardReport(env, ctxo) {
  const d = await db.dashboardData(env.DB);
  const now = today();

  // Task state is computed once and reused, so the dashboard's idea of "late"
  // cannot drift from the job screen's.
  const tasksByJob = new Map();
  for (const [jobId, rows] of d.rawTasksByJob) {
    tasksByJob.set(jobId, rows.map((t) => taskState(t, now)));
  }

  const active = d.jobs.filter((j) => j.status !== 'complete');
  const risks = atRiskJobs(d.jobs, {
    crewByJob: d.crewByJob,
    costsByJob: d.costsByJob,
    tasksByJob,
    logsByJob: d.logsByJob,
  }, now);
  const riskIds = new Set(risks.map((r) => r.job_id));

  const cash = summariseInvoices(d.invoices, now);
  const invoicedJobIds = new Set(d.invoices.filter((i) => i.job_id).map((i) => i.job_id));
  const forecast = cashForecast(d.invoices, d.jobs, invoicedJobIds, now);

  const board = reliabilityBoard(d.people, d.tasksByPerson, now);
  const attention = ownerAttention(d.allTasks, d.allLogs, now);

  return json({
    headline: {
      outstanding: cash.outstanding,
      overdue_amount: cash.overdue_amount,
      overdue_count: cash.overdue_count,
      cash_next_30: forecast.next_30,
      active_jobs: active.length,
      at_risk_jobs: risks.length,
      on_track_jobs: active.length - risks.length,
    },
    jobs: active
      .map((j) => ({
        id: j.id,
        client_name: j.client_name,
        site_address: j.site_address,
        job_type: j.job_type,
        status: j.status,
        target_end: j.target_end,
        percent: jobProgress(j, tasksByJob.get(j.id) ?? [], d.stepsByJob.get(j.id) ?? []),
        at_risk: riskIds.has(j.id),
        crew: (d.crewByJob.get(j.id) ?? []).map((c) => c.name),
      }))
      .sort((a, b) => Number(b.at_risk) - Number(a.at_risk) || a.percent - b.percent),
    at_risk: risks,
    cash: {
      outstanding: cash.outstanding,
      overdue_amount: cash.overdue_amount,
      aging: cash.aging,
      needs_chasing: cash.needs_chasing.slice(0, 5),
      forecast,
    },
    margin: marginHealth(d.jobs, d.costsByJob),
    // "Needs your decision" — the same attention feed as Phase 1, so there is
    // one definition of what is the owner's problem.
    decisions: {
      escalated: attention.escalated.slice(0, 8),
      unassigned: attention.unassigned.slice(0, 8),
      awaiting_photo: attention.awaiting_photo.slice(0, 8),
      unread_issues: attention.unread_issues.slice(0, 8),
    },
    reliability: {
      board,
      concerns: reliabilityConcerns(board),
      measured: MEASURED,
      not_measured: NOT_MEASURED,
    },
  }, ctxo);
}

/* ------------------------------------------------- Phase 0: team & SOPs */

async function peopleRoutes(id, action, request, env, ctxo) {
  const D1 = env.DB;
  const method = request.method;

  // Mint or rotate a crew link. Rotating is how access is revoked, so it is a
  // deliberate action rather than something that happens on every edit.
  if (id && action === 'link' && method === 'POST') {
    const token = randomToken(26);
    const res = await D1.prepare('UPDATE people SET access_token = ?2 WHERE id = ?1')
      .bind(id, token).run();
    if (!res.meta?.changes) return fail(404, 'Person not found', {}, ctxo);
    return json({
      token,
      url: `${env.PUBLIC_APP_URL || ''}/crew.html?t=${token}`,
    }, ctxo);
  }

  if (!id && method === 'GET') {
    const url = new URL(request.url);
    return json({ people: await db.listPeople(D1, { includeInactive: url.searchParams.has('all') }) }, ctxo);
  }

  if (!id && method === 'POST') {
    const body = await readJson(request);
    const name = String(body.name || '').trim();
    if (!name) return fail(400, 'A name is required.', {}, ctxo);
    const personId = newId('per');
    await D1.prepare(
      `INSERT INTO people (id, name, kind, trade, role, phone, email, day_rate, notes)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
    ).bind(
      personId, name,
      body.kind === 'subcontractor' ? 'subcontractor' : 'staff',
      body.trade || null, body.role || null, body.phone || null, body.email || null,
      body.day_rate == null || body.day_rate === '' ? null : Number(body.day_rate),
      body.notes || null,
    ).run();
    return json({ people: await db.listPeople(D1) }, { ...ctxo, status: 201 });
  }

  if (id && method === 'PATCH') {
    const body = await readJson(request);
    const fields = ['name', 'kind', 'trade', 'role', 'phone', 'email', 'day_rate', 'notes', 'active'];
    const sets = [];
    const binds = [id];
    for (const f of fields) {
      if (body[f] === undefined) continue;
      binds.push(f === 'active' ? (body[f] ? 1 : 0) : body[f]);
      sets.push(`${f} = ?${binds.length}`);
    }
    if (!sets.length) return fail(400, 'No updatable fields supplied', {}, ctxo);
    await D1.prepare(`UPDATE people SET ${sets.join(', ')} WHERE id = ?1`).bind(...binds).run();
    return json({ people: await db.listPeople(D1) }, ctxo);
  }

  if (id && method === 'DELETE') {
    // Deactivated, not deleted: a person who worked a job stays attached to its
    // history, so removing the row would tear a hole in past assignments.
    await D1.prepare('UPDATE people SET active = 0 WHERE id = ?1').bind(id).run();
    return json({ people: await db.listPeople(D1) }, ctxo);
  }

  return fail(404, 'Not found', {}, ctxo);
}

async function sopRoutes(id, request, env, ctxo) {
  const D1 = env.DB;
  if (!id && request.method === 'GET') return json({ sops: await db.listSops(D1) }, ctxo);

  if (!id && request.method === 'POST') {
    const body = await readJson(request);
    const title = String(body.title || '').trim();
    const steps = Array.isArray(body.steps) ? body.steps : [];
    if (!title) return fail(400, 'A title is required.', {}, ctxo);
    if (!steps.length) return fail(400, 'An SOP needs at least one step.', {}, ctxo);

    const clean = steps
      .map((s) => ({
        text: String(typeof s === 'string' ? s : s.text || '').trim(),
        needs_photo: typeof s === 'object' && !!s.needs_photo,
      }))
      .filter((s) => s.text);
    if (!clean.length) return fail(400, 'Every step was empty.', {}, ctxo);

    const sopId = newId('sop');
    await D1.prepare(
      'INSERT INTO sops (id, title, category, job_type, role, steps) VALUES (?1,?2,?3,?4,?5,?6)',
    ).bind(sopId, title, body.category || 'general', body.job_type || null, body.role || null,
      JSON.stringify(clean)).run();
    return json({ sops: await db.listSops(D1) }, { ...ctxo, status: 201 });
  }

  return fail(404, 'Not found', {}, ctxo);
}

/* ------------------------------------------------------ Phase 0: invoices */

async function invoiceRoutes(id, request, env, ctxo) {
  const D1 = env.DB;
  const method = request.method;

  if (!id && method === 'GET') {
    const rows = await db.listInvoices(D1);
    return json({ invoices: rows.map((i) => invoiceState(i, today())) }, ctxo);
  }

  if (!id && method === 'POST') {
    const body = await readJson(request);
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount < 0) return fail(400, 'A valid amount is required.', {}, ctxo);

    let clientName = String(body.client_name || '').trim();
    let jobId = body.job_id || null;
    if (jobId) {
      const job = await db.getJob(D1, jobId);
      if (!job) return fail(400, 'That job does not exist.', {}, ctxo);
      clientName = clientName || job.client_name;
    }
    if (!clientName) return fail(400, 'A client name is required.', {}, ctxo);

    const number = String(body.number || '').trim() || nextInvoiceNumber(await db.invoiceNumbers(D1));
    const issued = body.issued_on || today();
    // 14-day terms unless told otherwise, matching the seeded template terms.
    const due = body.due_on
      || new Date(Date.parse(`${issued}T00:00:00Z`) + 14 * 864e5).toISOString().slice(0, 10);

    const invId = newId('inv');
    await D1.prepare(
      `INSERT INTO invoices (id, job_id, number, client_name, amount, status, issued_on, due_on, notes)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
    ).bind(invId, jobId, number, clientName, money(amount),
      body.status === 'sent' ? 'sent' : 'draft', issued, due, body.notes || null).run();

    const rows = await db.listInvoices(D1);
    return json({ invoices: rows.map((i) => invoiceState(i, today())) }, { ...ctxo, status: 201 });
  }

  if (id && method === 'PATCH') {
    const body = await readJson(request);
    const existing = await D1.prepare('SELECT * FROM invoices WHERE id = ?1').bind(id).first();
    if (!existing) return fail(404, 'Invoice not found', {}, ctxo);

    const sets = [];
    const binds = [id];
    const push = (col, val) => { binds.push(val); sets.push(`${col} = ?${binds.length}`); };

    if (body.status) {
      if (!['draft', 'sent', 'paid', 'void'].includes(body.status)) {
        return fail(400, 'Unknown invoice status.', {}, ctxo);
      }
      push('status', body.status);
      if (body.status === 'sent' && !existing.issued_on) push('issued_on', today());
      // Marking it paid settles the balance and stamps the date, so the two can
      // never disagree with each other.
      if (body.status === 'paid') {
        push('amount_paid', money(existing.amount));
        push('paid_on', body.paid_on || today());
      }
    }

    if (body.amount_paid !== undefined) {
      const paid = Number(body.amount_paid);
      if (!Number.isFinite(paid) || paid < 0) return fail(400, 'Payment must be zero or more.', {}, ctxo);
      push('amount_paid', money(paid));
      if (paid >= existing.amount) {
        push('status', 'paid');
        push('paid_on', body.paid_on || today());
      }
    }

    for (const f of ['amount', 'due_on', 'issued_on', 'notes', 'client_name']) {
      if (body[f] !== undefined) push(f, f === 'amount' ? money(Number(body[f])) : body[f]);
    }

    if (!sets.length) return fail(400, 'No updatable fields supplied', {}, ctxo);
    await D1.prepare(`UPDATE invoices SET ${sets.join(', ')} WHERE id = ?1`).bind(...binds).run();

    const rows = await db.listInvoices(D1);
    return json({ invoices: rows.map((i) => invoiceState(i, today())) }, ctxo);
  }

  return fail(404, 'Not found', {}, ctxo);
}

/* --------------------------------------------------- jobs & cost capture */

async function jobRoutes(id, action, subId, request, env, ctxo) {
  const D1 = env.DB;
  const method = request.method;

  if (!id && method === 'GET') return json({ jobs: await db.listJobs(D1) }, ctxo);

  // A job created by hand, for work that did not come through a quote here.
  if (!id && method === 'POST') {
    const body = await readJson(request);
    const client = String(body.client_name || '').trim();
    const jobType = String(body.job_type || '').trim();
    if (!client) return fail(400, 'A client name is required.', {}, ctxo);
    if (!jobType) return fail(400, 'A job type is required.', {}, ctxo);

    const jobId = newId('job');
    await D1.prepare(
      `INSERT INTO jobs (id, quote_id, client_name, client_phone, client_email, site_address,
                         job_type, status, budget_baseline, cost_baseline,
                         target_start, target_end, notes)
       VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
    ).bind(
      jobId, client, body.client_phone || null, body.client_email || null,
      body.site_address || null, jobType,
      ['booked', 'in_progress', 'on_hold'].includes(body.status) ? body.status : 'booked',
      money(Number(body.budget_baseline) || 0),
      money(Number(body.cost_baseline) || 0),
      body.target_start || null, body.target_end || null, body.notes || null,
    ).run();

    return json({ job: await db.getJob(D1, jobId) }, { ...ctxo, status: 201 });
  }

  if (!id) return fail(404, 'Not found', {}, ctxo);

  const job = await db.getJob(D1, id);
  if (!job) return fail(404, 'Job not found', {}, ctxo);

  if (!action && method === 'GET') {
    const [costs, crew, sops, tasks, logs, checkins] = await Promise.all([
      db.getJobCosts(D1, id),
      db.getAssignments(D1, id),
      db.listJobSops(D1, id),
      db.listTasks(D1, id),
      db.listSiteLogs(D1, id),
      db.listCheckins(D1, id),
    ]);
    return json({
      job,
      costs,
      variance: jobVariance(job, costs),
      crew,
      sops: sops.map((s) => ({ ...s, progress: sopProgress(s.steps) })),
      tasks: tasks.map((t) => taskState(t, today())),
      task_progress: taskProgress(tasks, today()),
      logs,
      checkins,
      overdue_checkins: overdueCheckins(checkins, today()),
    }, ctxo);
  }

  /* ----------------------------------------------------------- tasks */

  if (action === 'tasks' && method === 'POST') {
    const body = await readJson(request);
    const title = String(body.title || '').trim();
    if (!title) return fail(400, 'A task needs a title.', {}, ctxo);
    await D1.prepare(
      `INSERT INTO tasks (id, job_id, person_id, title, detail, due_on, needs_photo, grace_days)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
    ).bind(
      newId('task'), id, body.person_id || null, title, body.detail || null,
      body.due_on || null, body.needs_photo ? 1 : 0,
      Number.isFinite(Number(body.grace_days)) ? Number(body.grace_days) : 2,
    ).run();
    return json(await tasksPayload(D1, id), { ...ctxo, status: 201 });
  }

  if (action === 'tasks' && method === 'PATCH' && subId) {
    const body = await readJson(request);
    const sets = [];
    const binds = [subId, id];
    const push = (col, val) => { binds.push(val); sets.push(`${col} = ?${binds.length}`); };

    if (body.status) {
      if (!['open', 'done', 'cancelled'].includes(body.status)) {
        return fail(400, 'Unknown task status.', {}, ctxo);
      }
      push('status', body.status);
      push('completed_at', body.status === 'done' ? new Date().toISOString() : null);
      push('completed_by', body.status === 'done' ? (body.completed_by || null) : null);
    }
    for (const f of ['person_id', 'title', 'detail', 'due_on', 'photo_id']) {
      if (body[f] !== undefined) push(f, body[f]);
    }
    if (body.needs_photo !== undefined) push('needs_photo', body.needs_photo ? 1 : 0);
    if (body.grace_days !== undefined) push('grace_days', Number(body.grace_days) || 0);
    if (!sets.length) return fail(400, 'No updatable fields supplied', {}, ctxo);

    await D1.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?1 AND job_id = ?2`)
      .bind(...binds).run();
    return json(await tasksPayload(D1, id), ctxo);
  }

  /* -------------------------------------------------------- site log */

  if (action === 'log' && method === 'POST') {
    const body = await readJson(request);
    const text = String(body.body || '').trim();
    if (!text) return fail(400, 'Say what happened.', {}, ctxo);
    await D1.prepare(
      'INSERT INTO site_logs (id, job_id, person_id, kind, body, photo_id) VALUES (?1,?2,?3,?4,?5,?6)',
    ).bind(
      newId('log'), id, body.person_id || null,
      ['progress', 'issue', 'delay', 'delivery', 'safety'].includes(body.kind) ? body.kind : 'progress',
      text.slice(0, 4000), body.photo_id || null,
    ).run();
    return json({ logs: await db.listSiteLogs(D1, id) }, { ...ctxo, status: 201 });
  }

  // Acknowledging is what takes an issue off the owner's list — an explicit
  // "I've seen this", not a side effect of loading a page.
  if (action === 'log' && method === 'PATCH' && subId) {
    await D1.prepare("UPDATE site_logs SET acknowledged_at = datetime('now') WHERE id = ?1 AND job_id = ?2")
      .bind(subId, id).run();
    return json({ logs: await db.listSiteLogs(D1, id) }, ctxo);
  }

  /* ------------------------------------------------------- check-ins */

  if (action === 'checkins' && method === 'POST' && !subId) {
    const existing = await db.listCheckins(D1, id);
    if (existing.length) return fail(409, 'This job already has a check-in schedule.', {}, ctxo);
    const planned = plannedCheckins(job);
    await D1.batch(planned.map((c) =>
      D1.prepare('INSERT INTO client_checkins (id, job_id, milestone, due_on) VALUES (?1,?2,?3,?4)')
        .bind(newId('chk'), id, c.milestone, c.due_on)));
    const checkins = await db.listCheckins(D1, id);
    return json({ checkins, overdue_checkins: overdueCheckins(checkins, today()) }, { ...ctxo, status: 201 });
  }

  if (action === 'checkins' && method === 'PATCH' && subId) {
    const body = await readJson(request);
    if (!['due', 'done', 'skipped'].includes(body.status)) {
      return fail(400, 'status must be due, done or skipped', {}, ctxo);
    }
    await D1.prepare(
      `UPDATE client_checkins
          SET status = ?3, note = COALESCE(?4, note),
              done_at = CASE WHEN ?3 = 'done' THEN datetime('now') ELSE NULL END
        WHERE id = ?1 AND job_id = ?2`,
    ).bind(subId, id, body.status, body.note ?? null).run();
    const checkins = await db.listCheckins(D1, id);
    return json({ checkins, overdue_checkins: overdueCheckins(checkins, today()) }, ctxo);
  }

  /* ------------------------------------------------------ job photos */

  if (action === 'photos' && method === 'POST') {
    const body = await readJson(request);
    const stored = await storeJobPhoto(D1, id, body);
    if (stored.error) return fail(stored.status, stored.error, {}, ctxo);
    return json({ photo_id: stored.id }, { ...ctxo, status: 201 });
  }

  if (action === 'photos' && method === 'GET' && subId) {
    const photo = await db.getJobPhotoBytes(D1, subId);
    if (!photo) return fail(404, 'Photo not found', {}, ctxo);
    return new Response(photo.bytes, {
      headers: {
        'Content-Type': photo.mime,
        'Cache-Control': 'private, max-age=3600',
        ...corsHeaders(env, request),
      },
    });
  }

  /* ------------------------------------------------------------ crew */

  if (action === 'crew' && method === 'POST') {
    const body = await readJson(request);
    if (!body.person_id) return fail(400, 'person_id is required', {}, ctxo);
    try {
      await D1.prepare(
        'INSERT INTO job_assignments (id, job_id, person_id, role_on_job) VALUES (?1,?2,?3,?4)',
      ).bind(newId('asg'), id, body.person_id, body.role_on_job || null).run();
    } catch (err) {
      // The UNIQUE(job_id, person_id) index makes assigning twice a no-op rather
      // than an error the owner has to think about.
      if (!/UNIQUE/i.test(String(err))) throw err;
    }
    return json({ crew: await db.getAssignments(D1, id) }, ctxo);
  }

  if (action === 'crew' && method === 'DELETE' && subId) {
    await D1.prepare('DELETE FROM job_assignments WHERE job_id = ?1 AND person_id = ?2')
      .bind(id, subId).run();
    return json({ crew: await db.getAssignments(D1, id) }, ctxo);
  }

  /* ------------------------------------------------------------ SOPs */

  if (action === 'sops' && method === 'POST') {
    const body = await readJson(request);
    const sop = await db.getSop(D1, body.sop_id);
    if (!sop) return fail(400, 'That SOP does not exist.', {}, ctxo);

    // Steps are copied, not referenced: editing the library later must not
    // rewrite a checklist somebody has already signed off.
    const steps = sop.steps.map((s) => ({
      text: s.text, needs_photo: !!s.needs_photo, done: false, done_at: null, photo_id: null,
    }));
    await D1.prepare(
      'INSERT INTO job_sops (id, job_id, sop_id, title, sop_version, steps) VALUES (?1,?2,?3,?4,?5,?6)',
    ).bind(newId('jsop'), id, sop.id, sop.title, sop.version, JSON.stringify(steps)).run();

    const sops = await db.listJobSops(D1, id);
    return json({ sops: sops.map((s) => ({ ...s, progress: sopProgress(s.steps) })) }, { ...ctxo, status: 201 });
  }

  if (action === 'sops' && method === 'PATCH' && subId) {
    const body = await readJson(request);
    const idx = Number(body.step);
    const row = await D1.prepare('SELECT * FROM job_sops WHERE id = ?1 AND job_id = ?2')
      .bind(subId, id).first();
    if (!row) return fail(404, 'Checklist not found', {}, ctxo);

    const steps = JSON.parse(row.steps);
    if (!Number.isInteger(idx) || idx < 0 || idx >= steps.length) {
      return fail(400, 'step must be a valid step index', {}, ctxo);
    }
    steps[idx] = {
      ...steps[idx],
      done: !!body.done,
      done_at: body.done ? new Date().toISOString() : null,
      done_by: body.done ? (body.done_by || null) : null,
      photo_id: body.photo_id ?? steps[idx].photo_id ?? null,
    };
    await D1.prepare('UPDATE job_sops SET steps = ?2 WHERE id = ?1')
      .bind(subId, JSON.stringify(steps)).run();

    const sops = await db.listJobSops(D1, id);
    return json({ sops: sops.map((s) => ({ ...s, progress: sopProgress(s.steps) })) }, ctxo);
  }

  if (action === 'sops' && method === 'DELETE' && subId) {
    await D1.prepare('DELETE FROM job_sops WHERE id = ?1 AND job_id = ?2').bind(subId, id).run();
    const sops = await db.listJobSops(D1, id);
    return json({ sops: sops.map((s) => ({ ...s, progress: sopProgress(s.steps) })) }, ctxo);
  }

  if (!action && method === 'PATCH') {
    const body = await readJson(request);

    if (body.status !== undefined) {
      if (!['booked', 'in_progress', 'complete', 'on_hold'].includes(body.status)) {
        return fail(400, 'status must be booked, in_progress, on_hold or complete', {}, ctxo);
      }
      // Stamp the completion date on the transition, and clear it if the job is
      // reopened — otherwise a reopened job keeps a date that says it finished.
      await D1.prepare(
        `UPDATE jobs
            SET status = ?2,
                completed_at = CASE WHEN ?2 = 'complete' THEN COALESCE(completed_at, date('now')) ELSE NULL END
          WHERE id = ?1`,
      ).bind(id, body.status).run();
    }

    const sets = [];
    const binds = [id];
    for (const f of ['client_name', 'client_phone', 'client_email', 'site_address', 'target_start', 'target_end', 'notes']) {
      if (body[f] === undefined) continue;
      binds.push(body[f]);
      sets.push(`${f} = ?${binds.length}`);
    }
    if (sets.length) {
      await D1.prepare(`UPDATE jobs SET ${sets.join(', ')} WHERE id = ?1`).bind(...binds).run();
    }

    const updated = await db.getJob(D1, id);
    const costs = await db.getJobCosts(D1, id);
    return json({ job: updated, costs, variance: jobVariance(updated, costs) }, ctxo);
  }

  if (action === 'costs' && method === 'POST') {
    const body = await readJson(request);
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      return fail(400, 'amount must be a number of 0 or more', {}, ctxo);
    }
    if (!String(body.description || '').trim()) {
      return fail(400, 'description is required', {}, ctxo);
    }
    await D1.prepare(
      `INSERT INTO job_costs (id, job_id, line_code, description, category, quantity, unit, amount, incurred_on, note)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,COALESCE(?9, date('now')),?10)`,
    ).bind(
      newId('jc'),
      id,
      body.line_code || null,
      String(body.description).trim(),
      ['labour', 'material', 'plant', 'other'].includes(body.category) ? body.category : 'other',
      body.quantity == null ? null : Number(body.quantity),
      body.unit || null,
      money(amount),
      body.incurred_on || null,
      body.note || null,
    ).run();

    const costs = await db.getJobCosts(D1, id);
    return json({ job, costs, variance: jobVariance(job, costs) }, { ...ctxo, status: 201 });
  }

  if (action === 'costs' && method === 'DELETE' && subId) {
    await D1.prepare('DELETE FROM job_costs WHERE id = ?1 AND job_id = ?2').bind(subId, id).run();
    const costs = await db.getJobCosts(D1, id);
    return json({ job, costs, variance: jobVariance(job, costs) }, ctxo);
  }

  return fail(404, 'Not found', {}, ctxo);
}

/**
 * Quote-vs-actual variance (Phase D).
 *
 * The report the owner reads, and the same data the draft assistant is briefed
 * with — one source, so the numbers on screen and the numbers steering the AI
 * cannot disagree.
 */
async function varianceReport(env, ctxo) {
  const D1 = env.DB;
  const [rows, quotedLines, actualCosts] = await Promise.all([
    db.completedJobsWithCosts(D1),
    db.quotedLinesForCompletedJobs(D1),
    db.allActualCosts(D1),
  ]);

  // A completed job with nothing booked against it would read as 100% under
  // budget and quietly poison every average on the page.
  const measured = rows.filter(({ costs }) => costs.length > 0);
  const variances = measured.map(({ job, costs }) => jobVariance(job, costs));
  const bias = lineCodeBias(quotedLines, actualCosts);

  return json(
    {
      summary: summarise(variances),
      jobs: variances.sort((a, b) => Math.abs(b.cost_variance) - Math.abs(a.cost_variance)),
      by_job_type: byJobType(variances),
      line_code_bias: bias,
      assistant_briefing: biasBriefing(bias),
      unmeasured_jobs: rows.length - measured.length,
    },
    ctxo,
  );
}

/* ------------------------------------------------------------------ photos */

async function addPhoto(row, request, env, ctxo) {
  const body = await readJson(request);
  const mime = String(body.mime || '');
  if (!/^image\/(jpeg|png|webp)$/.test(mime)) {
    return fail(400, 'Photo must be a JPEG, PNG or WebP.', {}, ctxo);
  }

  let bytes;
  try {
    const b64 = String(body.data_base64 || '').replace(/^data:[^,]+,/, '');
    const bin = atob(b64);
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return fail(400, 'Photo data could not be decoded.', {}, ctxo);
  }
  if (!bytes.length) return fail(400, 'Photo is empty.', {}, ctxo);
  if (bytes.length > MAX_PHOTO_BYTES) {
    return fail(413, `Photo is ${Math.round(bytes.length / 1024)}KB; the limit is ${MAX_PHOTO_BYTES / 1024}KB.`, {}, ctxo);
  }

  const existing = await db.listPhotos(env.DB, row.id);
  const id = newId('ph');
  await env.DB.prepare(
    `INSERT INTO quote_photos (id, quote_id, position, mime, bytes, width, height, caption, show_client)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)`,
  ).bind(
    id,
    row.id,
    existing.length,
    mime,
    bytes,
    body.width ? Number(body.width) : null,
    body.height ? Number(body.height) : null,
    body.caption || null,
    body.show_client === false ? 0 : 1,
  ).run();

  return json({ photos: await db.listPhotos(env.DB, row.id), id }, { ...ctxo, status: 201 });
}

async function tasksPayload(D1, jobId) {
  const tasks = await db.listTasks(D1, jobId);
  return {
    tasks: tasks.map((t) => taskState(t, today())),
    task_progress: taskProgress(tasks, today()),
  };
}

/** Decode, size-check and store a job photo. Shared by the owner and crew paths. */
async function storeJobPhoto(D1, jobId, body, uploadedBy = null) {
  const mime = String(body.mime || '');
  if (!/^image\/(jpeg|png|webp)$/.test(mime)) {
    return { error: 'Photo must be a JPEG, PNG or WebP.', status: 400 };
  }
  let bytes;
  try {
    const b64 = String(body.data_base64 || '').replace(/^data:[^,]+,/, '');
    const bin = atob(b64);
    bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return { error: 'Photo data could not be decoded.', status: 400 };
  }
  if (!bytes.length) return { error: 'Photo is empty.', status: 400 };
  if (bytes.length > MAX_JOB_PHOTO_BYTES) {
    return { error: `Photo is ${Math.round(bytes.length / 1024)}KB; the limit is ${MAX_JOB_PHOTO_BYTES / 1024}KB.`, status: 413 };
  }

  const photoId = newId('jph');
  await D1.prepare(
    `INSERT INTO job_photos (id, job_id, uploaded_by, mime, bytes, width, height, caption)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`,
  ).bind(
    photoId, jobId, uploadedBy, mime, bytes,
    body.width ? Number(body.width) : null,
    body.height ? Number(body.height) : null,
    body.caption || null,
  ).run();
  return { id: photoId };
}

/* ------------------------------------------------------------------- crew */

/**
 * The crew view.
 *
 * Reached by an unguessable per-person link — no account, no password, nothing
 * to forget on a roof in the rain. The token identifies the person, and every
 * query is scoped to what they are actually assigned to, so it cannot be used to
 * browse the business.
 */
async function crewRoutes(path, request, env, ctxo) {
  const D1 = env.DB;
  const seg = path.split('/').filter(Boolean);       // ['crew', token, action?, id?]
  const [, token, action, actionId] = seg;
  if (!token) return fail(404, 'Not found', {}, ctxo);

  const person = await db.personByToken(D1, token);
  if (!person) return fail(404, 'This link is not valid.', {}, ctxo);

  /** Is this person actually on that job? Everything they write is gated on it. */
  const onJob = async (jobId) => {
    const row = await D1.prepare(
      'SELECT 1 FROM job_assignments WHERE job_id = ?1 AND person_id = ?2',
    ).bind(jobId, person.id).first();
    return !!row;
  };

  if (!action && request.method === 'GET') {
    const [jobs, tasks, library] = await Promise.all([
      db.jobsForPerson(D1, person.id),
      db.tasksForPerson(D1, person.id),
      db.listSops(D1),
    ]);

    // SOPs are filtered per job by this person's role — they see what applies to
    // them, not the whole manual.
    const withSops = await Promise.all(jobs.map(async (j) => ({
      ...j,
      sops: visibleSops(library, { role: person.role, jobType: j.job_type }),
      checklists: (await db.listJobSops(D1, j.id)).map((s) => ({ ...s, progress: sopProgress(s.steps) })),
      recent_log: (await db.listSiteLogs(D1, j.id, 5)),
    })));

    return json({
      person: { id: person.id, name: person.name, role: person.role, kind: person.kind },
      jobs: withSops,
      tasks: tasks.map((t) => taskState(t, today())),
    }, ctxo);
  }

  if (action === 'photo' && request.method === 'POST') {
    const body = await readJson(request);
    if (!body.job_id || !(await onJob(body.job_id))) {
      return fail(403, 'You are not on that job.', {}, ctxo);
    }
    const stored = await storeJobPhoto(D1, body.job_id, body, person.id);
    if (stored.error) return fail(stored.status, stored.error, {}, ctxo);
    return json({ photo_id: stored.id }, { ...ctxo, status: 201 });
  }

  if (action === 'tasks' && request.method === 'POST' && actionId) {
    const body = await readJson(request);
    const task = await D1.prepare('SELECT * FROM tasks WHERE id = ?1 AND person_id = ?2')
      .bind(actionId, person.id).first();
    if (!task) return fail(404, 'That task is not yours.', {}, ctxo);

    if (task.needs_photo && body.done && !body.photo_id) {
      // Refused rather than accepted-and-flagged: on the crew side the point is
      // to ask for the photo while the person is still standing in front of it.
      return fail(422, 'This one needs a photo before it can be ticked off.', {}, ctxo);
    }

    await D1.prepare(
      `UPDATE tasks
          SET status = ?2,
              photo_id = COALESCE(?3, photo_id),
              completed_at = CASE WHEN ?2 = 'done' THEN datetime('now') ELSE NULL END,
              completed_by = CASE WHEN ?2 = 'done' THEN ?4 ELSE NULL END
        WHERE id = ?1`,
    ).bind(actionId, body.done ? 'done' : 'open', body.photo_id || null, person.id).run();

    return json({ tasks: (await db.tasksForPerson(D1, person.id)).map((t) => taskState(t, today())) }, ctxo);
  }

  if (action === 'log' && request.method === 'POST') {
    const body = await readJson(request);
    if (!body.job_id || !(await onJob(body.job_id))) {
      return fail(403, 'You are not on that job.', {}, ctxo);
    }
    const text = String(body.body || '').trim();
    if (!text) return fail(400, 'Say what happened.', {}, ctxo);

    await D1.prepare(
      'INSERT INTO site_logs (id, job_id, person_id, kind, body, photo_id) VALUES (?1,?2,?3,?4,?5,?6)',
    ).bind(
      newId('log'), body.job_id, person.id,
      ['progress', 'issue', 'delay', 'delivery', 'safety'].includes(body.kind) ? body.kind : 'progress',
      text.slice(0, 4000), body.photo_id || null,
    ).run();

    return json({ logs: await db.listSiteLogs(D1, body.job_id, 5) }, { ...ctxo, status: 201 });
  }

  if (action === 'checklists' && request.method === 'PATCH' && actionId) {
    const body = await readJson(request);
    const row = await D1.prepare('SELECT * FROM job_sops WHERE id = ?1').bind(actionId).first();
    if (!row || !(await onJob(row.job_id))) return fail(404, 'Checklist not found.', {}, ctxo);

    const steps = JSON.parse(row.steps);
    const idx = Number(body.step);
    if (!Number.isInteger(idx) || idx < 0 || idx >= steps.length) {
      return fail(400, 'step must be a valid step index', {}, ctxo);
    }
    if (steps[idx].needs_photo && body.done && !body.photo_id && !steps[idx].photo_id) {
      return fail(422, 'This step needs a photo before it can be ticked off.', {}, ctxo);
    }
    steps[idx] = {
      ...steps[idx],
      done: !!body.done,
      done_at: body.done ? new Date().toISOString() : null,
      done_by: body.done ? person.id : null,
      photo_id: body.photo_id ?? steps[idx].photo_id ?? null,
    };
    await D1.prepare('UPDATE job_sops SET steps = ?2 WHERE id = ?1')
      .bind(actionId, JSON.stringify(steps)).run();

    const sops = await db.listJobSops(D1, row.job_id);
    return json({ checklists: sops.map((s) => ({ ...s, progress: sopProgress(s.steps) })) }, ctxo);
  }

  // Photo bytes, scoped to a job this person is on.
  if (action === 'photo' && request.method === 'GET' && actionId) {
    const photo = await db.getJobPhotoBytes(D1, actionId);
    if (!photo) return fail(404, 'Not found', {}, ctxo);
    return new Response(photo.bytes, {
      headers: {
        'Content-Type': photo.mime,
        'Cache-Control': 'private, max-age=3600',
        ...corsHeaders(env, request),
      },
    });
  }

  return fail(404, 'Not found', {}, ctxo);
}

/* ----------------------------------------------------------------- client */

/**
 * What the client is allowed to see. Built by construction rather than by
 * deletion: we name the fields that go out, so a new internal column (cost,
 * margin, an AI note to the owner) can never leak by being forgotten here.
 */
function clientView(quote, lines, totals, photos = []) {
  const pick = (l) => ({
    id: l.id,
    description: l.description,
    blurb: l.blurb || null,
    quantity: l.quantity,
    unit: l.unit,
    price: l.line_price,
    selected: !!l.selected,
  });
  const base = lines.filter((l) => l.kind !== 'extra');
  return {
    client_name: quote.client_name,
    site_address: quote.site_address,
    job_type: quote.job_type,
    // Deliberately NOT quote.description — that is the owner's dictated brief
    // ("right, this is the Elm Street job…"), which is working notes, not copy
    // to put in front of a paying client.
    summary: quote.client_summary || '',
    status: quote.status,
    valid_until: quote.valid_until,
    accepted_at: quote.accepted_at,
    scope: base.map((l) => ({ description: l.description, quantity: l.quantity, unit: l.unit })),
    // Ids only; the bytes are fetched from the token-scoped photo route.
    photos: photos.map((p) => ({ id: p.id, caption: p.caption, width: p.width, height: p.height })),
    base_price: totals.subtotal_price,
    extras: lines.filter((l) => l.kind === 'extra').map(pick),
    total: totals.total_with_extras,
  };
}

async function clientRoutes(path, request, env, ctxo) {
  const D1 = env.DB;
  const seg = path.split('/').filter(Boolean); // ['q', token, action?]
  const token = seg[1];
  const action = seg[2];
  if (!token) return fail(404, 'Not found', {}, ctxo);

  const row = await db.getQuoteRowByToken(D1, token);
  // Same response for a bad token and a draft quote, so the endpoint can't be
  // used to probe which tokens exist.
  if (!row || row.status === 'draft') return fail(404, 'Quote not found', {}, ctxo);

  const expired = row.valid_until && row.valid_until < new Date().toISOString().slice(0, 10);

  if (!action && request.method === 'GET') {
    const [loaded, photos] = await Promise.all([
      db.loadQuote(D1, row),
      db.listPhotos(D1, row.id, { clientOnly: true }),
    ]);
    if (row.status === 'sent') {
      await D1.prepare("UPDATE quotes SET status = 'viewed' WHERE id = ?1").bind(row.id).run();
    }
    await db.logEvent(D1, row.id, 'opened', {});
    return json(
      { quote: { ...clientView(loaded.quote, loaded.lines, loaded.totals, photos), expired } },
      ctxo,
    );
  }

  // Photo bytes, scoped to the quote's own token so a photo id alone is not a
  // handle on someone else's site pictures.
  if (action === 'photo' && seg[3] && request.method === 'GET') {
    const owned = await D1.prepare(
      'SELECT id FROM quote_photos WHERE id = ?1 AND quote_id = ?2 AND show_client = 1',
    ).bind(seg[3], row.id).first();
    if (!owned) return fail(404, 'Not found', {}, ctxo);

    const photo = await db.getPhotoBytes(D1, seg[3]);
    return new Response(photo.bytes, {
      headers: {
        'Content-Type': photo.mime,
        // Immutable: a photo id never points at different bytes.
        'Cache-Control': 'public, max-age=31536000, immutable',
        ...corsHeaders(env, request),
      },
    });
  }

  if (expired || row.status === 'accepted') {
    const verb = expired ? 'expired' : 'already been accepted';
    if (action === 'extras' || action === 'accept') {
      return fail(409, `This quote has ${verb}.`, {}, ctxo);
    }
  }

  if (action === 'extras' && request.method === 'POST') {
    const body = await readJson(request);
    const ids = new Set(Array.isArray(body.selected) ? body.selected : []);
    const lines = await db.getLines(D1, row.id);
    const extras = lines.filter((l) => l.kind === 'extra');
    await D1.batch(
      extras.map((l) =>
        D1.prepare('UPDATE quote_line_items SET selected = ?2 WHERE id = ?1')
          .bind(l.id, ids.has(l.id) ? 1 : 0),
      ),
    );
    await db.logEvent(D1, row.id, 'extra_toggled', { selected: [...ids] });
    const loaded = await db.loadQuote(D1, await db.getQuoteRow(D1, row.id));
    return json({ quote: clientView(loaded.quote, loaded.lines, loaded.totals) }, ctxo);
  }

  if (action === 'accept' && request.method === 'POST') {
    const loaded = await db.loadQuote(D1, row);
    const jobId = newId('job');
    await D1.batch([
      D1.prepare("UPDATE quotes SET status = 'accepted', accepted_at = datetime('now') WHERE id = ?1").bind(row.id),
      D1.prepare(
        `INSERT INTO jobs (id, quote_id, client_name, client_email, site_address, job_type,
                           status, budget_baseline, cost_baseline)
         VALUES (?1,?2,?3,?4,?5,?6,'booked',?7,?8)`,
      ).bind(
        jobId,
        row.id,
        row.client_name,
        // So the client-care automations have somewhere to send to.
        row.client_email,
        row.site_address,
        row.job_type,
        // The accepted total, extras included, becomes the job's budget baseline —
        // this is the number Job Profitability later measures actuals against.
        loaded.totals.total_with_extras,
        money(loaded.totals.subtotal_cost + loaded.totals.extras_cost),
      ),
    ]);
    await db.logEvent(D1, row.id, 'accepted', { job_id: jobId, total: loaded.totals.total_with_extras });
    return json({ accepted: true, job_id: jobId, message: "We'll be in touch to confirm your start date." }, ctxo);
  }

  if (action === 'question' && request.method === 'POST') {
    const body = await readJson(request);
    const message = (body.message || '').trim();
    if (!message) return fail(400, 'Message is required', {}, ctxo);
    // Lands in the owner's Client Care inbox as an event on the quote, rather
    // than a generic email (wireframe §1.2).
    await db.logEvent(D1, row.id, 'question_asked', { message: message.slice(0, 2000) });
    return json({ sent: true }, ctxo);
  }

  return fail(404, 'Not found', {}, ctxo);
}

async function readJson(request) {
  try {
    return (await request.json()) ?? {};
  } catch {
    return {};
  }
}
