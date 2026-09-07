-- GENERATED FILE — DO NOT EDIT. Built from worker/migrations/ by
-- worker/scripts/build-generated.mjs. Run: npm run build:generated
--
-- GitHub Pages publishes web/ only, so the browser fallback cannot reach the
-- migrations where they live. This is the same SQL, concatenated in order.

-- ===== 0001_init.sql =====
-- Auto-Quoting module — D1 schema.
-- Mirrors the data model in docs/auto-quoting/README.md §8.

-- Dependents first. Everything below holds a foreign key into jobs or quotes, so
-- dropping those before these would fail with enforcement on. They are created
-- in later migrations; dropping them here keeps a full re-run a clean reset
-- rather than leaving orphaned rows behind to skew reports — or colliding with
-- seeded ids the second time round.
DROP TABLE IF EXISTS automation_runs;  -- 0006
DROP TABLE IF EXISTS outbox;           -- 0006
DROP TABLE IF EXISTS automations;      -- 0006
DROP TABLE IF EXISTS tasks;            -- 0005
DROP TABLE IF EXISTS site_logs;        -- 0005
DROP TABLE IF EXISTS job_photos;       -- 0005
DROP TABLE IF EXISTS client_checkins;  -- 0005
DROP TABLE IF EXISTS job_costs;        -- 0003
DROP TABLE IF EXISTS quote_photos;     -- 0003
DROP TABLE IF EXISTS job_assignments;  -- 0004
DROP TABLE IF EXISTS job_sops;         -- 0004
DROP TABLE IF EXISTS invoices;         -- 0004
DROP TABLE IF EXISTS people;           -- 0004
DROP TABLE IF EXISTS sops;             -- 0004
DROP TABLE IF EXISTS jobs_new;         -- 0004, if its table rebuild was interrupted
DROP TABLE IF EXISTS job_costs_backup; -- 0004, likewise
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
              CHECK (source IN ('owner_entered','explicit_in_description','ai_inferred','photo_inferred','template_default')),
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

-- ===== 0002_seed.sql =====
-- Starter template + price book.
-- Deliberately tuned so the seeded demo reproduces the wireframe in
-- docs/auto-quoting/ui-and-ai-spec.md §1.1 exactly: 45m² erect + 5 days hire +
-- dismantle = £1,835 at 32% margin against a 30% target.

INSERT INTO price_book (code, description, category, unit, unit_cost, unit_price) VALUES
  ('scaffold_erect',    'Scaffold erect',              'labour',   'm2',    18.50,  27.00),
  ('scaffold_hire',     'Scaffold hire',               'plant',    'days',  40.00,  68.00),
  ('scaffold_dismantle','Dismantle',                   'labour',   'job',  215.00, 280.00),
  ('gutter_clearance',  'Gutter clearance',            'labour',   'job',  110.00, 180.00),
  ('extra_lift',        'Extra lift',                  'labour',   'job',  140.00, 210.00),
  ('permit_road',       'Road closure / permit',       'other',    'job',  180.00, 240.00),
  ('waste_removal',     'Waste removal',               'other',    'job',   95.00, 150.00),
  ('roof_strip',        'Strip existing roof covering','labour',   'm2',    22.00,  34.00),
  ('roof_tile',         'Re-tile roof',                'material', 'm2',    41.00,  62.00),
  ('labourer_day',      'Labourer day rate',           'labour',   'days', 145.00, 220.00),
  ('site_lead_day',     'Site lead day rate',          'labour',   'days', 210.00, 310.00);

INSERT INTO quote_templates
  (id, job_type, name, default_margin, margin_floor, validity_days, terms, exclusions, line_items, optional_extras)
VALUES (
  'tpl_domestic_scaffold',
  'domestic_scaffold_erect',
  'Domestic Scaffold Erect',
  30.0,
  25.0,
  30,
  'Payment due 14 days from invoice. Scaffold remains our property throughout the hire period.',
  'Excludes road closure permits, ground works, and out-of-hours access unless stated.',
  json('[
    {"line_code":"scaffold_erect","description":"Scaffold erect","unit":"m2","default_quantity":null,"always_include":true,"locked":false},
    {"line_code":"scaffold_hire","description":"Scaffold hire","unit":"days","default_quantity":7,"always_include":true,"locked":false},
    {"line_code":"scaffold_dismantle","description":"Dismantle","unit":"job","default_quantity":1,"always_include":true,"locked":false},
    {"line_code":"permit_road","description":"Road closure / permit","unit":"job","default_quantity":1,"always_include":false,"locked":false},
    {"line_code":"waste_removal","description":"Waste removal","unit":"job","default_quantity":1,"always_include":false,"locked":false}
  ]'),
  json('[
    {"line_code":"gutter_clearance","description":"Gutter clearance","blurb":"Clear & flush all gutters while scaffold is up"},
    {"line_code":"extra_lift","description":"Extra lift","blurb":"Access to chimney level"}
  ]')
);

INSERT INTO quote_templates
  (id, job_type, name, default_margin, margin_floor, validity_days, terms, exclusions, line_items, optional_extras)
VALUES (
  'tpl_reroof',
  'domestic_reroof',
  'Domestic Re-roof',
  35.0,
  28.0,
  30,
  'Payment due 14 days from invoice. 50% materials deposit on booking.',
  'Excludes structural timber replacement, discovered on strip-back and quoted separately.',
  json('[
    {"line_code":"roof_strip","description":"Strip existing roof covering","unit":"m2","default_quantity":null,"always_include":true,"locked":false},
    {"line_code":"roof_tile","description":"Re-tile roof","unit":"m2","default_quantity":null,"always_include":true,"locked":false},
    {"line_code":"waste_removal","description":"Waste removal","unit":"job","default_quantity":1,"always_include":true,"locked":false},
    {"line_code":"scaffold_erect","description":"Scaffold erect","unit":"m2","default_quantity":null,"always_include":false,"locked":false}
  ]'),
  json('[
    {"line_code":"gutter_clearance","description":"Gutter clearance","blurb":"New gutters cleared and flushed on completion"}
  ]')
);

-- Completed jobs, used only as a scale sanity-check for the AI (§2.2 "last 5 similar jobs")
-- and later as the seed of the quoted-vs-actual learning loop.
INSERT INTO quotes (id, public_token, template_id, job_type, client_name, site_address,
                    description, status, subtotal_cost, subtotal_price, margin_pct,
                    margin_floor, target_margin, valid_until, created_at, sent_at, accepted_at)
VALUES
  ('q_seed_vine','tok_seed_vine','tpl_domestic_scaffold','domestic_scaffold_erect',
   'M. Okafor','22 Vine Rd','Scaffold erect to rear, 2 lifts','accepted',
   1330.0,1780.0,25.3,25.0,30.0,'2026-06-01','2026-05-02','2026-05-02','2026-05-04'),
  ('q_seed_ash','tok_seed_ash','tpl_domestic_scaffold','domestic_scaffold_erect',
   'D. Whitfield','8 Ashfield Cl','Side elevation scaffold, single lift','accepted',
   1010.0,1420.0,28.9,25.0,30.0,'2026-06-14','2026-05-15','2026-05-15','2026-05-18');

-- The quoted lines behind those two jobs. Rates are held on the line rather than
-- read from today's price book, because a historical quote is a snapshot — rates
-- move, and a past job must not silently reprice itself.
INSERT INTO quote_line_items
  (id, quote_id, position, line_code, description, quantity, unit, unit_cost, unit_price, category, kind, source, confidence, confirmed)
VALUES
  ('li_seed_v1','q_seed_vine',0,'scaffold_erect',    'Scaffold erect',45,'m2',  19.50, 26.00,'labour','base','owner_entered','high',1),
  ('li_seed_v2','q_seed_vine',1,'scaffold_hire',     'Scaffold hire',  5,'days',45.00, 68.00,'plant', 'base','owner_entered','high',1),
  ('li_seed_v3','q_seed_vine',2,'scaffold_dismantle','Dismantle',      1,'job',227.50,270.00,'labour','base','owner_entered','high',1),
  ('li_seed_a1','q_seed_ash', 0,'scaffold_erect',    'Scaffold erect',32,'m2',  19.50, 26.00,'labour','base','owner_entered','high',1),
  ('li_seed_a2','q_seed_ash', 1,'scaffold_hire',     'Scaffold hire',  4,'days',45.00, 68.00,'plant', 'base','owner_entered','high',1),
  ('li_seed_a3','q_seed_ash', 2,'scaffold_dismantle','Dismantle',      1,'job',206.00,316.00,'labour','base','owner_entered','high',1);

INSERT INTO jobs (id, quote_id, client_name, site_address, job_type, status, budget_baseline, cost_baseline)
VALUES
  ('job_seed_vine','q_seed_vine','M. Okafor','22 Vine Rd','domestic_scaffold_erect','complete',1780.0,1330.0),
  ('job_seed_ash','q_seed_ash','D. Whitfield','8 Ashfield Cl','domestic_scaffold_erect','complete',1420.0,1010.0);

-- ===== 0003_phase_d.sql =====
-- Phase D: the learning loop.
--
-- Until now a job carried only its *quoted* cost. Nothing recorded what the job
-- actually cost, so "similar past jobs" fed the AI quoted-vs-quoted — which can
-- never teach it anything. These tables capture reality and let it be compared
-- against the estimate.

-- Actual costs booked against a job as it runs.
CREATE TABLE IF NOT EXISTS job_costs (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  -- Optional link back to the quoted line this cost belongs to. When present,
  -- it gives per-line-code variance ("scaffold erect runs 9% over"), which is
  -- what actually improves future estimates. When absent the cost still counts
  -- toward the job total.
  line_code   TEXT,
  description TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'other'
              CHECK (category IN ('labour','material','plant','other')),
  quantity    REAL,
  unit        TEXT,
  amount      REAL NOT NULL CHECK (amount >= 0),   -- actual cost, £
  incurred_on TEXT NOT NULL DEFAULT (date('now')),
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_job_costs_job ON job_costs(job_id, incurred_on);
CREATE INDEX IF NOT EXISTS idx_job_costs_code ON job_costs(line_code);

-- Jobs gain a completion date so the variance report can be scoped by period.
ALTER TABLE jobs ADD COLUMN completed_at TEXT;

-- Site photos. Stored in D1 rather than R2 to keep deployment to a single
-- binding; the browser downscales before upload, so rows stay small. R2 is the
-- upgrade path once photo volume justifies a second service.
CREATE TABLE IF NOT EXISTS quote_photos (
  id          TEXT PRIMARY KEY,
  quote_id    TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL DEFAULT 0,
  mime        TEXT NOT NULL,
  bytes       BLOB NOT NULL,
  width       INTEGER,
  height      INTEGER,
  caption     TEXT,
  -- Whether the client sees it on the quote page. Off by default: an owner's
  -- working shot of a defect is not automatically marketing material.
  show_client INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_photos_quote ON quote_photos(quote_id, position);

-- Backfill the seeded demo jobs with plausible actuals so the variance report
-- and the AI's reference data have something real to work with on a fresh install.
-- Tuned to show the loop doing its job: erect labour ran ~12% over on both jobs,
-- which is enough for the bias check to call it and brief the assistant, while
-- hire and dismantle sit close enough to the quote to be noise.
INSERT INTO job_costs (id, job_id, line_code, description, category, quantity, unit, amount, incurred_on) VALUES
  ('jc_seed_1','job_seed_vine','scaffold_erect',    'Erect labour, 2.5 days','labour',  45, 'm2',   980.00,'2026-05-06'),
  ('jc_seed_2','job_seed_vine','scaffold_hire',     'Hire, 5 days',          'plant',    5, 'days', 245.00,'2026-05-13'),
  ('jc_seed_3','job_seed_vine','scaffold_dismantle','Dismantle',             'labour',   1, 'job',  225.00,'2026-05-14'),
  ('jc_seed_4','job_seed_ash', 'scaffold_erect',    'Erect labour',          'labour',  32, 'm2',   700.00,'2026-05-19'),
  ('jc_seed_5','job_seed_ash', 'scaffold_hire',     'Hire, 4 days',          'plant',    4, 'days', 190.00,'2026-05-24'),
  ('jc_seed_6','job_seed_ash', 'scaffold_dismantle','Dismantle',             'labour',   1, 'job',  175.00,'2026-05-25');

UPDATE jobs SET completed_at = '2026-05-14' WHERE id = 'job_seed_vine';
UPDATE jobs SET completed_at = '2026-05-25' WHERE id = 'job_seed_ash';

-- ===== 0004_phase0.sql =====
-- BuilderOS Phase 0 — Foundation.
--
-- Goal from the roadmap: the owner can see every active job and who is on it in
-- one place. That needs three things quoting never provided — people, written
-- systems, and money owed — plus jobs that exist independently of a quote.

/* -------------------------------------------------- jobs: rebuild in place */

-- Done FIRST, before the new child tables exist, and with `job_costs` parked out
-- of the way.
--
-- SQLite performs an implicit DELETE when dropping a table while foreign keys
-- are enforced, and that DELETE fires ON DELETE CASCADE on every child. Dropping
-- `jobs` therefore wipes `job_costs` — silently, with the migration reporting
-- success. Moving the rows aside first is the only thing standing between this
-- migration and every recorded actual cost in the business.
DROP TABLE IF EXISTS job_costs_backup;
CREATE TABLE job_costs_backup AS SELECT * FROM job_costs;
DELETE FROM job_costs;

-- Two changes SQLite cannot make with ALTER: quote_id must become nullable (a
-- builder's existing jobs did not come from a quote in this app), and the
-- baselines must default to 0 for a job that was never quoted here.
DROP TABLE IF EXISTS jobs_new;
CREATE TABLE jobs_new (
  id              TEXT PRIMARY KEY,
  quote_id        TEXT REFERENCES quotes(id),       -- nullable: manually created jobs
  client_name     TEXT NOT NULL,
  site_address    TEXT,
  job_type        TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'booked'
                  CHECK (status IN ('booked','in_progress','complete','on_hold')),
  budget_baseline REAL NOT NULL DEFAULT 0,
  cost_baseline   REAL NOT NULL DEFAULT 0,
  target_start    TEXT,
  target_end      TEXT,
  notes           TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at    TEXT
);

INSERT INTO jobs_new (id, quote_id, client_name, site_address, job_type, status,
                      budget_baseline, cost_baseline, created_at, completed_at)
  SELECT id, quote_id, client_name, site_address, job_type, status,
         budget_baseline, cost_baseline, created_at, completed_at
    FROM jobs;

DROP TABLE jobs;
ALTER TABLE jobs_new RENAME TO jobs;
CREATE INDEX IF NOT EXISTS idx_jobs_quote ON jobs(quote_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, target_start);

-- Costs go back now that their parent rows exist again.
INSERT INTO job_costs SELECT * FROM job_costs_backup;
DROP TABLE job_costs_backup;

/* ---------------------------------------------------------------- people */

-- Staff and subcontractors share a table: from the owner's point of view the
-- question is always "who is on this job and can I rely on them", and the answer
-- should not depend on which side of the payroll they sit.
CREATE TABLE IF NOT EXISTS people (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'staff' CHECK (kind IN ('staff','subcontractor')),
  trade      TEXT,                                  -- scaffolder, roofer, labourer…
  role       TEXT,                                  -- site lead, labourer, office admin
  phone      TEXT,
  email      TEXT,
  day_rate   REAL,
  notes      TEXT,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_people_active ON people(active, name);

CREATE TABLE IF NOT EXISTS job_assignments (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  person_id   TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  role_on_job TEXT,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (job_id, person_id)
);
CREATE INDEX IF NOT EXISTS idx_assignments_job ON job_assignments(job_id);

/* ------------------------------------------------------------------ SOPs */

-- The library: how this business does a thing, written down once.
CREATE TABLE IF NOT EXISTS sops (
  id         TEXT PRIMARY KEY,
  title      TEXT NOT NULL,
  category   TEXT NOT NULL DEFAULT 'general',
  job_type   TEXT,                                  -- null = applies to any job
  role       TEXT,                                  -- null = applies to any role
  version    INTEGER NOT NULL DEFAULT 1,
  -- JSON array of {text, needs_photo}
  steps      TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sops_job_type ON sops(job_type, role);

-- A checklist attached to a job. Steps are copied in rather than referenced, so
-- editing the library later cannot rewrite what someone already signed off.
CREATE TABLE IF NOT EXISTS job_sops (
  id          TEXT PRIMARY KEY,
  job_id      TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  sop_id      TEXT REFERENCES sops(id),
  title       TEXT NOT NULL,
  sop_version INTEGER NOT NULL DEFAULT 1,
  -- JSON array of {text, needs_photo, done, done_at, done_by}
  steps       TEXT NOT NULL DEFAULT '[]',
  attached_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_job_sops_job ON job_sops(job_id);

/* -------------------------------------------------------------- invoices */

CREATE TABLE IF NOT EXISTS invoices (
  id         TEXT PRIMARY KEY,
  job_id     TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  number     TEXT NOT NULL UNIQUE,
  client_name TEXT NOT NULL,
  amount     REAL NOT NULL CHECK (amount >= 0),
  -- Status is derived from the dates wherever possible; 'overdue' is never
  -- stored, because it is a fact about today rather than about the invoice.
  status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','paid','void')),
  issued_on  TEXT,
  due_on     TEXT,
  paid_on    TEXT,
  amount_paid REAL NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  notes      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status, due_on);
CREATE INDEX IF NOT EXISTS idx_invoices_job ON invoices(job_id);

/* ----------------------------------------------------------------- seed */

-- Starter SOPs, one per category in the spec's §5.3 list. Deliberately short:
-- a checklist someone actually completes beats a manual nobody opens.
INSERT INTO sops (id, title, category, job_type, role, steps) VALUES
  ('sop_new_job', 'New job setup', 'setup', NULL, 'site lead', json('[
    {"text":"Confirm start date with the client","needs_photo":false},
    {"text":"Check access, parking and where materials can land","needs_photo":true},
    {"text":"Confirm who on site is the point of contact","needs_photo":false},
    {"text":"Order materials against the quoted list","needs_photo":false},
    {"text":"Brief the crew on scope and finish date","needs_photo":false}
  ]')),
  ('sop_safety', 'Site safety check', 'safety', NULL, NULL, json('[
    {"text":"Walk the site and note hazards","needs_photo":true},
    {"text":"Check everyone has the right PPE","needs_photo":false},
    {"text":"Check public access is safely separated","needs_photo":true},
    {"text":"Confirm first aid kit and emergency numbers on site","needs_photo":false}
  ]')),
  ('sop_scaffold_erect', 'Scaffold erect — handover check', 'quality', 'domestic_scaffold_erect', NULL, json('[
    {"text":"Base plates and sole boards bearing correctly","needs_photo":true},
    {"text":"Ties installed to spec and recorded","needs_photo":true},
    {"text":"Guardrails and toe boards on every working lift","needs_photo":true},
    {"text":"Ladder access secured","needs_photo":true},
    {"text":"Scafftag fitted and signed","needs_photo":true}
  ]')),
  ('sop_materials', 'Materials ordering & delivery', 'materials', NULL, NULL, json('[
    {"text":"Check what is already on site before ordering","needs_photo":false},
    {"text":"Place the order against the quoted quantities","needs_photo":false},
    {"text":"Confirm the delivery slot and who receives it","needs_photo":false},
    {"text":"Check the delivery against the note before signing","needs_photo":true}
  ]')),
  ('sop_handover', 'Client handover', 'handover', NULL, 'site lead', json('[
    {"text":"Walk the finished work with the client","needs_photo":false},
    {"text":"Photograph the completed job","needs_photo":true},
    {"text":"Note any snags the client raises","needs_photo":false},
    {"text":"Confirm the site is left clean and clear","needs_photo":true},
    {"text":"Tell the office the job is ready to invoice","needs_photo":false}
  ]')),
  ('sop_breakdown', 'Vehicle or equipment breakdown', 'incident', NULL, NULL, json('[
    {"text":"Make the situation safe and tell the site lead","needs_photo":false},
    {"text":"Photograph the fault","needs_photo":true},
    {"text":"Call the hire company or garage on the contact list","needs_photo":false},
    {"text":"Tell any affected client the same day","needs_photo":false}
  ]')),
  ('sop_onboarding', 'New staff or sub onboarding', 'onboarding', NULL, NULL, json('[
    {"text":"Collect insurance, qualifications and UTR where relevant","needs_photo":true},
    {"text":"Walk through how we run a site and what we expect","needs_photo":false},
    {"text":"Add to the team directory with contact details","needs_photo":false},
    {"text":"Assign their first job and the SOPs for it","needs_photo":false}
  ]')),
  ('sop_snagging', 'End-of-job snagging & sign-off', 'handover', NULL, NULL, json('[
    {"text":"Walk the job against the quoted scope","needs_photo":false},
    {"text":"List anything outstanding","needs_photo":false},
    {"text":"Fix or schedule each snag","needs_photo":false},
    {"text":"Get the client sign-off","needs_photo":true}
  ]'));

INSERT INTO people (id, name, kind, trade, role, phone, day_rate) VALUES
  ('per_seed_dave', 'Dave Mullen',   'subcontractor', 'scaffolder', 'site lead', '07700 900112', 310.0),
  ('per_seed_kaz',  'Kaz Nowak',     'staff',         'scaffolder', 'labourer',  '07700 900145', 220.0),
  ('per_seed_ellie','Ellie Barnes',  'staff',         NULL,         'office admin', '07700 900178', NULL);

-- ===== 0005_phase1.sql =====
-- BuilderOS Phase 1 — Delegation & Systems Layer.
--
-- Goal from the roadmap: the owner isn't the bottleneck for daily job updates.
-- That needs the crew to be able to log work themselves, which needs three
-- things: a way in that isn't an owner login, tasks that belong to a person, and
-- somewhere to put what happened on site today.
--
-- Additive only. No table is rebuilt here — dropping a parent table while
-- foreign keys are enforced fires ON DELETE CASCADE on its children, which is
-- how 0004 silently deleted every recorded cost the first time it ran.

/* ------------------------------------------------------------ crew access */

-- An unguessable per-person link, exactly like the client quote token. A
-- tradesperson gets sent a URL in WhatsApp and can log work; no account, no
-- password, nothing to forget on a roof in the rain. It is a capability, so it
-- is revocable by rotating the token.
ALTER TABLE people ADD COLUMN access_token TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_people_token ON people(access_token);

/* ------------------------------------------------------------------ tasks */

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  -- Exactly one owner per task (system spec §6.2). Nullable only so a task can
  -- be written before it is handed to someone.
  person_id     TEXT REFERENCES people(id) ON DELETE SET NULL,
  title         TEXT NOT NULL,
  detail        TEXT,
  due_on        TEXT,
  -- Photo proof is a property of the task, decided when it is set.
  needs_photo   INTEGER NOT NULL DEFAULT 0,
  photo_id      TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','cancelled')),
  completed_at  TEXT,
  completed_by  TEXT REFERENCES people(id) ON DELETE SET NULL,
  -- Days past due before it stops being the assignee's problem and becomes the
  -- owner's. Per-task so a safety job can escalate faster than a tidy-up.
  grace_days    INTEGER NOT NULL DEFAULT 2,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_job ON tasks(job_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_person ON tasks(person_id, status, due_on);

/* --------------------------------------------------------------- site log */

CREATE TABLE IF NOT EXISTS site_logs (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  person_id  TEXT REFERENCES people(id) ON DELETE SET NULL,
  -- 'issue' and 'delay' are what the owner needs to see; 'progress' is the
  -- routine record that means they do not have to ask.
  kind       TEXT NOT NULL DEFAULT 'progress'
             CHECK (kind IN ('progress','issue','delay','delivery','safety')),
  body       TEXT NOT NULL,
  photo_id   TEXT,
  -- Set when the owner has read an issue, so the feed can show what is new
  -- without marking routine progress as needing attention.
  acknowledged_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_site_logs_job ON site_logs(job_id, created_at);
CREATE INDEX IF NOT EXISTS idx_site_logs_kind ON site_logs(kind, acknowledged_at);

/* ------------------------------------------------------------- job photos */

-- Separate from quote_photos on purpose: different lifecycle and, more
-- importantly, different access. A quote photo is served to a client over an
-- unguessable link; a job photo is internal evidence and never leaves the
-- owner/crew side.
CREATE TABLE IF NOT EXISTS job_photos (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  uploaded_by TEXT REFERENCES people(id) ON DELETE SET NULL,
  mime       TEXT NOT NULL,
  bytes      BLOB NOT NULL,
  width      INTEGER,
  height     INTEGER,
  caption    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_job_photos_job ON job_photos(job_id, created_at);

/* ---------------------------------------------------------- client care */

-- Scheduled touchpoints through the life of a job, not just at sale and
-- completion (system spec §7.2). Nothing is sent from here — the automation
-- engine is Phase 3 — but the schedule exists and going quiet is now visible.
CREATE TABLE IF NOT EXISTS client_checkins (
  id         TEXT PRIMARY KEY,
  job_id     TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  milestone  TEXT NOT NULL,
  due_on     TEXT,
  status     TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due','done','skipped')),
  note       TEXT,
  done_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_checkins_job ON client_checkins(job_id, status, due_on);

/* ----------------------------------------------------------------- seed */

-- Give the seeded crew their access links so the crew view works on a fresh
-- install. Real tokens are minted by the API; these are obviously fake.
UPDATE people SET access_token = 'crewdemodavemullen00000001' WHERE id = 'per_seed_dave';
UPDATE people SET access_token = 'crewdemokaznowak000000002' WHERE id = 'per_seed_kaz';
UPDATE people SET access_token = 'crewdemoelliebarnes000003' WHERE id = 'per_seed_ellie';

-- ===== 0006_phase3.sql =====
-- BuilderOS Phase 3 — Automation Engine.
--
-- Goal from the roadmap: the owner stops manually chasing invoices and client
-- updates. Everything the engine needs to act on already exists — overdue
-- invoices with chase stages, at-risk detection, check-in schedules. What was
-- missing is the trigger/action layer and somewhere for outbound messages to go.
--
-- Additive only; no table is rebuilt.

/* --------------------------------------------------------- client contact */

-- Without these, an automation can never actually reach a client: the engine
-- would faithfully record "no phone number on file" forever. Carried across
-- from the quote when a job is booked, and editable on the job.
ALTER TABLE jobs ADD COLUMN client_phone TEXT;
ALTER TABLE jobs ADD COLUMN client_email TEXT;

/* ------------------------------------------------------------ automations */

CREATE TABLE IF NOT EXISTS automations (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  -- Set for the pre-built templates from the system spec §4.4, so they can be
  -- recognised, upgraded, and explained. Null for anything the owner builds.
  template_key TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  trigger_type TEXT NOT NULL,
  -- JSON: trigger parameters, e.g. {"days": 7}
  trigger_config TEXT NOT NULL DEFAULT '{}',
  -- JSON array of {field, op, value}. Empty means "always".
  conditions   TEXT NOT NULL DEFAULT '[]',
  -- JSON array of {type, ...params}
  actions      TEXT NOT NULL DEFAULT '[]',
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_automations_enabled ON automations(enabled, trigger_type);

-- One row per (rule, thing, stage) that has already fired.
--
-- This table is the whole reason the engine can be run on a schedule without
-- becoming a nuisance: a "7 days overdue" rule must chase once, not once per
-- hour until it is paid.
CREATE TABLE IF NOT EXISTS automation_runs (
  id            TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  dedupe_key    TEXT NOT NULL UNIQUE,
  entity_type   TEXT NOT NULL,
  entity_id     TEXT,
  actions_taken TEXT NOT NULL DEFAULT '[]',
  fired_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_runs_automation ON automation_runs(automation_id, fired_at);

/* ---------------------------------------------------------------- outbox */

-- Every outbound message, whether or not a provider is wired up.
--
-- With no provider configured the status is 'simulated' — never 'sent'. The
-- owner can read exactly what would have gone out, and the day they connect a
-- provider the same rows start saying 'sent' for real. A system that claims to
-- have texted a client when it did not is worse than one that never texts.
CREATE TABLE IF NOT EXISTS outbox (
  id            TEXT PRIMARY KEY,
  automation_id TEXT REFERENCES automations(id) ON DELETE SET NULL,
  channel       TEXT NOT NULL CHECK (channel IN ('sms','whatsapp','email','owner_alert')),
  recipient     TEXT,
  recipient_name TEXT,
  subject       TEXT,
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'simulated'
                CHECK (status IN ('simulated','queued','sent','failed')),
  provider      TEXT,
  error         TEXT,
  entity_type   TEXT,
  entity_id     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_outbox_status ON outbox(status, created_at);

/* ------------------------------------------------------------------ seed */

-- The pre-built templates from system spec §4.4. Enabled by default except the
-- ones that message a client directly — those are opt-in, because the first time
-- software texts your customer should be a decision you made.
INSERT INTO automations (id, name, template_key, enabled, trigger_type, trigger_config, conditions, actions) VALUES
  ('auto_chase_7', 'Payment chasing — friendly reminder', 'payment_chasing_7', 0,
   'invoice_overdue', json('{"days":7}'), json('[]'),
   json('[{"type":"message_client","channel":"sms","message":"Hi {client_name}, just a gentle nudge that invoice {invoice_number} for {amount} was due on {due_date}. Any problems, give us a shout. Thanks, {business_name}"}]')),

  ('auto_chase_14', 'Payment chasing — firmer reminder', 'payment_chasing_14', 0,
   'invoice_overdue', json('{"days":14}'), json('[]'),
   json('[{"type":"message_client","channel":"sms","message":"Hi {client_name}, invoice {invoice_number} for {amount} is now {days_overdue} days overdue. Could you let us know when we can expect payment? Thanks, {business_name}"}]')),

  ('auto_chase_30', 'Payment chasing — escalate to owner', 'payment_chasing_30', 1,
   'invoice_overdue', json('{"days":30}'), json('[]'),
   json('[{"type":"notify_owner","message":"{client_name} has not paid invoice {invoice_number} ({amount}), now {days_overdue} days overdue. Time to call them."}]')),

  ('auto_job_risk', 'Job risk detection', 'job_risk', 1,
   'job_at_risk', json('{}'), json('[]'),
   json('[{"type":"notify_owner","message":"{site_address} needs a look: {risk_reasons}."}]')),

  ('auto_checkin', 'Client care cadence', 'client_care', 1,
   'checkin_due', json('{}'), json('[]'),
   json('[{"type":"notify_owner","message":"Client check-in due on {site_address}: {milestone}."}]')),

  -- Onboarding is about a person, not a job, so it alerts rather than creating a
  -- task: tasks belong to a job, and there is no job to hang this one on.
  ('auto_onboard', 'New sub or staff onboarding', 'onboarding', 1,
   'person_added', json('{"days":7}'), json('[]'),
   json('[{"type":"notify_owner","message":"{person_name} ({person_role}) has joined and has no work assigned yet — insurance, quals and a first-job brief."}]')),

  ('auto_review', 'Post-completion review request', 'post_completion', 0,
   'job_completed', json('{}'), json('[]'),
   json('[{"type":"message_client","channel":"sms","message":"Hi {client_name}, thanks for having us at {site_address}. If you were happy with the work, a quick review would mean a lot. — {business_name}"}]')),

  ('auto_delegation_nudge', 'Delegation nudge', 'delegation_nudge', 1,
   'task_escalated', json('{}'), json('[]'),
   json('[{"type":"notify_owner","message":"\"{task_title}\" has been sitting with {person_name} for {days_late} days past its date. Chase it, reassign it, or drop it."}]'));
