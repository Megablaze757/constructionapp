/**
 * A D1 binding, implemented over SQLite in the browser.
 *
 * The Worker's source talks to `env.DB` through a small slice of the D1 API:
 * `prepare(sql).bind(...).first() / .all() / .run()`, plus `batch()`. Implement
 * that slice over sql.js and the entire Worker — router, queries, guardrails,
 * money maths — runs unchanged on the device.
 *
 * That is the whole point. A second implementation of the backend in the browser
 * would drift from the deployed one within a week, and the divergence would show
 * up as a quote that totals differently depending on whether the Worker was
 * reachable. There is one implementation; this just gives it somewhere to run.
 */

/** Where the shape of a D1 result differs from sql.js, it is normalised here. */
export class LocalD1 {
  /**
   * @param {object} sqlite an open sql.js Database
   * @param {() => void} onWrite called after any statement that changed data
   */
  constructor(sqlite, onWrite = () => {}) {
    this.sqlite = sqlite;
    this.onWrite = onWrite;
  }

  prepare(sql) {
    return new LocalStatement(this, sql, []);
  }

  /**
   * D1 runs a batch in one implicit transaction. So does this — a half-applied
   * line-item replacement would leave a quote priced from two different drafts.
   */
  async batch(statements) {
    this.sqlite.run('BEGIN');
    try {
      const out = [];
      for (const stmt of statements) out.push(await stmt.run({ silent: true }));
      this.sqlite.run('COMMIT');
      this.onWrite();
      return out;
    } catch (err) {
      this.sqlite.run('ROLLBACK');
      throw err;
    }
  }

  exec(sql) {
    this.sqlite.exec(sql);
    this.onWrite();
    return { count: 0, duration: 0 };
  }
}

class LocalStatement {
  constructor(db, sql, params) {
    this.db = db;
    this.sql = sql;
    this.params = params;
  }

  /**
   * D1 uses ?1-style numbered parameters, and so does SQLite: `?3` takes the
   * third bound value wherever it appears in the statement, so an array in
   * caller order is already right and the textual order does not matter.
   *
   * What does matter is that the numbering runs 1..n with no gaps — `?1, ?3`
   * would leave `?2` unbound as NULL and write a silently wrong row. That is
   * worth a loud failure rather than a wrong quote.
   */
  bind(...params) {
    const numbered = [...new Set([...this.sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1])))];
    if (numbered.length) {
      const highest = Math.max(...numbered);
      if (numbered.length !== highest || highest > params.length) {
        throw new Error(
          `Local mode: ${params.length} value(s) bound to parameters ${numbered.sort((a, b) => a - b).join(',')} in: ${this.sql}`,
        );
      }
    }
    return new LocalStatement(this.db, this.sql, params.map(normaliseIn));
  }

  async first(column) {
    const rows = await this.rows();
    if (!rows.length) return null;
    return column === undefined ? rows[0] : rows[0][column];
  }

  async all() {
    return { results: await this.rows(), success: true, meta: {} };
  }

  async run({ silent = false } = {}) {
    const stmt = this.db.sqlite.prepare(this.sql);
    try {
      stmt.bind(this.params);
      while (stmt.step()); // a write statement returns no rows, but must be stepped
    } finally {
      stmt.free();
    }
    const meta = {
      changes: this.db.sqlite.getRowsModified(),
      last_row_id: null,
      duration: 0,
    };
    if (!silent) this.db.onWrite();
    return { success: true, meta, results: [] };
  }

  async rows() {
    const stmt = this.db.sqlite.prepare(this.sql);
    const out = [];
    try {
      stmt.bind(this.params);
      while (stmt.step()) out.push(stmt.getAsObject());
    } finally {
      stmt.free();
    }
    return out;
  }
}

/**
 * sql.js binds numbers, strings, null and Uint8Array. Booleans and the odd
 * `undefined` reach it from code written against D1, which accepts both.
 */
function normaliseIn(value) {
  if (value === undefined) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value) && !(value instanceof Uint8Array)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return value;
}
