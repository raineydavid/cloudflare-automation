/**
 * Holding an address so a render can be announced without carrying it.
 *
 * A generation is dispatched to GitHub Actions and finishes minutes
 * later, so the thing that knows it is done is the workflow — not the
 * function that queued it. The obvious wiring is to pass the address as a
 * workflow input and let the run mail it at the end.
 *
 * That is wrong twice over:
 *
 *   A workflow_dispatch input is recorded on the run. It is visible in
 *   the Actions UI to anybody with read on the repository, it stays
 *   there, and it ends up in logs. A customer's email address is not
 *   build metadata.
 *
 *   And it would make the workflow a relay driven by an input. Our own
 *   send-test workflow refuses to mail "an address from a workflow
 *   input, a branch name or a form" precisely because anything holding a
 *   sending credential that mails what it is handed is a way to make our
 *   domain write to a stranger. Building the opposite next door would
 *   undo the rule.
 *
 * So the address never enters Actions. `/notify/ticket` takes it here and
 * returns an opaque id; the dispatch carries only the id; `/notify/ready`
 * redeems it. What Actions holds is a random string that means nothing
 * without this Worker and the bucket behind it.
 *
 * ## Single use, and short-lived
 *
 * A ticket is deleted the moment it is redeemed, so a leaked run log
 * cannot be replayed to mail somebody repeatedly. It also expires: a
 * render that never finishes should not leave an address sitting in a
 * bucket indefinitely, and the expiry is what makes "we hold this until
 * the job is done" true rather than aspirational.
 *
 * ## Where they live
 *
 * The PROVENANCE bucket, under its own prefix. Not the SITES bucket,
 * which site-host serves to the public internet — the same reasoning that
 * gave provenance its own bucket applies harder to a store of customer
 * addresses. A dedicated bucket would be cleaner still and needs
 * provisioning; this is bound already and is private.
 */

/** How long an unredeemed ticket is honoured. */
export const TICKET_TTL_MS = 24 * 60 * 60 * 1000;

const PREFIX = "notify/tickets/";

/** Opaque, random, and not derived from the address it stands for. */
export function newTicketId(random = crypto.getRandomValues.bind(crypto)) {
	const b = random(new Uint8Array(16));
	return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** A ticket id we are willing to look up. Never a path fragment. */
export function safeTicketId(value) {
	const v = typeof value === "string" ? value.trim().toLowerCase() : "";
	// Hex only, fixed length. A slash or a dot here would be a way to
	// read another key out of the bucket.
	return /^[0-9a-f]{32}$/.test(v) ? v : null;
}

export const ticketKey = (id) => `${PREFIX}${id}`;

/** Whether a stored ticket is still good. */
export function isFresh(record, now) {
	const at = Date.parse(record?.createdAt ?? "");
	// An unreadable date is treated as expired. The safe direction for a
	// record that decides whether to mail somebody is to stop.
	return Number.isFinite(at) && now - at < TICKET_TTL_MS;
}
