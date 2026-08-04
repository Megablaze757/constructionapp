# Phase 3 — Automation Engine

*Remove recurring manual work.*

Status: **built** (running against a simulated message provider)
Parent: [BuilderOS system spec §4](../builderos-system-spec.md#4-automation-engine)
Builds on: [Phase 0](../phase-0/README.md) · [Phase 1](../phase-1/README.md) · [Phase 2](../phase-2/README.md)

```
WHEN [trigger]   IF [conditions]   THEN [actions]
```

The roadmap's test is that **the owner stops manually chasing invoices and client
updates.** Everything worth acting on already existed by Phase 2 — overdue
invoices with chase stages, at-risk detection, check-in schedules. What was
missing was the layer that acts, and somewhere honest for outbound messages to go.

---

## 1. The rule that shapes everything: nothing is claimed as sent

No message provider is wired up. So every outbound message is written to the
outbox with status **`simulated`** — never `sent` — and the owner can read the
exact text that would have gone out, to the exact number it would have gone to.

This matters more than it sounds. A system that says "reminder sent" when nothing
was sent produces an owner who stops chasing and a client who never heard. The
outbox distinguishes four states, and they are not interchangeable:

| Status | Means |
| --- | --- |
| `simulated` | No provider configured. Recorded, not sent. |
| `sent` | A provider accepted it, or it is an in-app owner alert. |
| `failed` | A provider was configured and rejected it, **or** there was no phone number on file. |
| `queued` | Reserved for a provider that acknowledges asynchronously. |

"Not wired up" and "wired up and broken" must never look the same to an owner.

### Wiring a real provider

The engine takes no dependency on any vendor. Set two variables and the same
rules start sending for real:

```toml
MESSAGING_DRIVER = "webhook"
MESSAGING_WEBHOOK_URL = "https://your-endpoint.example/messages"
# MESSAGING_WEBHOOK_SECRET via `wrangler secret put`
```

Each message is POSTed as `{channel, to, to_name, subject, body, entity_type,
entity_id}`. Point it at Twilio, WhatsApp Business, Zapier, Make, or a Worker of
your own. The outbox rows then say `sent` because something actually accepted
them.

## 2. A pure function of state, not an event bus

The engine does not listen for events. It looks at the world as it is today and
asks which rules apply.

That is deliberate. An event bus only knows about things that happened while it
was running, whereas *"this invoice is 14 days overdue"* is true whether or not
anything was listening on day 14. A missed deploy, a restart, a cron that did not
fire — none of them can lose a chase.

Triggers therefore fire on **at least** N days, not exactly N.

Deciding and doing are separated: `planActions()` has no side effects at all, so
**a dry run is genuinely the same code path as a real one** rather than a
best-effort imitation of it.

## 3. Deduplication is what makes it safe to run hourly

Every firing gets a key of `rule : entity : stage`, recorded in `automation_runs`.
A "14 days overdue" rule chases once, not once an hour until the invoice is paid.

The `stage` part is what makes escalation work: the 7-day, 14-day and 30-day
chases are separate stages of the same invoice, so each fires exactly once. And
for at-risk jobs the stage is derived from the *reasons themselves*, so a job that
develops a **new** problem is reported again rather than staying silent because it
was already known to be struggling.

## 4. Defaults that respect the client relationship

The pre-built templates from spec §4.4 all ship, but the ones that message a
client directly are **off by default**. The first time software texts your
customer should be a decision you made, not a side effect of installing an update.

Rules that only alert the owner are on.

## Triggers and actions

| Trigger | Fires on |
| --- | --- |
| `invoice_overdue` | An invoice unpaid N+ days past its due date |
| `job_at_risk` | A job carrying risk reasons (re-fires if new ones appear) |
| `checkin_due` | A scheduled client touchpoint that has come due |
| `person_added` | Someone joined recently with no work assigned |
| `job_completed` | A job marked complete |
| `task_escalated` | A task past its grace window |

| Action | Does |
| --- | --- |
| `notify_owner` | In-app alert; needs no provider |
| `message_client` / `message_person` | SMS, WhatsApp or email via the driver |
| `create_task` | Creates a task on the job |
| `flag_job` | Writes an issue to the job's site log |

Conditions are `{field, op, value}` against the trigger's context, with
`> >= < <= == != contains`. An **unknown operator blocks the rule** rather than
firing it — a rule nobody can read should do nothing, not something arbitrary.

Templates use `{placeholders}`; an unknown one is **left visible** rather than
blanked, so a broken template looks broken instead of sending half a sentence.

## Scheduling

`wrangler.toml` registers an hourly cron, handled by the Worker's `scheduled()`
export calling the same `runAutomations()` the API does. Safe to run often
because of deduplication.

## Known gaps

- **No provider is connected.** By design for now — see above.
- **`create_task` needs a job.** Tasks belong to jobs, so the onboarding template
  alerts the owner rather than creating a task with nothing to hang it on.
- **No ELSE branch.** The spec's `WHEN/IF/THEN/ELSE` is implemented as far as
  THEN; a rule that does one thing or another is not yet expressible.
- **No per-rule schedule.** Everything evaluates on the same hourly pass.
- **The builder is form-based**, not drag-and-drop: pick a trigger, set its
  parameters, pick an action, write the message. It covers every trigger and
  action the engine implements, because the catalogue that populates it comes
  from the engine itself.
