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
