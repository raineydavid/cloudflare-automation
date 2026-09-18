/**
 * Single sign-on across the three properties.
 *
 * The problem this solves, and why a shared cookie does not
 * ---------------------------------------------------------
 * nationalfilmfestivals.com, screeningstudio.com and ontold.com are three
 * separate registrable domains. A cookie cannot span them — that only works
 * across subdomains of one apex — so "sign in once" cannot be a shared
 * session cookie however much we would prefer it. It has to be a redirect:
 * ontold holds the session, the other two bounce a visitor through it, and
 * ontold hands back proof of who they are.
 *
 * Why a code, and not the token itself
 * -----------------------------------
 * The obvious version redirects back with `?token=…`. Do not. A URL is the
 * least private place in the stack: it lands in the server's access log, in
 * the next request's Referer header, in browser history, and in whatever
 * analytics the receiving page runs. A session token there is a session token
 * given away.
 *
 * So this is the authorization-code shape. The redirect carries a single-use
 * code that is worth nothing on its own; the receiving property exchanges it
 * server-to-server for the real token. The code is short-lived, burned on
 * first use, and bound to the audience that asked for it — so a code
 * intercepted from a log is useless twice over: it is probably already spent,
 * and it will not mint a token for anyone else's property.
 *
 * The other thing that must not be got wrong
 * -----------------------------------------
 * `returnTo` is attacker-controlled. An /authorize that redirects anywhere
 * is an open redirector, and an open redirector on an identity provider is a
 * way to have us hand a visitor's session to whoever asked. Origins are
 * matched exactly against a fixed list — not by suffix, because
 * `ontold.com.evil.com` ends with nothing useful but `endsWith('ontold.com')`
 * says otherwise.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { AUDIENCES, type Audience } from './_identity';

/**
 * Where a sign-in may return to, by exact origin.
 *
 * A fixed list rather than an environment variable: this is the boundary
 * that decides who may receive somebody's session, and it should require a
 * code change and a review, not a dashboard edit. Localhost is included for
 * development and is harmless in production, where nothing can reach it.
 */
export const RETURN_ORIGINS: Readonly<Record<Audience, readonly string[]>> = {
  ontold: ['https://ontold.com', 'https://www.ontold.com', 'http://localhost:3000'],
  screening: ['https://screeningstudio.com', 'https://www.screeningstudio.com', 'http://localhost:3001'],
  nationalff: [
    'https://nationalfilmfestivals.com',
    'https://www.nationalfilmfestivals.com',
    'https://nationalff.com',
    'http://localhost:3002',
  ],
  workais: ['https://workais.com', 'https://www.workais.com', 'http://localhost:3003'],
};

/**
 * Codes are worth little and live briefly.
 *
 * Long enough for a redirect and a server-side exchange, which is one round
 * trip; short enough that one recovered from a log has almost certainly
 * expired as well as been spent.
 */
export const CODE_TTL_SECONDS = 60;

/** Is this exactly an origin we will return a visitor to? */
export function isAllowedReturn(audience: Audience, returnTo: string): boolean {
  let url: URL;
  try {
    url = new URL(returnTo);
  } catch {
    return false;
  }
  // Compared as origins, so a path, a query or a port cannot smuggle
  // anything past a string match on the front of the URL.
  return (RETURN_ORIGINS[audience] ?? []).includes(url.origin);
}

/** A minted authorization code: the value to redirect with, and what to store. */
export interface AuthCode {
  /** Goes in the redirect. Never stored. */
  code: string;
  /** Store this. */
  hash: string;
  expiresAt: number;
}

/** What the store holds against a pending code. */
export interface StoredAuthCode {
  hash: string;
  subject: string;
  /** The property that asked. A code will not mint a token for another. */
  audience: Audience;
  expiresAt: number;
  /** Unix seconds, once exchanged. Single use. */
  usedAt?: number;
}

/** The stored form of a code. Only this is persisted. */
export function hashAuthCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

/** Mint an authorization code for a subject and the property that asked. */
export function newAuthCode(now: number = Date.now()): AuthCode {
  const code = randomBytes(32).toString('base64url');
  return {
    code,
    hash: hashAuthCode(code),
    expiresAt: Math.floor(now / 1000) + CODE_TTL_SECONDS,
  };
}

/** Why an exchange was refused. */
export type ExchangeFailure = 'unknown' | 'expired' | 'used' | 'wrong-audience';

/**
 * The result of exchanging a code.
 *
 * The `?: undefined` members are for the same reason as in _identity: this
 * repo's tsconfig sets no `strict`, so a union is not narrowed by the
 * truthiness of a boolean discriminant.
 */
export type ExchangeResult =
  | { ok: true; subject: string; reason?: undefined }
  | { ok: false; reason: ExchangeFailure; subject?: undefined };

/**
 * Check a presented code against what was stored.
 *
 * `audience` is the property doing the exchanging, taken from its
 * credentials, NOT from anything it sent in the request. A code minted for
 * the directory must not be exchangeable by the property that spends money,
 * and that is only true if the caller cannot name its own audience.
 */
export function checkAuthCode(
  presented: string,
  stored: StoredAuthCode | undefined,
  audience: Audience,
  now: number = Date.now(),
): ExchangeResult {
  if (!stored) return { ok: false, reason: 'unknown' };

  const presentedHash = Buffer.from(hashAuthCode(presented), 'hex');
  const storedHash = Buffer.from(stored.hash, 'hex');
  if (
    presentedHash.length !== storedHash.length ||
    !timingSafeEqual(presentedHash, storedHash)
  ) {
    return { ok: false, reason: 'unknown' };
  }

  // Order matters below. "Used" is reported before "expired" because a
  // replayed code is the interesting event and should not be masked by the
  // clock having moved on.
  if (stored.usedAt != null) return { ok: false, reason: 'used' };
  if (now / 1000 >= stored.expiresAt) return { ok: false, reason: 'expired' };
  if (stored.audience !== audience) return { ok: false, reason: 'wrong-audience' };

  return { ok: true, subject: stored.subject };
}

/**
 * Build the URL to send a visitor back to.
 *
 * Refuses rather than falling back to a default when `returnTo` is not
 * allowed. A "safe default redirect" here would mean an attacker who
 * supplies a bad returnTo still gets a valid code delivered somewhere, and
 * the whole point is that they get nothing.
 */
export function buildReturnUrl(
  audience: Audience,
  returnTo: string,
  code: string,
  state?: string,
): string | null {
  if (!isAllowedReturn(audience, returnTo)) return null;
  const url = new URL(returnTo);
  url.searchParams.set('code', code);
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

/** Is this a property we know about? Narrows an untrusted string. */
export function isAudience(value: unknown): value is Audience {
  return typeof value === 'string' && (AUDIENCES as readonly string[]).includes(value);
}
