# Deploying BuilderOS

Three moving parts:

| Part | Runs on | Holds |
| --- | --- | --- |
| `web/` | GitHub Pages | Every screen, owner and client. Static files only. |
| `worker/` | Cloudflare Workers + D1 | The API, all pricing, and every secret. |
| Draft assistant | Groq | The model call, reached only from a Worker. |

The split matters for one reason: **GitHub Pages can only serve static files**, so
there is nowhere on the frontend to keep an API key. The Groq key lives as a
Cloudflare secret and never reaches a browser. The same goes for cost and margin —
see [Security notes](#security-notes).

**None of it is required to start.** Deploy `web/` on its own and the app runs in
the browser: the Worker's own source against SQLite in WebAssembly, stored in
IndexedDB on that device. Three steps, in the order most people will want them:

| Step | Get | Cost | Effort |
| --- | --- | --- | --- |
| [0. Pages only](#0-pages-on-its-own-no-worker) | the whole app, one device, template drafts | free | push to `main` |
| [1. + the AI worker](#1-the-ai-worker-one-paste) | real AI estimates, still one device | pennies per quote | one paste, no CLI |
| [2. + the full Worker](#2-cloudflare-worker--d1) | shared data, client and crew links | free tier | wrangler + D1 |

---

## Prerequisites

Nothing at all for step 0. For the rest:

- A Cloudflare account (the free plan is enough to start)
- A [Groq](https://console.groq.com) API key
- This repository pushed to GitHub

---

## 0. Pages on its own (no Worker)

**Settings → Pages → Build and deployment → Source: GitHub Actions**, then push to
`main`. With neither `API_BASE` nor `AI_BASE` set, the published site runs
everything locally and says so at the top of every screen.

What works: quoting, jobs, tasks, SOPs, invoicing, the dashboard, reliability, and
the automation engine — all of it, against a real SQLite database in the browser.
Drafting falls back to the job template, with every line marked as needing a check.

What does not: anything that has to leave the device. A client cannot open a quote
link, a crew member cannot open their own page, and a second device sees a
different database. Clearing site data deletes the lot.

That is a real limit, not a trial mode — but it is enough to quote a job today.

---

## 1. The AI worker (one paste)

An API key cannot live in a browser, so AI drafting needs something to sit behind.
[`worker/paste/ai-worker.js`](../worker/paste/ai-worker.js) is a single
self-contained file for exactly this: no build, no CLI, no database.

1. **dash.cloudflare.com → Workers & Pages → Create → Start with Hello World**,
   then Deploy.
2. **Edit code**, select all, paste the whole file over the top, Deploy again.
3. **Settings → Variables and Secrets**:

   | Name | Type | Value |
   | --- | --- | --- |
   | `GROQ_API_KEY` | Secret | from [console.groq.com/keys](https://console.groq.com/keys) |
   | `ALLOWED_ORIGINS` | Variable | `https://<user>.github.io` |
   | `AI_SHARED_TOKEN` | Secret | optional; callers must send it as a bearer token |
   | `GROQ_MODEL` | Variable | optional, see [Choosing a model](#choosing-a-model) |
   | `GROQ_VISION_MODEL` | Variable | optional, used only when photos are attached |

4. Check it: `curl https://<worker>.workers.dev/health` → `{"ok":true,"ai":true,…}`.
5. On the site: **Settings → AI worker URL** → paste → Save. Or set the repository
   variable `AI_BASE` so every deploy has it.

`ALLOWED_ORIGINS` is what stops another site spending your key. `*` is accepted so
a first deploy works before you know the Pages URL, but narrow it after that.

The file is generated from `worker/src/schema.js` and `worker/src/groq.js`, and CI
fails if it drifts from them — so the guardrails in it are the same ones the full
Worker enforces, not a simplified copy. To run it locally:
`GROQ_BASE_URL=http://127.0.0.1:8799/openai/v1 GROQ_API_KEY=stub npm run ai`.

---

## 2. Cloudflare Worker + D1

This is the one that makes it a business system rather than an app on a phone:
shared data, working client links, working crew links.

```bash
cd worker
npm install
npx wrangler login
```

Create the database and paste the returned id into `wrangler.toml` under
`database_id`:

```bash
npx wrangler d1 create builderos-quoting
```

Create the tables and load the starter templates and price book:

```bash
npm run db:remote
```

`0001` is a **destructive reset** — it drops every table before recreating it. That is what you
want on first install, and not what you want later.

Set the two secrets. `OWNER_TOKEN` is one you invent — it is what the Quote
Builder authenticates with, so make it long and random:

```bash
openssl rand -hex 24                        # generate one, then:
npx wrangler secret put OWNER_TOKEN
npx wrangler secret put GROQ_API_KEY
```

Deploy:

```bash
npm run deploy
```

Note the Worker URL it prints (`https://builderos-quoting.<subdomain>.workers.dev`).
Check it:

```bash
curl https://builderos-quoting.<subdomain>.workers.dev/health
# {"service":"builderos-auto-quoting","ok":true,"ai":true,"ai_mode":"groq"}
```

`ai_mode` says which of the three routes to a model is in play:

| `ai_mode` | Means |
| --- | --- |
| `groq` | `GROQ_API_KEY` is set; the Worker calls Groq directly |
| `proxy` | `AI_PROXY_URL` is set; drafts go through another Worker that holds the key |
| `template` | neither; drafting falls back to the job template, every line flagged |

`AI_PROXY_URL` lets the full Worker reuse the same AI worker from step 1 rather
than holding a second copy of the key — point it at `https://<ai-worker>/draft`,
and set `AI_PROXY_TOKEN` if you set `AI_SHARED_TOKEN` on it. Either way the draft
is validated again on the Worker's side, so trusting the proxy with the key is not
the same as trusting it with the contract.

---

## 3. GitHub Pages

In the repository: **Settings → Pages → Build and deployment → Source:
GitHub Actions**.

Then **Settings → Secrets and variables → Actions → Variables**, add:

| Variable | Value |
| --- | --- |
| `API_BASE` | Your Worker URL, no trailing slash. Leave unset for local mode. |
| `AI_BASE` | The AI worker's URL. Only used when `API_BASE` is unset. |
| `BUSINESS_NAME` | The name shown on client quotes, e.g. `Higgins Scaffolding` |

Push to `main`. [`deploy-pages.yml`](../.github/workflows/deploy-pages.yml) writes
`config.js` from those and publishes `web/`. Your site lands at
`https://<user>.github.io/<repo>/`.

Both can be set from the site's own **Settings** dialog instead, which is stored in
that browser only — useful for trying a Worker before committing a repository
variable to it.

---

## 4. Point the Worker back at Pages

The Worker refuses cross-origin calls from anywhere it does not know, so it needs
the Pages origin. Edit `worker/wrangler.toml`:

```toml
[vars]
ALLOWED_ORIGINS = "https://<user>.github.io"
PUBLIC_APP_URL  = "https://<user>.github.io/<repo>"
```

`ALLOWED_ORIGINS` is an **origin** (scheme + host, no path). `PUBLIC_APP_URL`
includes the repo path, because it is used to build the client's quote link.
Redeploy with `npm run deploy`.

---

## 5. First run

1. Open your Pages URL.
2. **Settings** → paste the `OWNER_TOKEN` → Save. It is stored in that browser's
   `localStorage` only.
3. Fill in a client and site, pick **Domestic Scaffold Erect**, **Start quote**.
4. Describe the job, **Generate Draft with AI**, confirm the flagged lines, **Send**.

If the top of the screen says *running in this browser*, the site did not reach the
Worker. Check `API_BASE`, then `ALLOWED_ORIGINS` on the Worker — a CORS rejection
and an unreachable host look identical from a browser, so the app names both.

### Moving off local mode

There is no import: work done in local mode stays in that browser. If you have been
using it seriously before deploying the Worker, treat the local database as the
draft and re-enter what matters — or keep using it and deploy the Worker for the
next job. The app never silently switches between the two: once a Worker has
answered, a later failure is reported as a fault rather than quietly falling back to
a different database.

---

## Deploying the Worker from CI instead

[`deploy-worker.yml`](../.github/workflows/deploy-worker.yml) runs the test suite
and then deploys on any push touching `worker/`. It needs two repository
**secrets** — `CLOUDFLARE_API_TOKEN` (with the *Edit Cloudflare Workers* template,
plus D1 edit) and `CLOUDFLARE_ACCOUNT_ID` — and the repository **variable**
`DEPLOY_WORKER` set to `true`.

The variable is the switch: until you set it, the deploy step skips rather than
failing, because the app runs on Pages alone and a red cross on every push would
hide a real failure. You can also run it once by hand from the Actions tab.

Deployment is gated on `npm test`, so a change that breaks a pricing or contract
guardrail cannot reach production.

---

## Local development

```bash
cd worker && npm install
cp .dev.vars.example .dev.vars      # git-ignored; the stub needs no real key
npm run db:local                    # applies every migration

npm run dev                         # the API              http://127.0.0.1:8787
npm run stub                        # stands in for Groq   http://127.0.0.1:8799
npm run ai                          # the paste-in worker  http://127.0.0.1:8790
npm run web                         # the site             http://127.0.0.1:8788
```

Open <http://127.0.0.1:8788>, set the owner token to `dev-owner-token` in Settings.
Add `?api=&local=1` to any page to see it with no Worker at all.

`npm run ai` runs [`worker/paste/ai-worker.js`](../worker/paste/ai-worker.js) — the
exact file you paste into the dashboard — on Node, so a mistake in it surfaces here
rather than after someone has pasted it.

The stub returns the worked example from
[`ui-and-ai-spec.md` §2.5](auto-quoting/ui-and-ai-spec.md#25-example-voice-note--draft),
and asserts that the Worker actually sent structured-output constraints. Run it
with `STUB_MODE=bad` to watch a contract-violating draft get rejected.

To use the real Groq locally, drop `GROQ_BASE_URL` and put a real key
in `GROQ_API_KEY`.

### Tests

```bash
npm test                            # unit: pricing, margin gate, AI contract, the paste file
npm run e2e                         # four browser journeys against the running stack
```

The journeys drive a real browser through the real stack. The fourth runs the whole
app with the API pointed at nothing, which is the only way to catch local mode
breaking — it looks identical to the working app until you try to use it.

### Generated files

`worker/paste/`, `web/assets/schema.sql` and `web/assets/js/worker/` are built from
`worker/src` by `npm run build:generated`. Edit the source, regenerate, commit both;
[`ci.yml`](../.github/workflows/ci.yml) fails on a diff. The browser fallback runs
the Worker's real code rather than a re-implementation of it, and that only stays
true if the copy is mechanical.

---

## Choosing a model

Two models, because the strongest text model on Groq cannot see:

| Variable | Default | Used for |
| --- | --- | --- |
| `GROQ_MODEL` | `llama-3.3-70b-versatile` | every draft from a description |
| `GROQ_VISION_MODEL` | `meta-llama/llama-4-maverick-17b-128e-instruct` | drafts with site photos attached |

Confirm both slugs against [console.groq.com/docs/models](https://console.groq.com/docs/models)
before deploying — slugs change as models are released and retired, and a stale one
surfaces as `Groq returned 400` on the first draft.

Structured-output support varies by model on Groq, so the request tries
`response_format: json_schema` first and falls back to plain JSON mode with the
schema described in the prompt if the model rejects it. The fallback loosens
*generation* only: the response is validated against the same contract either way,
so a model that returns prose or invents a line still produces a failed draft
rather than a bad quote. Set `GROQ_STRUCTURED_OUTPUTS` to `json_schema` or
`json_object` to pin one mode when you know what your model supports.

---

## Connecting a message provider

Automations run with **no provider by default**: messages are recorded in the
outbox as `simulated` and nothing is sent. To send for real, set in
`wrangler.toml`:

```toml
MESSAGING_DRIVER = "webhook"
MESSAGING_WEBHOOK_URL = "https://your-endpoint.example/messages"
```

and optionally `wrangler secret put MESSAGING_WEBHOOK_SECRET` (sent as a bearer
token). Each message POSTs as `{channel, to, to_name, subject, body,
entity_type, entity_id}` — point it at Twilio, WhatsApp Business, Zapier, Make or
your own Worker. See [Phase 3](phase-3/README.md#1-the-rule-that-shapes-everything-nothing-is-claimed-as-sent).

The hourly cron in `wrangler.toml` runs the engine. It deduplicates every
firing, so running it often is safe.

## Security notes

- **The client quote page never receives cost or margin.** The API builds the
  client payload by naming the fields that go out rather than deleting the ones
  that shouldn't, so adding an internal column later cannot leak it by omission.
  See `clientView()` in `worker/src/index.js`.
- **Quote links are unguessable** (26 random characters, ~130 bits) and there is no
  listing endpoint, so a link cannot be enumerated. A draft quote returns 404 on
  the public route — the same response as a nonexistent token, so the endpoint
  cannot be used to probe which tokens are real.
- **The owner token is a single shared secret**, which is right for a one-owner
  business and *not* right for a team. Per-user accounts are the obvious next step
  before more than one person holds it.
- **Prices are never accepted from a client.** Everything is recomputed server-side
  from the price book on every write, so a tampered request cannot set its own
  price.
- **Site photos are served two ways, deliberately.** The client route is scoped to
  the quote's own token, so a photo id alone is not a handle on someone else's site
  pictures, and it serves only photos flagged for the client. The builder uses an
  authenticated route instead, because the public one 404s a draft quote and an
  owner must be able to review photos before sending.
- **Local mode's owner token guards nothing.** It is minted in the browser and kept
  in `localStorage`, because the Worker's router requires one and there is nobody to
  authenticate against your own device. Anything with access to that browser profile
  has the data; local mode is a single-device convenience, not a security boundary.
- **The AI worker's only defence is `ALLOWED_ORIGINS`** unless you set
  `AI_SHARED_TOKEN`. It holds a billable key, so leaving it at `*` means anyone who
  finds the URL can spend it.

## Costs

| Service | Free tier | Notes |
| --- | --- | --- |
| GitHub Pages | Free for public repos | Static hosting — on its own, the whole app runs on it |
| Cloudflare Workers | 100k requests/day | Well beyond a single builder's quoting |
| Cloudflare D1 | 5GB, 5M rows read/day | Quotes are small |
| Groq | Pay per token | Only on **Generate Draft with AI** — pennies per quote |

Step 0 costs nothing at all. Step 1 adds only Groq usage.

Which matches the £20–40/month figure in the
[system spec §14](builderos-system-spec.md#14-cost-breakdown), with the AI line
being usage-based.
