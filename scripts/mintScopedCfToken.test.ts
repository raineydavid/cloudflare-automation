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
      if ((req.url || '').endsWith('/tokens/permission_groups')) {
        return send({ success: true, result: [
          { id: 'pg-zone', name: 'Zone Write' },
          { id: 'pg-ssl', name: 'SSL and Certificates Write' },
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

  it('burning is idempotent: twice is a success, not a failure', async () => {
    const { burn } = await import('./mint_scoped_cf_token.mjs');
    expect(await burn('tok-1')).toBe(true);
    expect(await burn('tok-1')).toBe(false); // already gone — returns false, never throws
  });
});
