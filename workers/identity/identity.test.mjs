import { describe, it, expect, beforeAll } from 'vitest';
import { handle, audienceForCredentials, SubjectHub } from './src/index.mjs';
import { memoryStore, d1Store } from './src/store.mjs';

const T0 = Date.parse('2026-09-03T10:00:00Z');
const ORIGIN = 'https://id.ontold.com';

function fakeKv() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? m.get(k) : null; }, async put(k, v) { m.set(k, v); } };
}
function fakeDo() {
  const objects = new Map();
  return {
    idFromName: (n) => n,
    get: (id) => {
      if (!objects.has(id)) {
        const storage = new Map();
        objects.set(id, new SubjectHub({ storage: {
          get: async (k) => storage.get(k), put: async (k, v) => storage.set(k, v), delete: async (k) => storage.delete(k),
        } }));
      }
      return objects.get(id);
    },
  };
}
function env() {
  const sent = [];
  return {
    sent,
    SESSIONS: fakeKv(),
    SUBJECTS: fakeDo(),
    EMAIL: { async send(m) { sent.push(m); } },
    CLIENT_SECRET_SCREENING: 'screening-secret',
    CLIENT_SECRET_WORKAIS: 'workais-secret',
  };
}
const basic = (id, secret) => `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

async function signIn(e, store, audience, returnTo, now = T0) {
  const begin = await handle(new Request(`${ORIGIN}/signin/begin`, {
    method: 'POST', body: JSON.stringify({ email: 'Rainey@Example.com', audience, returnTo, state: 'xyz' }),
  }), e, { store, now });
  expect(begin.status).toBe(202);
  const link = e.sent.at(-1).raw.match(/https:\/\/\S+/)[0];
  const verify = await handle(new Request(link), e, { store, now: now + 1000 });
  expect(verify.status).toBe(302);
  return new URL(verify.headers.get('location'));
}

describe('ontold-identity', () => {
  beforeAll(() => { process.env.IDENTITY_HMAC_SECRET = 'test-secret'; });

  it('answers the same whatever the address, and mails a link that returns with a code', async () => {
    const e = env(); const store = memoryStore();
    const bad = await handle(new Request(`${ORIGIN}/signin/begin`, { method: 'POST', body: JSON.stringify({ email: 'not an address', audience: 'screening', returnTo: 'https://screeningstudio.com/auth/callback' }) }), e, { store, now: T0 });
    expect(bad.status).toBe(202);
    const back = await signIn(e, store, 'screening', 'https://screeningstudio.com/auth/callback');
    expect(back.origin).toBe('https://screeningstudio.com');
    expect(back.searchParams.get('state')).toBe('xyz');
    expect(back.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(back.searchParams.get('token')).toBeNull();
  });

  it('refuses a return origin that is not the property’s own', async () => {
    const e = env();
    const res = await handle(new Request(`${ORIGIN}/signin/begin`, { method: 'POST', body: JSON.stringify({ email: 'a@example.com', audience: 'screening', returnTo: 'https://evil.example/cb' }) }), e, { store: memoryStore(), now: T0 });
    expect(res.status).toBe(400);
    expect(e.sent).toHaveLength(0);
  });

  it('the audience comes from the client credentials, never the request', async () => {
    const e = env(); const store = memoryStore();
    const back = await signIn(e, store, 'screening', 'https://screeningstudio.com/auth/callback');
    const code = back.searchParams.get('code');
    const wrongClient = await handle(new Request(`${ORIGIN}/token`, { method: 'POST', headers: { authorization: basic('workais', 'workais-secret') }, body: JSON.stringify({ code }) }), e, { store, now: T0 + 2000 });
    expect(wrongClient.status).toBe(400);
    expect((await wrongClient.json()).error).toBe('wrong-audience');
    const ok = await handle(new Request(`${ORIGIN}/token`, { method: 'POST', headers: { authorization: basic('screening', 'screening-secret') }, body: JSON.stringify({ code }) }), e, { store, now: T0 + 2000 });
    expect(ok.status).toBe(200);
    const { token, subject, audience } = await ok.json();
    expect(audience).toBe('screening');
    expect(subject).toMatch(/^sub_/);
    const again = await handle(new Request(`${ORIGIN}/token`, { method: 'POST', headers: { authorization: basic('screening', 'screening-secret') }, body: JSON.stringify({ code }) }), e, { store, now: T0 + 3000 });
    expect((await again.json()).error).toBe('used');
    const session = await handle(new Request(`${ORIGIN}/session?audience=screening`, { headers: { authorization: `Bearer ${token}` } }), e, { store, now: T0 + 4000 });
    expect(session.status).toBe(200);
    expect((await session.json()).subject).toBe(subject);
    const elsewhere = await handle(new Request(`${ORIGIN}/session?audience=workais`, { headers: { authorization: `Bearer ${token}` } }), e, { store, now: T0 + 4000 });
    expect(elsewhere.status).toBe(401);
  });

  it('sign out ends every session for the subject, through the subject’s object', async () => {
    const e = env(); const store = memoryStore();
    const back = await signIn(e, store, 'workais', 'https://workais.com/auth/callback');
    const tok = await handle(new Request(`${ORIGIN}/token`, { method: 'POST', headers: { authorization: basic('workais', 'workais-secret') }, body: JSON.stringify({ code: back.searchParams.get('code') }) }), e, { store, now: T0 + 2000 });
    const { token, subject } = await tok.json();
    const out = await handle(new Request(`${ORIGIN}/signout?audience=workais`, { method: 'POST', headers: { authorization: `Bearer ${token}` } }), e, { store, now: T0 + 5000 });
    expect(out.status).toBe(200);
    const after = await handle(new Request(`${ORIGIN}/session?audience=workais`, { headers: { authorization: `Bearer ${token}` } }), e, { store, now: T0 + 6000 });
    expect(after.status).toBe(401);
    expect((await after.json()).error).toBe('revoked');
    const hub = await e.SUBJECTS.get(subject).fetch(new Request('https://subject/'));
    expect((await hub.json()).revokedAt).toBeGreaterThan(0);
  });

  it('client credentials are checked in constant shape', () => {
    const e = env();
    expect(audienceForCredentials(e, basic('screening', 'screening-secret'))).toBe('screening');
    expect(audienceForCredentials(e, basic('screening', 'wrong'))).toBeNull();
    expect(audienceForCredentials(e, basic('ontold', 'anything'))).toBeNull();
    expect(audienceForCredentials(e, 'Bearer x')).toBeNull();
  });

  it('the D1 store speaks the same shape as memory', async () => {
    const rows = { accounts: [], login_tokens: [], auth_codes: [] };
    const db = { prepare: (sql) => ({ bind: (...args) => ({
      async first() {
        if (sql.startsWith('SELECT subject FROM accounts')) return rows.accounts.find(r => r.email === args[0]) ?? null;
        if (sql.includes('FROM login_tokens')) { const r = rows.login_tokens.find(r => r.hash === args[0]); return r ?? null; }
        if (sql.includes('FROM auth_codes')) { const r = rows.auth_codes.find(r => r.hash === args[0]); return r ?? null; }
        return null;
      },
      async run() {
        if (sql.startsWith('INSERT INTO accounts')) rows.accounts.push({ subject: args[0], email: args[1], created_at: args[2] });
        if (sql.startsWith('INSERT INTO login_tokens')) rows.login_tokens.push({ hash: args[0], subject: args[1], expires_at: args[2], used_at: args[3] });
        if (sql.startsWith('INSERT INTO auth_codes')) rows.auth_codes.push({ hash: args[0], subject: args[1], audience: args[2], expires_at: args[3], used_at: args[4] });
        if (sql.startsWith('UPDATE login_tokens')) { const r = rows.login_tokens.find(r => r.hash === args[1]); if (r) r.used_at = args[0]; }
        if (sql.startsWith('UPDATE auth_codes')) { const r = rows.auth_codes.find(r => r.hash === args[1]); if (r) r.used_at = args[0]; }
        return { success: true };
      },
    }) }) };
    const e = { ...env(), IDENTITY: db };
    const store = d1Store(db);
    const back = await signIn(e, store, 'screening', 'https://screeningstudio.com/auth/callback');
    const tok = await handle(new Request(`${ORIGIN}/token`, { method: 'POST', headers: { authorization: basic('screening', 'screening-secret') }, body: JSON.stringify({ code: back.searchParams.get('code') }) }), e, { store, now: T0 + 2000 });
    expect(tok.status).toBe(200);
    expect(rows.accounts).toHaveLength(1);
    expect(rows.auth_codes[0].used_at).toBe(T0 + 2000);
  });
});

import { mintKey, hashKey, seal, unseal } from './src/ledger.mjs';
import { mintSessionToken } from '../../api/_identity.ts';

describe('the ledger', () => {
  const LEDGER = 'ledger-secret';
  const BYOK_KEY = Buffer.alloc(32, 7).toString('base64');
  const lenv = () => ({ ...env(), LEDGER_SECRET: LEDGER, BYOK_KEY });
  const session = () => `Bearer ${mintSessionToken('sub_alice', 'ontold', T0)}`;
  const asLedger = { 'x-ledger-secret': LEDGER, 'content-type': 'application/json' };

  it('a key is shown once, stored as a hash, and answers to the gateway', async () => {
    const e = lenv(); const store = memoryStore();
    const mint = await handle(new Request(`${ORIGIN}/keys`, { method: 'POST', headers: { authorization: session() }, body: JSON.stringify({ label: 'laptop' }) }), e, { store, now: T0 });
    expect(mint.status).toBe(201);
    const { key, prefix } = await mint.json();
    expect(key.startsWith('ok_')).toBe(true);
    const list = await (await handle(new Request(`${ORIGIN}/keys`, { headers: { authorization: session() } }), e, { store, now: T0 })).json();
    expect(list).toEqual([{ prefix, label: 'laptop', createdAt: T0, revokedAt: null }]);
    expect(JSON.stringify(list)).not.toContain(key);
    const who = await handle(new Request(`${ORIGIN}/keys/introspect`, { method: 'POST', headers: asLedger, body: JSON.stringify({ key }) }), e, { store, now: T0 + 1 });
    expect((await who.json())).toEqual({ subject: 'sub_alice', credits_cents: 0, plan: '', plan_until: 0, byok: {} });
    const noSecret = await handle(new Request(`${ORIGIN}/keys/introspect`, { method: 'POST', body: JSON.stringify({ key }) }), e, { store, now: T0 + 1 });
    expect(noSecret.status).toBe(401);
    await handle(new Request(`${ORIGIN}/keys/${prefix}`, { method: 'DELETE', headers: { authorization: session() } }), e, { store, now: T0 + 2 });
    const gone = await handle(new Request(`${ORIGIN}/keys/introspect`, { method: 'POST', headers: asLedger, body: JSON.stringify({ key }) }), e, { store, now: T0 + 3 });
    expect(gone.status).toBe(404);
  });

  it('credits are granted by the till and spent by usage; brought-key calls cost nothing', async () => {
    const e = lenv(); const store = memoryStore();
    const grant = await handle(new Request(`${ORIGIN}/credits/grant`, { method: 'POST', headers: asLedger, body: JSON.stringify({ subject: 'sub_alice', cents: 500, reason: 'topup' }) }), e, { store, now: T0 });
    expect((await grant.json()).credits_cents).toBe(500);
    const spend = await handle(new Request(`${ORIGIN}/usage`, { method: 'POST', headers: asLedger, body: JSON.stringify({ subject: 'sub_alice', kind: 'image-gen', cents: 6, jobId: 'j1' }) }), e, { store, now: T0 + 1 });
    expect((await spend.json()).credits_cents).toBe(494);
    const own = await handle(new Request(`${ORIGIN}/usage`, { method: 'POST', headers: asLedger, body: JSON.stringify({ subject: 'sub_alice', kind: 'image-gen', cents: 0, byok: true, jobId: 'j2' }) }), e, { store, now: T0 + 2 });
    expect((await own.json()).credits_cents).toBe(494);
    const mine = await handle(new Request(`${ORIGIN}/credits`, { headers: { authorization: session() } }), e, { store, now: T0 + 3 });
    expect((await mine.json()).credits_cents).toBe(494);
  });

  it('a plan is granted by the till, expires on its own, and rides with introspection', async () => {
    const e = lenv(); const store = memoryStore();
    const until = T0 + 30 * 86_400_000;
    const grant = await handle(new Request(`${ORIGIN}/plans/grant`, { method: 'POST', headers: asLedger, body: JSON.stringify({ subject: 'sub_alice', plan: 'film', until }) }), e, { store, now: T0 });
    expect(await grant.json()).toEqual({ plan: 'film', plan_until: until });
    const { key } = await (await handle(new Request(`${ORIGIN}/keys`, { method: 'POST', headers: { authorization: session() }, body: '{}' }), e, { store, now: T0 })).json();
    const during = await (await handle(new Request(`${ORIGIN}/keys/introspect`, { method: 'POST', headers: asLedger, body: JSON.stringify({ key }) }), e, { store, now: T0 + 1 })).json();
    expect(during.plan).toBe('film');
    const after = await (await handle(new Request(`${ORIGIN}/keys/introspect`, { method: 'POST', headers: asLedger, body: JSON.stringify({ key }) }), e, { store, now: until + 1 })).json();
    expect(after.plan).toBe('');
    const past = await handle(new Request(`${ORIGIN}/plans/grant`, { method: 'POST', headers: asLedger, body: JSON.stringify({ subject: 'sub_alice', plan: 'film', until: T0 - 1 }) }), e, { store, now: T0 });
    expect(past.status).toBe(400);
  });

  it('a brought key is sealed at rest and handed to the gateway per call', async () => {
    const e = lenv(); const store = memoryStore();
    const put = await handle(new Request(`${ORIGIN}/byok`, { method: 'PUT', headers: { authorization: session() }, body: JSON.stringify({ provider: 'runware', key: 'rw-live-1234567890' }) }), e, { store, now: T0 });
    expect(put.status).toBe(200);
    const stored = (await store.byokFor('sub_alice'))[0];
    expect(stored.sealed).not.toContain('rw-live');
    expect(await unseal(e, stored.sealed)).toBe('rw-live-1234567890');
    expect(await unseal({ BYOK_KEY: Buffer.alloc(32, 9).toString('base64') }, stored.sealed)).toBeNull();
    const { key } = await (await handle(new Request(`${ORIGIN}/keys`, { method: 'POST', headers: { authorization: session() }, body: '{}' }), e, { store, now: T0 })).json();
    const who = await (await handle(new Request(`${ORIGIN}/keys/introspect`, { method: 'POST', headers: asLedger, body: JSON.stringify({ key }) }), e, { store, now: T0 + 1 })).json();
    expect(who.byok).toEqual({ runware: 'rw-live-1234567890' });
    const bad = await handle(new Request(`${ORIGIN}/byok`, { method: 'PUT', headers: { authorization: session() }, body: JSON.stringify({ provider: 'somebody', key: 'x' }) }), e, { store, now: T0 });
    expect(bad.status).toBe(400);
    await handle(new Request(`${ORIGIN}/byok/runware`, { method: 'DELETE', headers: { authorization: session() } }), e, { store, now: T0 + 2 });
    expect(await store.byokFor('sub_alice')).toEqual([]);
  });

  it('without a session nothing is minted', async () => {
    const e = lenv();
    const res = await handle(new Request(`${ORIGIN}/keys`, { method: 'POST', body: '{}' }), e, { store: memoryStore(), now: T0 });
    expect(res.status).toBe(401);
    expect(hashKey(mintKey().key)).toHaveLength(64);
    expect(await seal({}, 'x')).toBeNull();
  });
});
