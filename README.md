# cloudflare-automation

The Cloudflare provisioning, DNS, email-routing, R2 and Workers automation
extracted from [`raineydavid/ontold`](https://github.com/raineydavid/ontold).

Paths are **deliberately unchanged** from the source repo. `scripts/*.py`
import each other as `from scripts.email_routing import …` and the workflows
call `scripts/…` by path, so moving anything breaks both. Run everything from
the repo root.

## What's here

### Zones, domains and DNS
| Workflow | Does |
|---|---|
| `adopt-domains` | Pull existing domains into the account |
| `attach-domain` | Attach a custom domain to a Worker / site host |
| `audit-zone` | Read a zone's real state back (`scripts/audit_zone.py`) |
| `r2-domain` | Put a custom domain in front of an R2 bucket |
| `provision-dmarc` | Apply a DMARC policy (`scripts/dmarc_apply.py`) |

### Email routing and sending
| Workflow | Does |
|---|---|
| `provision-email-routing` | Stand up inbound routing (`scripts/email_routing.py`) |
| `provision-sending-domain` | Verify a sending domain (`scripts/sending_domains.py`) |
| `mail-estate` | Survey every domain's mail posture (`scripts/mail_estate.py`) |
| `routing-state` / `switch-inbound` / `restore-inbound` | Read, cut over and roll back inbound MX |
| `grant-email-permissions` | Grant the email-routing scopes a token needs |
| `send-test-email` | Send exactly one real message, end to end |

### Credentials
| Workflow | Does |
|---|---|
| `mint-deploy-token` | Mint a scoped deploy credential into an allowlisted repo |
| `mint-d1-token` | Mint a D1-scoped token |
| `provision-notify-bearer` | Rotate the `/notify` bearer across Worker + callers |
| `cf-credential-audit` | Audit what every Cloudflare credential can actually reach |
| `sync-vercel-env` | Push the resulting values into Vercel |

`.github/mint-allowed-repos.txt` is the allowlist `mint-deploy-token` writes
credentials into. It is a **file rather than a dashboard variable on purpose** —
who may receive a live credential should appear in a diff and have a reviewer.
Absent or empty means nobody; it fails closed.

### R2
`provision-r2` (buckets), `seed-r2` (sync assets up), and the content lanes
`mirror-ai-films`, `mirror-public-domain`, `fetch-brief-assets`,
`unhost-brief-films`. `scripts/provision-r2.sh` is the non-Actions path.

### Workers
| Worker | Deployed by |
|---|---|
| `workers/mcp` | `deploy-mcp` |
| `workers/site-host` | `deploy-site-host` |
| `workers/wallet-signer` | `deploy-wallet-signer` |
| `api/_cdn-warmer` | `wrangler deploy` from that directory |

## Running the tests

```sh
npm install && npm test          # 307 tests — workers, workflows, mjs scripts
pip install -r requirements.txt
python3 -m pytest scripts api -q # 162 tests — DNS, routing, tokens, env sync

cd workers/wallet-signer && npm install && npx vitest run   # 16 tests
```

The wallet signer is excluded from the root suite because it has its own
`package.json` (viem) installed only inside that directory — the same split the
source repo used, and the same one `deploy-wallet-signer.yml` relies on.

The Python scripts are **stdlib-only** by design: they talk to
`api.cloudflare.com` over `urllib`, so a runner needs no install step and no
supply chain. `requirements.txt` carries `pytest` and nothing else.

## Credentials it expects

Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `CF_ACCOUNT_ID`,
`CLOUDFLARE_EMAIL_TOKEN`, `CLOUDFLARE_R2_ACCESS_KEY_ID`,
`CLOUDFLARE_R2_SECRET_ACCESS_KEY`, `CLOUDFLARE_R2_BUCKET`,
`CLOUDFLARE_R2_PUBLIC_URL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_JURISDICTION`, `R2_PUBLIC_BASE`,
`R2_PUBLIC_URL`, `GH_APP_ID`, `GH_APP_CLIENT_ID`, `GH_APP_PRIVATE_KEY`,
`GH_PAT`, `PUBLISH_TOKEN`, `MCP_TOKEN`, `ONTOLD_MCP_TOKEN`, `NOTIFY_TOKEN`,
`ROOT_SECRET`, `SIGNER_AUTH`, `SIGNING_SECRET`, `WALLET_MASTER_SEED`,
`WALLET_PRIVATE_KEY`, `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID`,
`API_KEY`.

Variables: `GITHUB_ORG`, `GH_APP_ORG`, `PRODUCT_ZONE`, `MAIL_DOMAIN`,
`MAIL_DESTINATION`, `NOTIFY_URL`, `MINT_ALLOWED_REPOS`.

None are set here. The workflows read them from this repo's own Actions
secrets, so they must be created before any lane will run.

## Cloudflare product sweep

Every Cloudflare product was checked against the source tree — binding
declarations in `wrangler.toml` first, then a name sweep across the repo. What
is actually in use:

| Product | In use | Where |
|---|---|---|
| **Workers** | yes | `workers/{mcp,site-host,wallet-signer}`, `api/_cdn-warmer` |
| **R2** | yes | `SITES` + `PROVENANCE` bindings; `provision-r2`, `seed-r2`, `r2-domain` |
| **Workers KV** | yes | `WARM_LOG` / `HIT_LOG` / `DERIVE_LOG` (cdn-warmer); `RATE` commented out in mcp |
| **Email Routing** | yes | inbound rules — `provision-email-routing`, `switch-inbound`, `restore-inbound` |
| **Email Sending** | yes | `[[send_email]]` binding in mcp; `provision-sending-domain`, DMARC |
| **Custom hostnames** (Cloudflare for SaaS) | yes | `attach-domain`; the `*/*` route it adds out-of-band |
| **Cron Triggers** | yes | cdn-warmer, `crons = ["*/10 * * * *"]` |
| **DNS / zones / registrar** | yes | `audit-zone`, `adopt-domains`, `provision-dmarc` |
| **D1** | token only | `mint-d1-token` mints a D1-scoped token; **no D1 binding exists yet** |
| **Dynamic Workers** (`worker_loaders`) | staged | `LOADER` binding commented out in mcp; `agentSandbox.mjs` + tests are in-tree, awaiting a route |
| **AI Gateway** | yes, but | see below — stayed in ontold |
| **Durable Objects** | no | — |
| **Queues** | no | — |
| **Vectorize** | no | — |
| **Workers AI** (`@cf/…`) | no | — |
| **Hyperdrive, Analytics Engine, Browser Rendering, Stream, Pages, Turnstile, Zero Trust, Images, WAF/rulesets, Logpush, Tunnels, Load Balancers, Page Rules, Snippets, R2 event notifications** | no | — |

Three earlier greps looked like hits and are not: "DURABLE ASSET" is prose in
`scripts/blender/`, "vectorize" is an image-tracing step in a PRD, and "queue"
never appears as a Cloudflare Queue. No Durable Object, Queue, or Vectorize
binding exists anywhere in the source tree.

### AI Gateway — a real surface that stayed behind

`api/_aiProviders-google.ts` optionally proxies every Google model call through
`https://gateway.ai.cloudflare.com/v1/<account>/<gateway>/google-ai-studio`,
switched on by `CF_AI_GATEWAY_ACCOUNT`, `CF_AI_GATEWAY_ID` and (only with
Authenticated Gateway) `CF_AI_GATEWAY_TOKEN`.

It did not come across because it is app runtime code — a Google provider shim
nothing in this repo calls — and because **there is no automation to extract**:
the gateway is created by hand in the dashboard under AI → AI Gateway, and the
three variables are set by hand. That is the one Cloudflare surface in ontold
with no workflow behind it. If you want it automated, that lane does not exist
yet and would be new work.

### D1 has a token but no database

`mint-d1-token` mints a D1-scoped API token, and `mint-deploy-token` /
`attach-domain` reference D1 in their scope lists. No `[[d1_databases]]` binding
exists in any `wrangler.toml` — the credential lane runs ahead of the database.

## What was left behind, and why

This is the Cloudflare surface, not the app around it. Left in `ontold`:

- **App content lanes** that merely *use* Cloudflare — `demo`, `import`,
  `onboard`, `generate-*`, `home-film-smoke`, `unfurl-check`,
  `verify-transform-reveal`, `fetch-brief-source`.
- **`check-keys`** — audits AI-provider keys (Gemini, Runware), not Cloudflare.
- **`api/watch.py`, `api/status.py`, `api/seed/`, `scaffolding/`** — Vercel app
  code. From `api/` only what this repo's own code needs came across:
  `_mail.py`, `_secrets.py`, `_env.py` (imported by `mail_check.py` and
  `derive_tokens.py`), plus the `_consent.py` / `_provenance.py` cluster —
  see below.

Two tests were scoped down rather than deleted, each with the reason written at
the edit:

1. `scripts/publishSiteRepo.test.ts` — the *debate lane* case asserted against
   `generate-debate.yml`, a content workflow that stayed behind. It still
   guards the real thing in `ontold`.
2. The same file's *assumptions* suite is `describe.skip` — it bundles
   `scaffolding/renderEntry.ts`. `publish_site_repo.mjs` treats that renderer
   as optional at runtime (it warns and publishes anyway), so nothing here
   depends on it.

Everything else runs green as copied.

## The request-file trigger, and why the imports are disarmed

Most lanes trigger two ways: `workflow_dispatch`, and a `push:` watching one
file in `.github/dispatch-requests/`. You run a lane by editing its request
file — the diff *is* the authorisation record, which is the point.

There is **no branch filter** on those push triggers. The initial import
therefore touched every watched path at once and fired 25 workflows; all of
them failed on missing secrets, so nothing acted. That is a one-time event —
from here, only editing a given request file fires that lane.

Four request files arrived mid-flight from ontold's real operations, still
carrying `apply: true` and still pointed at the live `ontold.com` zone:
`grant-email-permissions`, `provision-dmarc`, `r2-domain` and `switch-inbound`
(that last one cuts over inbound MX). They have been flipped to
`apply: false`, with the original request preserved in the `why` field. Adding
secrets to this repo cannot now replay a production change by accident. Arm one
deliberately when you mean it — the same disarm-after-the-write convention the
source repo follows.

### Carried-over `ontold` defaults

Several scripts default to ontold's own values — `R2_BUCKET=ontold-public`,
`R2_PUBLIC_BASE=https://media.ontold.com`, the `raineydavid/*` entries in
`mint-allowed-repos.txt`. They are all env- or input-overridable; change them
before pointing this at another account.


### Both halves of two cross-language contracts

`workers/mcp` carries two decisions that also exist in Python, and in both cases
the agreement between them is the safety property:

- **Consent.** `workers/mcp/src/consent.mjs` and `api/_consent.py` both decide
  whether an agent may contact a vulnerable person. Neither owns the answers —
  `shared/consentVectors.json` does, and both suites read it. Copying only the
  JavaScript half would have meant an edit to the fixture that makes the edge
  pass could no longer be caught, which is the exact drift the fixture exists to
  prevent.
- **Provenance.** `workers/mcp/src/provenance.mjs` shares a wire format with
  `api/_provenance.py`; a record signed one side must verify on the other, which
  rests on `canonical()` producing identical bytes (Python escapes non-ASCII to
  `\uXXXX`, `JSON.stringify` does not).

So `api/_consent.py`, `api/_provenance.py`, `api/_provenanceStore.py` and their
tests came across too. All are stdlib-only. Both halves of both contracts now
run here.
