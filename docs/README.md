# BuilderOS — Specs

Product and technical specs for BuilderOS, a business operating system for construction owners.
Everything here is a **draft spec** — design intent, not shipped behaviour. No application code
exists in this repository yet.

## Map

```
docs/
├── builderos-system-spec.md          ← start here: whole-system vision, features, 12-month roadmap
└── auto-quoting/
    ├── README.md                     ← module spec: components, data model, phased build plan
    ├── ui-and-ai-spec.md             ← wireframes + AI draft assistant prompt & output contract
    └── schemas/
        └── draft-quote.schema.json   ← machine-readable output contract for the AI assistant
```

## Documents

| Document | What it covers | Depth |
| --- | --- | --- |
| [BuilderOS system spec](builderos-system-spec.md) | Philosophy, full feature specification, owner dashboard, automation engine, SOP module, team, client care, financials, integrations, security, deployment, 12-month roadmap, KPIs, costs | System |
| [Auto-quoting module](auto-quoting/README.md) | Quote templates, AI draft assistant, pricing & margin engine, interactive client quote, data model, phased build | Module |
| [Auto-quoting UI & AI spec](auto-quoting/ui-and-ai-spec.md) | Quote builder and client quote wireframes, AI prompt structure, output schema, worked voice-note example | Screen / contract |
| [Draft quote schema](auto-quoting/schemas/draft-quote.schema.json) | JSON Schema (draft 2020-12) enforcing the AI assistant's output | Implementation |

The auto-quoting module is the worked example of taking one slice of the system spec down to
buildable detail. Other modules are still at system-spec depth.

## Conventions

- Specs are markdown, one directory per module once a module needs more than a single file.
- Anything machine-readable (schemas, fixtures) lives beside the spec that defines it, so the
  prose and the contract can't drift apart unnoticed.
- Open questions live in an **Open Items** section at the foot of the document that owns them,
  rather than in a separate backlog.
