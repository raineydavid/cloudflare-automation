/**
 * The JSON-RPC layer — a direct port of `api/_mcp.py`'s dispatch.
 *
 * ## Why this is hand-rolled and not `createMcpHandler`
 *
 * Cloudflare's Agents SDK ships `createMcpHandler`, and for a new
 * server it would be the obvious choice. This is not a new server: it
 * is a port of one with 78 tests describing its exact behaviour, and
 * those tests are the only thing standing between "moved to the edge"
 * and "quietly changed while nobody was looking". Porting the dispatch
 * verbatim means the tests port with it and parity is provable line by
 * line. Adopting a different protocol layer at the same time would mean
 * changing the transport and the tools in one move, with no way to tell
 * which one broke something.
 *
 * The SDK is the right answer for the OAuth 2.1 work that comes next —
 * `@cloudflare/workers-oauth-provider` is genuinely hard to beat — and
 * swapping it in is a contained change once the tools are known-good
 * here. Sequencing, not rejection.
 *
 * ## Stateless on purpose
 *
 * The 2026-07-28 spec removed protocol-level sessions, so one JSON
 * response per POST is spec-valid and needs no Durable Object. A
 * Worker that holds no session is a Worker that cannot leak one
 * caller's state into another's request.
 */

import { ToolError } from './brief.mjs';

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_INFO = { name: "ontold", version: "0.5.0" };

const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });
const error = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

/**
 * Tools that spend real money when called.
 *
 * They get their own rate-limit bucket. The MCP surface was once
 * limited as ONE bucket at the storage default — 30 a minute — while
 * /api/video, which starts strictly less work per call, capped
 * generation at 10. So the cheapest way to burn the render budget was
 * this endpoint, and the free read-only tools shared the allowance,
 * meaning a chatty agent could exhaust the budget for renders without
 * ever starting one.
 *
 * `publish` is deliberately NOT here. It writes to the internet, which
 * is consequential, but it does not commission a render.
 */
export const COST_BEARING_TOOLS = new Set(["generate"]);

/**
 * Handle one JSON-RPC request → a response object, or null for a
 * notification (no `id` — the caller replies 202 with no body).
 *
 * `ctx.caller` is the HASHED per-caller identity, never the bearer.
 * That is a deliberate constraint carried over from the Python: the
 * spend window must not become the place a credential is stored.
 */
export async function handle(request, ctx) {
	const base = (ctx.base || "").replace(/\/+$/, "");

	if (!request || typeof request !== "object" || Array.isArray(request) || request.jsonrpc !== "2.0") {
		const id = request && typeof request === "object" && !Array.isArray(request) ? request.id ?? null : null;
		return error(id, -32600, "invalid request");
	}

	// A notification has no `id` AT ALL — distinct from `id: null`,
	// which is a request that wants an answer addressed to null.
	if (!("id" in request)) return null;

	const { method, id } = request;
	const params = request.params || {};

	if (method === "initialize") {
		return result(id, {
			protocolVersion: params.protocolVersion || PROTOCOL_VERSION,
			capabilities: { tools: { listChanged: false } },
			serverInfo: SERVER_INFO,
		});
	}

	if (method === "ping") return result(id, {});
	if (method === "tools/list") return result(id, { tools: ctx.tools.schemas });

	if (method === "tools/call") {
		const name = params.name;
		const args = params.arguments || {};
		const impl = ctx.tools.impls[name];
		if (!impl) return error(id, -32602, `unknown tool: ${name}`);

		if (COST_BEARING_TOOLS.has(name) && !(await ctx.generationAllowed(ctx.caller))) {
			return result(id, {
				content: [{ type: "text", text:
					"Error: generation rate limit reached — a render is " +
					"cost-bearing and capped per minute. Retry shortly." }],
				isError: true,
			});
		}

		try {
			return result(id, { content: [{ type: "text", text: await impl(args, { ...ctx, base }) }] });
		} catch (e) {
			// ONLY a ToolError's message is forwarded. Anything else is a
			// fault on our side, and its message may name an internal host,
			// a key variable or a stack path — the I11 posture the Python
			// api/ modules hold everywhere. The caller gets a flat refusal
			// and the detail goes to the log.
			if (e instanceof ToolError) {
				return result(id, { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true });
			}
			console.log(`[mcp] tool ${name} failed: ${e && e.stack ? e.stack : e}`);
			return result(id, {
				content: [{ type: "text", text: "Error: that call failed on our side. Nothing was charged." }],
				isError: true,
			});
		}
	}

	return error(id, -32601, `method not found: ${method}`);
}

/**
 * Parse a request body (single or batch), dispatch, return
 * `{ status, body }`. A body of only notifications → 202 with no body.
 */
export async function handleBody(raw, ctx) {
	let payload;
	try {
		payload = JSON.parse(raw);
	} catch {
		return { status: 200, body: JSON.stringify(error(null, -32700, "parse error")) };
	}

	// WorkAIs rail health probe (expert-station's api/_handlers/ontold.js
	// sends {"ping": true} and expects {"ok": true}). Answering it here
	// lets the platform point API_BASE at this endpoint and have
	// its status op verify — one rail, one endpoint. Not JSON-RPC by
	// design, and checked BEFORE protocol dispatch so the shim can never
	// shadow a real request.
	if (payload && typeof payload === "object" && !Array.isArray(payload)
		&& payload.ping === true && !("jsonrpc" in payload)) {
		return { status: 200, body: JSON.stringify({ ok: true, server: SERVER_INFO }) };
	}

	if (Array.isArray(payload)) {
		const responses = (await Promise.all(payload.map((item) => handle(item, ctx)))).filter((r) => r !== null);
		if (!responses.length) return { status: 202, body: null };
		return { status: 200, body: JSON.stringify(responses) };
	}

	const response = await handle(payload, ctx);
	if (response === null) return { status: 202, body: null };
	return { status: 200, body: JSON.stringify(response) };
}
