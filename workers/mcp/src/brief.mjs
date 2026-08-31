/**
 * Brief composition and the mint link — the two tools that spend
 * nothing.
 *
 * Both are pure string work with no I/O at all, which is why they are
 * in their own file: they can be tested without a bucket, a bearer, or
 * a network, and they are the tools most likely to be called in a loop
 * by a chatty agent.
 *
 * ## The cost boundary runs through here
 *
 * `compose` and `mintWorker` produce a LINK. The cost-bearing synthesis
 * — the LLM persona, the portrait render, the film — happens when a
 * human opens that link in their own Ontold session, against their own
 * keys. That is deliberate and it is the same boundary that separates
 * `compose` from `generate`: composing is free because it commissions
 * nothing.
 *
 * ## A templateId is passed through, never validated
 *
 * Checking a supplied templateId against the catalogue would turn this
 * into a probing oracle: call it with a guess, and a "valid"/"invalid"
 * answer enumerates the catalogue one request at a time. The generation
 * pipeline resolves and validates it server-side where the answer is
 * not observable. Same founder ruling as the missing list-templates
 * tool.
 */

/**
 * Percent-encoding for a query-string VALUE.
 *
 * Deliberately not byte-identical to the Python original. `urllib.parse
 * .quote` defaults to `safe="/"`, so a brief containing a slash produced
 * `?compose=a/b`; `encodeURIComponent` produces `?compose=a%2Fb`. Both
 * round-trip correctly through the SPA's `decodeURIComponent`, and the
 * encoded form is the safer one for a value that will be concatenated
 * into a URL. Noted rather than "fixed" because a future parity test
 * comparing the two implementations will otherwise look like it found a
 * bug.
 */
const q = (s) => encodeURIComponent(s);

/**
 * The bracket-brief the app's composer produces.
 *
 * Throws when neither an idea nor a template is given, because a brief
 * composed from nothing is an empty string, and an empty string sent
 * onward to `generate` would dispatch a render of nothing and bill for
 * it.
 */
export function buildBrief(args = {}) {
	const idea = String(args.idea ?? "").trim();
	const templateId = String(args.templateId ?? "").trim();
	if (!idea && !templateId) throw new ToolError("idea or templateId is required");

	const parts = [];
	if (templateId) parts.push(`Template: ${templateId}`);
	for (const [key, label] of [["format", "Format"], ["treatment", "Treatment"], ["camera", "Camera"]]) {
		const v = String(args[key] ?? "").trim();
		if (v) parts.push(`${label}: ${v}`);
	}
	if (parts.length && idea) return `[${parts.join(" | ")}] ${idea}`;
	if (parts.length) return `[${parts.join(" | ")}]`;
	return idea;
}

/**
 * A caller mistake, as distinct from a server fault.
 *
 * The protocol layer turns these into an MCP tool result with
 * `isError: true` and the message shown to the model, which is what
 * lets a calling agent correct itself and retry. Anything NOT of this
 * type is a bug on our side and must not have its message forwarded —
 * see the catch in protocol.mjs.
 */
export class ToolError extends Error {}

export function composeText(args, base) {
	const brief = buildBrief(args);
	return `Composed Ontold brief:\n\n${brief}\n\nOpen in Ontold to generate it:\n${base}/?compose=${q(brief)}`;
}

export function mintWorkerText(args, base) {
	const role = String(args.role ?? "").trim();
	if (!role) throw new ToolError("role is required — e.g. 'Head of Growth'");

	const name = String(args.name ?? "").trim();
	const company = String(args.company ?? "").trim();
	const traits = String(args.traits ?? "").trim();
	const ref = String(args.ref ?? "").trim();

	const at = company ? ` at ${company}` : "";
	const personaParts = [`${role}${at}.`];
	if (traits) personaParts.push(/[.!?]$/.test(traits) ? traits : `${traits}.`);
	personaParts.push(
		"Speaks like a trusted colleague: direct, specific, personable; " +
		"asks the sharp question; allergic to corporate filler.",
	);

	const query = `mint=${q(personaParts.join(" "))}`
		+ (name ? `&mintName=${q(name)}` : "")
		// Correlation id for the return leg: when the link is opened from
		// a dashboard tab, Ontold postMessages the minted character (id +
		// portrait) back to the opener under this ref.
		+ (ref ? `&mintRef=${q(ref)}` : "");

	return `Mint link for your ${role}:\n\n${base}/?${query}\n\n`
		+ "Opening it in Ontold synthesizes the character — persona, portrait, a first-meeting "
		+ "scene — adds them to the cast, and lands on their page with the live call one tap away. "
		+ "To ground them in a real background, paste a CV or bio in Ontold's cast dialog after minting.";
}

/**
 * A correlation id for an agent-dispatched run.
 *
 * The `mcp-` prefix is not decoration: it makes agent-originated runs
 * distinguishable from SPA ones in the artefact store and in the
 * workflow log, which matters the first time one of them misbehaves at
 * 3am. 16 hex characters after the prefix sits well inside run.py's
 * 6-64 character grammar.
 */
export function newRunId() {
	const bytes = crypto.getRandomValues(new Uint8Array(8));
	return `mcp-${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** The grammar api/run.py validates at dispatch. Rejecting a bad id
 *  here means a caller learns immediately rather than after a workflow
 *  has been queued under a name nothing can poll. */
export const RUN_ID_RE = /^[a-zA-Z0-9_-]{6,64}$/;
