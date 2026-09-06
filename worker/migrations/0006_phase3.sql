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
