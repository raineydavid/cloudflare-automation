/**
 * ontold-identity — sign in once, for every property.
 *
 * The cores in api/_identity.ts and api/_sso.ts decide everything; this
 * file gives them a store, a mailer and HTTP. A property never receives
 * a session in a URL: the redirect carries a single-use code, and the
 * property exchanges it here with its own client credentials, so the
 * audience on the token comes from who is asking, not from the request.
 *
 *   POST /signin/begin   {email, audience, returnTo, state?}  → 202, always
 *   GET  /signin/verify  ?token&audience&returnTo&state       → 302 returnTo?code=
 *   POST /token          Basic client:secret, {code}          → {token, subject, exp}
 *   GET  /session        Bearer token, ?audience               → claims, unless revoked
 *   POST /signout        Bearer token                          → every session for that subject
 */

import {
  beginSignIn, completeSignIn, verifySessionToken, identityConfigured,
} from '../../../api/_identity.ts';
import {
  newAuthCode, checkAuthCode, buildReturnUrl, isAllowedReturn, isAudience, hashAuthCode as hashOf, mintTokenForSubject,
} from './sso.mjs';
import { d1Store } from './store.mjs';
import { handleLedger } from './ledger.mjs';

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

/** Which property holds these client credentials. Secrets are named CLIENT_SECRET_<AUDIENCE>. */
export function audienceForCredentials(env, header) {
  if (!header || !header.startsWith('Basic ')) return null;
  let decoded = '';
  try { decoded = atob(header.slice(6)); } catch { return null; }
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  const id = decoded.slice(0, i);
  const secret = decoded.slice(i + 1);
  if (!isAudience(id) || !secret) return null;
  const expected = env[`CLIENT_SECRET_${id.toUpperCase()}`];
  if (!expected || expected.length !== secret.length) return null;
  let diff = 0;
  for (let k = 0; k < secret.length; k++) diff |= secret.charCodeAt(k) ^ expected.charCodeAt(k);
  return diff === 0 ? id : null;
}

const bearer = (req) => {
  const h = req.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
};

async function readJson(req) {
  try { const b = await req.json(); return b && typeof b === 'object' ? b : {}; } catch { return {}; }
}

/** The link in the mail. Same host as the request, so no URL is written here. */
function verifyLink(origin, token, audience, returnTo, state) {
  const u = new URL('/signin/verify', origin);
  u.searchParams.set('token', token);
  u.searchParams.set('audience', audience);
  u.searchParams.set('returnTo', returnTo);
  if (state) u.searchParams.set('state', state);
  return u.toString();
}

async function mail(env, to, link) {
  if (!env.EMAIL) return false;
  const text = `Sign in to Ontold:\n\n${link}\n\nThe link works once and expires in fifteen minutes. If you did not ask for it, ignore this.`;
  const raw = [
    `From: Ontold <${env.MAIL_FROM || 'sign-in@mail.ontold.com'}>`,
    `To: ${to}`,
    'Subject: Your sign-in link',
    'Content-Type: text/plain; charset=utf-8',
    '',
    text,
  ].join('\r\n');
  try {
    await env.EMAIL.send({ from: env.MAIL_FROM || 'sign-in@mail.ontold.com', to, raw });
    return true;
  } catch {
    return false;
  }
}

/** Every route, given a store. Pure of Cloudflare so the tests run it. */
export async function handle(req, env, opts = {}) {
  const now = opts.now ?? Date.now();
  const store = opts.store ?? d1Store(env.IDENTITY);
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (path === '/' && req.method === 'GET') return json({ ok: true, configured: identityConfigured() });
  if (!identityConfigured()) return json({ error: 'not configured' }, 503);

  const ledger = await handleLedger(req, env, store, now);
  if (ledger) return ledger;

  if (path === '/signin/begin' && req.method === 'POST') {
    const body = await readJson(req);
    const audience = isAudience(body.audience) ? body.audience : null;
    const returnTo = typeof body.returnTo === 'string' ? body.returnTo : '';
    // Refused loudly: a wrong return origin is a bug in a property, not
    // a guess about a person.
    if (!audience || !isAllowedReturn(audience, returnTo)) return json({ error: 'bad request' }, 400);
    const email = typeof body.email === 'string' ? body.email : '';
    // The same answer whether or not the address is known, valid, or reachable.
    try {
      const t = await beginSignIn(store, email, now);
      const link = verifyLink(url.origin, t.token, audience, returnTo, typeof body.state === 'string' ? body.state.slice(0, 200) : '');
      await (opts.mail ?? mail)(env, email.trim().toLowerCase(), link);
    } catch { /* same answer */ }
    return json({ ok: true, message: 'If that address can receive mail, a link is on its way.' }, 202);
  }

  if (path === '/signin/verify' && req.method === 'GET') {
    const audience = url.searchParams.get('audience');
    const returnTo = url.searchParams.get('returnTo') || '';
    const state = url.searchParams.get('state') || '';
    if (!isAudience(audience) || !isAllowedReturn(audience, returnTo)) return json({ error: 'bad request' }, 400);
    const done = await completeSignIn(store, url.searchParams.get('token') || '', audience, now);
    if (!done.ok) return json({ error: done.reason }, 401);
    const code = newAuthCode(now);
    await store.putAuthCode({ hash: code.hash, subject: done.subject, audience, expiresAt: code.expiresAt });
    const to = buildReturnUrl(audience, returnTo, code.code, state);
    return Response.redirect(to, 302);
  }

  if (path === '/token' && req.method === 'POST') {
    const audience = audienceForCredentials(env, req.headers.get('authorization'));
    if (!audience) return json({ error: 'unauthorized' }, 401);
    const body = await readJson(req);
    const presented = typeof body.code === 'string' ? body.code : '';
    const stored = presented ? await store.takeAuthCode(hashOf(presented)) : undefined;
    const result = checkAuthCode(presented, stored, audience, now);
    if (!result.ok) return json({ error: result.reason }, 400);
    await store.markAuthCodeUsed(stored.hash, now);
    const token = mintTokenForSubject(result.subject, audience, now);
    if (!token) return json({ error: 'not configured' }, 503);
    return json({ token, subject: result.subject, audience });
  }

  if (path === '/session' && req.method === 'GET') {
    const audience = url.searchParams.get('audience');
    if (!isAudience(audience)) return json({ error: 'bad request' }, 400);
    const claims = verifySessionToken(bearer(req), audience, now);
    if (!claims) return json({ error: 'unauthorized' }, 401);
    const revokedAt = await revokedSince(env, claims.sub);
    if (revokedAt && claims.iat <= revokedAt) return json({ error: 'revoked' }, 401);
    return json({ subject: claims.sub, audience: claims.aud, exp: claims.exp });
  }

  if (path === '/signout' && req.method === 'POST') {
    const audience = url.searchParams.get('audience');
    const claims = isAudience(audience) ? verifySessionToken(bearer(req), audience, now) : null;
    if (!claims) return json({ error: 'unauthorized' }, 401);
    await revokeAll(env, claims.sub, Math.floor(now / 1000));
    return json({ ok: true });
  }

  return json({ error: 'not found' }, 404);
}

/** When every session for a subject was last revoked, in unix seconds; 0 if never. */
export async function revokedSince(env, subject) {
  if (!env.SESSIONS) return 0;
  const v = await env.SESSIONS.get(`revoked:${subject}`);
  return v ? Number(v) || 0 : 0;
}

/** Sign out everywhere: the subject's object decides, KV remembers. */
async function revokeAll(env, subject, at) {
  if (env.SUBJECTS) {
    const id = env.SUBJECTS.idFromName(subject);
    await env.SUBJECTS.get(id).fetch('https://subject/revoke', { method: 'POST', body: JSON.stringify({ at }) });
  }
  if (env.SESSIONS) await env.SESSIONS.put(`revoked:${subject}`, String(at));
}

/**
 * One object per subject. Holds which sessions are live and the
 * single decision to end them all, so two edges never disagree.
 */
export class SubjectHub {
  constructor(state) { this.state = state; }
  async fetch(input, init) {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (url.pathname === '/revoke' && req.method === 'POST') {
      const { at } = await req.json().catch(() => ({ at: Math.floor(Date.now() / 1000) }));
      await this.state.storage.put('revokedAt', Number(at) || Math.floor(Date.now() / 1000));
      await this.state.storage.delete('sessions');
      return json({ ok: true });
    }
    if (url.pathname === '/touch' && req.method === 'POST') {
      const { iat } = await req.json().catch(() => ({}));
      const sessions = (await this.state.storage.get('sessions')) || [];
      if (Number.isFinite(iat) && !sessions.includes(iat)) sessions.push(iat);
      await this.state.storage.put('sessions', sessions.slice(-50));
      return json({ ok: true, live: sessions.length });
    }
    const revokedAt = (await this.state.storage.get('revokedAt')) || 0;
    const sessions = (await this.state.storage.get('sessions')) || [];
    return json({ revokedAt, live: sessions.length });
  }
}

export default {
  fetch: (req, env) => handle(req, env),
};
