/**
 * HTTP for the provenance store. The rules live in provenance.mjs;
 * this only maps them onto paths.
 *
 * Split from the store itself so the store stays testable without a
 * Request object, and split from index.mjs so the MCP protocol surface
 * and this one cannot accidentally share a code path — they have
 * different auth models and only one of them is JSON-RPC.
 *
 *   POST /provenance          store a signed record (verifies first)
 *   GET  /provenance/<creator>/<id>   read one — deliberately public
 *   POST /provenance/nonce    mint a single-use listing nonce
 *   POST /provenance/list     enumerate — signature required
 *
 * ## Why there is no bearer here
 *
 * Every write is authenticated by the signature ON the record, and
 * every listing by a signature over a server-issued nonce. A bearer
 * token would add nothing: it identifies whoever holds it, while the
 * signature identifies who holds the key that the prefix is derived
 * from. The second is the property that matters, and it is the one we
 * cannot forge on a creator's behalf either.
 */

import { put, get, issueNonce, listRecords, Refused } from './provenance.mjs';

const json = (body, status, cors) =>
	new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

/** A Refused message is safe to return: every one of them describes
 *  what the caller sent, never anything about anyone else. Anything
 *  else is a fault on our side and gets a flat answer plus a log. */
function refusal(e, cors) {
	if (e instanceof Refused) return json({ error: e.message }, 400, cors);
	console.log(`[provenance] ${e && e.stack ? e.stack : e}`);
	return json({ error: "that failed on our side" }, 500, cors);
}

export async function provenanceRoute(request, env, url, cors) {
	const bucket = env.PROVENANCE;
	if (!bucket) return json({ error: "this deploy has no provenance storage bound" }, 501, cors);

	const parts = url.pathname.split("/").filter(Boolean);   // ["provenance", ...]

	try {
		if (request.method === "POST" && parts.length === 1) {
			const key = await put(await request.json(), bucket);
			return json({ stored: true, key }, 201, cors);
		}

		if (request.method === "POST" && parts[1] === "nonce") {
			const { public_key: publicKey } = await request.json();
			return json(await issueNonce(publicKey, env.RATE), 200, cors);
		}

		if (request.method === "POST" && parts[1] === "list") {
			const body = await request.json();
			const ids = await listRecords(body.public_key, body.nonce, body.signature,
				{ bucket, kv: env.RATE });
			return json({ records: ids }, 200, cors);
		}

		if (request.method === "GET" && parts.length === 3) {
			const [, creator, id] = parts;
			const record = await get(id, creator, bucket);
			if (!record) return json({ error: "no such record" }, 404, cors);
			// Served as the canonical bytes it was stored as, so a caller
			// can re-verify the signature over exactly what we hold.
			return new Response(record, {
				status: 200,
				headers: { ...cors, "Content-Type": "application/json" },
			});
		}
	} catch (e) {
		if (e instanceof SyntaxError) return json({ error: "body must be JSON" }, 400, cors);
		return refusal(e, cors);
	}

	return json({ error: "no such provenance route" }, 404, cors);
}
