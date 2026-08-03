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
import { requestDraft } from './openrouter.js';
import {
  jobVariance, byJobType, lineCodeBias, biasBriefing, summarise,
} from './variance.js';
import * as db from './db.js';

/** Cap on a single uploaded photo, after the browser has downscaled it. */
const MAX_PHOTO_BYTES = 1_000_000;

export default {
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
          { service: 'builderos-auto-quoting', ok: true, ai: !!env.OPENROUTER_API_KEY },
          ctxo,
        );
      }
      if (path.startsWith('/api/')) return await ownerRoutes(path, request, env, ctxo);
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

  if (resource === 'templates' && method === 'GET') {
    return json({ templates: await db.getTemplates(D1) }, ctxo);
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

  const [book, similar, quotedLines, actualCosts] = await Promise.all([
    db.getPriceBook(D1),
    db.similarPastJobs(D1, row.job_type),
    db.quotedLinesForCompletedJobs(D1),
    db.allActualCosts(D1),
  ]);

  // The learning loop: measured drift between what this business quoted and what
  // its jobs actually cost, fed back in as scoping guidance.
  const estimatingHistory = biasBriefing(lineCodeBias(quotedLines, actualCosts));

  const result = await requestDraft(env, {
    description,
    template,
    priceBook: book,
    similarJobs: similar,
    estimatingHistory,
  });
  if (!result.ok) {
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
      // The tap-to-confirm gate: anything the AI inferred lands unconfirmed and
      // shows an amber dot until the owner taps it.
      confirmed: li.source !== 'ai_inferred' && li.confidence === 'high',
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
    model: result.model,
    drafted_at: new Date().toISOString(),
  };
  await D1.prepare('UPDATE quotes SET description = ?2, ai_summary = ?3 WHERE id = ?1')
    .bind(row.id, description, JSON.stringify(summary))
    .run();
  await db.logEvent(D1, row.id, 'ai_drafted', { model: result.model, lines: drafted.length });

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

/* --------------------------------------------------- jobs & cost capture */

async function jobRoutes(id, action, subId, request, env, ctxo) {
  const D1 = env.DB;
  const method = request.method;

  if (!id && method === 'GET') return json({ jobs: await db.listJobs(D1) }, ctxo);
  if (!id) return fail(404, 'Not found', {}, ctxo);

  const job = await db.getJob(D1, id);
  if (!job) return fail(404, 'Job not found', {}, ctxo);

  if (!action && method === 'GET') {
    const costs = await db.getJobCosts(D1, id);
    return json({ job, costs, variance: jobVariance(job, costs) }, ctxo);
  }

  if (!action && method === 'PATCH') {
    const body = await readJson(request);
    const status = body.status;
    if (!['booked', 'in_progress', 'complete'].includes(status)) {
      return fail(400, 'status must be booked, in_progress or complete', {}, ctxo);
    }
    // Stamp the completion date on the transition, and clear it if the job is
    // reopened — otherwise a reopened job keeps a date that says it finished.
    await D1.prepare(
      `UPDATE jobs
          SET status = ?2,
              completed_at = CASE WHEN ?2 = 'complete' THEN COALESCE(completed_at, date('now')) ELSE NULL END
        WHERE id = ?1`,
    ).bind(id, status).run();

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
        `INSERT INTO jobs (id, quote_id, client_name, site_address, job_type, status, budget_baseline, cost_baseline)
         VALUES (?1,?2,?3,?4,?5,'booked',?6,?7)`,
      ).bind(
        jobId,
        row.id,
        row.client_name,
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
