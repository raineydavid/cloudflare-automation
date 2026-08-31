# Cloudflare Workers — augmented CDN layer

Background processing for the augmented CDN layer. These Workers
run on Cloudflare, **NOT on Vercel** — they don't count against the
12-function Vercel limit. They sit ALONGSIDE the existing
`api/watch.py` request-path function.

**Why is this under `api/` if it's not a Vercel function?** Two
reasons:

1. **Project convention.** Server-side code (anything the SPA
   shouldn't bundle) lives under `api/`. The underscore prefix
   (`api/_inference/`, `api/_aiProviders-*`, `api/_cdn-warmer/`)
   signals "not a Vercel route, just a sibling module that lives
   on the server side." Keeps the mental model consistent.
2. **Explicit `.vercelignore`.** Vercel could otherwise pick up the
   nested `package.json` and try to install `@cloudflare/workers-
   types` into the main Node build. `.vercelignore` at the repo
   root excludes `api/_cdn-warmer/` from the Vercel deploy pipeline
   entirely.

The deploy target is Cloudflare via `wrangler` — this folder is
the wrangler root.

```
        Browser ──HTTPS──▶ Cloudflare Edge ──cache miss──▶ Vercel ──▶ R2
                                  │
                                  ▼
                       cf-workers/warmer (cron)
                       fires HEAD requests to pre-fill the edge
                       cache for hot / canonical content
```

## Why Cloudflare and not Vercel for this

1. **Function-count budget.** Vercel Hobby caps at 12 functions; we
   use 11 (`ai` — JSON + SSE stream mode, `refs`, `watch`, `video`,
   `realtime`, `run`, `import`, `status`, `health` — incl. the R2
   probe, `storage/mirror`, `storage/upload`), and `.vercelignore`
   keeps `api/**/test_*.py` from burning slots. Cloudflare Workers
   are a separate billing surface — free tier covers 100k req/day +
   100k KV ops/day, more than enough for the warmer.
2. **Crons are first-class.** Cloudflare Workers have native
   `[triggers] crons = […]` config. Vercel cron is also a function.
3. **Region affinity.** Workers run at the edge near the user, so
   HEAD-fetch warming actually lands in the right PoP.
4. **Keep concerns split.** Request-path stays Vercel (watch.py is
   already well-tuned). Background prediction + warming stays
   Cloudflare. Easier to reason about, easier to scale either side
   independently.

## What's shipped (Phase 1 + Phase 2)

### Phase 1 — canonical warming
- Cron every 10 minutes.
- Reads `CANONICAL.json` — the static list of "must never cold-start"
  ids (lighthouse hero film, cast portraits, AI-GENT series).
- HEAD-fetches `/api/watch?id=<id>&kind=<k>` for each, populating
  the nearest Cloudflare PoP cache.
- Records each warm in `WARM_LOG` (KV).

### Phase 3 — derive pipeline integration

Two endpoints — both pure tracking. The Worker does NOT run renders;
the existing `api/_inference/gateway.execute_video_from_image()` +
`api/_inference/providers/*` are the renderer. The Worker just
correlates intent → result → warming.

- **`POST /derive-variant`** (auth: `X-Ontold-Derive-Token`).
  Body `{ assetId, sceneId, variant, characterId, providerId?, targetRegions? }`.
  Called by the inference gateway (or the workflow wrapping it) at
  job-start. Records `status='requested'` so we have a paper trail
  before the long-running render begins.

- **`POST /derive-result`** (same auth).
  Body `{ assetId, sceneId, variant, status, outputAssetId?, outputWatchKind?, sha256Short?, error? }`.
  Called by the gateway (or `r2_sink.py`) when the render lands in
  R2. Status `done` flips the record's state — the next cron tick
  drains pending derives and warms the output URL to the regions
  listed in the original request.

The cron tick drains THREE sources in priority order:
1. Just-rendered derives (`status === 'done'`, not yet `warmed`)
2. `CANONICAL.json` entries
3. Hit-driven predictions

Successfully warmed derives get stamped `warmed` so they don't
re-fire next tick.

The actual render call lives where it always has —
`aiService.generateVideo()` → `POST /api/video` →
`gateway.execute_video_from_image()` → `router.route()` →
`providers/runway.py` / `tavus.py` / `runware.py` / `local_gpu.py`
/ `thirdparty.py`. Finishing those provider adapters (currently
stubs that raise `NotImplementedError`) is where the work is, not
in a parallel TypeScript abstraction.
- New endpoint: **`POST /derive-result`** (same auth). Body
  `{ assetId, sceneId, variant, status, outputAssetId?, outputWatchKind?, sha256Short?, error? }`.
  GPU worker calls this on completion. Status `done` flips the
  record's state — next cron tick warms the output to the regions
  listed in the request (default: global 10-PoP fan-out).
- The cron tick now drains three sources in priority order:
  1. Just-rendered derives (`status === 'done'`, not yet `warmed`)
  2. CANONICAL.json entries
  3. Hit-driven predictions
- Successfully warmed derives get stamped `warmed` so they don't
  re-fire next tick.

### Phase 2 — hit-driven predictor + recorder
- New endpoint: **`POST /record-hit`**  body `{ id, kind, region?, ts? }`.
  `api/watch.py` fires fire-and-forget hits here for public-cacheable
  kinds (image / thumbnail; films skip because they're no-store).
- The Worker writes hits to `HIT_LOG` (KV) keyed by
  `hit:<id>:<kind>:<hourBucket>` with a 2h TTL.
- Each cron tick the **predictor** reads `HIT_LOG`, aggregates by
  (id, kind) over the last hour, and includes anything with
  ≥ `HIT_THRESHOLD` hits in the warm queue.
- **Hysteresis**: before each warm, the Worker checks `WARM_LOG`
  for the same (id, kind). If the last successful warm was within
  `HYSTERESIS_MS` (10 min), it's skipped. No thrash.

### Tuning knobs (in `src/warmer.ts`)
| Constant | Default | What it does |
|---|---|---|
| `MAX_JOBS_PER_TICK` | 30 | Hard cap per cron run |
| `CONCURRENCY` | 6 | Parallel HEAD requests |
| `HIT_THRESHOLD` | 3 | Hits/hour required to trigger a warm |
| `HYSTERESIS_MS` | 10 min | Cooldown before re-warming |
| `PREDICTOR_LOOKBACK_HOURS` | 1 | Hit window |

## What's next (not in this commit)

- **Tail Worker for passive hit recording**. Replaces the
  api/watch.py POST with a Cloudflare-native pipeline (paid
  feature — $5/mo minimum — defer until Vercel CPU starts looking
  expensive).
- **Per-tenant fair-share queue**. Once a single tenant can push
  thousands of warms.
- **EV math + calibration loop**. Once we have weeks of hit logs.
- **Variant derivation**. Currently we only WARM existing variants.
  The bigger win is pre-DERIVING (`derive-variant` queue job from
  the design spec §7) — origin needs a `/api/derive` companion.

## Env vars (set via `wrangler secret` or in dashboard)

| Var | Where | Purpose |
|---|---|---|
| `ORIGIN_BASE_URL` | wrangler.toml `[vars]` | Origin Cloudflare fronts (e.g. `https://ontold.com`) |
| `WARMER_TOKEN`    | secret | Auth for `GET /warm-now` manual trigger |
| `HIT_TOKEN`       | secret (optional) | Auth for `POST /record-hit` — set to lock down |

And on the Vercel side (`api/watch.py` reads):

| Var | Purpose |
|---|---|
| `WARMER_HIT_URL` | Full URL to the Worker's /record-hit endpoint |
| `WARMER_HIT_TOKEN` | Matching shared secret (if HIT_TOKEN is set) |
| `DERIVE_URL` | Full URL to the Worker's /derive-submit endpoint |
| `DERIVE_TOKEN` | Matching shared secret for DERIVE_TOKEN |

## How the end-to-end loop closes

```
SPA
  │  POST /api/run { mode: 'derive', assetId, sceneId, variant, characterId, ... }
  ▼
api/run.py (dispatch_derive)
  │  POST /derive-submit (auth via X-Ontold-Derive-Token)
  ▼
Worker /derive-submit
  │  1. writeDerive(status='requested')
  │  2. pickProviderId() → 'runway-offline' | 'heygen-batch' | '2d-portrait-batch' | …
  │  3. dispatchX(env, input) — STUB today, real fetch tomorrow
  │  4. writeDerive(updated status)
  └────► returns to SPA via api/run.py with { ok, providerId, status }

(later, when render completes — webhook or polling)
provider webhook → POST /derive-result → writeDerive(status='done', outputAssetId)

(next cron tick)
pendingDeriveWarms() → drains status='done' records → warms output → marks 'warmed'
```

Real provider implementations close the loop with one file change
each:
- `dispatchRunwayOffline` → fetch to Runway's batch render endpoint
- `dispatchHeygenBatch`   → fetch to HeyGen V2 video API
- `dispatch2DPortrait`    → fetch to a small render endpoint
  (ElevenLabs TTS + ffmpeg, GCP Cloud Run or similar)

## Setup

```bash
# One-time:
npm install -g wrangler
cd api/_cdn-warmer
wrangler login

# Create the KV namespace:
wrangler kv namespace create WARM_LOG
# Then paste the returned id into wrangler.toml under [[kv_namespaces]].

# Deploy:
wrangler deploy
```

`CANONICAL.json` is the static list of "always-warm" assets. Edit
to add or remove ids. Deploy applies on next push.

## Costs (Cloudflare free tier)

- Workers: 100k requests/day free. Our cron fires every 10 min ×
  CANONICAL.length HEAD requests. With 20 canonical ids = 2,880
  HEAD requests/day. ~3% of free tier.
- KV: 100k reads/day, 1k writes/day free. We do 1 read + 1 write
  per warm = 5,760 ops/day. Well under.
- Cache: every HEAD that fills a PoP cache slot is essentially
  free (no extra storage cost — uses the same R2-backed cache the
  request path uses).
