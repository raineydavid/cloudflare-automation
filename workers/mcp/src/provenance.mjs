/**
 * The provenance store, where R2 actually lives (issue #110).
 *
 * `api/_provenanceStore.py` was written with storage as three injected
 * callables — write, read, list_keys — precisely so the backend could
 * be swapped without touching the rules. This is that swap. The rules
 * are unchanged and restated here because they are the whole point:
 *
 *   A RECORD IS ONLY STORED IF IT VERIFIES. A store that keeps
 *   unverified claims proves nothing and looks like evidence, which is
 *   worse than keeping none.
 *
 *   ONE RECORD IS PUBLIC; THE LIST IS NOT. Fetching a record by id is
 *   fine — it is a signed public claim and the point of publishing it
 *   is that a holder can check it. ENUMERATING a creator's records is
 *   the "everybody's generations in a public file" problem the founder
 *   already rejected, one directory listing away. Listing therefore
 *   takes a signature, not a token.
 *
 *   NOTHING IS OVERWRITTEN. A record id is a hash of its contents, so
 *   a second write of the same id is the same record; a DIFFERENT
 *   record claiming a taken id is somebody rewriting history.
 *
 * ## Two things got better by being here
 *
 * **No credential.** From Vercel this needed SigV4 signing and
 * long-lived R2 keys in env (api/_inference/s3_sigv4.py exists only for
 * that). Here it is a binding. There is no key to leak, rotate, or
 * find in a log.
 *
 * **Real Ed25519.** `api/_ed25519.py` is a hand-written RFC 8032
 * verifier — 200 lines of field arithmetic — because Vercel's Python
 * runtime has no crypto library we are willing to bundle. Workers ship
 * Ed25519 in WebCrypto. This calls the platform's implementation, which
 * is constant-time and audited, and ours is not.
 *
 * ## The nonce is now server-issued and single-use
 *
 * The Python took a caller-supplied nonce, which made replay the
 * caller's problem to avoid. Here `issueNonce` mints one into KV and
 * `listRecords` DELETES it on use, so a captured listing signature is
 * worth exactly one attempt that has already happened.
 */

const PREFIX = "provenance";

/** 32 hex characters of the key hash — 128 bits, collision-proof for
 *  this, and short enough that an operator can read a path in a log. */
const PREFIX_LEN = 32;

/** How long an unused listing nonce stays valid. Long enough for a
 *  round trip and a signature prompt, short enough that a captured one
 *  is stale before it is useful. */
const NONCE_TTL_SECONDS = 300;

export class Refused extends Error {}

/**
 * Deterministic JSON for signing — sorted keys, no whitespace, and
 * every non-ASCII character escaped as \uXXXX.
 *
 * That last clause is the one that matters and the one that is easy to
 * miss. Python's `json.dumps` defaults to `ensure_ascii=True`, so
 * `canonical({"note": "café"})` is `{"note":"café"}` there and
 * would be `{"note":"café"}` from a bare `JSON.stringify` here. The
 * bytes differ, so the digest differs, so every signature over a record
 * containing an accent, a dash, or an emoji would fail to verify across
 * the two implementations — and it would fail for exactly the records a
 * human wrote by hand, while every ASCII test case passed.
 *
 * Escaping per UTF-16 code unit reproduces Python's surrogate pairs
 * (🎬 → 🎬) without special-casing astral characters.
 */
export function canonical(value) {
	const sorted = (v) => {
		if (Array.isArray(v)) return v.map(sorted);
		if (v && typeof v === "object") {
			return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])]));
		}
		return v;
	};
	const json = JSON.stringify(sorted(value));
	return new TextEncoder().encode(
		json.replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`),
	);
}

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

function unhex(s) {
	if (typeof s !== "string" || s.length % 2 || /[^0-9a-fA-F]/.test(s)) return null;
	const out = new Uint8Array(s.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
	return out;
}

async function sha256Hex(bytes) {
	return hex(await crypto.subtle.digest("SHA-256", bytes));
}

/**
 * Ed25519 public keys of small order, which must never be accepted.
 *
 * Found by a test rather than by reading: an all-zero key with an
 * all-zero signature VERIFIES — under WebCrypto here and under
 * `api/_ed25519.py` too, for roughly one message in four. RFC 8032 does
 * not require rejecting these and neither implementation does, so both
 * are arguably correct and both are wrong for this store.
 *
 * The consequence is specific. `verifyRecord` requires creator ===
 * public_key, so nobody can impersonate a real creator this way. What
 * they CAN do is mint unlimited records under a key nobody holds, and
 * those records verify — which turns "this record is signed" into a
 * claim that means nothing for that prefix. A provenance store whose
 * whole value is "this proves who made it" cannot ship with a key
 * anyone can sign as.
 *
 * This is libsodium's `ge25519_has_small_order` blacklist: the points
 * of order 1, 2, 4 and 8, plus their non-canonical encodings.
 *
 * NOTE this makes the Worker STRICTER than the Python. That direction
 * is safe — everything the Worker accepts, Python accepts — and the
 * records it now refuses are all forgeries. The Python should follow;
 * tracked separately rather than changed here, because loosening the
 * Worker to match would be the wrong fix.
 */
const SMALL_ORDER = new Set([
	"0000000000000000000000000000000000000000000000000000000000000000",
	"0100000000000000000000000000000000000000000000000000000000000000",
	"ecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
	"0000000000000000000000000000000000000000000000000000000000000080",
	"26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05",
	"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a",
	"26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85",
	"c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa",
	"edffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
	"eeffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f",
	"d9ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
	"daffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
]);

/**
 * Did the holder of this key sign these bytes?
 *
 * Every malformed input is `false`, never a throw. A caller verifying
 * an untrusted record should not have to tell "this signature is wrong"
 * from "this signature is 63 bytes long" — both mean the same thing,
 * and raising on one turns a bad request into a 500.
 */
export async function verifyBytes(message, signatureHex, publicKeyHex) {
	const sig = unhex(signatureHex);
	const pub = unhex(publicKeyHex);
	if (!sig || sig.length !== 64 || !pub || pub.length !== 32) return false;
	if (SMALL_ORDER.has(String(publicKeyHex).toLowerCase())) return false;
	try {
		const key = await crypto.subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
		return await crypto.subtle.verify({ name: "Ed25519" }, key, sig, message);
	} catch {
		return false;
	}
}

/**
 * Is this record what its creator signed? Returns [ok, reason].
 *
 * A reason rather than a bare false, for the same purpose Registrack's
 * `authorize_payment` has one: "invalid" tells a user nothing and an
 * operator less.
 */
export async function verifyRecord(signed) {
	if (!signed || typeof signed !== "object" || !signed.record) return [false, "not a signed record"];
	const body = signed.record || {};
	const msg = canonical(body);

	if (signed.digest !== (await sha256Hex(msg))) return [false, "digest does not match the record"];
	// The creator field IS the identity. A record signed by some other
	// key is somebody else's claim about your work.
	if (body.creator !== signed.public_key) {
		return [false, "signed by a different key than the one claiming authorship"];
	}
	if (!(await verifyBytes(msg, signed.signature, signed.public_key))) return [false, "signature invalid"];
	return [true, "verified"];
}

/**
 * The storage prefix for a creator, derived from their key.
 *
 * Hashed rather than used raw for two reasons. Keys are long and may
 * contain characters an object store dislikes, and a raw key in a path
 * turns every access log into a list of who uses the service. The hash
 * is one-way and stable — the same key always lands in the same place,
 * and no other key does.
 *
 * Derived, never supplied. A caller cannot choose where its records
 * land, which is what makes writing into somebody else's prefix
 * impossible rather than merely discouraged.
 */
export async function ownerPrefix(publicKey) {
	if (!publicKey) throw new Refused("a record with no creator has nowhere to live");
	const digest = await sha256Hex(new TextEncoder().encode(publicKey));
	return `${PREFIX}/${digest.slice(0, PREFIX_LEN)}`;
}

export async function keyFor(signed) {
	const body = (signed || {}).record || {};
	if (!body.id || !body.creator) throw new Refused("a record needs an id and a creator before it can be stored");
	return `${await ownerPrefix(body.creator)}/${body.id}.json`;
}

/** Store a signed record. Returns the key it landed at. */
export async function put(signed, bucket) {
	const [ok, why] = await verifyRecord(signed);
	if (!ok) throw new Refused(`not stored — ${why}`);

	const key = await keyFor(signed);
	const body = canonical(signed);

	const existing = await bucket.get(key);
	if (existing) {
		const prior = new Uint8Array(await existing.arrayBuffer());
		// The id is a hash of the record's contents, so a mismatch means
		// somebody built a DIFFERENT record claiming an id already taken.
		// Nothing legitimate does that. Same bytes is a retry after a
		// dropped connection and must not read as an attack.
		const same = prior.length === body.length && prior.every((b, i) => b === body[i]);
		if (!same) throw new Refused("a different record already exists at this id");
		return key;
	}

	await bucket.put(key, body, { httpMetadata: { contentType: "application/json" } });
	return key;
}

/**
 * One record, by id, for anyone who knows where to look.
 *
 * Deliberately open. A record is a signed public claim — the prompt is
 * a hash, the creator is a public key — and the point of publishing it
 * is that a person holding a derivative can check where it came from.
 * Requiring permission would make lineage unverifiable by exactly the
 * people it is for.
 *
 * The creator's key is half the ADDRESS, not a credential: you cannot
 * ask for a record without already knowing whose it is, so this is not
 * a route to enumeration.
 */
export async function get(recordId, creator, bucket) {
	if (!recordId || !creator) return null;
	const obj = await bucket.get(`${await ownerPrefix(creator)}/${recordId}.json`);
	return obj ? await obj.text() : null;
}

/**
 * The bytes a creator signs to prove they hold their key.
 *
 * Binds the nonce to the key being claimed. Signing a bare nonce would
 * let a signature captured from one exchange be replayed to claim a
 * different key — the signature is valid, it just was not about this.
 */
export function challenge(publicKey, nonce) {
	if (!publicKey || !nonce) throw new Refused("a challenge needs both a key and a nonce");
	return canonical({ claim: "list", key: publicKey, nonce });
}

/**
 * Mint a single-use nonce for a listing request.
 *
 * Server-issued, which the Python version was not. A caller-supplied
 * nonce makes replay the caller's problem to avoid, and callers do not
 * avoid it. Bound to the key at issue time so a nonce minted for one
 * creator cannot be spent by another.
 */
export async function issueNonce(publicKey, kv) {
	if (!publicKey) throw new Refused("a nonce is issued to a key");
	if (!kv) throw new Refused("this deploy cannot issue nonces — listing is unavailable");
	const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
	await kv.put(`nonce:${nonce}`, publicKey, { expirationTtl: NONCE_TTL_SECONDS });
	return { nonce, expires_in: NONCE_TTL_SECONDS };
}

/**
 * Every record id under a creator's prefix — to that creator only.
 *
 * This is the call that would otherwise recreate the problem the repo
 * already rejected. A listing endpoint is one request away from
 * "everybody's generations in a public file", whether the file is in
 * git or in a bucket.
 *
 * So it takes a signature over `challenge()`, not a token. A token can
 * be stolen and replayed; this proves possession of the private key for
 * the prefix being asked about, and nothing else grants it — including
 * us. We cannot enumerate a creator's work on their behalf, which is
 * the property worth having.
 *
 * Throws rather than returning empty: "you may not" and "you have none"
 * are different answers and a caller needs to tell them apart.
 */
export async function listRecords(publicKey, nonce, signatureHex, { bucket, kv }) {
	if (!kv) throw new Refused("this deploy cannot verify nonces — listing is unavailable");

	const issuedTo = await kv.get(`nonce:${nonce}`);
	if (!issuedTo) throw new Refused("that nonce is unknown or has expired — ask for a new one");
	if (issuedTo !== publicKey) throw new Refused("that nonce was issued to a different key");

	// Spent BEFORE the signature is checked. A nonce consumed by a failed
	// attempt is a nonce that cannot be retried, which is the point — an
	// attacker holding a captured signature gets one shot at a value that
	// is already gone, and a legitimate caller just asks for another.
	await kv.delete(`nonce:${nonce}`);

	if (!(await verifyBytes(challenge(publicKey, nonce), signatureHex, publicKey))) {
		throw new Refused("that signature does not prove you hold this key");
	}

	const prefix = await ownerPrefix(publicKey);
	const out = [];
	let cursor;
	do {
		const page = await bucket.list({ prefix, cursor });
		for (const o of page.objects || []) {
			const name = o.key.split("/").pop();
			if (name.endsWith(".json")) out.push(name.slice(0, -".json".length));
		}
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);

	// Sorted so a listing is stable between calls — an unstable one makes
	// a diff between two snapshots unreadable.
	return out.sort();
}
