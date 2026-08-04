# Deploying the Auto-Quoting Module

Three moving parts:

| Part | Runs on | Holds |
| --- | --- | --- |
| `web/` | GitHub Pages | The Quote Builder and the client quote page. Static files only. |
| `worker/` | Cloudflare Workers + D1 | The API, all pricing, and every secret. |
| Draft assistant | OpenRouter | The model call, reached only from the Worker. |

The split matters for one reason: **GitHub Pages can only serve static files**, so
there is nowhere on the frontend to keep an API key. The OpenRouter key lives as a
Cloudflare secret and never reaches a browser. The same goes for cost and margin —
see [Security notes](#security-notes).

---

## Prerequisites

- A Cloudflare account (the free plan is enough to start)
- An [OpenRouter](https://openrouter.ai) API key with credit on it
- This repository pushed to GitHub

---

## 1. Cloudflare Worker + D1

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
npx wrangler secret put OPENROUTER_API_KEY
```

Deploy:

```bash
npm run deploy
```

Note the Worker URL it prints (`https://builderos-quoting.<subdomain>.workers.dev`).
Check it:

```bash
curl https://builderos-quoting.<subdomain>.workers.dev/health
# {"service":"builderos-auto-quoting","ok":true,"ai":true}
```

`ai: false` means `OPENROUTER_API_KEY` did not get set — the rest of the app still
works, since AI drafting is an accelerator rather than a dependency.

---

## 2. GitHub Pages

In the repository: **Settings → Pages → Build and deployment → Source:
GitHub Actions**.

Then **Settings → Secrets and variables → Actions → Variables**, add:

| Variable | Value |
| --- | --- |
| `API_BASE` | Your Worker URL, no trailing slash |
| `BUSINESS_NAME` | The name shown on client quotes, e.g. `Higgins Scaffolding` |

Push to `main`. [`deploy-pages.yml`](../.github/workflows/deploy-pages.yml) writes
`config.js` from `API_BASE` and publishes `web/`. Your site lands at
`https://<user>.github.io/<repo>/`.

> If you skip `API_BASE`, the workflow warns and ships the committed `config.js`,
> which points at localhost — the app will load but not reach any API.

---

## 3. Point the Worker back at Pages

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

## 4. First run

1. Open your Pages URL.
2. **Settings** → paste the `OWNER_TOKEN` → Save. It is stored in that browser's
   `localStorage` only.
3. Fill in a client and site, pick **Domestic Scaffold Erect**, **Start quote**.
4. Describe the job, **Generate Draft with AI**, confirm the flagged lines, **Send**.

---

## Deploying the Worker from CI instead

[`deploy-worker.yml`](../.github/workflows/deploy-worker.yml) runs the test suite
and then deploys on any push touching `worker/`. It needs two repository
**secrets**: `CLOUDFLARE_API_TOKEN` (with the *Edit Cloudflare Workers* template,
plus D1 edit) and `CLOUDFLARE_ACCOUNT_ID`.

Deployment is gated on `npm test`, so a change that breaks a pricing or contract
guardrail cannot reach production.

---

## Local development

Four terminals, or run the first three in the background:

```bash
# 1. the API
cd worker && npm install
npm run db:local                    # applies every migration
npx wrangler dev                    # http://127.0.0.1:8787

# 2. a stand-in for OpenRouter, so you can develop without spending tokens
node dev/stub-openrouter.js         # http://127.0.0.1:8799

# 3. the frontend
cd web && python3 -m http.server 8788
```

Create `worker/.dev.vars` (git-ignored):

```
OWNER_TOKEN=dev-owner-token
OPENROUTER_API_KEY=stub-key-for-local-dev
OPENROUTER_BASE_URL=http://127.0.0.1:8799/v1
ALLOWED_ORIGINS=http://127.0.0.1:8788
PUBLIC_APP_URL=http://127.0.0.1:8788
```

Open <http://127.0.0.1:8788>, set the owner token to `dev-owner-token` in Settings.

The stub returns the worked example from
[`ui-and-ai-spec.md` §2.5](auto-quoting/ui-and-ai-spec.md#25-example-voice-note--draft),
and asserts that the Worker actually sent structured-output constraints. Run it
with `STUB_MODE=bad` to watch a contract-violating draft get rejected.

To use the real OpenRouter locally, drop `OPENROUTER_BASE_URL` and put a real key
in `OPENROUTER_API_KEY`.

---

## Choosing a model

`OPENROUTER_MODEL` defaults to `anthropic/claude-sonnet-5`. Two requirements:

- it must support **structured outputs** (`response_format: json_schema`), and
- it must be a slug OpenRouter currently serves.

Confirm the exact slug against [openrouter.ai/models](https://openrouter.ai/models)
before deploying — slugs change as models are released and retired, and a stale one
surfaces as `OpenRouter returned 400` on the first draft. A model without
structured-output support will mostly work and then intermittently return prose,
which the Worker rejects as a failed draft.

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

## Costs

| Service | Free tier | Notes |
| --- | --- | --- |
| GitHub Pages | Free for public repos | Static hosting |
| Cloudflare Workers | 100k requests/day | Well beyond a single builder's quoting |
| Cloudflare D1 | 5GB, 5M rows read/day | Quotes are small |
| OpenRouter | Pay per token | Only on **Generate Draft with AI** — pennies per quote |

Which matches the £20–40/month figure in the
[system spec §14](builderos-system-spec.md#14-cost-breakdown), with the AI line
being usage-based.
