/**
 * Which bearers /notify accepts.
 *
 * Its own file because notify.mjs imports `cloudflare:email`, which
 * resolves only inside the Workers runtime — anything importing it is
 * unreachable from vitest. This is the decision that must not regress,
 * so it lives where it can be tested.
 *
 * ## Every value we hold, not the first one present
 *
 * The obvious spelling is `env.MCP_TOKEN || env.ROOT_SECRET`, and it is
 * wrong in a way that is silent. api/_mail resolves the same pair in the
 * same order on the CALLER side, so a deployment carrying only
 * ROOT_SECRET presents a real credential — and a Worker that happens to
 * hold both resolves MCP_TOKEN, compares against that alone, and
 * refuses it. Nobody is misconfigured. Mail just stops.
 *
 * That is preference-by-presence, which this codebase has now found in
 * three places. The fix is the same each time: ask what a value CAN do,
 * not which one turned up first.
 *
 * Accepting all of them is not a widening. They are the same trusted
 * secret under several names, and the alternative is not "stricter" —
 * it is one arbitrary member of the set.
 *
 * ## NOTIFY_TOKEN exists so mail does not govern /mcp
 *
 * MCP_TOKEN drives three unrelated policies: whether /mcp requires a
 * bearer, whether the cost-bearing tools are switched on, and what this
 * route accepts. Setting it so that mail could work therefore CLOSED an
 * MCP surface that was deliberately open and switched generate and
 * publish on — a side effect nobody asked for, from provisioning a
 * mailer.
 *
 * So mail gets a name of its own, and MCP_TOKEN stays accepted because
 * that is what is deployed today. Once NOTIFY_TOKEN is in place,
 * removing MCP_TOKEN from the Worker restores /mcp to how it was
 * without taking mail down.
 */

/** The bearers this deployment will accept. Empty means refuse everything. */
export function acceptedBearers(env) {
	return [env?.NOTIFY_TOKEN, env?.MCP_TOKEN, env?.ROOT_SECRET]
		.map((v) => (typeof v === "string" ? v.trim() : ""))
		.filter(Boolean);
}

/** Whether an Authorization header matches one of them. */
export function bearerOk(header, accepted) {
	const presented = typeof header === "string" ? header : "";
	// An empty list must never match. A caller sending no Authorization
	// header at all would otherwise walk in on a Worker with no secrets
	// — which is the open relay the whole route is written to refuse.
	return accepted.length > 0 && accepted.some((t) => presented === `Bearer ${t}`);
}
