/**
 * The reseller's ledger: keys a person mints against their subject,
 * credits they buy from us, usage against them, and provider keys they
 * bring for their own calls. We are the custodian: brought keys are
 * sealed with a secret only this worker holds, and the gateway asks for
 * them server-to-server under a shared secret, per call, never in bulk.
 *
 *   POST   /keys                Bearer session  {label?}   → {key, prefix}  (the key is shown once)
 *   GET    /keys                Bearer session             → [{prefix,label,createdAt,revokedAt}]
 *   DELETE /keys/:prefix        Bearer session             → {ok}
 *   POST   /keys/introspect     X-Ledger-Secret {key}      → {subject, credits_cents, byok:{provider:key}}
 *   GET    /credits             Bearer session             → {credits_cents}
 *   POST   /credits/grant       X-Ledger-Secret {subject, cents, reason} → {credits_cents}   (the till, after payment)
 *   POST   /plans/grant         X-Ledger-Secret {subject, plan, until}   → {plan, plan_until} (the till; a plan is the price of a brought key)
 *   POST   /usage               X-Ledger-Secret {subject, kind, cents, byok, jobId} → {ok, credits_cents}
 *   PUT    /byok                Bearer session  {provider, key} → {ok}
 *   DELETE /byok/:provider      Bearer session             → {ok}
 */

import { createHash, randomBytes } from 'node:crypto';
import { verifySessionToken } from '../../../api/_identity.ts';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

export const KEY_PREFIX = 'ok_';
const PROVIDERS = new Set(['runware', 'google', 'openrouter', 'bytedance', 'runway']);

/** A new key: shown once, stored as a hash, found again by its prefix. */
export function mintKey() {
  const secret = randomBytes(24).toString('base64url');
  const key = `${KEY_PREFIX}${secret}`;
  return { key, hash: hashKey(key), prefix: key.slice(0, 11) };
}

export const hashKey = (key) => createHash('sha256').update(key).digest('hex');

const constantEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
};

const bearer = (req) => {
  const h = req.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
};

async function readJson(req) {
  try { const b = await req.json(); return b && typeof b === 'object' ? b : {}; } catch { return {}; }
}

/** The subject behind a session token for the ontold audience, or null. */
function subjectOf(req, now) {
  const claims = verifySessionToken(bearer(req), 'ontold', now);
  return claims ? claims.sub : null;
}

const fromLedger = (env, req) => Boolean(env.LEDGER_SECRET) && constantEqual(req.headers.get('x-ledger-secret') || '', env.LEDGER_SECRET);

// Brought keys are sealed with AES-GCM under BYOK_KEY (32 bytes, base64).
async function aesKey(env) {
  const raw = Buffer.from(env.BYOK_KEY || '', 'base64');
  if (raw.length !== 32) return null;
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(env, text) {
  const k = await aesKey(env);
  if (!k) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, new TextEncoder().encode(text)));
  return `${Buffer.from(iv).toString('base64')}.${Buffer.from(ct).toString('base64')}`;
}

export async function unseal(env, sealed) {
  const k = await aesKey(env);
  if (!k || typeof sealed !== 'string' || !sealed.includes('.')) return null;
  const [iv, ct] = sealed.split('.', 2);
  try {
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: Buffer.from(iv, 'base64') }, k, Buffer.from(ct, 'base64'));
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/** Every ledger route, or null when the path is not one. */
export async function handleLedger(req, env, store, now) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '');
  const head = path.split('/')[1];
  if (!['keys', 'credits', 'usage', 'byok', 'plans'].includes(head)) return null;

  if (path === '/keys/introspect' && req.method === 'POST') {
    if (!fromLedger(env, req)) return json({ error: 'unauthorized' }, 401);
    const { key } = await readJson(req);
    const row = typeof key === 'string' && key.startsWith(KEY_PREFIX) ? await store.apiKeyByHash(hashKey(key)) : undefined;
    if (!row || row.revokedAt) return json({ error: 'unknown' }, 404);
    const byok = {};
    for (const b of await store.byokFor(row.subject)) {
      const plain = await unseal(env, b.sealed);
      if (plain) byok[b.provider] = plain;
    }
    const plan = await store.plan(row.subject);
    const active = Boolean(plan.plan) && plan.planUntil > now;
    return json({ subject: row.subject, credits_cents: await store.balance(row.subject), plan: active ? plan.plan : '', plan_until: active ? plan.planUntil : 0, byok });
  }

  if (path === '/plans/grant' && req.method === 'POST') {
    if (!fromLedger(env, req)) return json({ error: 'unauthorized' }, 401);
    const body = await readJson(req);
    const until = Number(body.until);
    if (typeof body.subject !== 'string' || !body.subject || typeof body.plan !== 'string' || !body.plan || !Number.isFinite(until) || until <= now) return json({ error: 'bad request' }, 400);
    await store.setPlan(body.subject, body.plan.slice(0, 40), Math.floor(until));
    return json({ plan: body.plan.slice(0, 40), plan_until: Math.floor(until) });
  }

  if (path === '/credits/grant' && req.method === 'POST') {
    if (!fromLedger(env, req)) return json({ error: 'unauthorized' }, 401);
    const body = await readJson(req);
    const cents = Number(body.cents);
    if (typeof body.subject !== 'string' || !body.subject || !Number.isInteger(cents) || cents <= 0) return json({ error: 'bad request' }, 400);
    const balance = await store.adjustBalance(body.subject, cents);
    await store.putUsage({ id: `grant-${now}-${randomBytes(4).toString('hex')}`, subject: body.subject, kind: `grant:${String(body.reason || '').slice(0, 40)}`, cents: -cents, byok: false, at: now });
    return json({ credits_cents: balance });
  }

  if (path === '/usage' && req.method === 'POST') {
    if (!fromLedger(env, req)) return json({ error: 'unauthorized' }, 401);
    const body = await readJson(req);
    const cents = Number(body.cents);
    if (typeof body.subject !== 'string' || !body.subject || !Number.isInteger(cents) || cents < 0) return json({ error: 'bad request' }, 400);
    await store.putUsage({ id: String(body.jobId || `${now}-${randomBytes(4).toString('hex')}`).slice(0, 80), subject: body.subject, kind: String(body.kind || '').slice(0, 40), cents, byok: Boolean(body.byok), at: now });
    const balance = cents ? await store.adjustBalance(body.subject, -cents) : await store.balance(body.subject);
    return json({ ok: true, credits_cents: balance });
  }

  const subject = subjectOf(req, now);
  if (!subject) return json({ error: 'unauthorized' }, 401);

  if (path === '/keys' && req.method === 'POST') {
    const { label } = await readJson(req);
    const k = mintKey();
    await store.putApiKey({ hash: k.hash, subject, label: String(label || '').slice(0, 60), prefix: k.prefix, createdAt: now });
    return json({ key: k.key, prefix: k.prefix }, 201);
  }
  if (path === '/keys' && req.method === 'GET') {
    const rows = await store.apiKeysFor(subject);
    return json(rows.map(r => ({ prefix: r.prefix, label: r.label, createdAt: r.createdAt, revokedAt: r.revokedAt ?? null })));
  }
  if (head === 'keys' && req.method === 'DELETE') {
    const prefix = path.split('/')[2] || '';
    const row = (await store.apiKeysFor(subject)).find(r => r.prefix === prefix);
    if (!row) return json({ error: 'unknown' }, 404);
    return json({ ok: await store.revokeApiKey(row.hash, subject, now) });
  }
  if (path === '/credits' && req.method === 'GET') {
    const plan = await store.plan(subject);
    const active = Boolean(plan.plan) && plan.planUntil > now;
    return json({ credits_cents: await store.balance(subject), plan: active ? plan.plan : '', plan_until: active ? plan.planUntil : 0 });
  }
  if (path === '/byok' && req.method === 'PUT') {
    const { provider, key } = await readJson(req);
    if (!PROVIDERS.has(provider) || typeof key !== 'string' || key.length < 8 || key.length > 400) return json({ error: 'bad request' }, 400);
    const sealed = await seal(env, key);
    if (!sealed) return json({ error: 'not configured' }, 503);
    await store.putByok(subject, provider, sealed, now);
    return json({ ok: true });
  }
  if (head === 'byok' && req.method === 'DELETE') {
    const provider = path.split('/')[2] || '';
    return json({ ok: await store.deleteByok(subject, provider) });
  }
  return json({ error: 'not found' }, 404);
}
