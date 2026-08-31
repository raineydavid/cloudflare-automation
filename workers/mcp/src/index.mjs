/**
 * Ontold's MCP server, at the edge.
 *
 * A port of the surface that ran inside `api/status.py` on Vercel. The
 * protocol and the seven tools behave identically — that is the whole
 * contract, and workers/mcp/test asserts it. What changed is where it
 * sits and what it can reach:
 *
 *   - `publish` writes R2 through a BINDING instead of presenting a
 *     bearer token to our own Worker over the public internet.
 *   - It costs no Vercel function. The Hobby cap is 12, eight were
 *     used, and `/mcp` was riding inside status.py to avoid spending a
 *     ninth. One Worker is one script with a router and no such cap.
 *   - OAuth 2.1 becomes reachable — `@cloudflare/workers-oauth-provider`
 *     is a swap here and would have been hand-rolled callback routes,
 *     each costing a function, on Vercel.
 *
 * ## Auth, unchanged on purpose
 *
 * When `MCP_TOKEN` is configured, callers must present
 * `Authorization: Bearer <token>`; when it is not, the surface is open.
 * That is the Vercel behaviour and changing it during a port would mean
 * a deployment silently gaining or losing a gate at the same moment its
 * address changed.
 *
 * The rate-limit key is a HASH of the credential, never the credential.
 * An earlier version of the Python keyed the window on the raw
 * Authorization header, which parked a live bearer in the rate-limit
 * store; the hash is the fix and it ports with the code.
 *
 * ## Spend fails closed
 *
 * If no KV namespace is bound there is nowhere to count calls, and
 * `generate` REFUSES rather than proceeding uncounted. An unmetered
 * render endpoint is the "loses money silently" failure the launch
 * blockers name, and defaulting to allow would reintroduce it at
 * exactly the moment nobody is looking — a fresh deploy.
 */

import { handleBody, SERVER_INFO } from './protocol.mjs';
import { TOOLS } from './tools.mjs';
import { provenanceRoute } from './provenanceRoutes.mjs';
import { notifyRoute } from "./notify.mjs";

/** Requests a caller may make per minute across all tools. */
const GENERAL_LIMIT = 30;

/** Cost-bearing calls per minute. Its own bucket, so read-only chatter
 *  cannot consume the render allowance and a burst of renders cannot
 *  hide inside ordinary traffic. */
const GENERATION_LIMIT = 10;

const CORS = {
	// The surface is already public-or-bearer-gated, so `*` widens
	// reach, not risk.
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const rpcError = (code, message) =>
	JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } });

/** The configured bearer, explicit or derived from the root secret. */
function configuredToken(env) {
	return (env.MCP_TOKEN || env.ROOT_SECRET || "").trim();
}

/** A stable, non-reversible id for the caller.
 *
 *  Hashed because this value is written to the rate-limit store and
 *  appears in logs, and a bearer token that lands in either is a bearer
 *  token that has to be rotated. Falls back to the connecting IP so an
 *  unauthenticated public deployment still meters per caller rather
 *  than as one shared bucket. */
async function callerKey(request) {
	const raw = request.headers.get("Authorization")
		|| request.headers.get("CF-Connecting-IP")
		|| "anon";
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
	return [...new Uint8Array(digest)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A fixed per-minute window in KV.
 *
 * KV is eventually consistent, so a caller hammering several edge
 * locations at once can briefly exceed the limit. That is acceptable
 * here and worth stating plainly: the purpose of this window is to stop
 * a runaway loop burning a month's render budget in ninety seconds, not
 * to bill precisely. A Durable Object would be exact and would add a
 * round trip to every read-only call to fix a problem this does not
 * have.
 */
async function withinLimit(env, bucket, limit) {
	if (!env.RATE) return null;          // nothing bound — caller decides
	const key = `${bucket}:${Math.floor(Date.now() / 60000)}`;
	const used = Number((await env.RATE.get(key)) || 0);
	if (used >= limit) return false;
	// TTL 120s: KV's minimum is 60, and two minutes outlives the window
	// without leaving keys around to be counted twice.
	await env.RATE.put(key, String(used + 1), { expirationTtl: 120 });
	return true;
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);

		if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

		// The provenance store (#110) rides in this Worker rather than a
		// second one: it wants the same R2 bindings and the same deploy,
		// and a separate Worker would mean a second wrangler config, a
		// second secret store and a second thing to forget to deploy. It
		// is NOT part of the MCP protocol surface, so it lives under its
		// own path prefix and its own module.
		if (url.pathname.startsWith("/provenance")) {
			return provenanceRoute(request, env, url, CORS);
		}

		// Telling somebody their generation is ready. Here for the same
		// reason provenance is: it wants a binding this Worker already
		// holds — send_email, which needs no credential at all — and a
		// second Worker would mean a second config and a second deploy to
		// forget. Not part of the MCP protocol surface, so its own path
		// prefix and its own module.
		//
		// Unlike /mcp below, it REFUSES when no token is configured. An
		// open mail route is an open relay.
		if (url.pathname.startsWith("/notify")) {
			return notifyRoute(request, env, CORS, url);
		}

		// A GET is almost always a human pasting the URL into a browser.
		// Say what this is rather than returning a bare 405.
		if (request.method === "GET") {
			return Response.json(
				{ server: SERVER_INFO, transport: "streamable-http", endpoint: "/mcp",
				  hint: "POST JSON-RPC here. This endpoint speaks MCP, not HTML." },
				{ headers: CORS },
			);
		}

		if (request.method !== "POST" || (url.pathname !== "/mcp" && url.pathname !== "/")) {
			return new Response(rpcError(-32601, "method not found"), {
				status: 404, headers: { ...CORS, "Content-Type": "application/json" },
			});
		}

		const token = configuredToken(env);
		if (token) {
			const got = request.headers.get("Authorization") || "";
			if (got !== `Bearer ${token}`) {
				return new Response(rpcError(-32001, "unauthorized"), {
					status: 401, headers: { ...CORS, "Content-Type": "application/json" },
				});
			}
		}

		const caller = await callerKey(request);

		// The general window. `null` means nothing is bound to count in;
		// read-only calls are cheap enough to let through, and the
		// cost-bearing ones fail closed below.
		if ((await withinLimit(env, `mcp:${caller}`, GENERAL_LIMIT)) === false) {
			return new Response(rpcError(-32002, "rate limited"), {
				status: 429, headers: { ...CORS, "Content-Type": "application/json" },
			});
		}

		let raw;
		try {
			raw = await request.text();
		} catch {
			return new Response(rpcError(-32600, "bad request"), {
				status: 400, headers: { ...CORS, "Content-Type": "application/json" },
			});
		}

		const { status, body } = await handleBody(raw, {
			base: (env.APP_BASE || `https://${url.host}`).replace(/\/+$/, ""),
			env,
			caller,
			tools: TOOLS,
			now: () => Date.now(),
			// Fails CLOSED: no counter bound means no render.
			generationAllowed: async (who) =>
				(await withinLimit(env, `mcp-generate:${who}`, GENERATION_LIMIT)) === true,
		});

		if (body === null) return new Response(null, { status, headers: CORS });
		return new Response(body, { status, headers: { ...CORS, "Content-Type": "application/json" } });
	},
};
