/* ------------------------------------------------------------------------- *
 * GENERATED FILE — DO NOT EDIT.
 * Built by worker/scripts/build-generated.mjs from worker/src/automation.js.
 * Edit the source and run: npm run build:generated
 * ------------------------------------------------------------------------- */

/**
 * Automation engine (BuilderOS Phase 3, system spec §4).
 *
 *     WHEN [trigger]  IF [conditions]  THEN [actions]
 *
 * The engine is a **pure function of state**: given the world as it is today and
 * a set of rules, it returns the actions that should happen. It does not listen
 * for events, which matters more than it sounds — an event bus only knows about
 * things that happened while it was running, whereas "this invoice is 14 days
 * overdue" is true whether or not anything was listening on day 14.
 *
 * Nothing here writes, sends, or has any side effect. Deciding and doing are
 * separated so the decisions can be tested exhaustively, and so a dry run is
 * genuinely the same code path as a real one.
 */

import { daysBetween } from './invoicing.js';

/* ------------------------------------------------------------- triggers */

/**
 * Every trigger takes the world and returns candidate firings, each with the
 * context an action will be rendered against and a `bucket` that makes the
 * firing unique.
 */
export const TRIGGERS = {
  /** An invoice that has been unpaid for at least N days past its due date. */
  invoice_overdue: {
    label: 'An invoice goes N days overdue',
    entity: 'invoice',
    params: [{ key: 'days', label: 'Days overdue', type: 'number', default: 7 }],
    find(world, config) {
      const days = Number(config.days) || 7;
      return world.invoices
        .filter((i) => i.status === 'sent' && (i.amount - (i.amount_paid || 0)) > 0.005 && i.due_on)
        .map((i) => ({ inv: i, late: daysBetween(i.due_on, world.today) }))
        // At least N, not exactly N: a scheduler that misses a day must not
        // silently skip the chase forever.
        .filter(({ late }) => late !== null && late >= days)
        .map(({ inv, late }) => ({
          entity_type: 'invoice',
          entity_id: inv.id,
          bucket: `overdue_${days}`,
          context: {
            invoice_number: inv.number,
            client_name: inv.client_name,
            amount: money(inv.amount - (inv.amount_paid || 0)),
            amount_value: inv.amount - (inv.amount_paid || 0),
            due_date: inv.due_on,
            days_overdue: late,
            job_id: inv.job_id,
          },
        }));
    },
  },

  /** A job carrying one or more risk reasons. */
  job_at_risk: {
    label: 'A job becomes at risk',
    entity: 'job',
    params: [],
    find(world) {
      return world.risks.map((r) => ({
        entity_type: 'job',
        entity_id: r.job_id,
        // Keyed on the reasons themselves, so a job that develops a *new*
        // problem is reported again rather than staying silent because it was
        // already known to be struggling.
        bucket: `risk_${r.reasons.map((x) => x.code).sort().join('-')}`,
        context: {
          client_name: r.client_name,
          site_address: r.site_address || r.client_name,
          risk_reasons: r.reasons.map((x) => x.text).join(', '),
          risk_count: r.reasons.length,
          job_id: r.job_id,
        },
      }));
    },
  },

  /** A scheduled client touchpoint that has come due. */
  checkin_due: {
    label: 'A client check-in falls due',
    entity: 'checkin',
    params: [],
    find(world) {
      return world.checkins
        .filter((c) => c.status === 'due' && c.due_on && daysBetween(c.due_on, world.today) >= 0)
        .map((c) => ({
          entity_type: 'checkin',
          entity_id: c.id,
          bucket: 'due',
          context: {
            milestone: c.milestone,
            client_name: c.client_name,
            site_address: c.site_address || c.client_name,
            due_date: c.due_on,
            job_id: c.job_id,
          },
        }));
    },
  },

  /** Somebody joined and has no onboarding task. */
  person_added: {
    label: 'Someone joins and is not onboarded',
    entity: 'person',
    params: [{ key: 'days', label: 'Within the last N days', type: 'number', default: 7 }],
    find(world, config) {
      const days = Number(config.days) || 7;
      return world.people
        .filter((p) => {
          const age = daysBetween(String(p.created_at).slice(0, 10), world.today);
          return age !== null && age <= days && !world.onboardedPersonIds.has(p.id);
        })
        .map((p) => ({
          entity_type: 'person',
          entity_id: p.id,
          bucket: 'onboarding',
          context: { person_name: p.name, person_role: p.role || p.kind, person_id: p.id },
        }));
    },
  },

  /** A job just finished. */
  job_completed: {
    label: 'A job is marked complete',
    entity: 'job',
    params: [],
    find(world) {
      return world.jobs
        .filter((j) => j.status === 'complete')
        .map((j) => ({
          entity_type: 'job',
          entity_id: j.id,
          bucket: 'completed',
          context: {
            client_name: j.client_name,
            site_address: j.site_address || j.client_name,
            job_id: j.id,
          },
        }));
    },
  },

  /** A task that has run past its grace window. */
  task_escalated: {
    label: 'A task escalates past its grace window',
    entity: 'task',
    params: [],
    find(world) {
      return world.escalatedTasks.map((t) => ({
        entity_type: 'task',
        entity_id: t.id,
        bucket: `late_${t.days_late}`,
        context: {
          task_title: t.title,
          person_name: t.person_name || 'nobody',
          days_late: t.days_late,
          site_address: t.site_address || t.client_name || '',
          job_id: t.job_id,
        },
      }));
    },
  },
};

/* ----------------------------------------------------------- conditions */

const OPS = {
  '>': (a, b) => Number(a) > Number(b),
  '>=': (a, b) => Number(a) >= Number(b),
  '<': (a, b) => Number(a) < Number(b),
  '<=': (a, b) => Number(a) <= Number(b),
  '==': (a, b) => String(a) === String(b),
  '!=': (a, b) => String(a) !== String(b),
  contains: (a, b) => String(a ?? '').toLowerCase().includes(String(b).toLowerCase()),
};

export function conditionsPass(conditions, context) {
  if (!Array.isArray(conditions) || !conditions.length) return true;
  return conditions.every((c) => {
    const op = OPS[c.op];
    // An unknown operator blocks the rule rather than firing it. A rule nobody
    // can read should do nothing, not something arbitrary.
    if (!op) return false;
    return op(context[c.field], c.value);
  });
}

/* ------------------------------------------------------------- actions */

export const ACTIONS = {
  notify_owner: { label: 'Alert me', fields: ['message'] },
  message_client: { label: 'Message the client', fields: ['channel', 'message'] },
  message_person: { label: 'Message a team member', fields: ['channel', 'message'] },
  create_task: { label: 'Create a task', fields: ['title', 'due_in_days', 'needs_photo'] },
  flag_job: { label: 'Flag it on the job log', fields: ['message'] },
};

/** Fill {placeholders} from the trigger context. */
export function renderTemplate(text, context) {
  return String(text ?? '').replace(/\{(\w+)\}/g, (whole, key) => (
    // An unknown placeholder is left visible rather than blanked, so a broken
    // template looks broken instead of quietly sending half a sentence.
    context[key] === undefined || context[key] === null ? whole : String(context[key])
  ));
}

/* -------------------------------------------------------------- engine */

/**
 * Decide what should happen. Pure — no writes, no sends.
 *
 * @param {Array}  automations  enabled rules
 * @param {object} world        state snapshot
 * @param {Set}    firedKeys    dedupe keys already recorded
 * @returns {{plans: Array, skipped: number}}
 */
export function planActions(automations, world, firedKeys) {
  const plans = [];
  let skipped = 0;

  for (const rule of automations) {
    if (!rule.enabled) continue;
    const trigger = TRIGGERS[rule.trigger_type];
    if (!trigger) continue;

    for (const hit of trigger.find(world, rule.trigger_config || {})) {
      const context = { ...world.globals, ...hit.context };
      if (!conditionsPass(rule.conditions, context)) continue;

      const dedupe_key = `${rule.id}:${hit.entity_id}:${hit.bucket}`;
      if (firedKeys.has(dedupe_key)) { skipped += 1; continue; }

      plans.push({
        automation_id: rule.id,
        automation_name: rule.name,
        dedupe_key,
        entity_type: hit.entity_type,
        entity_id: hit.entity_id,
        context,
        actions: (rule.actions || []).map((a) => renderAction(a, context)),
      });
    }
  }

  return { plans, skipped };
}

function renderAction(action, context) {
  const out = { ...action };
  for (const field of ['message', 'title', 'subject']) {
    if (out[field]) out[field] = renderTemplate(out[field], context);
  }
  return out;
}

/** Validate a rule before it is stored, so a broken one cannot sit there silently. */
export function validateAutomation(rule) {
  const errors = [];
  if (!String(rule.name || '').trim()) errors.push('A rule needs a name.');
  if (!TRIGGERS[rule.trigger_type]) errors.push(`Unknown trigger "${rule.trigger_type}".`);
  if (!Array.isArray(rule.actions) || !rule.actions.length) {
    errors.push('A rule needs at least one action.');
  } else {
    rule.actions.forEach((a, i) => {
      if (!ACTIONS[a.type]) errors.push(`Action ${i + 1}: unknown type "${a.type}".`);
      else if (ACTIONS[a.type].fields.includes('message') && !String(a.message || '').trim()) {
        errors.push(`Action ${i + 1}: needs a message.`);
      } else if (a.type === 'create_task' && !String(a.title || '').trim()) {
        errors.push(`Action ${i + 1}: needs a task title.`);
      }
      if (a.channel && !['sms', 'whatsapp', 'email'].includes(a.channel)) {
        errors.push(`Action ${i + 1}: unknown channel "${a.channel}".`);
      }
    });
  }
  for (const c of rule.conditions || []) {
    if (!OPS[c.op]) errors.push(`Unknown condition operator "${c.op}".`);
  }
  return errors;
}

const money = (n) => `£${(Math.round((Number(n) || 0) * 100) / 100).toLocaleString('en-GB')}`;
