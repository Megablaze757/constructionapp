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
