/**
 * Identity: subject ids, session tokens, and sign-in links.
 *
 * See internal/prd/SHARED-IDENTITY.md for why this lives here rather than in
 * one of the other two properties. The short version: ontold currently has
 * entitlement without identity — someone can pay us and have no account — so
 * the account is worth most where the money and the artefacts are.
 *
 * What this file is, and is not
 * -----------------------------
 * It is the crypto and the lifecycle rules, and nothing else. There is no
 * storage here and no HTTP: an account store is a port the caller supplies
 * (`AccountStore`), and the routes come later. That split is deliberate —
 * ontold has R2 and no relational store today, and this module should not be
 * the thing that forces that decision. Everything here is pure given `now`,
 * so it is testable without a clock, a database, or a network.
 *
 * Registrack is the canonical implementation
 * ------------------------------------------
 * `src/canton8/sessions.py` in raineydavid/imperial-canton8 already issues
 * and verifies exactly this credential — "stateless HMAC-signed session
 * tokens... issue a signed token for a subject, verify it (signature +
 * expiry)" — and Registrack is the payments layer, so it is where a subject
 * that owns money already has to be understood. This file is a TS MIRROR of
 * that format, not a second design: base64url signature, payload serialised
 * byte-identically to Python's compact sorted json.dumps. A token issued by
 * either half verifies in the other, which is the only reason it is safe for
 * two languages to hold one credential.
 *
 * The audience claim rides in Registrack's `claims` parameter, so adding it
 * needs no change there.
 *
 * Relationship to _requestAuth
 * ----------------------------
 * Same fail-closed posture, deliberately, because that module has already
 * paid for the lessons (see the shape-validation note in verifySessionToken
 * below). Its ENCODING is different — it uses hex, Registrack uses base64url
 * — and this file follows Registrack, because a payments subject and an
 * identity subject being the same string matters more than internal
 * symmetry. Also a DIFFERENT secret:
 * `IDENTITY_HMAC_SECRET`, not `API_HMAC_SECRET`. They protect
 * different things — one keeps scraped requests out of the inference gateway,
 * the other says who a person is — and sharing a key means a leak of the
 * cheaper one mints identities. Separate keys cost nothing and bound the
 * blast radius.
 *
 * The audience claim
 * ------------------
 * A session token names the property it was minted for and is verified
 * against an expected audience. Three properties accepting each other's
 * tokens is the point; three properties accepting a token minted for a
 * different one, without saying so, is how a low-value session on a public
 * directory becomes a session on the surface that spends money.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Who a token is for. Each property verifies with its own name. */
export type Audience = 'ontold' | 'screening' | 'nationalff' | 'workais';

/** Every property that can hold a session. Iterated by tests that check no
 *  token is accepted outside the audience it was minted for. */
export const AUDIENCES: readonly Audience[] = ['ontold', 'screening', 'nationalff', 'workais'];

/**
 * Session lifetime.
 *
 * Long, because this is a consumer product people come back to every few
 * weeks and a filmmaker signed out mid-submission will not come back at all.
 * The short-lived thing is the sign-in link, not the session.
 */
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

/**
 * Sign-in link lifetime.
 *
 * Short, because it travels through email: a copy left in an inbox, a
 * forward, or a corporate scanner following the URL must not be a way in
 * afterwards. Fifteen minutes is enough to open a mail client and not much
 * more.
 */
export const LOGIN_TTL_SECONDS = 15 * 60;

function secret(): string | undefined {
  return process.env.IDENTITY_HMAC_SECRET;
}

/** Whether identity can operate at all. */
export function identityConfigured(): boolean {
  return !!secret();
}

/**
 * The signature, base64url, unpadded.
 *
 * This is Registrack's encoding, not `_requestAuth`'s hex. See the header:
 * `src/canton8/sessions.py` is the canonical implementation and this file
 * mirrors it, so a token issued by either verifies in both.
 */
function sign(payloadB64: string, key: string): string {
  return createHmac('sha256', key).update(payloadB64).digest('base64url');
}

/**
 * The payload, byte-identical to Python's
 * `json.dumps(payload, separators=(",", ":"), sort_keys=True)`.
 *
 * Both halves of that matter and neither is JavaScript's default. Compact is
 * what `JSON.stringify` already does; sorted is not, and insertion order
 * would produce a different string, a different signature, and a token the
 * other language rejects as forged.
 *
 * Claims must be ASCII. Python's `json.dumps` escapes non-ASCII to \\uXXXX by
 * default and `JSON.stringify` does not, so a subject or audience carrying
 * an accented character would serialise differently in each language. Subject
 * ids are hex and audiences are a fixed list, so this holds today; it is
 * asserted rather than assumed.
 */
function canonicalPayload(claims: object): string {
  const json = JSON.stringify(claims, Object.keys(claims).sort());
  if (!/^[\x20-\x7e]*$/.test(json)) {
    throw new Error('identity claims must be ASCII to serialise identically in both languages');
  }
  return json;
}

/**
 * A new subject id.
 *
 * Opaque and random. Never derived from the address, because a subject id
 * ends up in logs, in artefact paths and in tokens, and a derived one would
 * make every one of those a place someone's email can be recovered from — by
 * guessing addresses and comparing, even if it is hashed.
 */
export function newSubjectId(): string {
  return `sub_${randomBytes(16).toString('hex')}`;
}

/** What a verified session token carries. `sub` is the subject id, `aud` the
 *  property it was minted for, `iat`/`exp` unix seconds. */
export interface SessionClaims {
  sub: string;
  aud: Audience;
  iat: number;
  exp: number;
}

/**
 * Mint a session token for a subject.
 *
 * Returns null when no secret is configured. Callers must treat that as
 * "nobody is signed in", never as permissive.
 */
export function mintSessionToken(
  subject: string,
  audience: Audience,
  now: number = Date.now(),
): string | null {
  const key = secret();
  if (!key || !subject) return null;
  const iat = Math.floor(now / 1000);
  const claims: SessionClaims = { sub: subject, aud: audience, iat, exp: iat + SESSION_TTL_SECONDS };
  const payloadB64 = Buffer.from(canonicalPayload(claims), 'utf-8').toString('base64url');
  return `${payloadB64}.${sign(payloadB64, key)}`;
}

/**
 * Verify a session token and return its claims, or null.
 *
 * FAILS CLOSED: no secret, malformed token, bad signature, expired, or an
 * audience that is not the one asked for all return null. There is no
 * permissive branch and no "unknown audience means any audience".
 */
export function verifySessionToken(
  token: string | null | undefined,
  expectedAudience: Audience,
  now: number = Date.now(),
): SessionClaims | null {
  const key = secret();
  if (!key || !token) return null;

  // Split on the FIRST dot only, matching Python's `token.split(".", 1)`.
  // A payload can never contain a dot (it is base64url) but the two halves
  // must agree about what a malformed token is, not merely about a good one.
  const dot = token.indexOf('.');
  if (dot < 1 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  // The signature has to LOOK like one before it is decoded, and this is
  // where the two implementations currently differ. Registrack's
  // verify_token calls _b64u_dec(sig) outside its try, so a signature that
  // is not valid base64 raises binascii.Error and escapes as a 500 instead
  // of a clean rejection — and only for SOME malformed inputs, since others
  // happen to pad correctly and return None. Verified against that code on
  // 2026-08-10. This half refuses on shape first, so a garbage token is a
  // rejection in both languages rather than a rejection in one and a crash
  // in the other. 43 characters is an unpadded base64url sha256 digest, and
  // nothing else is.
  if (!/^[A-Za-z0-9_-]{43}$/.test(sig)) return null;

  const expected = sign(payloadB64, key);
  const sigBuf = Buffer.from(sig, 'base64url');
  const expectedBuf = Buffer.from(expected, 'base64url');
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;

  let claims: Partial<SessionClaims>;
  try {
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8')) as Partial<SessionClaims>;
  } catch {
    return null;
  }

  if (typeof claims.sub !== 'string' || !claims.sub) return null;
  if (typeof claims.exp !== 'number' || now / 1000 >= claims.exp) return null;
  // Compared explicitly rather than trusted from the payload: an attacker
  // controls nothing here (the signature covers the audience), but a token
  // minted honestly for one property must still not be accepted by another.
  if (claims.aud !== expectedAudience) return null;

  return claims as SessionClaims;
}

// ---------------------------------------------------------------------------
// Sign-in links
// ---------------------------------------------------------------------------

/**
 * A sign-in token, and what to store for it.
 *
 * The token goes in the email. Only the hash is stored, so a leak of the
 * store does not hand anyone a working link — the same reason a password
 * store holds hashes, and it matters more here because this token IS the
 * credential rather than something checked against one.
 */
export interface LoginToken {
  /** Goes in the link. Never stored. */
  token: string;
  /** Store this. */
  hash: string;
  /** Unix seconds. */
  expiresAt: number;
}

/** The stored form of a sign-in token. Only this is persisted, so a leak of
 *  the store hands nobody a working link. */
export function hashLoginToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Mint a sign-in token: the value to email, the hash to store, and when it
 *  stops working. */
export function newLoginToken(now: number = Date.now()): LoginToken {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    hash: hashLoginToken(token),
    expiresAt: Math.floor(now / 1000) + LOGIN_TTL_SECONDS,
  };
}

/** Why a sign-in link was refused. Distinct values because they mean
 *  different things to the person holding the link. */
export type LoginFailureReason = 'unknown' | 'expired' | 'used';

/**
 * The `?: undefined` members are not decoration. This repo's tsconfig does
 * not set `strict`, so `strictNullChecks` is off and TypeScript will not
 * narrow a union by the truthiness of a boolean discriminant: inside
 * `if (!check.ok)`, `check` stays the full union and `check.reason` is an
 * error. Declaring the absent field on each branch makes both readable
 * without narrowing, at the cost of letting you read a `reason` that is
 * undefined on success. Fixing the tsconfig instead would be right and is a
 * repo-wide change, not this file's to make.
 */
export type LoginCheck =
  | { ok: true; subject: string; reason?: undefined }
  | { ok: false; reason: LoginFailureReason; subject?: undefined };

/** What the store must hold for a pending link. */
export interface StoredLoginToken {
  hash: string;
  subject: string;
  expiresAt: number;
  /** Unix seconds, once followed. Single use: a second attempt is refused. */
  usedAt?: number;
}

/**
 * Is this presented token good?
 *
 * Single-use is enforced by `usedAt` rather than by deleting the row, so a
 * second click is refused rather than looking like an unknown token. The
 * distinction matters to the person: "that link has already been used" is
 * actionable and "we don't recognise that" sends them hunting for a typo.
 */
export function checkLoginToken(
  presented: string,
  stored: StoredLoginToken | undefined,
  now: number = Date.now(),
): LoginCheck {
  if (!stored) return { ok: false, reason: 'unknown' };
  // Constant-time on the hash, not on the raw token: both are fixed-length
  // hex here, and comparing the presented token to a stored hash directly
  // would be comparing different things.
  const presentedHash = Buffer.from(hashLoginToken(presented), 'hex');
  const storedHash = Buffer.from(stored.hash, 'hex');
  if (
    presentedHash.length !== storedHash.length ||
    !timingSafeEqual(presentedHash, storedHash)
  ) {
    return { ok: false, reason: 'unknown' };
  }
  if (stored.usedAt != null) return { ok: false, reason: 'used' };
  if (now / 1000 >= stored.expiresAt) return { ok: false, reason: 'expired' };
  return { ok: true, subject: stored.subject };
}

// ---------------------------------------------------------------------------
// The store port
// ---------------------------------------------------------------------------

/**
 * What identity needs from persistence, and nothing more.
 *
 * An interface rather than a concrete store because ontold has R2 and no
 * relational database today, and that choice should be made when the routes
 * are built, on the evidence then — not baked in here by whichever store
 * happened to be convenient. Everything above is testable against an
 * in-memory implementation of this.
 */
export interface AccountStore {
  /** The subject for an address, or undefined. Address is already normalised. */
  subjectForEmail(email: string): Promise<string | undefined>;
  /** Create and return a subject for an address that has none. */
  createAccount(email: string, subject: string, now: number): Promise<void>;
  putLoginToken(t: StoredLoginToken): Promise<void>;
  takeLoginToken(hash: string): Promise<StoredLoginToken | undefined>;
  markLoginTokenUsed(hash: string, now: number): Promise<void>;
}

/**
 * An address, normalised, or undefined if it is not one.
 *
 * Same rules as nationalff's normaliseEmail, deliberately: the two systems
 * have to agree on whether two spellings are the same person, or the same
 * human ends up with two subjects.
 */
export function normaliseEmail(raw: string): string | undefined {
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return undefined;
  const at = email.indexOf('@');
  if (at < 1 || at !== email.lastIndexOf('@') || at === email.length - 1) return undefined;
  const domain = email.slice(at + 1);
  if (!domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) return undefined;
  return email;
}

/**
 * Begin a sign-in: find or create the subject, and issue a link token.
 *
 * Returns the token to email. It deliberately does NOT report whether the
 * account already existed — the caller has no way to leak that even by
 * accident, because there is nothing in the return value to leak.
 */
export async function beginSignIn(
  store: AccountStore,
  email: string,
  now: number = Date.now(),
): Promise<LoginToken> {
  let subject = await store.subjectForEmail(email);
  if (!subject) {
    subject = newSubjectId();
    await store.createAccount(email, subject, now);
  }
  const t = newLoginToken(now);
  await store.putLoginToken({ hash: t.hash, subject, expiresAt: t.expiresAt });
  return t;
}

/**
 * Complete a sign-in: check the token, burn it, mint a session.
 *
 * Burned before the session is minted, not after. If minting throws, the
 * link is still spent — which is the safe direction, because the alternative
 * leaves a live link on the floor after a failure nobody saw.
 */
export async function completeSignIn(
  store: AccountStore,
  presented: string,
  audience: Audience,
  now: number = Date.now(),
): Promise<
  | { ok: true; subject: string; token: string; reason?: undefined }
  | { ok: false; reason: LoginFailureReason; subject?: undefined; token?: undefined }
> {
  const stored = await store.takeLoginToken(hashLoginToken(presented));
  const check = checkLoginToken(presented, stored, now);
  if (!check.ok) return { ok: false, reason: check.reason };

  await store.markLoginTokenUsed(stored!.hash, Math.floor(now / 1000));

  const token = mintSessionToken(check.subject, audience, now);
  // No secret configured: fail closed rather than returning a subject with
  // no way to prove it later.
  if (!token) return { ok: false, reason: 'unknown' };

  return { ok: true, subject: check.subject, token };
}
