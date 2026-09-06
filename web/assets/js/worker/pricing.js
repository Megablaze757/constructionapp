/* ------------------------------------------------------------------------- *
 * GENERATED FILE — DO NOT EDIT.
 * Built by worker/scripts/build-generated.mjs from worker/src/pricing.js.
 * Edit the source and run: npm run build:generated
 * ------------------------------------------------------------------------- */

/**
 * Pricing & margin engine (docs/auto-quoting/README.md §5).
 *
 * The single rule this module exists to enforce: money is derived here, from the
 * price book, and nowhere else. The AI supplies quantities. The browser supplies
 * quantities. Neither supplies a price — so neither can underprice a job.
 */

/** Round to pennies without the usual float drift (1.005 -> 1.01, not 1.00). */
export function money(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Price a single line against the price book.
 * @param {{line_code?: string, quantity: number, unit?: string, description?: string}} line
 * @param {Map<string, object>} priceBook keyed by code
 */
export function priceLine(line, priceBook) {
  const entry = line.line_code ? priceBook.get(line.line_code) : null;

  // An owner-entered line with no price-book code carries its own rates; that is
  // the manual escape hatch. Anything claiming a code must resolve to one.
  if (!entry) {
    if (line.line_code) throw new Error(`unknown price book code "${line.line_code}"`);
    return {
      ...line,
      unit: line.unit ?? 'job',
      unit_cost: money(Number(line.unit_cost) || 0),
      unit_price: money(Number(line.unit_price) || 0),
      category: line.category ?? 'other',
      line_cost: money((Number(line.unit_cost) || 0) * line.quantity),
      line_price: money((Number(line.unit_price) || 0) * line.quantity),
    };
  }

  return {
    ...line,
    description: line.description || entry.description,
    unit: entry.unit,
    unit_cost: entry.unit_cost,
    unit_price: entry.unit_price,
    category: entry.category,
    line_cost: money(entry.unit_cost * line.quantity),
    line_price: money(entry.unit_price * line.quantity),
  };
}

/**
 * Total a quote and compute its margin.
 *
 * Extras are excluded from the headline total (the wireframe's
 * "TOTAL (excl. extras)") but included in `withExtras` so the client-facing page
 * can show a live total as they toggle.
 */
export function totalQuote(lines, { targetMargin = 0, marginFloor = 0 } = {}) {
  const base = lines.filter((l) => l.kind !== 'extra');
  const extras = lines.filter((l) => l.kind === 'extra');
  const selected = extras.filter((l) => l.selected);

  const sum = (arr, k) => money(arr.reduce((t, l) => t + (l[k] || 0), 0));

  const subtotal_cost = sum(base, 'line_cost');
  const subtotal_price = sum(base, 'line_price');
  const extras_price = sum(selected, 'line_price');
  const extras_cost = sum(selected, 'line_cost');

  const margin_pct = marginOf(subtotal_price, subtotal_cost);
  const withExtrasPrice = money(subtotal_price + extras_price);

  // A line priced at or below cost is a quiet margin leak; surface it per-line
  // rather than only in the total, so the owner can see which one.
  const below_cost = base
    .filter((l) => l.line_price <= l.line_cost && l.line_price > 0)
    .map((l) => l.description);

  return {
    subtotal_cost,
    subtotal_price,
    extras_cost,
    extras_price,
    total_with_extras: withExtrasPrice,
    margin_pct,
    margin_with_extras: marginOf(withExtrasPrice, money(subtotal_cost + extras_cost)),
    target_margin: targetMargin,
    margin_floor: marginFloor,
    below_floor: margin_pct < marginFloor,
    meets_target: margin_pct >= targetMargin,
    below_cost_lines: below_cost,
  };
}

/** Margin as a percentage of price. Zero-price quote has no meaningful margin. */
export function marginOf(price, cost) {
  if (!price) return 0;
  return Math.round(((price - cost) / price) * 1000) / 10;
}

/**
 * The send gate (§4.3 "margin floor" + wireframe §1.1).
 *
 * Returns the reasons a quote cannot be sent. An owner may send below the floor
 * ONLY with a recorded reason — the override is a logged decision, not a bypass.
 */
export function sendBlockers(quote, lines, totals) {
  const blockers = [];

  if (!lines.some((l) => l.kind !== 'extra')) {
    blockers.push({ code: 'no_line_items', message: 'Quote has no line items.' });
  }

  const unconfirmed = lines.filter((l) => !l.confirmed);
  if (unconfirmed.length) {
    // With no AI connected the same gate holds template defaults, which nothing
    // estimated. Calling those "AI-drafted" would misdescribe what is on screen.
    const drafted = unconfirmed.some((l) => l.source === 'ai_inferred' || l.source === 'photo_inferred')
      ? 'AI-drafted' : 'drafted';
    blockers.push({
      code: 'unconfirmed_ai_lines',
      message: unconfirmed.length === 1
        ? `1 ${drafted} item still needs confirming.`
        : `${unconfirmed.length} ${drafted} items still need confirming.`,
      lines: unconfirmed.map((l) => l.id),
    });
  }

  if (totals.below_floor && !quote.override_reason) {
    blockers.push({
      code: 'below_margin_floor',
      message: `Margin ${totals.margin_pct}% is below the ${totals.margin_floor}% floor. Adjust pricing or record an override reason.`,
      overridable: true,
    });
  }

  if (!quote.client_name?.trim()) {
    blockers.push({ code: 'no_client', message: 'Quote has no client name.' });
  }

  return blockers;
}
