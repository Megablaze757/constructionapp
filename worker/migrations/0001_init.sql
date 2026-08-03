-- Auto-Quoting module — D1 schema.
-- Mirrors the data model in docs/auto-quoting/README.md §8.

-- Dependents first: job_costs and quote_photos hold foreign keys into jobs and
-- quotes, so dropping those before these would fail with enforcement on. They
-- are created in 0003; dropping them here keeps a full re-run a clean reset
-- rather than leaving orphaned rows behind to skew the variance report.
DROP TABLE IF EXISTS job_costs;
DROP TABLE IF EXISTS quote_photos;
DROP TABLE IF EXISTS quote_events;
DROP TABLE IF EXISTS quote_line_items;
DROP TABLE IF EXISTS jobs;
DROP TABLE IF EXISTS quotes;
DROP TABLE IF EXISTS price_book;
DROP TABLE IF EXISTS quote_templates;

-- QuoteTemplate: reusable structure per job type.
CREATE TABLE quote_templates (
  id             TEXT PRIMARY KEY,
  job_type       TEXT NOT NULL,
  name           TEXT NOT NULL,
  version        INTEGER NOT NULL DEFAULT 1,
  default_margin REAL    NOT NULL,          -- target margin %, e.g. 30
  margin_floor   REAL    NOT NULL,          -- hard floor %, blocks send below this
  validity_days  INTEGER NOT NULL DEFAULT 30,
  terms          TEXT    NOT NULL DEFAULT '',
  exclusions     TEXT    NOT NULL DEFAULT '',
  -- Line items the AI may draw on. JSON array of
  -- {line_code, description, unit, default_quantity|null, always_include, locked}
  line_items     TEXT    NOT NULL,
  -- Optional extras offered to the client. JSON array of
  -- {line_code, description, blurb}
  optional_extras TEXT   NOT NULL DEFAULT '[]',
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_templates_job_type ON quote_templates(job_type, version);

-- PriceBook: the ONLY source of money in the system. The AI never writes here
-- and never returns a price; it returns quantities that get priced from this table.
CREATE TABLE price_book (
  code         TEXT PRIMARY KEY,
  description  TEXT NOT NULL,
  category     TEXT NOT NULL CHECK (category IN ('labour','material','plant','other')),
  unit         TEXT NOT NULL,
  unit_cost    REAL NOT NULL CHECK (unit_cost >= 0),
  unit_price   REAL NOT NULL CHECK (unit_price >= 0),
  source       TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','supplier_sync')),
  last_updated TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE quotes (
  id             TEXT PRIMARY KEY,
  public_token   TEXT NOT NULL UNIQUE,      -- unguessable; the client's link
  template_id    TEXT REFERENCES quote_templates(id),
  job_type       TEXT NOT NULL,
  client_name    TEXT NOT NULL,
  client_email   TEXT,
  site_address   TEXT,
  -- The owner's own brief: typed or dictated on site, and the AI's input. It is
  -- working notes, so it is never shown to the client.
  description    TEXT NOT NULL DEFAULT '',
  -- What the client actually reads. Owner-written plain language; empty is fine,
  -- since the scope list already spells the job out.
  client_summary TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'draft'
                 CHECK (status IN ('draft','sent','viewed','accepted','expired')),
  -- Money, recomputed server-side on every write. Never trusted from the client.
  subtotal_cost  REAL NOT NULL DEFAULT 0,
  subtotal_price REAL NOT NULL DEFAULT 0,
  margin_pct     REAL NOT NULL DEFAULT 0,
  margin_floor   REAL NOT NULL DEFAULT 0,
  target_margin  REAL NOT NULL DEFAULT 0,
  -- Set only when an owner knowingly sends below the floor. Audit trail.
  override_reason TEXT,
  ai_summary     TEXT,                      -- JSON: assumptions, flags, past-job refs
  valid_until    TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at        TEXT,
  accepted_at    TEXT
);
CREATE INDEX idx_quotes_status ON quotes(status);

CREATE TABLE quote_line_items (
  id          TEXT PRIMARY KEY,
  quote_id    TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL DEFAULT 0,
  line_code   TEXT,                          -- resolves against price_book
  description TEXT NOT NULL,
  quantity    REAL NOT NULL CHECK (quantity > 0),
  unit        TEXT NOT NULL,
  unit_cost   REAL NOT NULL DEFAULT 0,
  unit_price  REAL NOT NULL DEFAULT 0,
  category    TEXT NOT NULL DEFAULT 'other',
  -- 'base' counts toward the quote total; 'extra' is client-toggleable.
  kind        TEXT NOT NULL DEFAULT 'base' CHECK (kind IN ('base','extra')),
  blurb       TEXT,                          -- client-facing plain-language line
  selected    INTEGER NOT NULL DEFAULT 0,    -- extras only: client toggled it on
  -- Provenance, straight from the AI output contract.
  source      TEXT NOT NULL DEFAULT 'owner_entered'
              CHECK (source IN ('owner_entered','explicit_in_description','ai_inferred','template_default')),
  confidence  TEXT CHECK (confidence IN ('high','medium','low')),
  note        TEXT,
  -- The tap-to-confirm gate. AI-sourced lines land unconfirmed (amber dot).
  confirmed   INTEGER NOT NULL DEFAULT 1,
  locked      INTEGER NOT NULL DEFAULT 0     -- owner-locked; AI must not overwrite
);
CREATE INDEX idx_line_items_quote ON quote_line_items(quote_id, kind, position);

-- Powers engagement tracking (§6.3) and the audit trail.
CREATE TABLE quote_events (
  id         TEXT PRIMARY KEY,
  quote_id   TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  meta       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_events_quote ON quote_events(quote_id, created_at);

-- "Accept & Book" auto-creates the job; quote line items become its budget baseline.
CREATE TABLE jobs (
  id              TEXT PRIMARY KEY,
  quote_id        TEXT NOT NULL REFERENCES quotes(id),
  client_name     TEXT NOT NULL,
  site_address    TEXT,
  job_type        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'booked',
  budget_baseline REAL NOT NULL,            -- quoted price, for quoted-vs-actual
  cost_baseline   REAL NOT NULL,            -- quoted cost, for variance tracking
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_jobs_quote ON jobs(quote_id);
