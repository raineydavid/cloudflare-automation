/**
 * A minted worker that actually runs, inside walls made of its consent
 * (issue #117).
 *
 * `mint_worker` has always produced a PERSONA — a name, a face, a
 * roster entry, a link. Nothing it returned could execute. Dynamic
 * Workers are the missing half: `env.LOADER.get(id, cb)` composes an
 * isolate at runtime and we choose what it receives.
 *
 * ## The point: consent stops being an if-statement
 *
 * `api/_consent.py` decides whether an agent may ring a vulnerable
 * person. Today that is a function, and it is load-bearing only for as
 * long as every call site remembers to call it. The entire reason the
 * module exists is that this class of check gets forgotten.
 *
 * Here the same policy becomes the SHAPE OF THE SANDBOX. The isolate
 * that places a call is composed with outbound access to one provider
 * host and nothing else. An agent that is out of its daily contacts, or
 * calling at 3am, or whose guardian revoked, is not an agent that
 * checks a counter and politely declines — it is an agent with
 * `globalOutbound: null`, which cannot reach the network to try.
 *
 * A refusal is the ABSENCE OF A CAPABILITY. There is no code path to
 * forget, and no bug in the agent's own logic that can route around it,
 * because the agent's logic never had the reach in the first place.
 *
 * ## The agent never sees a credential
 *
 * `globalOutbound` is not merely an allowlist — it is a Worker we
 * control that the isolate's every `fetch()` goes through. It checks
 * the host and INJECTS the provider token on the way out. So the agent
 * can cause a call to be placed and cannot read the key that pays for
 * it, cannot send it anywhere, and cannot include it in its own output.
 *
 * That distinction matters because the code inside an isolate is, in
 * the general case, model-authored. Handing model-authored code a
 * bearer token and asking it not to leak it is not a security posture.
 *
 * ## Everything here is pure except `mintAgent`
 *
 * `sandboxFor` returns a plain spec object. That is deliberate: the
 * interesting assertions — that a refusal produces null egress, that
 * the allowlist matches the permitted channels, that no secret is in
 * the spec — are all testable without a Worker Loader, a network, or a
 * deploy.
 */

import { mayContact, briefFor } from './consent.mjs';

/**
 * The hosts each channel legitimately needs, and nothing else.
 *
 * Enumerated rather than derived. A new way to reach someone is a
 * decision, the same way `CHANNELS` is a decision in the consent
 * module, and an agent that can reach a host nobody listed is an agent
 * doing something nobody agreed to.
 */
export const EGRESS_BY_CHANNEL = {
	voice: ["api.nexmo.com"],
	whatsapp: ["api.nexmo.com", "messages.nexmo.com"],
	sms: ["rest.nexmo.com"],
	// Deliberately empty: no email provider is wired, and an empty list
	// means "cannot reach anything", which is the correct behaviour for
	// a channel that does not work yet. Guessing a host here would give
	// an agent reach for a capability that does not exist.
	email: [],
};

/** Wall-clock and CPU ceilings for one agent run. A companionship call
 *  is a few seconds of orchestration; anything longer is a loop. */
export const LIMITS = { cpuMs: 5_000 };

const COMPATIBILITY_DATE = "2026-08-01";

/**
 * The module the isolate runs.
 *
 * Generated rather than stored so the brief — the access needs, in
 * words — is baked into the code that executes, not passed alongside it
 * where a caller can drop it. `_consent.brief_for` produces those
 * words; this makes them unavoidable.
 *
 * Note what is NOT interpolated: no token, no phone number, no
 * recipient name. The isolate is given a purpose and a manner, and the
 * outbound proxy supplies everything sensitive.
 */
export function agentSource({ brief, purpose, reintroduceAs }) {
	// JSON.stringify, not template quotes — a consent record can contain
	// an apostrophe, a newline or a backslash, and string-concatenating
	// those into source is how you get a syntax error at best.
	const j = (v) => JSON.stringify(v ?? "");
	return `
export default {
  async fetch(request, env) {
    const manner = ${j(brief)};
    const purpose = ${j(purpose)};
    const callerName = ${j(reintroduceAs)};

    // Every fetch from here goes through the outbound proxy, which
    // checks the host and adds the credential. There is no other exit.
    const res = await fetch("https://api.nexmo.com/v1/calls", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await request.json()),
    });
    return Response.json({
      purpose, manner, callerName,
      upstream: res.status,
    });
  },
};
`.trim();
}

/**
 * Compose the isolate for one contact attempt.
 *
 * Returns `{ allowed, why, spec }`. The spec is always returned, even
 * on a refusal — a refused agent is still a runnable isolate, just one
 * that cannot reach anything. That is the property worth having: the
 * caller does not have to remember to check `allowed` before running
 * it, because running it accomplishes nothing.
 */
export async function sandboxFor(signedConsent, situation) {
	const [allowed, why] = await mayContact(signedConsent, situation);
	const body = (signedConsent || {}).record || {};

	// The allowlist is the intersection of what the consent permits and
	// what this attempt is for. Not the union of every permitted channel
	// — an agent placing a call has no business reaching the SMS host.
	const hosts = allowed ? (EGRESS_BY_CHANNEL[situation.channel] || []) : [];

	const brief = briefFor(signedConsent);
	const reintroduceAs = (body.needs || []).includes("reintroduce")
		? (situation.callerName || "")
		: "";

	return {
		allowed,
		why,
		hosts,
		spec: {
			compatibilityDate: COMPATIBILITY_DATE,
			mainModule: "agent.js",
			modules: { "agent.js": agentSource({ brief, purpose: situation.purpose, reintroduceAs }) },
			// null is not a fallback or a default — it is the refusal.
			globalOutbound: hosts.length ? { allow: hosts } : null,
			limits: LIMITS,
			// What the isolate can see. The consent ID and the purpose,
			// so it can be traced in a log; nothing that identifies the
			// person and nothing that authenticates to anybody.
			env: {
				CONSENT_ID: String(body.id || ""),
				PURPOSE: String(situation.purpose || ""),
			},
		},
	};
}

/**
 * A stable id for the isolate, so `LOADER.get` can keep it warm.
 *
 * Keyed on the consent and the channel rather than on the attempt: two
 * calls under the same consent should reuse the isolate, and a
 * DIFFERENT consent must never land on a warm one composed from
 * somebody else's permissions. That last clause is why the consent id
 * is in the key and not just the recipient ref.
 */
export function isolateId(signedConsent, channel) {
	const body = (signedConsent || {}).record || {};
	return `agent:${body.id || "unknown"}:${channel}`;
}

/**
 * The outbound proxy every isolate's `fetch()` passes through.
 *
 * Two jobs, and the order matters: refuse anything not on the
 * allowlist, then attach the credential. Doing it the other way round
 * would put a live token on a request to an arbitrary host for as long
 * as it took the next line to reject it.
 */
export function outboundHandler(hosts, secrets) {
	const allow = new Set(hosts);
	return {
		async fetch(request) {
			const url = new URL(request.url);
			if (!allow.has(url.hostname)) {
				console.log(`[sandbox] blocked egress to ${url.hostname}`);
				return new Response(JSON.stringify({ error: "egress not permitted" }), {
					status: 403, headers: { "Content-Type": "application/json" },
				});
			}
			const headers = new Headers(request.headers);
			// Stripped first. If the isolate set its own Authorization —
			// which model-authored code will eventually try — it must not
			// survive to reach the provider.
			headers.delete("Authorization");
			if (secrets.vonageToken) headers.set("Authorization", `Bearer ${secrets.vonageToken}`);
			return fetch(new Request(request, { headers }));
		},
	};
}

/**
 * Actually run one. The only function here that touches the platform.
 */
export async function mintAgent(env, signedConsent, situation, secrets = {}) {
	const built = await sandboxFor(signedConsent, situation);
	if (!env.LOADER) throw new Error("this deploy has no Worker Loader bound");

	const worker = env.LOADER.get(isolateId(signedConsent, situation.channel), async () => ({
		...built.spec,
		globalOutbound: built.hosts.length ? outboundHandler(built.hosts, secrets) : null,
	}));
	return { ...built, worker };
}
