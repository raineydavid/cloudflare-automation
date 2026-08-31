/**
 * The provenance store, checked against the thing it has to agree with.
 *
 * This code shares a wire format with `api/_provenance.py` and with
 * Registrack. A record signed in the browser must verify here, and a
 * record stored here must verify in Python. That agreement rests
 * entirely on `canonical()` producing identical bytes, so the fixtures
 * below are not invented — they were produced by running the real
 * Python `canonical()` and pasting what it printed.
 *
 * The one that matters is the non-ASCII case. Python's `json.dumps`
 * escapes to \uXXXX and `JSON.stringify` does not, so a bare port
 * passes every ASCII test and silently breaks every signature over a
 * record containing an accent or an emoji.
 */

import { describe, it, expect } from 'vitest';
import { createSign, generateKeyPairSync, sign as nodeSign } from 'node:crypto';
import {
	canonical, verifyBytes, verifyRecord, ownerPrefix, keyFor,
	put, get, challenge, issueNonce, listRecords, Refused,
} from './src/provenance.mjs';

const dec = (bytes) => new TextDecoder().decode(bytes);

/** An R2 bucket that stores bytes and supports prefix listing. */
function fakeR2() {
	const store = new Map();
	return {
		store,
		async put(k, v) { store.set(k, v instanceof Uint8Array ? v : new TextEncoder().encode(String(v))); },
		async get(k) {
			if (!store.has(k)) return null;
			const v = store.get(k);
			return { async arrayBuffer() { return v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength); },
			         async text() { return dec(v); } };
		},
		async list({ prefix }) {
			return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })),
			         truncated: false };
		},
	};
}

/** A KV namespace with TTL ignored — expiry is tested by deleting. */
function fakeKV() {
	const store = new Map();
	return {
		store,
		async get(k) { return store.has(k) ? store.get(k) : null; },
		async put(k, v) { store.set(k, v); },
		async delete(k) { store.delete(k); },
	};
}

const hex = (b) => Buffer.from(b).toString('hex');

/** A real Ed25519 keypair, signing real bytes. */
function keypair() {
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	// JWK `x` is the raw 32-byte public key, base64url.
	const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url');
	return {
		publicHex: hex(raw),
		sign: (msg) => hex(nodeSign(null, Buffer.from(msg), privateKey)),
	};
}

describe('canonical bytes match Python exactly', () => {
	// Produced by `python3 -c "from api._provenance import canonical; ..."`
	// — not hand-written, because a hand-written expectation of what
	// Python "probably" emits is how the two drift apart.
	const CASES = [
		[{ b: 1, a: 2 }, '{"a":2,"b":1}'],
		[{ creator: 'ab12', note: 'café — naïve', id: 'x' },
		 '{"creator":"ab12","id":"x","note":"caf\\u00e9 \\u2014 na\\u00efve"}'],
		[{ z: [3, 1, { k: 'v', a: 'é' }], a: null, t: true },
		 '{"a":null,"t":true,"z":[3,1,{"a":"\\u00e9","k":"v"}]}'],
		[{ emoji: '🎬 lights' }, '{"emoji":"\\ud83c\\udfac lights"}'],
	];

	for (const [input, expected] of CASES) {
		it(`${JSON.stringify(input).slice(0, 40)}`, () => {
			expect(dec(canonical(input))).toBe(expected);
		});
	}

	it('a bare JSON.stringify would NOT match — this is the whole point', () => {
		// If this ever starts passing, the escaping was removed and every
		// signature over a non-ASCII record is quietly broken.
		expect(JSON.stringify({ note: 'café' })).not.toBe(dec(canonical({ note: 'café' })));
	});

	it('sorts nested keys, not just the top level', () => {
		expect(dec(canonical({ a: { z: 1, b: 2 } }))).toBe('{"a":{"b":2,"z":1}}');
	});
});

describe('Ed25519 through the platform', () => {
	it('verifies a real signature', async () => {
		const k = keypair();
		const msg = new TextEncoder().encode('the bytes');
		expect(await verifyBytes(msg, k.sign(msg), k.publicHex)).toBe(true);
	});

	it('rejects a signature over different bytes', async () => {
		const k = keypair();
		const sig = k.sign(new TextEncoder().encode('the bytes'));
		expect(await verifyBytes(new TextEncoder().encode('other bytes'), sig, k.publicHex)).toBe(false);
	});

	it('rejects another key\'s signature', async () => {
		const a = keypair(), b = keypair();
		const msg = new TextEncoder().encode('x');
		expect(await verifyBytes(msg, a.sign(msg), b.publicHex)).toBe(false);
	});

	it('returns false rather than throwing on junk', async () => {
		const msg = new TextEncoder().encode('x');
		for (const [sig, pub] of [['', ''], ['zz', 'zz'], ['ab', 'cd'], [null, undefined]]) {
			expect(await verifyBytes(msg, sig, pub), `${sig}/${pub}`).toBe(false);
		}
	});

	it('refuses small-order keys, which anyone can sign as', async () => {
		// The all-zero key with an all-zero signature verifies under both
		// WebCrypto and api/_ed25519.py. Nobody holds that key, so without
		// this check anyone can mint records that pass verification.
		expect(await verifyBytes(new TextEncoder().encode('x'), '00'.repeat(64), '00'.repeat(32))).toBe(false);
		expect(await verifyBytes(new TextEncoder().encode('x'), '00'.repeat(64),
			'0100000000000000000000000000000000000000000000000000000000000000')).toBe(false);
	});

	it('a real key is not caught by the small-order check', async () => {
		// Guards the guard: a blacklist that rejected everything would
		// make every test above pass for the wrong reason.
		const k = keypair();
		const msg = new TextEncoder().encode('still works');
		expect(await verifyBytes(msg, k.sign(msg), k.publicHex)).toBe(true);
	});
});

/** Build a signed record the way the browser would. */
async function signedRecord(k, body) {
	const record = { ...body, creator: k.publicHex };
	const msg = canonical(record);
	const digest = Buffer.from(
		await crypto.subtle.digest('SHA-256', msg)).toString('hex');
	return { record, digest, public_key: k.publicHex, signature: k.sign(msg) };
}

describe('a record is only stored if it verifies', () => {
	it('stores one that does', async () => {
		const k = keypair(), bucket = fakeR2();
		const signed = await signedRecord(k, { id: 'rec-1', kind: 'generation' });
		const key = await put(signed, bucket);
		expect(key).toBe(`${await ownerPrefix(k.publicHex)}/rec-1.json`);
		expect(bucket.store.has(key)).toBe(true);
	});

	it('refuses an unsigned one', async () => {
		const k = keypair();
		const signed = await signedRecord(k, { id: 'rec-1' });
		delete signed.signature;
		await expect(put(signed, fakeR2())).rejects.toThrow(Refused);
	});

	it('refuses one whose body was edited after signing', async () => {
		const k = keypair(), bucket = fakeR2();
		const signed = await signedRecord(k, { id: 'rec-1', prompt_hash: 'aaa' });
		signed.record.prompt_hash = 'bbb';
		const [ok, why] = await verifyRecord(signed);
		expect(ok).toBe(false);
		expect(why).toContain('digest');
		await expect(put(signed, bucket)).rejects.toThrow(Refused);
		expect(bucket.store.size).toBe(0);
	});

	it('refuses a record claiming authorship under someone else\'s key', async () => {
		const mine = keypair(), theirs = keypair();
		const signed = await signedRecord(mine, { id: 'rec-1' });
		signed.public_key = theirs.publicHex;   // claim it is theirs
		const [ok, why] = await verifyRecord(signed);
		expect(ok).toBe(false);
		expect(why).toContain('different key');
	});

	it('is idempotent for the same record and refuses a different one at the same id', async () => {
		const k = keypair(), bucket = fakeR2();
		const signed = await signedRecord(k, { id: 'rec-1', n: 1 });
		await put(signed, bucket);
		await expect(put(signed, bucket)).resolves.toBeTruthy();   // retry, not attack

		const impostor = await signedRecord(k, { id: 'rec-1', n: 2 });
		await expect(put(impostor, bucket)).rejects.toThrow(/already exists/);
	});

	it('needs an id and a creator before it has anywhere to live', async () => {
		await expect(keyFor({ record: {} })).rejects.toThrow(Refused);
	});
});

describe('the prefix is derived, never supplied', () => {
	it('lands two keys in different places, stably', async () => {
		const a = keypair(), b = keypair();
		expect(await ownerPrefix(a.publicHex)).toBe(await ownerPrefix(a.publicHex));
		expect(await ownerPrefix(a.publicHex)).not.toBe(await ownerPrefix(b.publicHex));
	});

	it('never puts the raw key in the path', async () => {
		const k = keypair();
		expect(await ownerPrefix(k.publicHex)).not.toContain(k.publicHex);
	});
});

describe('one record is public; the list is not', () => {
	it('anyone holding the id and the creator can read one', async () => {
		const k = keypair(), bucket = fakeR2();
		await put(await signedRecord(k, { id: 'rec-1' }), bucket);
		expect(await get('rec-1', k.publicHex, bucket)).toContain('rec-1');
		expect(await get('rec-1', keypair().publicHex, bucket)).toBeNull();
	});

	it('listing needs a signature over the challenge', async () => {
		const k = keypair(), bucket = fakeR2(), kv = fakeKV();
		await put(await signedRecord(k, { id: 'rec-1' }), bucket);
		await put(await signedRecord(k, { id: 'rec-2' }), bucket);

		const { nonce } = await issueNonce(k.publicHex, kv);
		const sig = k.sign(challenge(k.publicHex, nonce));
		expect(await listRecords(k.publicHex, nonce, sig, { bucket, kv })).toEqual(['rec-1', 'rec-2']);
	});

	it('refuses a listing signed by the wrong key', async () => {
		const mine = keypair(), theirs = keypair(), bucket = fakeR2(), kv = fakeKV();
		const { nonce } = await issueNonce(mine.publicHex, kv);
		const sig = theirs.sign(challenge(mine.publicHex, nonce));
		await expect(listRecords(mine.publicHex, nonce, sig, { bucket, kv }))
			.rejects.toThrow(/does not prove/);
	});

	it('a nonce issued to one key cannot be spent by another', async () => {
		const mine = keypair(), theirs = keypair(), bucket = fakeR2(), kv = fakeKV();
		const { nonce } = await issueNonce(mine.publicHex, kv);
		const sig = theirs.sign(challenge(theirs.publicHex, nonce));
		await expect(listRecords(theirs.publicHex, nonce, sig, { bucket, kv }))
			.rejects.toThrow(/different key/);
	});

	it('a nonce is single-use — the replay fails', async () => {
		const k = keypair(), bucket = fakeR2(), kv = fakeKV();
		const { nonce } = await issueNonce(k.publicHex, kv);
		const sig = k.sign(challenge(k.publicHex, nonce));

		await expect(listRecords(k.publicHex, nonce, sig, { bucket, kv })).resolves.toEqual([]);
		// Same signature, same nonce, replayed. This is the attack.
		await expect(listRecords(k.publicHex, nonce, sig, { bucket, kv }))
			.rejects.toThrow(/unknown or has expired/);
	});

	it('a failed attempt still spends the nonce', async () => {
		const k = keypair(), bucket = fakeR2(), kv = fakeKV();
		const { nonce } = await issueNonce(k.publicHex, kv);
		await expect(listRecords(k.publicHex, nonce, '00'.repeat(64), { bucket, kv })).rejects.toThrow();
		// Now even the CORRECT signature cannot use it.
		const sig = k.sign(challenge(k.publicHex, nonce));
		await expect(listRecords(k.publicHex, nonce, sig, { bucket, kv }))
			.rejects.toThrow(/unknown or has expired/);
	});

	it('the challenge binds the nonce to the key it is about', () => {
		const a = keypair(), b = keypair();
		expect(dec(challenge(a.publicHex, 'n1'))).not.toBe(dec(challenge(b.publicHex, 'n1')));
		expect(() => challenge('', 'n1')).toThrow(Refused);
	});

	it('refuses to list at all when there is nowhere to track nonces', async () => {
		const k = keypair();
		await expect(listRecords(k.publicHex, 'n', 'sig', { bucket: fakeR2(), kv: null }))
			.rejects.toThrow(/listing is unavailable/);
	});
});
