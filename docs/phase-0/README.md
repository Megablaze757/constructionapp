# Phase 0 — Foundation

*Get a builder out of "headless chicken" mode.*

Status: **built**
Parent: [BuilderOS system spec §12](../builderos-system-spec.md#phase-0--foundation-month-1)

The roadmap's success criterion is one sentence: **the owner can see every active
job and who's on it in one place.** That needs three things the quoting module
never provided — people, written systems, and money owed — plus jobs that exist
independently of a quote.

| Roadmap item | Where it lives |
| --- | --- |
| Job tracker (create, view, status) | `web/jobs.html` |
| SOP library (starter templates, custom) | `web/sops.html` |
| Staff/sub directory | `web/team.html` |
| Basic invoicing + manual payment tracking | `web/cash.html` |

---

## 1. Jobs

A job now has two ways to exist. It is created automatically when a client accepts
a quote — that path already carried the quote's totals through as the job's budget
baseline — or it is created by hand, for the work a builder already had on the books
before any of this existed.

That second path forced a change: `jobs.quote_id` had to become nullable. SQLite
cannot do that with `ALTER`, so `0004` rebuilds the table (see
[migration notes](#migration-notes) — the rebuild is more dangerous than it looks).

Jobs gained target dates, free-text notes, and an `on_hold` status, because a job
that is paused is not the same as a job that is running badly.

The list is ordered by what needs attention rather than by date: in progress,
then booked, then on hold, then complete. Each row shows the crew and checklist
progress, which is what makes the success criterion literally true on one screen.

## 2. Team

Staff and subcontractors share one table. From the owner's point of view the
question is always "who is on this job and can I rely on them", and the answer
should not depend on which side of the payroll someone sits.

People are **deactivated, never deleted**. Someone who worked a job stays attached
to its history; removing the row would tear a hole in past assignments.

Reliability scoring is Phase 2 and is deliberately absent here. The directory
records who exists and where they are; judging them comes later, with data.

## 3. SOPs

A library of how this business does a thing, written down once, plus checklists
attached to individual jobs.

**Steps are copied onto the job, not referenced.** Editing the library later must
not rewrite a checklist somebody has already signed off — the point of a checklist
is that it records what was actually done, and a live reference would quietly
rewrite history.

**Photo proof is enforced, not suggested.** A step marked `needs_photo` that has
been ticked but has no photo does *not* count toward progress; it shows as
"awaiting photo" and holds the checklist open. This is the whole point of photo
proof in the system spec (§5.2): "photo/checkbox proof that a step was actually
done, not just claimed."

> **Not yet wired:** the job screen ticks steps but has no camera attach button, so
> photo-required steps stay in the awaiting state. The enforcement is real and
> tested; the capture UI is the missing half.

Eight starter SOPs ship, one per category in the spec's §5.3 list. New ones are
written as one step per line, with a `*` prefix marking a step that needs a photo —
faster to type on a phone than a checkbox per row.

## 4. Cash

Invoices against jobs, with manual payment tracking.

**Overdue is never stored.** It is a fact about today, not about the invoice.
Storing it would mean a row written yesterday is wrong today, and every report
would have to remember to refresh it. `invoiceState()` derives it on read, with
today injected so the arithmetic stays testable.

**Part payment does not count as paid** — common in construction, and an invoice
with £900 of £2,400 received is still £1,500 late. The aging strip buckets by
1–30 / 31–60 / 61–90 / 90+ days, and the chase list leads with the oldest debt,
labelled with the stage the automation cadence would be at (friendly reminder →
firmer reminder → needs you), mirroring [system spec §4.4](../builderos-system-spec.md#44-pre-built-automation-templates).

Invoice numbers continue whatever sequence already exists, so a builder migrating
from a paper book at `2024/117` gets `INV-0118` next rather than restarting at 1.

---

## Migration notes

`0004` rebuilds the `jobs` table, and that operation is far more dangerous than it
appears:

> SQLite performs an implicit `DELETE` when dropping a table while foreign keys are
> enforced, and that `DELETE` fires `ON DELETE CASCADE` on every child.

`DROP TABLE jobs` therefore **wiped every row in `job_costs`** — silently, with the
migration reporting success. It was caught by the Phase D end-to-end suite going
red on the next run, not by anything the migration itself reported. The rebuild now
parks the cost rows in a backup table first and restores them afterwards, and it
runs before the new child tables exist so nothing else is exposed.

The same class of bug bit twice more in this repo: seeded ids colliding on a
re-run because `0001` did not drop the tables a later migration creates. `0001` now
drops every dependent table first, in dependency order, so a full re-run is a clean
reset rather than a partial one. It is a **destructive** reset by design.

## What Phase 0 deliberately does not do

- **No reliability scoring** — Phase 2, and it needs history first.
- **No task delegation with due dates** — Phase 1.
- **No daily site log** — Phase 1.
- **No automated payment chasing** — the chase *stages* are computed and shown, but
  nothing sends anything. That is the Phase 3 automation engine.
- **No owner dashboard** — Phase 2. The jobs list answers the Phase 0 question on
  its own.
