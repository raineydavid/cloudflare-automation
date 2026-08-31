#!/usr/bin/env node
/**
 * Mint a GitHub App installation token for ontold-app.
 *
 * The app (owned by the ontolddotcom org, installed on it) is how
 * generated sites get their own repos WITHOUT a long-lived PAT: this
 * script turns the app's private key into a token that lives ~1 hour
 * and can do exactly what the app's permissions allow, nothing more.
 *
 *   GH_APP_CLIENT_ID   the app's Client ID (public; GitHub's current
 *                      guidance for the JWT issuer — numeric GH_APP_ID
 *                      accepted as fallback)
 *   GH_APP_PRIVATE_KEY the .pem, verbatim (Actions secrets keep the
 *                      newlines; a \n-escaped paste is repaired here)
 *   GITHUB_ORG         which installation to use when the app is
 *                      installed in more than one place
 *
 * Prints ONLY the token on stdout — the caller masks it and passes it
 * on (generate-site.yml feeds it to publish_site_repo.mjs as
 * SYSTEM_GITHUB_TOKEN). Everything diagnostic goes to stderr. With no
 * key configured it prints nothing and exits 0: absence of the app is
 * a fallback, not a failure, same posture as the publisher itself.
 *
 * Stdlib only: the JWT is two base64url JSON blobs signed RS256 with
 * node:crypto. A dependency for nine lines of encoding would be the
 * heavier risk.
 */

import { createSign } from 'node:crypto';

const CLIENT_ID = (process.env.GH_APP_CLIENT_ID || process.env.GH_APP_ID || '').trim();
const KEY_RAW = process.env.GH_APP_PRIVATE_KEY || '';
const ORG = (process.env.GITHUB_ORG || '').trim().toLowerCase();
const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');

if (!CLIENT_ID || !KEY_RAW.trim()) {
  console.error('[app-token] GH_APP_CLIENT_ID / GH_APP_PRIVATE_KEY not configured — skipping');
  process.exit(0);
}
// The classic paste failure: a .pem that arrived with literal "\n"
// two-character sequences instead of newlines.
const KEY = KEY_RAW.includes('-----') && !KEY_RAW.includes('\n')
  ? KEY_RAW.replace(/\\n/g, '\n')
  : KEY_RAW;

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** App JWT: 10 minutes of authority to ask for an installation token,
 *  with 60s of clock-skew allowance behind iat. */
function appJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: CLIENT_ID }));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  return `${header}.${payload}.${b64url(signer.sign(KEY))}`;
}

async function gh(path, init = {}, auth) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${auth}`,
      'x-github-api-version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

const jwt = appJwt();
const installs = await gh('/app/installations', {}, jwt);
if (!installs.ok || !Array.isArray(installs.body) || installs.body.length === 0) {
  console.error(`[app-token] no installations visible (${installs.status}) — is the app installed on the org?`);
  process.exit(0);
}
// Prefer the installation on GITHUB_ORG; a single installation needs no
// preference. More than one with no ORG set is ambiguous — say so and
// take none, because minting against the wrong account is worse.
let install = installs.body.find((i) => (i.account?.login || '').toLowerCase() === ORG);
if (!install && installs.body.length === 1) install = installs.body[0];
if (!install) {
  console.error(`[app-token] ${installs.body.length} installations and GITHUB_ORG=${ORG || '(unset)'} matches none — refusing to guess`);
  process.exit(0);
}

const minted = await gh(`/app/installations/${install.id}/access_tokens`, { method: 'POST' }, jwt);
if (!minted.ok || !minted.body.token) {
  console.error(`[app-token] mint failed (${minted.status}): ${JSON.stringify(minted.body).slice(0, 200)}`);
  process.exit(0);
}
console.error(`[app-token] minted for ${install.account.login} (expires ${minted.body.expires_at})`);
process.stdout.write(minted.body.token);
