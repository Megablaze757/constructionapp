# constructionapp

**BuilderOS** — a business operating system for construction owners. Job tracking, SOPs,
delegation, client care, cash flow, and quoting, built so the business needs the owner less.

> Comfort never builds anything great, but chaos doesn't scale — systems do.

The **auto-quoting module is built and deployable**: describe a job on site, get an
AI-drafted quote, margin-check it, and send the client an interactive page they can
accept from their phone. The rest of the system is specced but not yet built.

## Architecture

```
web/      static PWA          → GitHub Pages    Quote Builder + client quote page
worker/   Cloudflare Worker   → Workers + D1    API, pricing, margin gate, secrets
                              → OpenRouter      the AI draft assistant
```

The split is load-bearing: GitHub Pages serves static files only, so there is
nowhere on the frontend to hide an API key. Every secret, every price, and every
margin calculation lives in the Worker. The browser is never trusted with money.

## Quick start

```bash
cd worker && npm install
npx wrangler d1 execute builderos-quoting --local --file=migrations/0001_init.sql
npx wrangler d1 execute builderos-quoting --local --file=migrations/0002_seed.sql
npx wrangler dev                       # API on :8787
node dev/stub-openrouter.js            # stands in for OpenRouter, no key needed
cd ../web && python3 -m http.server 8788
```

Open <http://127.0.0.1:8788>, set the owner token to `dev-owner-token` in Settings.
Full setup, including real deployment, is in [docs/deployment.md](docs/deployment.md).

```bash
cd worker && npm test                  # pricing, margin gate, and AI contract guardrails
```

## Docs

- **[docs/](docs/README.md)** — index and map
- **[BuilderOS system spec](docs/builderos-system-spec.md)** — the whole system: features, modules, 12-month roadmap, KPIs
- **[Auto-quoting module](docs/auto-quoting/README.md)** — the built module ([wireframes & AI spec](docs/auto-quoting/ui-and-ai-spec.md), [output schema](docs/auto-quoting/schemas/draft-quote.schema.json), [build status](docs/auto-quoting/README.md#12-build-status))
- **[Deployment](docs/deployment.md)** — Pages, Cloudflare, OpenRouter, and local dev

## The rule the quoting module is built around

The AI drafts; it never prices and never sends. It returns quantities and honest
provenance tags — what it was told, what it inferred, what came from the template —
and the system prices those quantities from the price book. An inferred quantity
can't claim high confidence, an unreviewed line can't be sent, and a quote below the
margin floor can't go out without a logged reason. Those are enforced in the API,
not just the UI, so skipping the app doesn't skip the gate.

## Core principles

- **Owner-independence first** — every feature reduces how much the business needs the owner present
- **Exception-based visibility** — surface only what needs the owner's decision
- **Systems over heroics** — recurring tasks become SOPs, not favours
- **Cash is oxygen** — payment chasing and cash flow are first-class
- **Field-first design** — built for a site in the rain with gloves on
