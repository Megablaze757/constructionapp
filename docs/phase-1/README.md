# Phase 1 — Delegation & Systems Layer

*Let the owner step back without it falling apart.*

Status: **built**
Parent: [BuilderOS system spec §12](../builderos-system-spec.md#phase-1--delegation--systems-layer-months-23)
Builds on: [Phase 0](../phase-0/README.md)

The roadmap's success criterion is that **the owner isn't the bottleneck for daily
job updates.** Phase 0 gave the owner a place to see everything; this phase gives
everyone else a way to put things there.

| Roadmap item | Where it lives |
| --- | --- |
| Task assignment with photo-proof completion | Job screen → Tasks · `web/crew.html` |
| Role-based SOP visibility | `visibleSops()` → the crew view |
| Daily site log | Job screen → Site log · `web/crew.html` |
| Client check-in workflow at milestones | Job screen → Client check-ins |

---

## 1. The crew link

The blocker for "let the field team log things" is normally authentication. Adding
accounts, passwords and resets for a three-person crew is how a tool like this
dies before it is adopted.

So the crew view works like the client quote does: **an unguessable per-person
link.** A tradesperson gets a URL on WhatsApp and can work. No account, no
password, nothing to forget on a roof in the rain.

It is a capability, so it carries the properties of one:

- The token *is* the identity — every query is scoped to what that person is
  actually assigned to, so the link cannot be used to browse the business.
- Writing to a job they are not on returns **403**, checked server-side per
  request rather than trusted from the page.
- **Re-issuing revokes.** Rotating the token is how access is removed when
  someone leaves, which is why it is a deliberate button rather than something
  that happens on every edit.

## 2. Tasks, and the rule that makes delegation real

Every task has exactly one owner (system spec §6.2). The part that matters is
**escalation**:

> Escalate to the owner only if overdue past a grace window.

A system that pings the owner about every task has simply moved the bottleneck
into their notifications. So a task that is one day late with a two-day grace
stays with the assignee and never reaches the owner. Past grace, it appears in
their attention list with a day count. Grace is **per task**, because a safety job
should escalate faster than a tidy-up.

**Photo proof is enforced on both sides, differently and deliberately:**

| Side | Behaviour | Why |
| --- | --- | --- |
| Crew | **Refuses** to tick without a photo (422), and opens the camera as part of the same tap | Ask while the person is still standing in front of the thing |
| Owner | Accepts, then shows "awaiting photo" and does *not* count it as done | The owner may be recording something second-hand; the gap should be visible, not blocking |

Either way the task keeps ageing and can still escalate, so a task cannot be
quietly closed by ticking a box.

## 3. Role-based SOP visibility

Staff see what applies to them, not the whole manual. `visibleSops()` filters by
the person's role and the job's type:

- An SOP with **no role** applies to everyone.
- An SOP with **no job type** applies to every job.
- Anything scoped to a different role or job type is noise to this person on this
  job, and is withheld.
- With **no role recorded**, only the universal ones show. Guessing a specialism
  from nothing would put the wrong checklist in somebody's hands, which is worse
  than showing them fewer.

## 4. Site log

The field team records what happened; the owner reads it when they choose to.

The kinds are `progress`, `issue`, `delay`, `delivery`, `safety`, and the
distinction earns its keep: **only issues, delays and safety entries reach the
owner's attention list**, and only until acknowledged. Routine progress is the
record — the thing that means the owner does not have to ring anyone — not a
request for their time.

Acknowledging is an explicit "I've seen this", not a side effect of loading a
page, so an unread problem cannot be cleared by scrolling past it.

## 5. Client check-ins

Scheduled touchpoints across the life of a job (system spec §7.2), not just at
sale and completion: before start, first day, midway, completion, and a follow-up
a week later. Dates derive from the job's own targets; a job with no dates still
gets the milestones, just undated — better an unscheduled reminder than silently
skipping client contact because nobody filled in a date.

> **Nothing is sent from here.** The automation engine is Phase 3. What this adds
> is the schedule and the visibility: a check-in that has come due and not
> happened is now something the owner can see rather than something nobody
> remembers.

## What the owner actually sees

`/api/reports/attention` is deliberately narrow — escalated tasks, unassigned
tasks, tasks awaiting photo proof, unacknowledged problems, and overdue
check-ins. Everything else is somebody else's job, which is the entire premise of
the phase.

## Known gaps

- **No push or SMS.** The crew link has to be sent by hand today; delivery is
  Phase 3.
- **Photos are stored in D1** as BLOBs, like quote photos, with the same
  browser-side downscale before upload. R2 is the upgrade path once volume
  justifies a second binding.
- **No offline queue.** The crew view needs a connection to log; offline capture
  with later sync is Phase 7.
- **Job photos are separate from quote photos** by design — different lifecycle
  and, more importantly, different access. A quote photo is served to a client
  over an unguessable link; a job photo is internal evidence.
