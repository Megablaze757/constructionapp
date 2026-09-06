# BuilderOS — Docs

Product specs and implementation docs for BuilderOS, a business operating system
for construction owners.

The **auto-quoting module and roadmap Phases 0–3 are built and runnable** — see
[deployment](deployment.md). Phases 4–7 of the system spec are still design intent.

It runs before anything is deployed: with no Worker configured, the browser runs the
Worker's own source against SQLite in WebAssembly, on that device only. Adding the
one-file [AI worker](../worker/paste/ai-worker.js) turns on real drafting; adding the
full Worker turns on sharing, client links and crew links. Each step stands alone —
[deployment §0–2](deployment.md#0-pages-on-its-own-no-worker).

## Map

```
docs/
├── builderos-system-spec.md          ← whole-system vision, features, 12-month roadmap
├── deployment.md                     ← GitHub Pages + Cloudflare + Groq setup
├── phase-0/README.md                 ← jobs, team, SOPs, invoicing (built)
├── phase-1/README.md                 ← tasks, crew links, site log, check-ins (built)
├── phase-2/README.md                 ← owner dashboard, reliability, forecast (built)
├── phase-3/README.md                 ← automation engine, outbox, messaging (built)
└── auto-quoting/
    ├── README.md                     ← module spec + what's built
    ├── ui-and-ai-spec.md             ← wireframes + AI prompt & output contract
    └── schemas/
        └── draft-quote.schema.json   ← the AI assistant's output contract

web/       static PWA → GitHub Pages
           dashboard · quotes · builder · client quote · jobs · variance
           team · sops · cash · automations · crew (field-facing)
           assets/js/local/  ← runs worker/src in the browser when no Worker is set
worker/    Cloudflare Worker + D1 → the API, pricing, variance, and Groq call
           paste/ai-worker.js ← one file, one paste, AI drafting with no CLI
```

## Documents

| Document | What it covers | Depth |
| --- | --- | --- |
| [BuilderOS system spec](builderos-system-spec.md) | Philosophy, full feature specification, owner dashboard, automation engine, SOP module, team, client care, financials, integrations, security, deployment, 12-month roadmap, KPIs, costs | System |
| [Auto-quoting module](auto-quoting/README.md) | Quote templates, AI draft assistant, pricing & margin engine, interactive client quote, data model, phased build, the quote-vs-actual learning loop, build status | Module |
| [Auto-quoting UI & AI spec](auto-quoting/ui-and-ai-spec.md) | Quote builder and client quote wireframes, AI prompt structure, output schema, worked voice-note example | Screen / contract |
| [Draft quote schema](auto-quoting/schemas/draft-quote.schema.json) | JSON Schema (draft 2020-12) for the AI assistant's output | Contract |
| [Phase 0 — Foundation](phase-0/README.md) | Job tracker, staff/sub directory, SOP library with photo proof, invoicing and payment tracking | Module |
| [Phase 1 — Delegation](phase-1/README.md) | Task assignment with photo proof and escalation, crew access links, role-based SOPs, daily site log, client check-ins | Module |
| [Phase 2 — Visibility](phase-2/README.md) | Owner dashboard, at-risk jobs, cash forecast, live margin, reliability scoring and what it refuses to guess | Module |
| [Phase 3 — Automation](phase-3/README.md) | WHEN/IF/THEN engine, deduplication, pre-built templates, the outbox, and why nothing is ever claimed as sent | Module |
| [Deployment](deployment.md) | The three steps — Pages alone, the one-paste AI worker, the full Worker + D1 — plus model choice, CI, security notes and costs | Ops |

## Conventions

- Specs are markdown, one directory per module once a module needs more than a
  single file.
- Anything machine-readable (schemas, fixtures) lives beside the spec that defines
  it, so the prose and the contract can't drift apart unnoticed.
- Where a spec has been built, the spec says so and points at the code, rather
  than a separate status document going stale on its own.
- Open questions live in an **Open Items** section at the foot of the document
  that owns them.
