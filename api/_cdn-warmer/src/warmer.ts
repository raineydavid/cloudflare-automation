/**
 * warmer.ts — augmented CDN warmer + predictor + hit recorder.
 *
 * Three handlers in one Worker:
 *
 *   scheduled()              cron tick (per wrangler.toml [triggers])
 *   fetch(POST /record-hit)  hit recorder — clients / Vercel call this
 *   fetch(GET  /warm-now)    manual trigger behind a shared secret
 *
 * Architecture:
 *
 *   Client / Vercel ──POST /record-hit──▶ Worker ──▶ HIT_LOG (KV)
 *                                            │
 *                                            └──── on cron tick ────┐
 *                                                                   │
 *                                            ┌──────────────────────┘
 *                                            ▼
 *                                  Predictor (rules-based)
 *                                            │
 *                                            ▼
 *                                  Warmer (HEAD fan-out)
 *                                            │
 *                                            ▼
 *                                  WARM_LOG (hysteresis)
 *
 * Phase 2 rules (more in the design spec; this is the MVP set):
 *   R1. Anything in CANONICAL.json — always warm.
 *   R2. Any (id, kind) with ≥ HIT_THRESHOLD hits in last hour — warm.
 *   R3. Honour hysteresis — don't re-warm same (id, kind) within
 *       HYSTERESIS_MS of the last successful warm.
 *
 * Cost ballpark (free tier): 100k Worker req/day, 100k KV reads/day,
 * 1k KV writes/day. Hit recording is the dominant write — every
 * cached request that misses the edge triggers one. Budget for
 * ~30 RPS sustained on hits before KV writes blow free tier.
 */

interface Env {
    ORIGIN_BASE_URL: string;
    WARM_LOG:        KVNamespace;
    HIT_LOG:         KVNamespace;
    /** Derive pipeline tracking — request + result records for the
     *  BatchProvider (offline render) flow. Host POSTs new derive
     *  requests; the GPU orchestrator POSTs results when renders
     *  complete; the cron tick scans for newly-completed records
     *  and warms the output to the right regions. */
    DERIVE_LOG:      KVNamespace;
    /** Shared secret for the manual /warm-now trigger. */
    WARMER_TOKEN?:   string;
    /** Optional shared secret for /record-hit. Unset = open endpoint
     *  (fine for early dev; lock down when public). */
    HIT_TOKEN?:      string;
    /** Required shared secret for /derive-variant + /derive-result —
     *  these write authoritative records, must be locked from day one. */
    DERIVE_TOKEN?:   string;
}

interface CanonicalEntry {
    id:    string;
    kind:  HitKind;
    note?: string;
}

interface CanonicalList {
    items: CanonicalEntry[];
}

type HitKind = 'video' | 'thumbnail' | 'captions';

interface HitRecord {
    id:      string;
    kind:    HitKind;
    region?: string;     // ISO country code (Cloudflare cf.country)
    ts?:     number;     // ms since epoch
}

interface HitBucket {
    count:   number;
    regions: Record<string, number>;
    lastTs:  number;
}

// ─── Derive pipeline (BatchProvider results) ─────────────────────
//
// The render orchestrator (Vercel / GPU worker) writes derive records
// here. State machine: requested → queued → rendering → done | failed.
// On `done`, the cron tick picks it up, warms the resulting variant
// URL to the right regions, then marks it `warmed`.
type DeriveStatus = 'requested' | 'queued' | 'rendering' | 'done' | 'failed' | 'warmed';

interface DeriveRecord {
    assetId:        string;
    sceneId:        string;
    variant:        string;             // VariantSlug — string for storage portability
    characterId:    string;
    providerId?:    string;
    status:         DeriveStatus;
    requestedAt:    number;
    completedAt?:   number;
    /** Set on `done` — the cache-key path the warmer should HEAD. */
    outputWatchKind?: HitKind;          // usually 'video'; 'thumbnail' for stills
    outputAssetId?:   string;           // resolves through api/watch.py — host writes this
    sha256Short?:     string;           // version tag for cache key
    error?:         string;
    /** Optional explicit regions. When unset, warms to a default
     *  global set (10-PoP fan-out). */
    targetRegions?: string[];
}

// Import the canonical list at build time. wrangler bundles JSON
// imports natively — no fetch round-trip at runtime.
import canonical from '../CANONICAL.json';

// ─── Tuning constants ────────────────────────────────────────────
const MAX_JOBS_PER_TICK        = 30;
const CONCURRENCY              = 6;
const WARM_LOG_TTL_SEC         = 60 * 60 * 24;     // 24h
const HIT_LOG_TTL_SEC          = 60 * 60 * 2;      // 2h
const HYSTERESIS_MS            = 10 * 60 * 1000;   // 10 min — don't re-warm within
const HIT_THRESHOLD            = 3;                 // hits/hour to trigger a warm
const PREDICTOR_LOOKBACK_HOURS = 1;

// ─── Key helpers ─────────────────────────────────────────────────
function warmLogKey(id: string, kind: HitKind): string {
    return `warm:${id}:${kind}`;
}

function hitBucketKey(id: string, kind: HitKind, hourBucket: number): string {
    return `hit:${id}:${kind}:${hourBucket}`;
}

function canonicalUrl(origin: string, item: { id: string; kind: HitKind }): string {
    const u = new URL('/api/watch', origin);
    u.searchParams.set('id', item.id);
    u.searchParams.set('kind', item.kind);
    return u.toString();
}

// ─── Warm step ───────────────────────────────────────────────────
async function warmOne(env: Env, item: CanonicalEntry, reason: string): Promise<{ ok: boolean; status?: number; ms: number }> {
    const url = canonicalUrl(env.ORIGIN_BASE_URL, item);
    const startedAt = Date.now();
    try {
        const res = await fetch(url, {
            method: 'HEAD',
            redirect: 'manual',
            cf: { cacheEverything: true } as any,
        });
        const ms = Date.now() - startedAt;
        console.info(`[warmer] warm ok id=${item.id} kind=${item.kind} reason=${reason} status=${res.status} ${ms}ms`);
        return { ok: res.status >= 200 && res.status < 400, status: res.status, ms };
    } catch (e) {
        const ms = Date.now() - startedAt;
        console.error('[warmer] warm failed', item.id, item.kind, reason, e);
        return { ok: false, ms };
    }
}

async function shouldSkipHysteresis(env: Env, item: CanonicalEntry): Promise<boolean> {
    const log = await env.WARM_LOG.get(warmLogKey(item.id, item.kind), 'json') as { at: number } | null;
    if (!log) return false;
    return (Date.now() - log.at) < HYSTERESIS_MS;
}

function recordWarm(env: Env, item: CanonicalEntry, result: { status?: number; ms: number }, ctx: ExecutionContext): void {
    ctx.waitUntil(env.WARM_LOG.put(
        warmLogKey(item.id, item.kind),
        JSON.stringify({ at: Date.now(), status: result.status, ms: result.ms }),
        { expirationTtl: WARM_LOG_TTL_SEC },
    ));
}

// ─── Predictor (rules-based) ─────────────────────────────────────
async function predictFromHits(env: Env): Promise<CanonicalEntry[]> {
    const list = await env.HIT_LOG.list({ prefix: 'hit:', limit: 1000 });
    const cutoffHour = Math.floor((Date.now() - PREDICTOR_LOOKBACK_HOURS * 3600_000) / 3600_000);
    // Aggregate by (id, kind) summing counts within the lookback window.
    const totals = new Map<string, { id: string; kind: HitKind; count: number }>();
    for (const key of list.keys) {
        // key shape: hit:<id>:<kind>:<hourBucket>
        const parts = key.name.split(':');
        if (parts.length !== 4 || parts[0] !== 'hit') continue;
        const id   = parts[1];
        const kind = parts[2] as HitKind;
        const hour = Number(parts[3]);
        if (!Number.isFinite(hour) || hour < cutoffHour) continue;
        const bucket = await env.HIT_LOG.get(key.name, 'json') as HitBucket | null;
        if (!bucket) continue;
        const k = `${id}:${kind}`;
        const cur = totals.get(k) || { id, kind, count: 0 };
        cur.count += bucket.count;
        totals.set(k, cur);
    }
    return Array.from(totals.values())
        .filter(t => t.count >= HIT_THRESHOLD)
        .sort((a, b) => b.count - a.count)
        .map(t => ({ id: t.id, kind: t.kind, note: `${t.count} hits/h` }));
}

// ─── Hit recorder ────────────────────────────────────────────────
async function recordHit(env: Env, hit: HitRecord): Promise<void> {
    const ts = hit.ts || Date.now();
    const hourBucket = Math.floor(ts / 3600_000);
    const key = hitBucketKey(hit.id, hit.kind, hourBucket);
    const existing = await env.HIT_LOG.get(key, 'json') as HitBucket | null;
    const next: HitBucket = {
        count:   (existing?.count || 0) + 1,
        regions: { ...(existing?.regions || {}) },
        lastTs:  ts,
    };
    if (hit.region) {
        next.regions[hit.region] = (next.regions[hit.region] || 0) + 1;
    }
    await env.HIT_LOG.put(key, JSON.stringify(next), { expirationTtl: HIT_LOG_TTL_SEC });
}

// ─── Derive helpers ──────────────────────────────────────────────
function deriveKey(assetId: string, sceneId: string, variant: string): string {
    return `derive:${assetId}:${sceneId}:${variant}`;
}

async function readDerive(env: Env, key: string): Promise<DeriveRecord | null> {
    return env.DERIVE_LOG.get(key, 'json') as Promise<DeriveRecord | null>;
}

async function writeDerive(env: Env, key: string, rec: DeriveRecord): Promise<void> {
    // 7-day TTL — derives are reference data after warming completes.
    // The OUTPUT object in R2 persists; this row just tracks pipeline state.
    await env.DERIVE_LOG.put(key, JSON.stringify(rec), { expirationTtl: 7 * 24 * 3600 });
}

/** Scan DERIVE_LOG for records in `done` state that haven't been
 *  warmed yet. Returns the warming targets (treated as CanonicalEntries
 *  so the existing warm loop handles them with hysteresis + concurrency). */
async function pendingDeriveWarms(env: Env): Promise<{ items: CanonicalEntry[]; keys: string[] }> {
    const list = await env.DERIVE_LOG.list({ prefix: 'derive:', limit: 1000 });
    const items: CanonicalEntry[] = [];
    const keys:  string[] = [];
    for (const k of list.keys) {
        const rec = await readDerive(env, k.name);
        if (!rec || rec.status !== 'done') continue;
        if (!rec.outputAssetId || !rec.outputWatchKind) continue;
        items.push({
            id:   rec.outputAssetId,
            kind: rec.outputWatchKind,
            note: `derive ${rec.assetId}/${rec.sceneId}/${rec.variant}`,
        });
        keys.push(k.name);
    }
    return { items, keys };
}

async function markDeriveWarmed(env: Env, key: string): Promise<void> {
    const rec = await readDerive(env, key);
    if (!rec) return;
    await writeDerive(env, key, { ...rec, status: 'warmed' });
}

// ─── Predict + warm — shared by scheduled() and /warm-now ────────
async function runPredictAndWarm(env: Env, ctx: ExecutionContext): Promise<void> {
    const list = canonical as CanonicalList;
    const fromCanonical = (list.items || []).map(it => ({ ...it, note: it.note || 'canonical' }));
    const fromHits      = await predictFromHits(env);
    // Derives ride a separate channel — they're explicit "just-rendered"
    // signals, higher priority than hit-based predictions. Track the
    // KV keys so we can stamp them `warmed` after a successful HEAD.
    const fromDerives   = await pendingDeriveWarms(env);

    // Combine + dedupe. Order: derives (just-rendered, high priority) →
    // canonical (always-warm) → hit-driven (predictive). Map back to
    // keys for the post-warm stamping step.
    const seen = new Set<string>();
    const queue: CanonicalEntry[] = [];
    const deriveKeyByEntry = new Map<string, string>();
    for (let i = 0; i < fromDerives.items.length; i++) {
        const item = fromDerives.items[i];
        const k = `${item.id}:${item.kind}`;
        if (seen.has(k)) continue;
        seen.add(k);
        queue.push(item);
        deriveKeyByEntry.set(k, fromDerives.keys[i]);
    }
    for (const item of [...fromCanonical, ...fromHits]) {
        const k = `${item.id}:${item.kind}`;
        if (seen.has(k)) continue;
        seen.add(k);
        queue.push(item);
    }
    const items = queue.slice(0, MAX_JOBS_PER_TICK);
    console.info(`[warmer] tick — derives=${fromDerives.items.length} canonical=${fromCanonical.length} hit-driven=${fromHits.length} queued=${items.length} origin=${env.ORIGIN_BASE_URL}`);

    let okCount   = 0;
    let failCount = 0;
    let skipCount = 0;

    const pending = [...items];
    const workers = Array.from({ length: CONCURRENCY }, async () => {
        while (pending.length > 0) {
            const item = pending.shift();
            if (!item) return;
            if (await shouldSkipHysteresis(env, item)) {
                skipCount++;
                continue;
            }
            const result = await warmOne(env, item, item.note || '');
            if (result.ok) {
                okCount++;
                recordWarm(env, item, result, ctx);
                // If this item came from a derive request, stamp the
                // derive record `warmed` so we don't re-warm next tick.
                const dk = deriveKeyByEntry.get(`${item.id}:${item.kind}`);
                if (dk) ctx.waitUntil(markDeriveWarmed(env, dk));
            } else {
                failCount++;
            }
        }
    });
    await Promise.all(workers);

    console.info(`[warmer] tick done — ok=${okCount} fail=${failCount} skipped(hysteresis)=${skipCount}`);
}

// ─── Worker entry ────────────────────────────────────────────────
export default {
    async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
        await runPredictAndWarm(env, ctx);
    },

    async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        const url = new URL(req.url);

        // ── Hit recorder ────────────────────────────────────────
        // POST /record-hit  body: { id, kind, region?, ts? }
        // Optional auth via X-Ontold-Hit-Token header.
        if (url.pathname === '/record-hit' && req.method === 'POST') {
            if (env.HIT_TOKEN) {
                const auth = req.headers.get('x-ontold-hit-token');
                if (auth !== env.HIT_TOKEN) return new Response('forbidden', { status: 403 });
            }
            let body: Partial<HitRecord>;
            try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
            if (!body.id || !body.kind) return new Response('bad request', { status: 400 });
            if (!['video', 'thumbnail', 'captions'].includes(body.kind as string)) {
                return new Response('bad kind', { status: 400 });
            }
            // Cloudflare ships request country as req.cf.country.
            // Prefer that over a client-supplied region — clients can lie.
            const cfRegion = (req as any).cf?.country;
            ctx.waitUntil(recordHit(env, {
                id:     body.id,
                kind:   body.kind as HitKind,
                region: typeof cfRegion === 'string' ? cfRegion : body.region,
                ts:     body.ts,
            }));
            // Respond fast — the actual KV write runs via ctx.waitUntil.
            return new Response('ok', { status: 200 });
        }

        // ── Derive request (host-side tracking) ─────────────────
        // POST /derive-variant
        // body: { assetId, sceneId, variant, characterId, providerId?, targetRegions? }
        // Called by api/_inference/gateway.execute_video_from_image()
        // (or the workflow that wraps it) at job-start time. Records
        // intent so the warmer cron can correlate it with the result
        // that lands at /derive-result. The actual render does NOT
        // happen here — the existing gateway + provider adapters in
        // api/_inference/providers/* are the renderer.
        // Records the intent — the actual render happens on a GPU
        // worker (Vercel api/run.py or external). Result flows
        // back via POST /derive-result.
        if (url.pathname === '/derive-variant' && req.method === 'POST') {
            const auth = req.headers.get('x-ontold-derive-token');
            if (!env.DERIVE_TOKEN || auth !== env.DERIVE_TOKEN) {
                return new Response('forbidden', { status: 403 });
            }
            let body: any;
            try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
            const { assetId, sceneId, variant, characterId, providerId, targetRegions } = body || {};
            if (!assetId || !sceneId || !variant || !characterId) {
                return new Response('bad request', { status: 400 });
            }
            const key = deriveKey(assetId, sceneId, variant);
            const rec: DeriveRecord = {
                assetId,
                sceneId,
                variant,
                characterId,
                providerId,
                status:      'requested',
                requestedAt: Date.now(),
                targetRegions,
            };
            ctx.waitUntil(writeDerive(env, key, rec));
            return new Response(JSON.stringify({ ok: true, key }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }

        // ── Derive result ───────────────────────────────────────
        // POST /derive-result
        // body: { assetId, sceneId, variant, status, outputAssetId?, outputWatchKind?, sha256Short?, error? }
        // GPU worker calls this when the BatchProvider returns.
        // Status `done` triggers warming on the next cron tick.
        if (url.pathname === '/derive-result' && req.method === 'POST') {
            const auth = req.headers.get('x-ontold-derive-token');
            if (!env.DERIVE_TOKEN || auth !== env.DERIVE_TOKEN) {
                return new Response('forbidden', { status: 403 });
            }
            let body: any;
            try { body = await req.json(); } catch { return new Response('bad json', { status: 400 }); }
            const { assetId, sceneId, variant, status } = body || {};
            if (!assetId || !sceneId || !variant || !status) {
                return new Response('bad request', { status: 400 });
            }
            if (!['queued', 'rendering', 'done', 'failed'].includes(status)) {
                return new Response('bad status', { status: 400 });
            }
            const key = deriveKey(assetId, sceneId, variant);
            const existing = await readDerive(env, key);
            if (!existing) {
                return new Response('unknown derive — POST /derive-variant first', { status: 404 });
            }
            const updated: DeriveRecord = {
                ...existing,
                status,
                completedAt:      status === 'done' || status === 'failed' ? Date.now() : existing.completedAt,
                outputAssetId:    body.outputAssetId  || existing.outputAssetId,
                outputWatchKind:  body.outputWatchKind || existing.outputWatchKind,
                sha256Short:      body.sha256Short    || existing.sha256Short,
                error:            body.error          || existing.error,
            };
            ctx.waitUntil(writeDerive(env, key, updated));
            return new Response('ok', { status: 200 });
        }

        // ── Manual warm trigger ─────────────────────────────────
        if (url.pathname === '/warm-now') {
            const auth = req.headers.get('x-ontold-warmer-token');
            if (!auth || auth !== env.WARMER_TOKEN) {
                return new Response('forbidden', { status: 403 });
            }
            await runPredictAndWarm(env, ctx);
            return new Response('ok', { status: 200 });
        }

        return new Response('not found', { status: 404 });
    },
};
