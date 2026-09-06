/* ------------------------------------------------------------------------- *
 * GENERATED FILE — DO NOT EDIT.
 * Built by worker/scripts/build-generated.mjs from worker/src/reliability.js.
 * Edit the source and run: npm run build:generated
 * ------------------------------------------------------------------------- */

/**
 * Reliability scoring (BuilderOS Phase 2, system spec §6.1).
 *
 * The point of this module is to turn "I have a feeling Dave's been unreliable
 * lately" into something a person can be shown and can argue with. That only
 * works if the score is built from things the system actually observed.
 *
 * The spec lists four inputs. Two of them this system genuinely measures, and
 * two of them it does not:
 *
 *   ✔ job completion vs deadline   — tasks completed on or before their due date
 *   ✔ quality flags / rework       — proxied by photo-proof compliance and by
 *                                    safety/issue logs raised against their jobs
 *   ✘ on-time arrival to site      — nothing here records arrival
 *   ✘ communication responsiveness — no messaging channel exists yet
 *
 * The two that are not measured are reported as gaps rather than folded in with
 * an invented number, because a score that quietly guesses is worse than a score
 * that admits its limits — someone's livelihood may hang off it.
 */

export const MEASURED = [
  'Tasks completed on or before their due date',
  'Tasks that had to be escalated to the owner',
  'Photo proof supplied where the task required it',
];

export const NOT_MEASURED = [
  'On-time arrival to site — nothing records arrival yet',
  'Communication responsiveness — no messaging channel yet',
];

/** Below this, a rate is an anecdote rather than a pattern. */
export const MIN_SAMPLE = 3;

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);

/**
 * Score one person from their task history.
 *
 * @param {object} person
 * @param {Array}  tasks  their tasks (cancelled ones already excluded)
 * @param {string} today  ISO date
 */
export function scorePerson(person, tasks, today) {
  const live = tasks.filter((t) => t.status !== 'cancelled');
  const completed = live.filter((t) => t.status === 'done');

  // A task needing proof is only done if the proof exists — the same rule the
  // rest of the system applies, so the score cannot disagree with the job screen.
  const genuinelyDone = completed.filter((t) => !t.needs_photo || t.photo_id);
  const proofRequired = completed.filter((t) => t.needs_photo);
  const proofSupplied = proofRequired.filter((t) => t.photo_id);

  const withDeadline = genuinelyDone.filter((t) => t.due_on && t.completed_at);
  const onTime = withDeadline.filter(
    (t) => String(t.completed_at).slice(0, 10) <= String(t.due_on).slice(0, 10),
  );

  // Escalations are counted over everything assigned, not just what finished —
  // a task still sitting there weeks late is the clearest signal of all.
  const escalated = live.filter((t) => isEscalated(t, today));

  const on_time_rate = pct(onTime.length, withDeadline.length);
  const escalation_rate = pct(escalated.length, live.length);
  const proof_rate = pct(proofSupplied.length, proofRequired.length);

  const sample = live.length;
  const scored = sample >= MIN_SAMPLE && withDeadline.length > 0;

  return {
    person_id: person.id,
    name: person.name,
    kind: person.kind,
    role: person.role,
    tasks_assigned: sample,
    tasks_done: genuinelyDone.length,
    tasks_open: live.length - genuinelyDone.length,
    on_time: onTime.length,
    with_deadline: withDeadline.length,
    on_time_rate,
    escalations: escalated.length,
    escalation_rate,
    proof_required: proofRequired.length,
    proof_supplied: proofSupplied.length,
    proof_rate,
    // Null rather than a default: "not enough evidence yet" and "average" are
    // very different things to show next to someone's name.
    score: scored ? composite({ on_time_rate, escalation_rate, proof_rate }) : null,
    sample_note: scored
      ? null
      : `Needs at least ${MIN_SAMPLE} assigned tasks with due dates before a score means anything.`,
  };
}

/** Mirrors delegation.taskState, kept local so scoring has no import cycle. */
function isEscalated(task, today) {
  const proofMissing = task.status === 'done' && !!task.needs_photo && !task.photo_id;
  const open = task.status === 'open' || proofMissing;
  if (!open || !task.due_on) return false;
  const a = Date.parse(`${String(task.due_on).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(today).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  const late = Math.round((b - a) / 86400000);
  const grace = Number.isFinite(task.grace_days) ? task.grace_days : 2;
  return late > grace;
}

/**
 * Weighted composite, 0–100.
 *
 * Hitting deadlines carries the most weight because it is what the business
 * actually feels. Escalation is weighted next: needing the owner is the specific
 * failure this system exists to reduce. Photo proof is real but lighter — it is
 * a discipline problem, not a delivery one.
 */
function composite({ on_time_rate, escalation_rate, proof_rate }) {
  const parts = [
    { value: on_time_rate, weight: 50 },
    { value: escalation_rate === null ? null : 100 - escalation_rate, weight: 30 },
    { value: proof_rate, weight: 20 },
  ].filter((p) => p.value !== null);

  // Re-normalise over the parts that exist, so someone who has never been given
  // a photo-proof task is not silently penalised for it.
  const totalWeight = parts.reduce((t, p) => t + p.weight, 0);
  if (!totalWeight) return null;
  return Math.round(parts.reduce((t, p) => t + p.value * p.weight, 0) / totalWeight);
}

/** Leaderboard: scored people first, best first; unscored listed after. */
export function reliabilityBoard(people, tasksByPerson, today) {
  const rows = people.map((p) => scorePerson(p, tasksByPerson.get(p.id) ?? [], today));
  return rows.sort((a, b) => {
    if (a.score === null && b.score === null) return a.name.localeCompare(b.name);
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return b.score - a.score;
  });
}

/**
 * Who is trending toward being a problem.
 *
 * Deliberately conservative: it takes a real sample and a clearly poor record
 * before someone is named, because being flagged by software has consequences
 * for a person's work.
 */
export function reliabilityConcerns(board, { scoreFloor = 60 } = {}) {
  return board
    .filter((r) => r.score !== null && r.score < scoreFloor)
    .map((r) => ({
      person_id: r.person_id,
      name: r.name,
      score: r.score,
      reasons: [
        r.on_time_rate !== null && r.on_time_rate < 70
          ? `${r.on_time}/${r.with_deadline} tasks hit their date`
          : null,
        r.escalations > 0
          ? `${r.escalations} task${r.escalations > 1 ? 's' : ''} escalated to you`
          : null,
        r.proof_rate !== null && r.proof_rate < 100
          ? `${r.proof_supplied}/${r.proof_required} photo proofs supplied`
          : null,
      ].filter(Boolean),
    }));
}
