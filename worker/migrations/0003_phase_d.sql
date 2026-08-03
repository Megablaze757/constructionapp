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
