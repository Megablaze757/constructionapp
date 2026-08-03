# BuilderOS — Docs

Product specs and implementation docs for BuilderOS, a business operating system
for construction owners.

The **auto-quoting module is built and runnable** — see
[deployment](deployment.md). Everything else in the system spec is still design
intent.

## Map

```
docs/
├── builderos-system-spec.md          ← whole-system vision, features, 12-month roadmap
├── deployment.md                     ← GitHub Pages + Cloudflare + OpenRouter setup
└── auto-quoting/
    ├── README.md                     ← module spec + what's built
    ├── ui-and-ai-spec.md             ← wireframes + AI prompt & output contract
    └── schemas/
        └── draft-quote.schema.json   ← the AI assistant's output contract

web/       static PWA → GitHub Pages
           index (quotes) · builder · quote (client) · jobs · variance
worker/    Cloudflare Worker + D1 → the API, pricing, variance, and OpenRouter call
```

## Documents

| Document | What it covers | Depth |
| --- | --- | --- |
| [BuilderOS system spec](builderos-system-spec.md) | Philosophy, full feature specification, owner dashboard, automation engine, SOP module, team, client care, financials, integrations, security, deployment, 12-month roadmap, KPIs, costs | System |
| [Auto-quoting module](auto-quoting/README.md) | Quote templates, AI draft assistant, pricing & margin engine, interactive client quote, data model, phased build, the quote-vs-actual learning loop, build status | Module |
| [Auto-quoting UI & AI spec](auto-quoting/ui-and-ai-spec.md) | Quote builder and client quote wireframes, AI prompt structure, output schema, worked voice-note example | Screen / contract |
| [Draft quote schema](auto-quoting/schemas/draft-quote.schema.json) | JSON Schema (draft 2020-12) for the AI assistant's output | Contract |
| [Deployment](deployment.md) | Deploying the Worker, the Pages site, and wiring them together; local development without an API key | Ops |

## Conventions

- Specs are markdown, one directory per module once a module needs more than a
  single file.
- Anything machine-readable (schemas, fixtures) lives beside the spec that defines
  it, so the prose and the contract can't drift apart unnoticed.
- Where a spec has been built, the spec says so and points at the code, rather
  than a separate status document going stale on its own.
- Open questions live in an **Open Items** section at the foot of the document
  that owns them.
