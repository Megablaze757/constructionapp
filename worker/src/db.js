/** D1 queries. Every read that produces money re-derives it from the price book. */

import { newId } from './http.js';
import { priceLine, totalQuote } from './pricing.js';

export async function getPriceBook(db) {
  const { results } = await db.prepare('SELECT * FROM price_book ORDER BY code').all();
  return results ?? [];
}

export function priceBookMap(rows) {
  return new Map(rows.map((r) => [r.code, r]));
}

export async function getTemplates(db) {
  const { results } = await db
    .prepare('SELECT * FROM quote_templates ORDER BY name')
    .all();
  return (results ?? []).map(hydrateTemplate);
}

export async function getTemplate(db, jobType) {
  const row = await db
    .prepare('SELECT * FROM quote_templates WHERE job_type = ?1 ORDER BY version DESC LIMIT 1')
    .bind(jobType)
    .first();
  return row ? hydrateTemplate(row) : null;
}

function hydrateTemplate(row) {
  return {
    ...row,
    line_items: safeParse(row.line_items, []),
    optional_extras: safeParse(row.optional_extras, []),
  };
}

function safeParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export async function listQuotes(db) {
  const { results } = await db
    .prepare(
      `SELECT id, public_token, client_name, site_address, job_type, status,
              subtotal_price, margin_pct, margin_floor, valid_until, created_at, sent_at
         FROM quotes
        WHERE id NOT LIKE 'q_seed_%'
        ORDER BY created_at DESC, rowid DESC
        LIMIT 100`,
    )
    .all();
  return results ?? [];
}

export async function getQuoteRow(db, id) {
  return db.prepare('SELECT * FROM quotes WHERE id = ?1').bind(id).first();
}

export async function getQuoteRowByToken(db, token) {
  return db.prepare('SELECT * FROM quotes WHERE public_token = ?1').bind(token).first();
}

export async function getLines(db, quoteId) {
  const { results } = await db
    // 'base' before 'extra' alphabetically, which is also the order they appear
    // on both screens.
    .prepare('SELECT * FROM quote_line_items WHERE quote_id = ?1 ORDER BY kind, position, rowid')
    .bind(quoteId)
    .all();
  return (results ?? []).map((r) => ({
    ...r,
    quantity: Number(r.quantity),
    confirmed: !!r.confirmed,
    locked: !!r.locked,
    selected: !!r.selected,
  }));
}

/**
 * Load a quote with its lines priced and totalled.
 * Prices are always recomputed here rather than read back from the quote row, so
 * a price-book change can never leave a stale total on screen.
 */
export async function loadQuote(db, row) {
  const [lines, book] = await Promise.all([getLines(db, row.id), getPriceBook(db)]);
  const map = priceBookMap(book);
  const priced = lines.map((l) => priceLine(l, map));
  const totals = totalQuote(priced, {
    targetMargin: row.target_margin,
    marginFloor: row.margin_floor,
  });
  return {
    quote: { ...row, ai_summary: safeParse(row.ai_summary, null) },
    lines: priced,
    totals,
  };
}

/** Persist recomputed totals so list views and reports don't have to re-derive them. */
export async function saveTotals(db, quoteId, totals) {
  await db
    .prepare(
      `UPDATE quotes
          SET subtotal_cost = ?2, subtotal_price = ?3, margin_pct = ?4
        WHERE id = ?1`,
    )
    .bind(quoteId, totals.subtotal_cost, totals.subtotal_price, totals.margin_pct)
    .run();
}

export async function replaceLines(db, quoteId, lines) {
  const stmts = [db.prepare('DELETE FROM quote_line_items WHERE quote_id = ?1').bind(quoteId)];
  lines.forEach((l, i) => {
    stmts.push(
      db
        .prepare(
          `INSERT INTO quote_line_items
             (id, quote_id, position, line_code, description, quantity, unit,
              unit_cost, unit_price, category, kind, blurb, selected,
              source, confidence, note, confirmed, locked)
           VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)`,
        )
        .bind(
          l.id || newId('li'),
          quoteId,
          i,
          l.line_code ?? null,
          l.description,
          l.quantity,
          l.unit ?? 'job',
          l.unit_cost ?? 0,
          l.unit_price ?? 0,
          l.category ?? 'other',
          l.kind ?? 'base',
          l.blurb ?? null,
          l.selected ? 1 : 0,
          l.source ?? 'owner_entered',
          l.confidence ?? null,
          l.note ?? null,
          l.confirmed ? 1 : 0,
          l.locked ? 1 : 0,
        ),
    );
  });
  await db.batch(stmts);
}

export async function logEvent(db, quoteId, type, meta = {}) {
  await db
    .prepare('INSERT INTO quote_events (id, quote_id, event_type, meta) VALUES (?1,?2,?3,?4)')
    .bind(newId('ev'), quoteId, type, JSON.stringify(meta))
    .run();
}

export async function getEvents(db, quoteId) {
  const { results } = await db
    .prepare('SELECT event_type, meta, created_at FROM quote_events WHERE quote_id = ?1 ORDER BY created_at DESC, rowid DESC LIMIT 50')
    .bind(quoteId)
    .all();
  return (results ?? []).map((e) => ({ ...e, meta: safeParse(e.meta, {}) }));
}

/**
 * The last N completed jobs of this type, for the AI's scale sanity-check
 * (spec §2.2) and the quoted-vs-actual learning loop.
 *
 * `actual_cost` is the sum of costs actually booked against the job. Where none
 * have been recorded it falls back to the quoted cost and says so, because a
 * silent fallback would feed the assistant a perfect-looking history that never
 * happened.
 */
export async function similarPastJobs(db, jobType, limit = 5) {
  const { results } = await db
    .prepare(
      `SELECT j.site_address,
              j.job_type,
              j.budget_baseline AS quoted,
              j.cost_baseline   AS quoted_cost,
              COALESCE(SUM(c.amount), 0) AS booked_cost,
              COUNT(c.id)                AS cost_entries
         FROM jobs j
    LEFT JOIN job_costs c ON c.job_id = j.id
        WHERE j.job_type = ?1 AND j.status = 'complete'
        GROUP BY j.id
        ORDER BY COALESCE(j.completed_at, j.created_at) DESC
        LIMIT ?2`,
    )
    .bind(jobType, limit)
    .all();

  return (results ?? []).map((r) => {
    const hasActuals = r.cost_entries > 0;
    const cost = hasActuals ? r.booked_cost : r.quoted_cost;
    return {
      job: `${r.site_address}, ${r.job_type.replace(/_/g, ' ')}`,
      quoted: r.quoted,
      actual_cost: Math.round(cost * 100) / 100,
      margin_actual: `${Math.round(((r.quoted - cost) / r.quoted) * 100)}%`,
      cost_basis: hasActuals ? 'actual' : 'quoted_estimate',
    };
  });
}

/* -------------------------------------------------------- jobs & variance */

/**
 * Every job with its crew, costs and checklist progress.
 *
 * The Phase 0 success criterion is "the owner can see every active job and who
 * is on it in one place", so the crew is part of the list query rather than
 * something each row has to fetch for itself.
 */
export async function listJobs(db) {
  const [{ results: jobs }, { results: crew }, { results: sops }] = await Promise.all([
    db.prepare(
      `SELECT j.*, COALESCE(SUM(c.amount), 0) AS actual_cost, COUNT(c.id) AS cost_entries
         FROM jobs j
    LEFT JOIN job_costs c ON c.job_id = j.id
        GROUP BY j.id
        ORDER BY
          CASE j.status WHEN 'in_progress' THEN 0 WHEN 'booked' THEN 1
                        WHEN 'on_hold' THEN 2 ELSE 3 END,
          COALESCE(j.target_start, j.created_at) DESC
        LIMIT 100`,
    ).all(),
    db.prepare(
      `SELECT a.job_id, a.role_on_job, p.id AS person_id, p.name, p.kind
         FROM job_assignments a JOIN people p ON p.id = a.person_id`,
    ).all(),
    db.prepare('SELECT job_id, steps FROM job_sops').all(),
  ]);

  const byJob = new Map();
  for (const c of crew ?? []) {
    if (!byJob.has(c.job_id)) byJob.set(c.job_id, []);
    byJob.get(c.job_id).push({ person_id: c.person_id, name: c.name, kind: c.kind, role_on_job: c.role_on_job });
  }

  const sopByJob = new Map();
  for (const s of sops ?? []) {
    const steps = safeParse(s.steps, []);
    const e = sopByJob.get(s.job_id) || { total: 0, done: 0 };
    e.total += steps.length;
    e.done += steps.filter((st) => st.done && (!st.needs_photo || st.photo_id)).length;
    sopByJob.set(s.job_id, e);
  }

  return (jobs ?? []).map((j) => ({
    ...j,
    crew: byJob.get(j.id) ?? [],
    sop_progress: sopByJob.get(j.id) ?? null,
  }));
}

/* ------------------------------------------------------------- Phase 0 */

export async function listPeople(db, { includeInactive = false } = {}) {
  const { results } = await db
    .prepare(
      `SELECT p.*, COUNT(a.id) AS active_jobs
         FROM people p
    LEFT JOIN job_assignments a ON a.person_id = p.id
    LEFT JOIN jobs j ON j.id = a.job_id AND j.status IN ('booked','in_progress')
        ${includeInactive ? '' : 'WHERE p.active = 1'}
        GROUP BY p.id
        ORDER BY p.active DESC, p.name`,
    )
    .all();
  return (results ?? []).map((p) => ({ ...p, active: !!p.active }));
}

export async function listSops(db) {
  const { results } = await db.prepare('SELECT * FROM sops ORDER BY category, title').all();
  return (results ?? []).map((s) => ({ ...s, steps: safeParse(s.steps, []) }));
}

export async function getSop(db, id) {
  const row = await db.prepare('SELECT * FROM sops WHERE id = ?1').bind(id).first();
  return row ? { ...row, steps: safeParse(row.steps, []) } : null;
}

export async function listJobSops(db, jobId) {
  const { results } = await db
    .prepare('SELECT * FROM job_sops WHERE job_id = ?1 ORDER BY attached_at, rowid')
    .bind(jobId)
    .all();
  return (results ?? []).map((s) => ({ ...s, steps: safeParse(s.steps, []) }));
}

export async function getAssignments(db, jobId) {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.role_on_job, p.id AS person_id, p.name, p.kind, p.trade, p.phone
         FROM job_assignments a JOIN people p ON p.id = a.person_id
        WHERE a.job_id = ?1 ORDER BY p.name`,
    )
    .bind(jobId)
    .all();
  return results ?? [];
}

/* ------------------------------------------------------------- Phase 1 */

export async function listTasks(db, jobId) {
  const { results } = await db
    .prepare(
      `SELECT t.*, p.name AS person_name
         FROM tasks t LEFT JOIN people p ON p.id = t.person_id
        WHERE t.job_id = ?1
        ORDER BY t.status, COALESCE(t.due_on, '9999'), t.rowid`,
    )
    .bind(jobId)
    .all();
  return (results ?? []).map((t) => ({ ...t, needs_photo: !!t.needs_photo }));
}

/** Every live task, for the owner's attention list. */
export async function allOpenTasks(db) {
  const { results } = await db
    .prepare(
      `SELECT t.*, p.name AS person_name, j.client_name, j.site_address
         FROM tasks t
    LEFT JOIN people p ON p.id = t.person_id
         JOIN jobs j ON j.id = t.job_id
        WHERE t.status != 'cancelled' AND j.status != 'complete'`,
    )
    .all();
  return (results ?? []).map((t) => ({ ...t, needs_photo: !!t.needs_photo }));
}

export async function listSiteLogs(db, jobId, limit = 50) {
  const { results } = await db
    .prepare(
      `SELECT l.*, p.name AS person_name
         FROM site_logs l LEFT JOIN people p ON p.id = l.person_id
        WHERE l.job_id = ?1
        ORDER BY l.created_at DESC, l.rowid DESC LIMIT ?2`,
    )
    .bind(jobId, limit)
    .all();
  return results ?? [];
}

export async function recentSiteLogs(db, limit = 60) {
  const { results } = await db
    .prepare(
      `SELECT l.*, p.name AS person_name, j.client_name, j.site_address
         FROM site_logs l
    LEFT JOIN people p ON p.id = l.person_id
         JOIN jobs j ON j.id = l.job_id
        ORDER BY l.created_at DESC, l.rowid DESC LIMIT ?1`,
    )
    .bind(limit)
    .all();
  return results ?? [];
}

export async function listCheckins(db, jobId) {
  const { results } = await db
    .prepare('SELECT * FROM client_checkins WHERE job_id = ?1 ORDER BY COALESCE(due_on, \'9999\'), rowid')
    .bind(jobId)
    .all();
  return results ?? [];
}

export async function allCheckins(db) {
  const { results } = await db
    .prepare(
      `SELECT c.*, j.client_name, j.site_address
         FROM client_checkins c JOIN jobs j ON j.id = c.job_id
        WHERE j.status != 'complete'`,
    )
    .all();
  return results ?? [];
}

export async function personByToken(db, token) {
  const row = await db
    .prepare('SELECT * FROM people WHERE access_token = ?1 AND active = 1')
    .bind(token)
    .first();
  return row ? { ...row, active: !!row.active } : null;
}

/** The jobs a person is actually on — the whole scope of their crew view. */
export async function jobsForPerson(db, personId) {
  const { results } = await db
    .prepare(
      `SELECT j.*, a.role_on_job
         FROM jobs j JOIN job_assignments a ON a.job_id = j.id
        WHERE a.person_id = ?1 AND j.status != 'complete'
        ORDER BY CASE j.status WHEN 'in_progress' THEN 0 WHEN 'booked' THEN 1 ELSE 2 END,
                 COALESCE(j.target_start, j.created_at)`,
    )
    .bind(personId)
    .all();
  return results ?? [];
}

export async function tasksForPerson(db, personId) {
  const { results } = await db
    .prepare(
      `SELECT t.*, j.client_name, j.site_address
         FROM tasks t JOIN jobs j ON j.id = t.job_id
        WHERE t.person_id = ?1 AND t.status != 'cancelled' AND j.status != 'complete'
        ORDER BY COALESCE(t.due_on, '9999'), t.rowid`,
    )
    .bind(personId)
    .all();
  return (results ?? []).map((t) => ({ ...t, needs_photo: !!t.needs_photo }));
}

export async function getJobPhotoBytes(db, photoId) {
  const row = await db.prepare('SELECT mime, bytes FROM job_photos WHERE id = ?1').bind(photoId).first();
  return row ? { mime: row.mime, bytes: toBytes(row.bytes) } : null;
}

export async function listInvoices(db) {
  const { results } = await db
    .prepare(
      `SELECT i.*, j.site_address
         FROM invoices i LEFT JOIN jobs j ON j.id = i.job_id
        ORDER BY COALESCE(i.issued_on, i.created_at) DESC, i.rowid DESC
        LIMIT 200`,
    )
    .all();
  return results ?? [];
}

export async function invoiceNumbers(db) {
  const { results } = await db.prepare('SELECT number FROM invoices').all();
  return (results ?? []).map((r) => r.number);
}

export async function getJob(db, id) {
  return db.prepare('SELECT * FROM jobs WHERE id = ?1').bind(id).first();
}

export async function getJobCosts(db, jobId) {
  const { results } = await db
    .prepare('SELECT * FROM job_costs WHERE job_id = ?1 ORDER BY incurred_on, rowid')
    .bind(jobId)
    .all();
  return results ?? [];
}

/** Every completed job with its booked costs, for the variance report. */
export async function completedJobsWithCosts(db) {
  const [{ results: jobs }, { results: costs }] = await Promise.all([
    db.prepare("SELECT * FROM jobs WHERE status = 'complete'").all(),
    db
      .prepare(
        `SELECT c.* FROM job_costs c
           JOIN jobs j ON j.id = c.job_id
          WHERE j.status = 'complete'`,
      )
      .all(),
  ]);

  const byJob = new Map();
  for (const c of costs ?? []) {
    if (!byJob.has(c.job_id)) byJob.set(c.job_id, []);
    byJob.get(c.job_id).push(c);
  }
  return (jobs ?? []).map((j) => ({ job: j, costs: byJob.get(j.id) ?? [] }));
}

/**
 * Quoted lines for completed jobs, tagged with their job id so per-line-code
 * bias can be matched against actual costs.
 */
export async function quotedLinesForCompletedJobs(db) {
  const { results } = await db
    .prepare(
      `SELECT j.id AS job_id, li.line_code, li.description,
              (li.unit_cost * li.quantity) AS line_cost
         FROM jobs j
         JOIN quotes q ON q.id = j.quote_id
         JOIN quote_line_items li ON li.quote_id = q.id
        WHERE j.status = 'complete' AND li.line_code IS NOT NULL
          AND (li.kind = 'base' OR li.selected = 1)`,
    )
    .all();
  return results ?? [];
}

export async function allActualCosts(db) {
  const { results } = await db
    .prepare(
      `SELECT c.job_id, c.line_code, c.amount
         FROM job_costs c
         JOIN jobs j ON j.id = c.job_id
        WHERE j.status = 'complete' AND c.line_code IS NOT NULL`,
    )
    .all();
  return results ?? [];
}

/**
 * Real quotes with their priced lines, for template-pattern detection.
 * Drafts are excluded: a half-built quote is not evidence of anything.
 */
export async function quotesWithLines(db, limit = 200) {
  const [{ results: quotes }, { results: lines }] = await Promise.all([
    db.prepare(
      `SELECT id, job_type, client_name FROM quotes
        WHERE status IN ('sent','viewed','accepted') AND id NOT LIKE 'q_seed_%'
        ORDER BY created_at DESC LIMIT ?1`,
    ).bind(limit).all(),
    db.prepare(
      `SELECT li.quote_id, li.line_code, li.description, li.unit, li.quantity, li.kind,
              (li.unit_price * li.quantity) AS line_price,
              (li.unit_cost  * li.quantity) AS line_cost
         FROM quote_line_items li
         JOIN quotes q ON q.id = li.quote_id
        WHERE q.status IN ('sent','viewed','accepted') AND q.id NOT LIKE 'q_seed_%'`,
    ).all(),
  ]);

  const byQuote = new Map();
  for (const l of lines ?? []) {
    if (!byQuote.has(l.quote_id)) byQuote.set(l.quote_id, []);
    byQuote.get(l.quote_id).push(l);
  }
  return (quotes ?? []).map((q) => ({ ...q, lines: byQuote.get(q.id) ?? [] }));
}

export async function createTemplate(db, tpl) {
  await db.prepare(
    `INSERT INTO quote_templates
       (id, job_type, name, default_margin, margin_floor, validity_days, terms, exclusions, line_items, optional_extras)
     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)`,
  ).bind(
    tpl.id, tpl.job_type, tpl.name, tpl.default_margin, tpl.margin_floor,
    tpl.validity_days ?? 30, tpl.terms ?? '', tpl.exclusions ?? '',
    JSON.stringify(tpl.line_items ?? []), JSON.stringify(tpl.optional_extras ?? []),
  ).run();
}

/* ------------------------------------------------------------------ photos */

export async function listPhotos(db, quoteId, { clientOnly = false } = {}) {
  const { results } = await db
    .prepare(
      `SELECT id, position, mime, width, height, caption, show_client
         FROM quote_photos
        WHERE quote_id = ?1 ${clientOnly ? 'AND show_client = 1' : ''}
        ORDER BY position, rowid`,
    )
    .bind(quoteId)
    .all();
  return (results ?? []).map((p) => ({ ...p, show_client: !!p.show_client }));
}

/**
 * Photos as base64, for a multimodal draft request.
 *
 * Capped rather than unbounded: images are the expensive part of a draft call,
 * and the fifth photo of the same elevation adds cost without adding scope.
 */
export async function getPhotosForDraft(db, quoteId, limit = 4) {
  const { results } = await db
    .prepare('SELECT id, mime, bytes FROM quote_photos WHERE quote_id = ?1 ORDER BY position, rowid LIMIT ?2')
    .bind(quoteId, limit)
    .all();

  return (results ?? []).map((r) => {
    const bytes = toBytes(r.bytes);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return { id: r.id, mime: r.mime, b64: btoa(binary) };
  });
}

export async function getPhotoBytes(db, photoId) {
  const row = await db
    .prepare('SELECT mime, bytes FROM quote_photos WHERE id = ?1')
    .bind(photoId)
    .first();
  return row ? { mime: row.mime, bytes: toBytes(row.bytes) } : null;
}

/**
 * Normalise a D1 BLOB into a Uint8Array.
 *
 * D1 hands BLOB columns back as a plain Array<number>. Passing that straight to
 * `new Response()` does not send the bytes — it stringifies the array, so the
 * client receives "255,216,255,…" under an image/jpeg content-type: right
 * status, right headers, three times the size, and an image that will not
 * decode. Normalising here keeps every caller safe from that.
 */
function toBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (Array.isArray(value)) return Uint8Array.from(value);
  return value;
}
