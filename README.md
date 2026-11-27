# constructionapp

**BuilderOS** — a business operating system for construction owners. Job tracking, SOPs,
delegation, client care, cash flow, and quoting, built so the business needs the owner less.

> Comfort never builds anything great, but chaos doesn't scale — systems do.

The **auto-quoting module is built and deployable** — all four phases. Describe a job
on site or photograph it, get an AI-drafted quote, margin-check it, and send the client
an interactive page they can accept from their phone. Log what the job actually cost and
the system measures its own estimating drift, then briefs the next draft with it. Quote
the same shape of job often enough and it offers to save it as a template. The rest of
the system is specced but not yet built. **Roadmap Phases 0–3** are built too — job tracker, team
directory, SOP library, invoicing, a delegation layer where the crew log their own
work through a personal link, an owner dashboard that answers "how is the
business" in one screen, and an automation engine that chases what needs chasing.

## Architecture

```
web/      static PWA          → GitHub Pages    every screen, owner and client
worker/   Cloudflare Worker   → Workers + D1    API, pricing, margin gate, secrets
                              → Groq            the AI draft assistant
```

The split is load-bearing: GitHub Pages serves static files only, so there is
nowhere on the frontend to hide an API key. Every secret, every price, and every
margin calculation lives in the Worker. The browser is never trusted with money.

## It runs before you deploy anything

Open the published site with no Worker behind it and it still works. The Worker's
own source runs in the browser against SQLite compiled to WebAssembly, with the
database in IndexedDB — the same router, the same SQL, the same send gates, so
behaviour matches the deployed thing rather than approximating it.

What local mode cannot do is leave the device: no client can open a quote link, no
crew member can open their own page, nothing syncs. The app says so on every screen.
Three steps, each independently useful:

| You have | Quoting | AI drafting | Client & crew links |
| --- | --- | --- | --- |
| nothing deployed | on this device | from the job template, every line flagged | — |
| the AI worker ([one paste](worker/paste/ai-worker.js)) | on this device | real estimates from Groq | — |
| the full Worker + D1 | shared | real estimates from Groq | yes |

Middle row first if you are in a hurry: paste `worker/paste/ai-worker.js` into the
Cloudflare dashboard, add your Groq key as a secret, and put the URL into Settings
on the site. No build, no CLI, no database. See
[docs/deployment.md](docs/deployment.md).

## Quick start

```bash
cd worker && npm install
npm run db:local                       # create tables + starter templates
npm run dev                            # API on :8787
npm run stub                           # stands in for Groq, no key needed  (:8799)
npm run ai                             # the paste-in AI worker, on Node     (:8790)
npm run web                            # the site                            (:8788)
```

Open <http://127.0.0.1:8788>, set the owner token to `dev-owner-token` in Settings —
or open <http://127.0.0.1:8788/index.html?api=&local=1> to see it with no Worker at
all. Full setup, including real deployment, is in
[docs/deployment.md](docs/deployment.md).

```bash
npm test                               # 184 unit tests: pricing, margin gate, AI contract
npm run e2e                            # four browser journeys against the running stack
npm run build:generated                # rebuild the paste file and the browser copies
```

`worker/paste/`, `web/assets/schema.sql` and `web/assets/js/worker/` are generated
from `worker/src` — edit the source, run `npm run build:generated`, and commit both.
CI fails on a diff.

## Docs

- **[docs/](docs/README.md)** — index and map
- **[BuilderOS system spec](docs/builderos-system-spec.md)** — the whole system: features, modules, 12-month roadmap, KPIs
- **[Phase 0 — Foundation](docs/phase-0/README.md)** — jobs, team, SOPs, invoicing
- **[Phase 1 — Delegation](docs/phase-1/README.md)** — tasks, crew links, site log, check-ins
- **[Phase 2 — Visibility](docs/phase-2/README.md)** — owner dashboard, reliability, cash forecast
- **[Phase 3 — Automation](docs/phase-3/README.md)** — WHEN/IF/THEN rules, outbox, messaging
- **[Auto-quoting module](docs/auto-quoting/README.md)** — the built module ([wireframes & AI spec](docs/auto-quoting/ui-and-ai-spec.md), [output schema](docs/auto-quoting/schemas/draft-quote.schema.json), [build status](docs/auto-quoting/README.md#12-build-status))
- **[Deployment](docs/deployment.md)** — Pages, Cloudflare, Groq, and local dev

## Screens

| Screen | What it does |
| --- | --- |
| `dashboard.html` | The single pane of glass: cash, jobs, risks, decisions, reliability |
| `index.html` | Quotes list, start a new quote |
| `builder.html` | Quote Builder — voice/typed brief, AI draft, margin gate, site photos, send |
| `quote.html` | What the client gets: scope, photos, toggleable extras, Accept & Book |
| `jobs.html` | Every job, who's on it, checklists, and what it actually cost |
| `variance.html` | Quote vs actual — per job, by job type, and per line |
| `team.html` | Staff and subcontractor directory |
| `sops.html` | SOP library — the checklists crews work through |
| `cash.html` | Invoices, aging, and what to chase first |
| `automations.html` | Rules, the outbox, and a preview of what would happen |
| `crew.html` | Field-facing: a crew member's own jobs, tasks and checklists, opened by a personal link |

## Nothing is a single point of failure

Both AI features are ladders. Each rung works on its own, and the app always
says which one answered — an owner must never have to guess whether anything
actually read the job.

**Drafting a quote**

| Rung | Needs | Gives |
| --- | --- | --- |
| Groq | a key, or the AI worker | a real estimate, with provenance per line |
| The description parser | nothing | figures stated in a unit the price book uses; the rest flagged |
| Template defaults | nothing | the template's own numbers, every line marked for checking |

**Voice notes**

| Rung | Needs | Gives |
| --- | --- | --- |
| Groq Whisper | the AI worker | best accuracy, ~0.05p a minute, primed with trade vocabulary |
| Whisper on the device | nothing after a one-off 41MB model download | ~3x faster than real-time on CPU, offline, free |

Measured on a machine with no GPU and no cross-origin isolation headers — the
same constraints GitHub Pages imposes: the model is ready about 5s after
download, and 11 seconds of speech transcribes in 3.6s.

The parser rung exists because the obvious alternative does not work. A language
model small enough to run in a phone browser was measured at 0.8 tokens/second —
3¼ minutes for one draft — and its output was rejected outright by this repo's
own contract validator. Asked about "two lifts… about five days" it returned
`scaffold_erect: 5 building`, having swapped both numbers and invented the unit.
Pattern matching is less clever and does not do that.

## The rule the quoting module is built around

The AI drafts; it never prices and never sends. It returns quantities and honest
provenance tags — what it was told, what it worked out from the wording, what it
scaled off a photo, what came from the template — and the system prices those
quantities from the price book. An inferred quantity can't claim high confidence, a
photo measurement can't be claimed when no photo was sent, an unreviewed line can't
be sent, and a quote below the margin floor can't go out without a logged reason.
Those are enforced in the API, not just the UI, so skipping the app doesn't skip the
gate — and they are enforced again on this side of a proxy, so trusting something
with the API key is not the same as trusting it with the contract.

The same discipline runs down the ladder. The parser marks a quantity
`explicit_in_description` only when it read that number in a unit the price book
uses — "two lifts" is two lifts, so it becomes a flag for the owner rather than
2m² on a line. Anything it could not read is `template_default` with a note, which
holds the send gate shut until the owner has been through the lot. And a
transcript is never drafted from directly: it lands in the description box to be
read and corrected first, because a misheard "ten lifts" would otherwise become a
quantity a client pays for.

A template default the owner has checked is a real quote; a template default
dressed up as an estimate is a lie the client pays for.

## Core principles

- **Owner-independence first** — every feature reduces how much the business needs the owner present
- **Exception-based visibility** — surface only what needs the owner's decision
- **Systems over heroics** — recurring tasks become SOPs, not favours
- **Cash is oxygen** — payment chasing and cash flow are first-class
- **Field-first design** — built for a site in the rain with gloves on
