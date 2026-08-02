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
 * (spec §2.2) and, later, the quoted-vs-actual learning loop.
 */
export async function similarPastJobs(db, jobType, limit = 5) {
  const { results } = await db
    .prepare(
      `SELECT j.site_address, j.job_type, j.budget_baseline AS quoted, j.cost_baseline AS actual_cost
         FROM jobs j
        WHERE j.job_type = ?1 AND j.status = 'complete'
        ORDER BY j.created_at DESC
        LIMIT ?2`,
    )
    .bind(jobType, limit)
    .all();

  return (results ?? []).map((r) => ({
    job: `${r.site_address}, ${r.job_type.replace(/_/g, ' ')}`,
    quoted: r.quoted,
    actual_cost: r.actual_cost,
    margin_actual: `${Math.round(((r.quoted - r.actual_cost) / r.quoted) * 100)}%`,
  }));
}
