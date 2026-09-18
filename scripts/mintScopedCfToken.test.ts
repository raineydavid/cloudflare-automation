/**
 * Just-in-time Cloudflare tokens, against a stub API. What is pinned
 * is the credential HYGIENE: names resolve to ids via the account's
 * own catalogue, every minted token carries an expiry (ephemeral by
 * construction — the opposite rule to the runtime tokens we mint for
 * apps), and burning is tolerant because burning twice is a success.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';

let server: Server;
let base = '';
let seen: Array<{ method: string; path: string; body: any }> = [];
let deleted: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method || '', path: req.url || '', body });
      const send = (obj: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      // The two catalogues differ, which is the whole bug. Account
      // groups live under /accounts/<id>/tokens/permission_groups;
      // 'SSL and Certificates Write' is a ZONE group and is served
      // from /user/tokens/permission_groups. A minter that reads only
      // the account endpoint cannot resolve it, throws, and the caller
      // silently falls back to its standing token.
      if ((req.url || '').startsWith('/user/tokens/permission_groups')) {
        return send({ success: true, result: [
          { id: 'pg-ssl', name: 'SSL and Certificates Write' },
        ] });
      }
      if ((req.url || '').endsWith('/tokens/permission_groups')) {
        return send({ success: true, result: [
          { id: 'pg-zone', name: 'Zone Write' },
        ] });
      }
      if (req.method === 'POST' && (req.url || '').endsWith('/tokens')) {
        return send({ success: true, result: { id: 'tok-1', value: 'ephemeral-value' } });
      }
      if (req.method === 'DELETE') {
        const id = (req.url || '').split('/').pop()!;
        if (deleted.includes(id)) return send({ success: false, errors: [{ code: 1001, message: 'not found' }] });
        deleted.push(id);
        return send({ success: true, result: { id } });
      }
      send({ success: false, errors: [{ code: 9999, message: 'unexpected' }] });
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  process.env.CF_API_URL = base;
  process.env.CLOUDFLARE_API_TOKEN = 'stub-base-token';
  process.env.CF_ACCOUNT_ID = 'a'.repeat(32);
});

afterAll(() => server.close());

describe('mint_scoped_cf_token', () => {
  it('mints an account-owned token with an expiry, groups resolved by name', async () => {
    const { mint } = await import('./mint_scoped_cf_token.mjs');
    const t = await mint('jit-test', 20, ['Zone Write']);
    expect(t).toEqual({ id: 'tok-1', value: 'ephemeral-value' });
    const create = seen.find((s) => s.method === 'POST' && s.path.endsWith('/tokens'))!;
    expect(create.body.policies[0].permission_groups).toEqual([{ id: 'pg-zone' }]);
    expect(create.body.policies[0].resources).toEqual({ [`com.cloudflare.api.account.${'a'.repeat(32)}`]: '*' });
    // Ephemeral BY CONSTRUCTION: expires within the hour, never blank.
    const expires = Date.parse(create.body.expires_on);
    expect(expires).toBeGreaterThan(Date.now());
    expect(expires).toBeLessThan(Date.now() + 3600_000);
  });

  it('refuses an unknown permission group by name, loudly', async () => {
    const { mint } = await import('./mint_scoped_cf_token.mjs');
    await expect(mint('jit-test', 20, ['Nonexistent Write'])).rejects.toThrow(/no permission group/);
  });

  it('resolves a ZONE group the account catalogue does not list', async () => {
    // The defect that cost the first custom domain. attach-domain asked
    // for 'SSL and Certificates Write', the account catalogue did not
    // have it, the mint threw, the lane fell back to the standing
    // token, and Cloudflare answered 10000 on the fallback origin. The
    // error printed asked for a dashboard checkbox that was never the
    // problem.
    const { mint } = await import('./mint_scoped_cf_token.mjs');
    const t = await mint('jit-ssl', 20, ['SSL and Certificates Write'], 'z'.repeat(32));
    expect(t.value).toBe('ephemeral-value');
    const create = seen.filter((s) => s.method === 'POST' && s.path.endsWith('/tokens')).pop()!;
    expect(create.body.policies[0].permission_groups).toEqual([{ id: 'pg-ssl' }]);
  });

  it('a zone id scopes the policy to the zone, not the account', async () => {
    // A zone permission group in an account-scoped policy is not a
    // narrower grant, it is an invalid one.
    const { mint } = await import('./mint_scoped_cf_token.mjs');
    await mint('jit-ssl', 20, ['SSL and Certificates Write'], 'z'.repeat(32));
    const create = seen.filter((s) => s.method === 'POST' && s.path.endsWith('/tokens')).pop()!;
    expect(create.body.policies[0].resources).toEqual({
      [`com.cloudflare.api.account.zone.${'z'.repeat(32)}`]: '*',
    });
  });

  it('without a zone id the policy still covers the account', async () => {
    // Account groups — D1 Write, Workers Scripts Write — are unchanged.
    const { mint } = await import('./mint_scoped_cf_token.mjs');
    await mint('jit-acct', 20, ['Zone Write']);
    const create = seen.filter((s) => s.method === 'POST' && s.path.endsWith('/tokens')).pop()!;
    expect(create.body.policies[0].resources).toEqual({
      [`com.cloudflare.api.account.${'a'.repeat(32)}`]: '*',
    });
  });

  it('burning is idempotent: twice is a success, not a failure', async () => {
    const { burn } = await import('./mint_scoped_cf_token.mjs');
    expect(await burn('tok-1')).toBe(true);
    expect(await burn('tok-1')).toBe(false); // already gone — returns false, never throws
  });
});
