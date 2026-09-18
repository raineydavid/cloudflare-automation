#!/usr/bin/env node
/**
 * Just-in-time Cloudflare credentials: mint a narrow, SHORT-LIVED
 * token for one job, use it, destroy it.
 *
 * Founder: "surely i just need to create account api tokens and you
 * can create the rest?" Exactly — token creation is the master
 * permission. The long-lived deploy token keeps only what it has
 * always had plus Account API Tokens: Edit; every other capability
 * (zone creation, SSL edits, …) is minted here for minutes at a time.
 * A leaked ephemeral token is dead by teatime; nothing broad ever
 * lands in a secret store.
 *
 * Usage:
 *   mint:   mint_scoped_cf_token.mjs mint <name> <ttl-minutes> <Group Name>[,...] [zone-id]
 *           → prints JSON {id, value} on stdout (caller masks both)
 *   burn:   mint_scoped_cf_token.mjs burn <id>
 *
 * Env: CLOUDFLARE_API_TOKEN (the minting credential),
 *      CF_ACCOUNT_ID, optional CF_API_URL for tests.
 *
 * ## Zone groups need a zone resource, and that is why the first
 * ## custom domain never attached
 *
 * Cloudflare permission groups come in two families. Account groups
 * (D1 Write, Workers Scripts Write) pair with an account resource;
 * ZONE groups — 'SSL and Certificates Write', 'Zone Settings Write' —
 * pair with a zone one. This minted everything against
 * `com.cloudflare.api.account.<ACC>` and read the catalogue from the
 * ACCOUNT endpoint only.
 *
 * So attach-domain asked for 'SSL and Certificates Write', the name
 * did not resolve in the account catalogue, the mint threw, the lane
 * fell back to the standing token, and the standing token got
 * `10000: Authentication error` on the fallback origin. One bug
 * wearing two costumes: it looked like a missing dashboard checkbox,
 * and the ask printed in the error was for a permission we did not
 * actually need to grant.
 *
 * Both halves are fixed here: the catalogue is read from the account
 * AND user endpoints (the same pair mint-d1-token.yml already tries,
 * for the same stated reason), and passing a zone id scopes the policy
 * to that zone.
 */

const API = process.env.CF_API_URL || 'https://api.cloudflare.com/client/v4';
const TOK = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
const ACC = (process.env.CF_ACCOUNT_ID || '').trim();

/** Authenticated Cloudflare call; throws with the API's own first
 *  error so a permission refusal names itself. */
async function cf(method, path, body) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOK}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const d = await r.json().catch(() => ({}));
  if (!d.success) {
    const e = (d.errors || [{}])[0];
    throw new Error(`${method} ${path} → ${e.code || r.status}: ${e.message || 'failed'}`);
  }
  return d.result;
}

/** Resolve permission-group names to ids, from the account's own
 *  catalogue — ids differ per account family and are never hardcoded. */
export async function groupIds(names) {
  // Both catalogues. Zone-scoped groups are not necessarily listed
  // under the account endpoint, and a name that fails to resolve here
  // does not fail loudly at the call site — it throws, the caller
  // falls back to its standing token, and the eventual permission
  // error names a grant that was never the problem.
  const seen = [];
  const errors = [];
  for (const path of [`/accounts/${ACC}/tokens/permission_groups`,
                      '/user/tokens/permission_groups']) {
    try {
      const groups = await cf('GET', path);
      if (Array.isArray(groups)) seen.push(...groups);
    } catch (e) {
      errors.push(`${path}: ${e.message || e}`);
    }
  }
  if (seen.length === 0) {
    throw new Error(`no permission-group catalogue readable (${errors.join('; ') || 'empty'})`);
  }
  return names.map((n) => {
    const g = seen.find((x) => x.name === n);
    if (!g) {
      throw new Error(
        `no permission group named '${n}' in ${seen.length} groups across both catalogues`);
    }
    return { id: g.id };
  });
}

/** Mint an account-owned token scoped to the given groups, expiring
 *  in ttlMinutes. Returns {id, value}.
 *
 *  `zoneId` narrows the policy to one zone, which zone-scoped groups
 *  require. Omitted, the policy covers the account — correct for
 *  account groups and wrong for zone ones. */
export async function mint(name, ttlMinutes, names, zoneId) {
  const expires = new Date(Date.now() + ttlMinutes * 60000).toISOString().replace(/\.\d+Z$/, 'Z');
  const resources = zoneId
    ? { [`com.cloudflare.api.account.zone.${zoneId}`]: '*' }
    : { [`com.cloudflare.api.account.${ACC}`]: '*' };
  const made = await cf('POST', `/accounts/${ACC}/tokens`, {
    name,
    expires_on: expires,
    policies: [{
      effect: 'allow',
      resources,
      permission_groups: await groupIds(names),
    }],
  });
  return { id: made.id, value: made.value };
}

/** Destroy a minted token by id. Never throws — burning twice, or
 *  burning after expiry, is a success, not a failure. */
export async function burn(id) {
  try { await cf('DELETE', `/accounts/${ACC}/tokens/${id}`); return true; }
  catch { return false; }
}

const [mode, a, b, c, d] = process.argv.slice(2);
if (mode === 'mint') {
  if (!TOK || !ACC) { console.error('CLOUDFLARE_API_TOKEN / CF_ACCOUNT_ID missing'); process.exit(1); }
  mint(a, Number(b) || 20, String(c || '').split(',').map((s) => s.trim()).filter(Boolean),
       (d || '').trim() || undefined)
    .then((t) => console.log(JSON.stringify(t)))
    .catch((e) => { console.error(String(e.message || e)); process.exit(1); });
} else if (mode === 'burn') {
  burn(a).then((okBurn) => console.error(okBurn ? `[cf-token] burned ${a}` : `[cf-token] ${a} already gone`));
}
