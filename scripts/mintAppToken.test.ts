/**
 * The app-token mint, against a stub GitHub that can say no.
 *
 * Same discipline as publishSiteRepo.test.ts (and for the same reason —
 * the stub that could not fail proved nothing): the stub here verifies
 * the JWT's actual claims, serves multiple installations, and the
 * assertions read what was sent. Async because the stub shares this
 * process's event loop.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { generateKeyPairSync, createVerify } from 'crypto';
import { join } from 'path';

const run = promisify(execFile);
const SCRIPT = join(__dirname, 'mint_app_token.mjs');

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = privateKey.export({ type: 'pkcs1', format: 'pem' }) as string;

let server: Server;
let base = '';
let lastJwt: { header: any; payload: any; valid: boolean } | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    const auth = (req.headers.authorization || '').replace('Bearer ', '');
    const send = (code: number, obj: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(obj));
    };
    if (req.url === '/app/installations') {
      const [h, p, sig] = auth.split('.');
      const verify = createVerify('RSA-SHA256');
      verify.update(`${h}.${p}`);
      lastJwt = {
        header: JSON.parse(Buffer.from(h, 'base64url').toString()),
        payload: JSON.parse(Buffer.from(p, 'base64url').toString()),
        valid: verify.verify(publicKey, Buffer.from(sig, 'base64url')),
      };
      return send(200, [
        { id: 11, account: { login: 'raineydavid' } },
        { id: 22, account: { login: 'ontolddotcom' } },
      ]);
    }
    if (req.url === '/app/installations/22/access_tokens' && req.method === 'POST') {
      return send(201, { token: 'ghs_stubtoken22', expires_at: '2026-08-02T14:00:00Z' });
    }
    if (req.url === '/app/installations/11/access_tokens' && req.method === 'POST') {
      return send(201, { token: 'ghs_stubtoken11', expires_at: '2026-08-02T14:00:00Z' });
    }
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(() => server.close());

function mint(env: Record<string, string>) {
  return run('node', [SCRIPT], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_API_URL: base, ...env },
  });
}

describe('mint_app_token', () => {
  it('signs a valid RS256 JWT with the client id as issuer and picks the org installation', async () => {
    const { stdout, stderr } = await mint({
      GH_APP_CLIENT_ID: 'Iv23liTESTCLIENT',
      GH_APP_PRIVATE_KEY: PEM,
      GITHUB_ORG: 'ontolddotcom',
    });
    expect(stdout).toBe('ghs_stubtoken22');           // token ONLY on stdout
    expect(stderr).toContain('ontolddotcom');
    expect(lastJwt!.valid, 'signature must verify against the real public key').toBe(true);
    expect(lastJwt!.header.alg).toBe('RS256');
    expect(lastJwt!.payload.iss).toBe('Iv23liTESTCLIENT');
    // 10-minute ceiling GitHub enforces, with skew allowance behind iat
    expect(lastJwt!.payload.exp - lastJwt!.payload.iat).toBeLessThanOrEqual(600);
  });

  it('repairs a \\n-escaped key paste', async () => {
    const { stdout } = await mint({
      GH_APP_CLIENT_ID: 'Iv23liTESTCLIENT',
      GH_APP_PRIVATE_KEY: PEM.replace(/\n/g, '\\n'),
      GITHUB_ORG: 'ontolddotcom',
    });
    expect(stdout).toBe('ghs_stubtoken22');
  });

  it('refuses to guess between installations when the org matches none', async () => {
    const { stdout, stderr } = await mint({
      GH_APP_CLIENT_ID: 'Iv23liTESTCLIENT',
      GH_APP_PRIVATE_KEY: PEM,
      GITHUB_ORG: 'someone-else',
    });
    expect(stdout).toBe('');
    expect(stderr).toContain('refusing to guess');
  });

  it('prints nothing and exits 0 without a key — absence is a fallback, not a failure', async () => {
    const { stdout, stderr } = await mint({
      GH_APP_CLIENT_ID: '', GH_APP_ID: '', GH_APP_PRIVATE_KEY: '',
    });
    expect(stdout).toBe('');
    expect(stderr).toContain('skipping');
  });
});
