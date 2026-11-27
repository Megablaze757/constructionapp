/* ------------------------------------------------------------------------- *
 * GENERATED FILE — DO NOT EDIT.
 * Built by worker/scripts/build-generated.mjs from worker/src/quote-import.js.
 * Edit the source and run: npm run build:generated
 * ------------------------------------------------------------------------- */

/**
 * Turning the owner's own quote into a template and a price book.
 *
 * This is the thing that makes the app theirs. Until they do this, every quote
 * comes out in a shape I invented, priced from a seeded price book with
 * fictional rates — £27/m² for scaffold erect, because something had to be
 * there. Their own quote has their descriptions, their units and their real
 * money in it.
 *
 * Two rules shape the whole module, because this writes to the price book and
 * the price book is what every future quote is costed from.
 *
 * **Nothing is invented.** Every figure returned here was read from the
 * document, and the arithmetic is re-checked rather than trusted: a quote
 * showing 45 m² at £27 with a line total of £1,215 is consistent, and one
 * showing £1,250 is not. A mismatch is reported, never resolved by picking
 * whichever number looks nicer.
 *
 * **Cost is not in the document.** A quote shows what the client pays, not what
 * the job costs, so margin cannot be derived from it. The importer refuses to
 * guess: it returns prices with `unit_cost: null`, and the owner supplies cost
 * — either per line, or from one typical-margin figure that is then labelled as
 * derived from what they told us rather than read from their quote. Inferring a
 * cost silently would put a made-up margin behind the send gate, which is the
 * one number the gate exists to protect.
 */

/** Units the price book understands. Anything else is reported, not mapped. */
export const KNOWN_UNITS = ['m2', 'm', 'days', 'job', 'each'];

const UNIT_WORDS = [
  [/^(?:m2|m²|sqm|sq\.?m|square\s*(?:metres?|meters?))$/i, 'm2'],
  [/^(?:lm|l\.?m|linear\s*(?:metres?|meters?)|metres?|meters?|m)$/i, 'm'],
  [/^(?:days?|dy|d)$/i, 'days'],
  [/^(?:weeks?|wk)$/i, 'days'],
  [/^(?:job|item|sum|lot|visit)$/i, 'job'],
  [/^(?:each|ea|no|nr|off|unit)$/i, 'each'],
];

/** Lines that are totals, tax or boilerplate rather than work. */
const NOT_WORK = /^(?:sub\s*-?total|total|vat|tax|discount|deposit|balance|carried|page\b|quotation|quote\b|invoice|date\b|site\b|ref\b|client\b|customer\b|address\b|tel\b|email\b|payment\s+due|terms\b|excludes?\b|exclusions?\b)/i;

/** Where a quote stops listing work and starts stating conditions. */
const TERMS_HEAD = /\b(payment\s+due|terms\s*(?:and|&)?\s*conditions?|terms\b)/i;
const EXCLUSIONS_HEAD = /\b(excludes?|exclusions?|not\s+included)\b/i;

function canonicalUnit(word) {
  const w = String(word || '').replace(/[.,]$/, '');
  for (const [re, unit] of UNIT_WORDS) if (re.test(w)) return unit;
  return null;
}

/** Weeks are read as weeks and stored as days, like everywhere else here. */
function unitMultiplier(word) {
  return /^(?:weeks?|wk)$/i.test(String(word || '').replace(/[.,]$/, '')) ? 7 : 1;
}

const money = (s) => Number(String(s).replace(/[£$€,\s]/g, ''));

/** Two decimal places, so repeated division does not drift. */
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * A snake_case job type from the quote's own wording.
 *
 * Deliberately conservative: it names what the document calls the work rather
 * than trying to match one of the seeded job types, because a template that
 * silently merged with an existing one would overwrite the owner's shape.
 */
export function jobTypeFrom(text) {
  const head = String(text || '').slice(0, 600).toLowerCase();
  const found = [
    [/re-?roof|re-?tile|roof\s+covering/, 'reroof'],
    [/scaffold/, 'scaffold'],
    [/render|rendering/, 'render'],
    [/extension/, 'extension'],
    [/driveway|block\s*pav/, 'driveway'],
    [/loft\s*conversion/, 'loft_conversion'],
    [/guttering|gutter/, 'guttering'],
    [/chimney/, 'chimney'],
  ].find(([re]) => re.test(head));
  const domestic = /\b(domestic|house|home|bungalow|semi|terrace|detached)\b/.test(head);
  const base = found ? found[1] : 'general_works';
  return domestic && base !== 'general_works' ? `domestic_${base}` : base;
}

/**
 * Pull the work items out of a quote's text.
 *
 * Handles the two orderings that cover almost every quote written in this
 * trade, and reports anything else rather than forcing it:
 *
 *   description … qty unit rate total      (rate shown)
 *   description … qty unit total           (total only)
 *
 * @param {string} text  extracted document text (see web/assets/js/plans.js)
 * @returns {{lines: Array<object>, skipped: string[], totals: object}}
 */
export function parseQuoteLines(text) {
  const raw = String(text || '')
    // A PDF text layer arrives as one run; the line items are what sit between
    // a price and the next description, so the numbers are the delimiters.
    .replace(/\s+/g, ' ')
    .replace(/(\d)\s+(?=[A-Z][a-z])/g, '$1\n')
    .split('\n');

  const lines = [];
  const skipped = [];
  const totals = {};
  let section = 'work';

  for (const rawLine of raw) {
    const line = rawLine.trim();
    if (!line) continue;

    if (TERMS_HEAD.test(line)) section = 'terms';
    if (EXCLUSIONS_HEAD.test(line)) section = 'exclusions';

    // Totals and tax are recorded so the import can be cross-checked against
    // them, and never treated as work. All of them, because a PDF text layer
    // puts "Subtotal … VAT … Total" on one run — and a rate like "VAT at 20%"
    // has to be stepped over to reach the amount.
    const totalsOnLine = [...line.matchAll(
      /\b(sub\s*-?total|total|vat)\b\s*(?:at\s*)?(?:[\d.]+\s*%\s*)?[^0-9£$€]*([£$€]?[\d,]+(?:\.\d{2})?)/gi,
    )];
    if (totalsOnLine.length) {
      for (const t of totalsOnLine) {
        totals[t[1].toLowerCase().replace(/[\s-]/g, '')] = money(t[2]);
      }
      // A totals run holds no work, so it is not parsed on.
      if (!/\d+\s*(?:m2|m²|days?|job)\b/i.test(line)) continue;
    }

    if (section !== 'work' || NOT_WORK.test(line)) {
      if (section === 'work' && NOT_WORK.test(line)) skipped.push(line.slice(0, 90));
      continue;
    }

    // qty + unit + one or two money figures, at the end of the line.
    const m = line.match(
      // The unit token has to be able to contain a digit: "m2" is one unit, and
      // splitting it leaves "m" as the unit and 2 as the rate.
      /^(.*?)[\s.·-]*(\d+(?:\.\d+)?)\s*([a-zA-Z²][a-zA-Z0-9²]*)\s*[@xX]?\s*([£$€]?\s?[\d,]+(?:\.\d{2})?)(?:\s*[£$€]?\s?([\d,]+(?:\.\d{2})?))?\s*$/,
    );
    if (!m) {
      if (/[\d]/.test(line) && line.length > 8) skipped.push(line.slice(0, 90));
      continue;
    }

    const [, descRaw, qtyRaw, unitRaw, firstRaw, secondRaw] = m;
    const unit = canonicalUnit(unitRaw);
    const description = descRaw.replace(/[\s,:–—-]+$/, '').trim();
    if (!unit || !description) {
      skipped.push(line.slice(0, 90));
      continue;
    }

    const quantity = round2(Number(qtyRaw) * unitMultiplier(unitRaw));
    const first = money(firstRaw);
    const second = secondRaw === undefined ? null : money(secondRaw);

    // Two figures means rate then line total. One means the line total, and the
    // rate follows from the quantity.
    const unitPrice = second === null ? round2(first / quantity) : round2(first);
    const lineTotal = second === null ? round2(first) : round2(second);

    // The arithmetic is checked, not trusted. A penny of rounding is fine; a
    // pound is a transcription problem the owner has to look at.
    const expected = round2(unitPrice * quantity);
    const consistent = Math.abs(expected - lineTotal) <= Math.max(0.02, lineTotal * 0.005);

    lines.push({
      description,
      unit,
      quantity,
      unit_price: unitPrice,
      line_total: lineTotal,
      // Never read from a quote — a quote states price, not cost. Supplied by
      // the owner, or derived from a margin they give, and labelled as such.
      unit_cost: null,
      source: 'read_from_document',
      consistent,
      note: consistent
        ? null
        : `Your quote shows ${quantity} ${unit} and a line total of ${lineTotal.toFixed(2)}, which works out at ${round2(lineTotal / quantity).toFixed(2)} each rather than ${unitPrice.toFixed(2)}. Check which is right.`,
    });
  }

  return { lines, skipped, totals };
}

/**
 * Apply the owner's typical margin to lines whose cost is unknown.
 *
 * `cost = price × (1 − margin)`. This is arithmetic on a figure the owner gave
 * us, not a reading of their quote, so each line it touches is marked
 * `derived_from_margin` and says so. The distinction matters: the send gate
 * compares margin against a floor, and a cost nobody supplied would make that
 * comparison meaningless while looking exactly as authoritative.
 */
export function applyMargin(lines, marginPct) {
  const pct = Number(marginPct);
  if (!Number.isFinite(pct) || pct < 0 || pct >= 100) {
    throw new Error('A typical margin must be between 0 and 99 per cent.');
  }
  const factor = 1 - pct / 100;
  return lines.map((l) => (l.unit_cost === null
    ? { ...l, unit_cost: round2(l.unit_price * factor), cost_source: 'derived_from_margin' }
    : l));
}

/**
 * Check an import before it is allowed to touch the price book.
 *
 * @returns {{ok: true, value: object} | {ok: false, errors: string[]}}
 */
export function validateImport(draft) {
  const errors = [];
  const bad = (m) => errors.push(m);

  if (!draft || typeof draft !== 'object') return { ok: false, errors: ['import must be an object'] };
  if (typeof draft.job_type !== 'string' || !/^[a-z0-9]+(_[a-z0-9]+)*$/.test(draft.job_type)) {
    bad('job_type must be a snake_case string');
  }
  if (typeof draft.name !== 'string' || !draft.name.trim()) bad('name is required');
  if (!Array.isArray(draft.lines) || !draft.lines.length) {
    bad('no work items could be read from that document');
    return { ok: false, errors };
  }

  draft.lines.forEach((l, i) => {
    const at = `lines[${i}]`;
    if (typeof l.description !== 'string' || !l.description.trim()) bad(`${at}.description is required`);
    if (!KNOWN_UNITS.includes(l.unit)) bad(`${at}.unit "${l.unit}" is not one the price book uses`);
    for (const n of ['quantity', 'unit_price', 'line_total']) {
      if (!Number.isFinite(l[n]) || l[n] <= 0) bad(`${at}.${n} must be a number greater than 0`);
    }
    // The gate this module exists to protect: a line cannot be saved with a
    // cost nobody has accounted for.
    if (l.unit_cost === null || l.unit_cost === undefined) {
      bad(`${at} has no cost — supply one, or a typical margin to derive it from`);
    } else if (!Number.isFinite(l.unit_cost) || l.unit_cost < 0) {
      bad(`${at}.unit_cost must be a number of 0 or more`);
    } else if (l.unit_cost > l.unit_price) {
      bad(`${at} costs more than it sells for (${l.unit_cost} > ${l.unit_price})`);
    }
    if (l.unit_cost !== null && l.cost_source !== 'derived_from_margin' && l.cost_source !== 'owner_entered') {
      bad(`${at}.cost_source must say where the cost came from`);
    }
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: draft };
}

/**
 * Everything needed to write the import: price-book rows keyed by a code
 * derived from the description, and a template that references those codes.
 */
export function toTemplateAndPriceBook(imported, { codePrefix = '' } = {}) {
  const used = new Set();
  const code = (description) => {
    const base = `${codePrefix}${description.toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .split('_')
      .slice(0, 4)
      .join('_')}`.slice(0, 40) || 'line_item';
    let candidate = base;
    let n = 2;
    while (used.has(candidate)) candidate = `${base}_${n++}`;
    used.add(candidate);
    return candidate;
  };

  const priceBook = imported.lines.map((l) => ({
    code: code(l.description),
    description: l.description,
    // Everything imported starts as labour unless the owner recategorises it.
    // Guessing category from wording would put plant hire in the labour column
    // and quietly skew the cost-breakdown bar.
    category: l.category || 'other',
    unit: l.unit,
    unit_cost: l.unit_cost,
    unit_price: l.unit_price,
  }));

  const lineItems = priceBook.map((p, i) => ({
    line_code: p.code,
    description: p.description,
    unit: p.unit,
    default_quantity: imported.lines[i].quantity,
    always_include: true,
    locked: false,
  }));

  return {
    price_book: priceBook,
    template: {
      job_type: imported.job_type,
      name: imported.name,
      line_items: lineItems,
      optional_extras: [],
      terms: imported.terms || null,
      exclusions: imported.exclusions || null,
    },
  };
}
