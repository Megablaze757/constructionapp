/**
 * Delegation (BuilderOS Phase 1).
 *
 * The roadmap's goal is that the owner stops being the bottleneck. The rule that
 * makes that real is in the system spec §6.2: escalate to the owner **only** if a
 * task is overdue past a grace window. A system that pings the owner about every
 * task has simply moved the bottleneck into their notifications.
 */

/** Days between two ISO dates, positive when `later` is after `earlier`. */
export function daysBetween(earlier, later) {
  if (!earlier || !later) return null;
  const a = Date.parse(`${String(earlier).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(later).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * Live state of a task.
 * @param {object} task  row from `tasks`
 * @param {string} today ISO date, injected so the maths stays testable
 */
export function taskState(task, today) {
  // A task needing photo proof is not done without one, however it was ticked —
  // the same rule the SOP checklists enforce, for the same reason.
  const proofMissing = task.status === 'done' && !!task.needs_photo && !task.photo_id;
  const done = task.status === 'done' && !proofMissing;
  const open = task.status === 'open' || proofMissing;

  const daysLate = open && task.due_on ? Math.max(0, daysBetween(task.due_on, today)) : 0;
  const grace = Number.isFinite(task.grace_days) ? task.grace_days : 2;

  return {
    ...task,
    done,
    awaiting_photo: proofMissing,
    overdue: open && daysLate > 0,
    days_late: daysLate,
    // The whole point: the owner hears about it only once the assignee has had
    // their grace window and still not done it.
    escalated: open && daysLate > grace,
    unassigned: !task.person_id && task.status === 'open',
  };
}

/**
 * What the owner actually needs to look at.
 *
 * Deliberately narrow. Everything else is somebody else's job, which is the
 * entire premise of the phase.
 */
export function ownerAttention(tasks, logs, today) {
  const states = tasks.map((t) => taskState(t, today));

  return {
    escalated: states
      .filter((t) => t.escalated)
      .sort((a, b) => b.days_late - a.days_late),
    unassigned: states.filter((t) => t.unassigned),
    awaiting_photo: states.filter((t) => t.awaiting_photo),
    // Issues and delays the owner has not yet acknowledged. Routine progress
    // never appears here — that is the record, not a request.
    unread_issues: (logs || [])
      .filter((l) => ['issue', 'delay', 'safety'].includes(l.kind) && !l.acknowledged_at)
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))),
  };
}

/** Progress across a job's tasks. */
export function taskProgress(tasks, today) {
  const states = tasks.map((t) => taskState(t, today));
  const live = states.filter((t) => t.status !== 'cancelled');
  const done = live.filter((t) => t.done).length;
  return {
    total: live.length,
    done,
    open: live.length - done,
    overdue: live.filter((t) => t.overdue).length,
    escalated: live.filter((t) => t.escalated).length,
    percent: live.length ? Math.round((done / live.length) * 100) : 0,
  };
}

/* ------------------------------------------------------------ client care */

/**
 * The touchpoints a job gets, from the system spec §7.2: not just at sale and
 * completion, but through the life of the job.
 *
 * Dates are derived from the job's own targets. A job with no dates still gets
 * the milestones, just undated — better to have an unscheduled reminder than to
 * silently skip client contact because nobody filled in a date.
 */
export function plannedCheckins(job) {
  const start = job.target_start || null;
  const end = job.target_end || null;
  const mid = start && end ? midpoint(start, end) : null;

  return [
    { milestone: 'Before start — confirm the date', due_on: start ? addDays(start, -3) : null },
    { milestone: 'First day on site', due_on: start },
    { milestone: 'Midway progress update', due_on: mid },
    { milestone: 'Completion and handover', due_on: end },
    { milestone: 'Follow-up — review and referral', due_on: end ? addDays(end, 7) : null },
  ];
}

export function addDays(iso, days) {
  const t = Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(t)) return null;
  return new Date(t + days * 86400000).toISOString().slice(0, 10);
}

function midpoint(a, b) {
  const ta = Date.parse(`${a.slice(0, 10)}T00:00:00Z`);
  const tb = Date.parse(`${b.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return null;
  return new Date(ta + (tb - ta) / 2).toISOString().slice(0, 10);
}

/** Check-ins that have come due and still have not happened. */
export function overdueCheckins(checkins, today) {
  return (checkins || [])
    .filter((c) => c.status === 'due' && c.due_on && daysBetween(c.due_on, today) > 0)
    .map((c) => ({ ...c, days_late: daysBetween(c.due_on, today) }))
    .sort((a, b) => b.days_late - a.days_late);
}

/* ------------------------------------------------------- role-based SOPs */

/**
 * Which SOPs a given person should see for a given job.
 *
 * Staff see what applies to them, not the whole manual (system spec §5.2). An
 * SOP with no role applies to everyone; one with no job_type applies to every
 * job. Anything scoped to a different role or a different job type is noise to
 * this person right now.
 */
export function visibleSops(sops, { role, jobType } = {}) {
  const normalise = (s) => String(s || '').trim().toLowerCase();
  const personRole = normalise(role);

  return (sops || []).filter((s) => {
    if (s.job_type && jobType && s.job_type !== jobType) return false;
    if (s.job_type && !jobType) return false;
    if (!s.role) return true;
    // With no role recorded for the person, show only the universal ones rather
    // than guessing which specialism they belong to.
    if (!personRole) return false;
    return normalise(s.role) === personRole;
  });
}
