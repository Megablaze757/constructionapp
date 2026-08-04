# Phase 2 — Visibility & Control

*The owner dashboard becomes the single source of truth.*

Status: **built**
Parent: [BuilderOS system spec §12](../builderos-system-spec.md#phase-2--visibility--control-months-45)
Builds on: [Phase 0](../phase-0/README.md) · [Phase 1](../phase-1/README.md)

The roadmap's test is that **the owner checks one dashboard instead of five
conversations.** Two things follow from that, and they pull against each other:

- it has to be complete enough to trust, or they go back to ringing people;
- it has to be short enough to read, or they stop opening it.

So `dashboard.html` shows only numbers to act on and things that need a decision.
Anything merely interesting stays on its own screen and is one tap away.

| Roadmap item | Where it lives |
| --- | --- |
| Cash flow dashboard + invoice aging | `cashForecast()` → dashboard Cash card |
| Job profitability tracking | `marginHealth()` → dashboard Margin card |
| Reliability scoring for staff/subs | `worker/src/reliability.js` |
| Exception-based alerts | "Needs your decision", from the Phase 1 attention feed |

---

## 1. Reliability scoring, and what it refuses to guess

This is the feature with the sharpest edge in the whole system: a number next to
a person's name that an owner may use to decide whether to keep giving them work.

The spec lists four inputs. This system genuinely measures two of them:

| Spec input | Status |
| --- | --- |
| Job completion vs deadline | ✔ tasks completed on or before their due date |
| Quality flags / rework | ✔ proxied by photo-proof compliance |
| On-time arrival to site | ✘ **nothing records arrival** |
| Communication responsiveness | ✘ **no messaging channel exists yet** |

The two it cannot measure are **listed on screen as gaps rather than folded in
with an invented number**, because a score that quietly guesses is worse than one
that admits its limits when someone's livelihood may hang off it.

Three further rules keep it fair:

- **No score below three assigned tasks with due dates.** The field is `null`,
  not a default — "not enough evidence yet" and "average" are very different
  things to show next to someone's name.
- **Never being given a photo-proof task cannot penalise you.** The weighting
  re-normalises over the components that actually apply.
- **Concerns are conservative.** Someone is only named as a worry below 60, and
  always with the specific counts behind it, so it starts a conversation rather
  than ending one.

Weighting is 50 on-time / 30 escalation / 20 photo proof. Hitting deadlines
carries the most because it is what the business feels; escalation is next,
because needing the owner is the specific failure this system exists to reduce.

## 2. At-risk jobs

A job is at risk for reasons an owner could act on this afternoon — "7 days past
its finish date", not "72% complete". The checks are: behind schedule, nobody
assigned, over the expected cost, tasks escalated past their grace window,
problems logged and not yet read, and on hold.

Severity is simply how many independent things are wrong. A job that is late
*and* unstaffed *and* over budget genuinely is worse than one that is only late,
and that needs no cleverer model.

Two deliberate refinements: an **acknowledged** problem stops counting (Phase 1's
"seen it" is what clears it), and an **on-hold** job is never flagged for being
unstaffed, because a paused job does not need a crew standing on it.

## 3. Cash forecast

Built only from money that has a date attached:

- unpaid **sent** invoices, expected on their due date;
- active jobs with nothing invoiced yet, expected at their target finish.

A quote that has not been accepted is **not** in here. Forecasting from a pipeline
of maybes is how a cash flow forecast becomes a wish, and this number is meant to
be one an owner can plan a wage run against.

Overdue money is shown in its own bucket rather than inside the 30-day figure —
it is late, not imminent, and mixing them flatters the forecast. The assumptions
are printed on the card rather than buried here.

## 4. The number that used to lie

`marginHealth()` reports margin on live work. Early on, before any costs are
booked, "cost so far" is £0 — and the naive calculation makes that **100%
margin**, displayed on the dashboard headline.

That is the most flattering possible lie, in the most prominent possible place.
So `margin_so_far` is `null` when nothing has been booked, and when it does have
a value it is captioned with how many of the live jobs it actually covers
("based on 1 of 2 jobs"). A job with no costs recorded is not a high-margin job;
it is an unmeasured one.

## Known gaps

- **Nothing is pushed.** The dashboard is a screen you open. Alerts that reach a
  phone are Phase 3's automation engine.
- **The forecast is linear** — invoices on their due date, jobs at their target
  finish. It does not learn that a particular client always pays 20 days late,
  though the data to do that is now being collected.
- **Reliability has no trend.** It scores the whole history at once, so improvement
  is invisible. Predicting who is *becoming* a risk is Phase 6.
- **Time-back tracking is absent** — that is Phase 5, and the wireframe panel for
  it is deliberately not stubbed here.
