# 📐 Auto-Quoting Module — UI Wireframes & AI Assistant Spec

Status: draft spec
Scope: quote creation (owner/estimator) and quote acceptance (client)
Parent: [Auto-Quoting & AI Estimating Module](README.md) · [BuilderOS system spec](../builderos-system-spec.md)

This is the screen-and-contract detail behind [Phase B and Phase C](README.md#9-phased-build-plan)
of the auto-quoting module. It covers two things:

1. **[UI wireframes](#part-1--ui-wireframes)** — the Quote Builder (owner-facing) and the Interactive Client Quote (client-facing).
2. **[AI draft assistant](#part-2--ai-draft-assistant-prompt--data-structure)** — how a voice note or typed description becomes a reviewable draft quote, and the strict output contract that makes it auditable.

The machine-readable output contract lives at
[`schemas/draft-quote.schema.json`](schemas/draft-quote.schema.json).

---

## Part 1 — UI Wireframes

### 1.1 Quote Builder Screen (Owner/Estimator View — Mobile)

```
┌─────────────────────────────────────┐
│ ← New Quote            [Save Draft] │
├─────────────────────────────────────┤
│ Client: Sarah Higgins                │
│ Job type: Domestic Scaffold ▾        │
│ Site: 14 Elm St                      │
├─────────────────────────────────────┤
│ 🎙️ Describe the job (tap to record)  │
│ [ ● Hold to record voice note ]      │
│  or type description below           │
│ ┌───────────────────────────────┐   │
│ │ Rear scaffold, 2 lifts, roofer│   │
│ │ access, up 5 days             │   │
│ └───────────────────────────────┘   │
│         [ Generate Draft with AI ]   │
├─────────────────────────────────────┤
│ LINE ITEMS                    Margin │
│                                 32% ✅│
│ ┌───────────────────────────────┐   │
│ │ Scaffold erect – 45m²          │   │
│ │ £1,215   [edit] [🤖 AI est.]   │   │
│ ├───────────────────────────────┤   │
│ │ Scaffold hire – 5 days         │   │
│ │ £340    [edit]                 │   │
│ ├───────────────────────────────┤   │
│ │ Dismantle                      │   │
│ │ £280    [edit]                 │   │
│ └───────────────────────────────┘   │
│         [+ Add line item]            │
├─────────────────────────────────────┤
│ Optional Extras (client can toggle)  │
│ ☑ Gutter clearance     +£180         │
│ ☐ Extra lift            +£210        │
│         [+ Add optional extra]       │
├─────────────────────────────────────┤
│ TOTAL (excl. extras):    £1,835      │
│ MARGIN: 32% (target 30%) ✅          │
├─────────────────────────────────────┤
│         [ Preview as Client ]        │
│         [ Send Quote → ]             │
└─────────────────────────────────────┘
```

**Key interaction notes**

- Any line item tagged 🤖 was AI-drafted and needs a tap-to-confirm before it counts toward
  "reviewed." Unconfirmed items show a subtle amber dot until tapped.
- The margin badge turns red and blocks **Send Quote** if margin falls below the template's
  floor. The owner has to either adjust pricing or explicitly override with a reason, which is
  logged.
- **Preview as Client** renders exactly what the client will see, so nothing surprises the owner
  after sending.

### 1.2 Interactive Client Quote (Client-Facing — Mobile Web)

```
┌─────────────────────────────────────┐
│  [Builder Co. Logo]                  │
│  Quote for Sarah Higgins             │
│  Valid until 2 Aug 2026              │
├─────────────────────────────────────┤
│  📸 [site photo]                     │
│                                       │
│  Rear scaffold — 2 lifts             │
│  Includes erect, 5-day hire,         │
│  dismantle, and roofer access        │
│                                       │
│  Base price:            £1,835       │
├─────────────────────────────────────┤
│  Add to your quote:                  │
│  ┌─────────────────────────────┐    │
│  │ ☐ Gutter clearance   +£180  │    │
│  │   Clear & flush all gutters │    │
│  │   while scaffold is up      │    │
│  ├─────────────────────────────┤    │
│  │ ☐ Extra lift          +£210 │    │
│  │   Access to chimney level   │    │
│  └─────────────────────────────┘    │
├─────────────────────────────────────┤
│  Your total:            £1,835       │
│                                       │
│      [ ✅ Accept & Book Job ]        │
│      [ Ask a question ]              │
└─────────────────────────────────────┘
```

**Key interaction notes**

- The total updates live as extras are toggled — no page reload.
- **Ask a question** opens a message thread that lands directly in the owner's Client Care
  inbox, not a generic email.
- On **Accept & Book**, the client sees a short confirmation ("We'll be in touch to confirm your
  start date") and the job is auto-created in the background.

---

## Part 2 — AI Draft Assistant: Prompt & Data Structure

### 2.1 High-Level Flow

```
Voice note / typed description
        ↓
  Speech-to-text (if voice)
        ↓
  Structured extraction prompt (below)
        ↓
  Match against QuoteTemplate for job_type
        ↓
  Draft line items with confidence flags
        ↓
  Owner reviews → confirms/edits → Send
```

### 2.2 System Prompt Structure (Conceptual)

The assistant is scoped narrowly — **it drafts, it never finalizes pricing or sends anything.**

**Role**

> You are a quoting assistant for a construction business. Extract job scope details from the
> input and map them to the provided template's line items. Never invent prices — only use the
> price book provided. Flag anything you're inferring rather than being told directly.

**Inputs provided to the model**

| Input | Purpose |
| --- | --- |
| Raw description / transcript | The scope to extract from |
| Matched `QuoteTemplate` (with standard line items) | The set of line items the draft may draw on |
| Current `PriceBook` (materials / labour / plant rates) | The only permitted source of prices |
| Last 5 similar completed jobs (`job_type`, final quoted total, final actual cost) | Sanity-check on scale |

**Output constraint**

Structured JSON only, matching [the schema below](#23-output-schema-draft-quote-object) — no
free-text pricing decisions embedded in prose.

### 2.3 Output Schema (Draft Quote Object)

Line items carry **quantities, not prices.** Pricing is applied by the app from the `PriceBook`
after the model returns, which is what makes "never invent prices" enforceable rather than
merely instructed.

```json
{
  "job_type": "domestic_scaffold_erect",
  "confidence": "medium",
  "line_items": [
    {
      "line_code": "scaffold_erect",
      "description": "Scaffold erect",
      "quantity_estimate": 45,
      "unit": "m2",
      "source": "ai_inferred",
      "confidence": "medium",
      "note": "Estimated from '2 lifts, rear of property' — confirm actual measurement on site"
    },
    {
      "line_code": "scaffold_hire",
      "description": "Scaffold hire",
      "quantity_estimate": 5,
      "unit": "days",
      "source": "explicit_in_description",
      "confidence": "high"
    },
    {
      "line_code": "scaffold_dismantle",
      "description": "Dismantle",
      "quantity_estimate": 1,
      "unit": "job",
      "source": "template_default",
      "confidence": "high"
    }
  ],
  "assumptions": [
    "Assumed standard domestic access scaffold, not industrial",
    "Assumed no special permit/road closure required — not mentioned"
  ],
  "flags_for_owner_review": [
    "Scaffold m² is an estimate — confirm before sending",
    "No mention of ground conditions — confirm access is clear"
  ],
  "similar_past_jobs_reference": [
    {"job": "22 Vine Rd, scaffold erect", "quoted": 1780, "actual_cost": 1390, "margin_actual": "22%"}
  ]
}
```

**Field semantics**

| Field | Meaning |
| --- | --- |
| `line_code` | The template line this maps to, which resolves to a `PriceBook` entry. Constrained at runtime to the codes the matched template offers |
| `source: explicit_in_description` | Stated outright in the input — safe to trust |
| `source: ai_inferred` | Derived from the wording, not stated — always needs owner confirmation |
| `source: photo_inferred` | Scaled off an attached site photo. Only valid when photos were actually supplied, and the note must say what it scaled against |
| `source: template_default` | Pulled from the `QuoteTemplate`, not the input |
| `confidence` | `high` / `medium` / `low`, per item and for the draft overall |
| `note` | Required whenever the owner needs context to judge the number |

**Two schemas, one contract**

Provider strict mode (OpenRouter/OpenAI-flavoured structured outputs) is a subset of JSON Schema:
no `if`/`then`/`allOf`, every property must appear in `required`, and "optional" has to be
expressed as a nullable union. The interesting guardrails here — *an inferred quantity is never
high confidence*, *anything below high confidence must carry a note* — are exactly the conditional
rules it cannot express. So the implementation splits them:

| | Purpose | Where |
| --- | --- | --- |
| **Wire schema** | Constrains the model's output *shape* at generation time | `worker/src/schema.js` → `WIRE_SCHEMA` |
| **Canonical schema** | The full contract, conditionals included | [`schemas/draft-quote.schema.json`](schemas/draft-quote.schema.json) |
| **Validator** | Enforces the contract on every response | `worker/src/schema.js` → `validateDraft()` |

A response that satisfies the wire schema can still violate the contract. That is what the second
pass is for, and it is the reason the guardrails live in code rather than in the prompt: a prompt
asks, a validator refuses. A draft that fails validation is **rejected outright** rather than
repaired — silently fixing it would put an unlabelled number in front of the owner, which is the
one thing the `source`/`confidence` tags exist to prevent.

Two of the rules depend on context the published schema cannot know, so they live only in the
validator: whether a `line_code` is one the matched template offers, and whether any photo was
actually attached. The second matters more than it looks — without it, a text-only draft could
launder a guess as a measurement by labelling it `photo_inferred`.

**On nullable notes.** Strict mode has no optional properties, so a high-confidence line
legitimately comes back as `note: null`. The published schema therefore accepts `null` at the
property level, while the conditional branches require a non-empty string — so a null can never
satisfy a rule that demands an explanation.

### 2.4 Why Structured Output Matters Here

- **Auditability** — every AI-suggested number carries a `source` and `confidence` tag, so the
  owner (or, later, an insurer or accountant) can see exactly what was inferred versus explicitly
  stated.
- **Safety** — because the output is a strict schema, the app can enforce *"no line item with
  `confidence: low` can be included without an owner tap-to-confirm"* as a hard rule in the UI
  layer, not just a suggestion in a prompt.
- **Learning loop** — `similar_past_jobs_reference` is what lets the system get smarter over
  time. Quoted-vs-actual variance data informs better future estimates without the AI having to
  guess from nothing.

### 2.5 Example: Voice Note → Draft

**Input (transcribed voice note)**

> "Right, this is the Elm Street job. Rear of the house, need scaffold for the roofers, probably
> two lifts, they'll be up there about five days."

**What happens**

1. Speech-to-text produces the transcript above.
2. The extraction prompt pulls: location context (rear of house), purpose (roofer access), lift
   count (2), duration (5 days).
3. Matches to the **Domestic Scaffold Erect** template.
4. Scaffold m² has no explicit number — flagged `confidence: medium`, `source: ai_inferred`,
   with a note to confirm on site.
5. Hire duration (5 days) is explicit — `confidence: high`.
6. The draft is handed to the owner in the Quote Builder screen, with the amber dot on the
   inferred line item.

---

## Open Items

- **Quote vs actual variance report** (accountant/owner-facing) — not yet specced. This is what
  feeds the learning loop described in [2.4](#24-why-structured-output-matters-here).
- Margin floor override: reason codes vs free text, and where the log surfaces.
- Quote validity/expiry behaviour once `Valid until` has passed.
