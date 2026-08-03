# 📐 Auto-Quoting & AI Estimating Module

*Turn a site visit into a sent, on-brand, margin-checked quote in minutes.*

Status: draft spec
Parent: [BuilderOS system spec](../builderos-system-spec.md)

**In this folder**

| Document | Covers |
| --- | --- |
| This file | Why the module exists, components, data model, phased build plan, [build status](#12-build-status) |
| [`ui-and-ai-spec.md`](ui-and-ai-spec.md) | Screen wireframes and the AI draft assistant's prompt/output contract |
| [`schemas/draft-quote.schema.json`](schemas/draft-quote.schema.json) | Machine-readable output contract for the AI draft assistant |

**This module is built.** Phases A–C are running code — `web/` (GitHub Pages) and
`worker/` (Cloudflare Workers + D1 + OpenRouter). See
[build status](#12-build-status) for what is and isn't done, and
[deployment](../deployment.md) to run it.

---

## 1. Why This Module Matters

Quoting is where most builders lose the most unpaid time — and where inconsistent pricing quietly
kills margin. This module turns quoting from "open a blank doc and remember what I charged last
time" into a repeatable, semi-automated system: pick a template, let AI draft the line items from
a description or photos, adjust, and send an interactive quote the client can actually engage
with online.

This slots into BuilderOS as the bridge between the **Client Care & Sales Module** (enquiry →
appraisal) and the **Job Management Module** (booked job).

---

## 2. Core Components

| Component | Purpose |
| --- | --- |
| Quote Template Library | Reusable structures per job type, so nobody starts from scratch |
| AI Draft Assistant | Turns a description, voice note, or photos into draft line items |
| Pricing & Margin Engine | Applies material costs, labour rates, and margin rules automatically |
| Interactive Client Quote | Client-facing, tappable quote with options, not a static PDF |
| Approval & Conversion | Client accepts online → auto-creates the job |

---

## 3. Quote Template Library

### 3.1 What a Template Contains

- Job type (e.g. "Domestic scaffold erect", "Single-storey extension", "Re-roof")
- Standard line-item structure (labour, materials, plant hire, waste, contingency)
- Default margin target for that job type
- Standard terms, exclusions, and validity period
- Optional photos/diagrams to include (e.g. scaffold layout diagram)

### 3.2 Template Sources

- **Pre-built starter templates** by trade — scaffolding, roofing, groundworks, extensions, etc.
- **Owner-created templates** — save any quote as a reusable template
- **AI-suggested templates** — after enough quotes, the system suggests "you quote this job type
  often, want to save it as a template?"

### 3.3 Template Management

- Version-controlled — updating a template doesn't break past sent quotes
- Shareable across a team, so every estimator quotes the same way
- Tagged by job type, so the AI Draft Assistant knows which one to pull

---

## 4. AI Draft Assistant

### 4.1 Inputs It Can Work From

- **Typed description** — "Erect scaffold to rear of 3-bed semi, 2 lifts, access for roofers"
- **Voice note** — owner describes the job on-site, walking the property
- **Photos** — uploaded site photos; AI estimates scale/scope where possible, always flagged as
  an estimate and never final
- **Past similar jobs** — AI cross-references similar completed jobs for a pricing sanity-check

### 4.2 What It Produces

- Draft line items pulled from the matching template
- Suggested quantities based on the description (e.g. estimated scaffold m², roof area)
- Flags for anything it's unsure about — **the AI never finalizes a quote; it always hands off a
  draft for the owner/estimator to confirm**
- A plain-language summary of assumptions made, so the builder can catch anything wrong before
  sending

The exact prompt structure and output schema are in
[`ui-and-ai-spec.md` §2](ui-and-ai-spec.md#part-2--ai-draft-assistant-prompt--data-structure).

### 4.3 Guardrails

- AI-suggested quantities and prices are always clearly marked as **estimates requiring
  confirmation** — never auto-sent to a client without human review
- **Margin floor** — if a draft would send below the minimum margin threshold, it's flagged red
  before it can be sent
- Owner can **lock** certain line items (e.g. day rate) so AI never overrides them

---

## 5. Pricing & Margin Engine

### 5.1 Inputs

- Material costs (synced from supplier price lists where available, or manually maintained)
- Labour rates per role (labourer, skilled trade, site lead)
- Plant/equipment hire rates
- Overhead allocation (optional — spreads a % of fixed costs across jobs)
- Target margin by job type

### 5.2 Outputs

- Real-time margin % shown as the quote is built
- Warning if a line item is priced below cost
- **What-if slider** — see how the quote total changes if the margin target is adjusted

### 5.3 Why This Matters

This directly protects against the classic trap: quoting competitively to win the job, then
discovering months later that the job barely broke even. The margin check happens **before** the
quote goes out, not after the job's done.

---

## 6. Interactive Client-Facing Quote

### 6.1 What the Client Sees

Instead of a flat PDF, the client gets a link to an interactive quote page:

- Itemized scope in plain language, not line-item jargon
- Optional add-ons they can toggle on/off (e.g. "add gutter clearance — +£180") with the total
  updating live
- Photos/diagrams relevant to their job
- Clear validity window and next steps
- **Accept & Book** button — tapping it converts the quote straight into a booked job

### 6.2 Why Interactive Beats Static PDF

- **Upsell opportunity** — optional extras are easy to add without a phone call back and forth
- **Faster conversion** — the client can accept immediately rather than "I'll get back to you"
- **Professional impression** — reinforces trust at the exact moment the client is deciding

### 6.3 Client Engagement Tracking

- Owner sees when the client opened the quote, how long they viewed it, and which optional extras
  they looked at
- Auto follow-up if a quote hasn't been opened or accepted within X days (ties into the
  Automation Engine)

---

## 7. Workflow Integration

```
Enquiry → Appraisal booked → Site visit →
   [AI Draft Assistant generates draft quote] →
   Owner/estimator reviews & adjusts →
   Interactive quote sent to client →
   Client views, adjusts optional extras, accepts →
   Job auto-created in Job Management Module →
   Quote line items become the job budget baseline
      (feeds directly into Job Profitability tracking:
       quoted vs actual cost)
```

The quote isn't a one-off document — it becomes the baseline the Financial Intelligence Module
tracks actual costs against, so "did we make money on this job" is answered automatically.

---

## 8. Data Model (High Level)

| Entity | Fields |
| --- | --- |
| **QuoteTemplate** | `job_type`, `default_line_items[]`, `default_margin`, `terms`, `version` |
| **Quote** | `client_id`, `job_type`, `line_items[]`, `optional_extras[]`, `margin_%`, `status` (draft/sent/viewed/accepted/expired), `valid_until` |
| **LineItem** | `description`, `quantity`, `unit_cost`, `unit_price`, `category` (labour/material/plant/other) |
| **QuoteEvent** | `quote_id`, `event_type` (opened/extra_toggled/accepted), `timestamp` — powers engagement tracking |
| **PriceBook** | material/labour/plant rates, `source` (manual/supplier sync), `last_updated` |

Note the split between `unit_cost` and `unit_price` on `LineItem` — cost drives the margin
calculation and stays internal; price is what the client sees. The AI draft assistant writes
neither, only quantities (see [§4.3](#43-guardrails)).

---

## 9. Phased Build Plan

### Phase A — Templates + Manual Quoting (Foundation)

- Build/select templates per job type
- Manual quote builder (no AI yet) with line items and margin display
- Static shareable quote link (view-only, not yet interactive extras)

**Success criteria:** owner can build and send a consistent, margin-checked quote faster than
their current method.

### Phase B — Interactive Client Quote

- Client-facing toggle-able optional extras
- **Accept & Book** button → auto-creates job
- Engagement tracking (opened/viewed/accepted)

**Success criteria:** clients can self-serve accept, and the owner sees drop-off/engagement data.

### Phase C — AI Draft Assistant

- Typed description → draft line items from matching template
- Voice note transcription → draft quote
- Assumption summary + confidence flags for owner review

**Success criteria:** turning a site visit into a sendable draft takes minutes, not an evening at
the kitchen table.

### Phase D — Photo-Based Estimating & Learning Loop

- Photo upload → rough scope estimate, clearly flagged as an estimate
- AI cross-references past similar jobs for pricing sanity-checks
- System suggests new templates based on recurring quote patterns

**Success criteria:** quoting accuracy improves over time using the business's own job history,
not generic assumptions.

---

## 9a. The Learning Loop (Phase D, built)

Phases A–C make quoting *faster*. This is the part that makes it *better*, and it only works
because something finally records what a job cost rather than what it was expected to cost.

```
Client accepts  →  job created, quote becomes the budget baseline
        ↓
Owner logs actual costs as the job runs (optionally against the quoted line)
        ↓
Job marked complete
        ↓
Quote-vs-actual report        →  what the owner and accountant read
        ↓
Per-line estimating bias      →  "scaffold erect runs 12% over"
        ↓
Briefed into the next AI draft  →  scoped generously, with a note saying why
```

The owner-facing report and the assistant's briefing are computed from **one** function
(`worker/src/variance.js`), so the numbers on screen and the numbers steering the AI cannot
drift apart.

### What counts as a signal

Three rules stop the loop learning from noise:

| Rule | Why |
| --- | --- |
| A job with **no** costs logged is excluded entirely | It would otherwise read as 100% under budget and drag every average down |
| A line needs **≥2 completed jobs** before bias is reported | One bad week is not a bias |
| Only **≥5% drift** is briefed to the assistant | Telling a model a line runs 1% over invites it to fiddle for no reason |

Rollups are weighted by value rather than averaging percentages — one small job running 80% over
should not outweigh five large ones landing on budget.

The briefing's advice follows the direction of the drift: a line running *over* is scoped
generously, a line running *under* is flagged as previously over-scoped. Both are sent as measured
history, and neither loosens the rule that the assistant never outputs a price.

### Known limitation

A job marked complete with only **some** of its costs logged reads as an underspend, and there is
no signal that would let the system tell "came in cheap" apart from "invoices not entered yet."
Costs should be logged before a job is marked complete. The job screen warns when none have been
recorded at all; it cannot detect a partial set.

---

## 10. Success Metrics

| Metric | Target |
| --- | --- |
| Time from site visit to sent quote | <30 minutes (down from hours/days) |
| Quote-to-acceptance rate | +20% vs static PDF baseline |
| Quotes sent below margin floor | 0 (hard block) |
| Optional extras uptake per accepted quote | >25% |
| Quoted-vs-actual cost variance per job | <10% |

---

## 11. Key Guardrail to Keep in the Plan

AI here is a **drafting assistant, not an autonomous pricer.** It accelerates the tedious part —
writing it all out — but the owner or estimator always confirms quantities, pricing, and margin
before anything reaches a client. This keeps trust intact and avoids the real risk of an
underpriced job going out the door on autopilot.

In the build this is not a convention but a set of enforced rules, each in a place
a caller cannot route around:

| Guardrail | Where it is enforced |
| --- | --- |
| The AI cannot return a price | The wire schema has no price field, and unknown properties are rejected — `worker/src/schema.js` |
| The AI cannot invent a line item | `line_code` is checked against the matched template's codes |
| An inferred quantity cannot claim high confidence | `validateDraft()`, which also requires a note on anything below high |
| A failed draft changes nothing | The Worker rejects the response instead of repairing it; the quote is left as it was |
| AI-drafted lines cannot be sent unreviewed | `sendBlockers()` — the API returns 422, so skipping the UI does not skip the gate |
| A quote below the margin floor cannot be sent silently | Same gate; an override requires a reason, which is written to `quote_events` |
| Money never comes from the client | Every write reprices from the `PriceBook` server-side |
| The client never sees cost or margin | `clientView()` names the fields that go out rather than deleting the ones that shouldn't |
| Measured history informs scope, never price | The learning loop briefs the assistant in words about *quantities*; the output schema still has no price field |

---

## 12. Build Status

| Phase | Status |
| --- | --- |
| **A — Templates + manual quoting** | Built. Two starter templates, price book, margin display, shareable link. |
| **B — Interactive client quote** | Built. Toggleable extras with live totals, Accept & Book creating a job, engagement events (`opened`, `extra_toggled`, `accepted`, `question_asked`). |
| **C — AI draft assistant** | Built. Typed or dictated description → draft line items, assumptions, flags, confidence, tap-to-confirm. |
| **D — Photo estimating & learning loop** | Mostly built. Site photo upload, cost capture against jobs, the quote-vs-actual variance report, and the [learning loop](#9a-the-learning-loop-phase-d-built) all work. Photo-based *scope estimating* and automatic template suggestions do not. |

Known gaps, deliberately left:

- **Photos are stored but not read by the AI.** Upload, downscaling, and display on
  the client quote work; a vision model inferring scope *from* a photo does not.
  That is the remaining half of Phase D.
- **No automatic template suggestions** from recurring quote patterns.
- **Voice notes use the browser's Web Speech API**, which Chrome and Safari support
  and Firefox does not. The button says so rather than failing quietly. A
  server-side transcription service would remove the browser dependency.
- **One shared owner token**, not per-user accounts. Right for a single owner,
  wrong for a team; see [deployment](../deployment.md#security-notes).
- **Partially-costed jobs skew the report** — see the
  [limitation above](#known-limitation).
- **Photos live in D1 as BLOBs**, which keeps deployment to a single binding. R2 is
  the upgrade path once photo volume justifies a second service.
