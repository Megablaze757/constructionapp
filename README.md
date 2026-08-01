# constructionapp

**BuilderOS** — a business operating system for construction owners. Job tracking, SOPs,
delegation, client care, cash flow, and quoting, built so the business needs the owner less.

> Comfort never builds anything great, but chaos doesn't scale — systems do.

This repository currently holds **specs only**; there is no application code yet.

## Where to start

- **[docs/](docs/README.md)** — spec index and map
- **[BuilderOS system spec](docs/builderos-system-spec.md)** — the whole system: philosophy,
  features, modules, 12-month roadmap, KPIs, costs
- **[Auto-quoting module](docs/auto-quoting/README.md)** — the first module taken down to
  buildable detail ([wireframes & AI spec](docs/auto-quoting/ui-and-ai-spec.md),
  [output schema](docs/auto-quoting/schemas/draft-quote.schema.json))

## Core principles

- **Owner-independence first** — every feature reduces how much the business needs the owner present
- **Exception-based visibility** — surface only what needs the owner's decision
- **Systems over heroics** — recurring tasks become SOPs, not favours
- **Cash is oxygen** — payment chasing and cash flow are first-class
- **Field-first design** — built for a site in the rain with gloves on

## Proposed stack

PWA + responsive web dashboard · Node/Postgres · offline-first sync for field logging ·
push notifications with SMS/WhatsApp fallback. See
[deployment strategy](docs/builderos-system-spec.md#11-deployment-strategy).
