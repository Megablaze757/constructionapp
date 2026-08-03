/**
 * Template suggestions (docs/auto-quoting/README.md §3.2, Phase D).
 *
 * "You quote this job type often — want to save it as a template?"
 *
 * The signal is the *shape* of a quote: which price-book lines it draws on. When
 * the same combination keeps being assembled by hand and no template covers it,
 * that combination has become a job type the business does regularly, whether or
 * not anyone has named it.
 */

import { money, marginOf } from './pricing.js';

/** Sorted, de-duplicated base line codes — the shape of a quote. */
export function signatureOf(lineCodes) {
  return [...new Set(lineCodes.filter(Boolean))].sort().join('+');
}

/** The median is the right average here: one freak 200m² job should not move it. */
export function median(values) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * @param {Array} quotes    sent/accepted quotes, each {id, job_type, client_name, lines[]}
 * @param {Array} templates existing templates, each {name, job_type, line_items[]}
 * @param {{minQuotes?: number}} opts
 */
export function suggestTemplates(quotes, templates, { minQuotes = 3 } = {}) {
  // What the existing templates already cover. A template is "covered" by its
  // always-include lines, since those are what it produces unprompted.
  const covered = new Set(
    (templates ?? []).map((t) =>
      signatureOf((t.line_items ?? []).filter((li) => li.always_include).map((li) => li.line_code))),
  );

  const groups = new Map();
  for (const q of quotes ?? []) {
    const base = (q.lines ?? []).filter((l) => l.kind !== 'extra');
    const sig = signatureOf(base.map((l) => l.line_code));
    if (!sig) continue;
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push({ ...q, base });
  }

  const suggestions = [];
  for (const [signature, rows] of groups) {
    if (rows.length < minQuotes) continue;
    if (covered.has(signature)) continue;      // a template already produces this

    // Median quantity per line, so the suggested template starts from what this
    // business typically does rather than from whatever the last job happened to be.
    const byCode = new Map();
    for (const q of rows) {
      for (const l of q.base) {
        if (!l.line_code) continue;
        const e = byCode.get(l.line_code)
          || { line_code: l.line_code, description: l.description, unit: l.unit, quantities: [] };
        e.quantities.push(Number(l.quantity) || 0);
        byCode.set(l.line_code, e);
      }
    }

    const line_items = [...byCode.values()].map((e) => ({
      line_code: e.line_code,
      description: e.description,
      unit: e.unit,
      default_quantity: round1(median(e.quantities)),
      always_include: true,
      locked: false,
    }));

    const price = money(rows.reduce((t, q) => t + sumOf(q.base, 'line_price'), 0));
    const cost = money(rows.reduce((t, q) => t + sumOf(q.base, 'line_cost'), 0));
    const observed_margin = marginOf(price, cost);

    suggestions.push({
      signature,
      quotes: rows.length,
      job_types: [...new Set(rows.map((q) => q.job_type))],
      suggested_name: nameFor(line_items),
      suggested_job_type: slugFor(line_items),
      line_items,
      observed_margin,
      // Seeded from what the business actually achieves, rounded down to a whole
      // point so the target is not set to an unrepeatable best case.
      suggested_margin: Math.max(0, Math.floor(observed_margin)),
      examples: rows.slice(0, 3).map((q) => q.client_name).filter(Boolean),
    });
  }

  return suggestions.sort((a, b) => b.quotes - a.quotes);
}

const sumOf = (lines, key) => lines.reduce((t, l) => t + (Number(l[key]) || 0), 0);
const round1 = (n) => Math.round(n * 10) / 10;

/** A readable name from the lines themselves — the owner can rename it. */
function nameFor(lineItems) {
  const parts = lineItems.slice(0, 3).map((l) => l.description);
  const suffix = lineItems.length > 3 ? ` +${lineItems.length - 3} more` : '';
  return `${parts.join(' + ')}${suffix}`;
}

function slugFor(lineItems) {
  return lineItems
    .map((l) => l.line_code)
    .sort()
    .join('_')
    .replace(/[^a-z0-9_]/g, '')
    .slice(0, 60);
}
