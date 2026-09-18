/**
 * The store behind the identity cores: accounts and login tokens
 * (api/_identity.ts AccountStore) plus auth codes (api/_sso.ts). Two
 * implementations of one shape, so the routes are tested against
 * memory and deployed against D1 with nothing between them.
 */

/** Everything the routes persist. */
export function memoryStore() {
  const accounts = new Map();
  const logins = new Map();
  const codes = new Map();
  return {
    async subjectForEmail(email) {
      for (const [subject, row] of accounts) if (row.email === email) return subject;
      return undefined;
    },
    async createAccount(email, subject, now) { accounts.set(subject, { email, createdAt: now }); },
    async putLoginToken(t) { logins.set(t.hash, { ...t }); },
    async takeLoginToken(hash) { return logins.get(hash); },
    async markLoginTokenUsed(hash, now) { const t = logins.get(hash); if (t) t.usedAt = now; },
    async putAuthCode(c) { codes.set(c.hash, { ...c }); },
    async takeAuthCode(hash) { return codes.get(hash); },
    async markAuthCodeUsed(hash, now) { const c = codes.get(hash); if (c) c.usedAt = now; },
    ...ledgerMemory(),
  };
}

/** Keys, credits, usage and brought keys, in memory. */
function ledgerMemory() {
  const keys = new Map();
  const credits = new Map();
  const plans = new Map();
  const usage = [];
  const byok = new Map();
  return {
    async putApiKey(k) { keys.set(k.hash, { ...k }); },
    async apiKeyByHash(hash) { return keys.get(hash); },
    async apiKeysFor(subject) { return [...keys.values()].filter(k => k.subject === subject); },
    async revokeApiKey(hash, subject, now) { const k = keys.get(hash); if (k && k.subject === subject && !k.revokedAt) { k.revokedAt = now; return true; } return false; },
    async balance(subject) { return credits.get(subject) ?? 0; },
    async adjustBalance(subject, delta) { const next = (credits.get(subject) ?? 0) + delta; credits.set(subject, next); return next; },
    async plan(subject) { return plans.get(subject) ?? { plan: '', planUntil: 0 }; },
    async setPlan(subject, plan, planUntil) { plans.set(subject, { plan, planUntil }); },
    async putUsage(u) { usage.push({ ...u }); },
    async putByok(subject, provider, sealed, now) { byok.set(`${subject}/${provider}`, { subject, provider, sealed, updatedAt: now }); },
    async deleteByok(subject, provider) { return byok.delete(`${subject}/${provider}`); },
    async byokFor(subject) { return [...byok.values()].filter(b => b.subject === subject); },
  };
}

/** The same shape on a D1 binding. */
export function d1Store(db) {
  return {
    async subjectForEmail(email) {
      const row = await db.prepare('SELECT subject FROM accounts WHERE email = ?').bind(email).first();
      return row?.subject ?? undefined;
    },
    async createAccount(email, subject, now) {
      await db.prepare('INSERT INTO accounts (subject, email, created_at) VALUES (?, ?, ?)').bind(subject, email, now).run();
    },
    async putLoginToken(t) {
      await db.prepare('INSERT INTO login_tokens (hash, subject, expires_at, used_at) VALUES (?, ?, ?, ?)')
        .bind(t.hash, t.subject, t.expiresAt, t.usedAt ?? null).run();
    },
    async takeLoginToken(hash) {
      const row = await db.prepare('SELECT hash, subject, expires_at, used_at FROM login_tokens WHERE hash = ?').bind(hash).first();
      return row ? { hash: row.hash, subject: row.subject, expiresAt: row.expires_at, usedAt: row.used_at ?? undefined } : undefined;
    },
    async markLoginTokenUsed(hash, now) {
      await db.prepare('UPDATE login_tokens SET used_at = ? WHERE hash = ?').bind(now, hash).run();
    },
    async putAuthCode(c) {
      await db.prepare('INSERT INTO auth_codes (hash, subject, audience, expires_at, used_at) VALUES (?, ?, ?, ?, ?)')
        .bind(c.hash, c.subject, c.audience, c.expiresAt, c.usedAt ?? null).run();
    },
    async takeAuthCode(hash) {
      const row = await db.prepare('SELECT hash, subject, audience, expires_at, used_at FROM auth_codes WHERE hash = ?').bind(hash).first();
      return row ? { hash: row.hash, subject: row.subject, audience: row.audience, expiresAt: row.expires_at, usedAt: row.used_at ?? undefined } : undefined;
    },
    async markAuthCodeUsed(hash, now) {
      await db.prepare('UPDATE auth_codes SET used_at = ? WHERE hash = ?').bind(now, hash).run();
    },
    async putApiKey(k) {
      await db.prepare('INSERT INTO api_keys (hash, subject, label, prefix, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, NULL)')
        .bind(k.hash, k.subject, k.label, k.prefix, k.createdAt).run();
    },
    async apiKeyByHash(hash) {
      const r = await db.prepare('SELECT hash, subject, label, prefix, created_at, revoked_at FROM api_keys WHERE hash = ?').bind(hash).first();
      return r ? { hash: r.hash, subject: r.subject, label: r.label, prefix: r.prefix, createdAt: r.created_at, revokedAt: r.revoked_at ?? undefined } : undefined;
    },
    async apiKeysFor(subject) {
      const { results } = await db.prepare('SELECT hash, subject, label, prefix, created_at, revoked_at FROM api_keys WHERE subject = ? ORDER BY created_at').bind(subject).all();
      return (results || []).map(r => ({ hash: r.hash, subject: r.subject, label: r.label, prefix: r.prefix, createdAt: r.created_at, revokedAt: r.revoked_at ?? undefined }));
    },
    async revokeApiKey(hash, subject, now) {
      const r = await db.prepare('UPDATE api_keys SET revoked_at = ? WHERE hash = ? AND subject = ? AND revoked_at IS NULL').bind(now, hash, subject).run();
      return Boolean(r?.meta?.changes);
    },
    async balance(subject) {
      const r = await db.prepare('SELECT balance_cents FROM credits WHERE subject = ?').bind(subject).first();
      return r?.balance_cents ?? 0;
    },
    async adjustBalance(subject, delta) {
      await db.prepare('INSERT INTO credits (subject, balance_cents) VALUES (?, ?) ON CONFLICT(subject) DO UPDATE SET balance_cents = balance_cents + excluded.balance_cents')
        .bind(subject, delta).run();
      const r = await db.prepare('SELECT balance_cents FROM credits WHERE subject = ?').bind(subject).first();
      return r?.balance_cents ?? 0;
    },
    async plan(subject) {
      const r = await db.prepare('SELECT plan, plan_until FROM credits WHERE subject = ?').bind(subject).first();
      return { plan: r?.plan ?? '', planUntil: r?.plan_until ?? 0 };
    },
    async setPlan(subject, plan, planUntil) {
      await db.prepare('INSERT INTO credits (subject, balance_cents, plan, plan_until) VALUES (?, 0, ?, ?) ON CONFLICT(subject) DO UPDATE SET plan = excluded.plan, plan_until = excluded.plan_until')
        .bind(subject, plan, planUntil).run();
    },
    async putUsage(u) {
      await db.prepare('INSERT INTO usage (id, subject, kind, cents, byok, at) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(u.id, u.subject, u.kind, u.cents, u.byok ? 1 : 0, u.at).run();
    },
    async putByok(subject, provider, sealed, now) {
      await db.prepare('INSERT INTO byok (subject, provider, sealed, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(subject, provider) DO UPDATE SET sealed = excluded.sealed, updated_at = excluded.updated_at')
        .bind(subject, provider, sealed, now).run();
    },
    async deleteByok(subject, provider) {
      const r = await db.prepare('DELETE FROM byok WHERE subject = ? AND provider = ?').bind(subject, provider).run();
      return Boolean(r?.meta?.changes);
    },
    async byokFor(subject) {
      const { results } = await db.prepare('SELECT subject, provider, sealed, updated_at FROM byok WHERE subject = ?').bind(subject).all();
      return (results || []).map(r => ({ subject: r.subject, provider: r.provider, sealed: r.sealed, updatedAt: r.updated_at }));
    },
  };
}
