/**
 * Telling somebody their generation is ready.
 *
 * A render takes minutes. The person who asked for it has closed the tab,
 * and nothing has ever told them it finished — so the work completes and
 * the only way to find out is to come back and look. That is the gap this
 * closes, and it is why mail exists here before receipts (#143) do.
 *
 * ## Why this is in a Worker and not in the Vercel function
 *
 * The `send_email` binding is authority this Worker already holds. There
 * is no API token, so there is nothing to grant, rotate or leak — and the
 * first attempt at sending from Vercel failed on exactly that: a token
 * without Email Sending, answering `401 10000`.
 *
 * Same reasoning that moved publish here (#116): "publish writes R2
 * through the SITES binding instead of presenting a bearer to our own
 * site-host Worker over the public internet". A binding beats a
 * credential every time it is available.
 *
 * ## This route FAILS CLOSED, unlike /mcp
 *
 * The MCP surface is open when `MCP_TOKEN` is unset — a deliberate choice
 * for a read-mostly protocol endpoint. That choice must not extend here.
 * A mail route with no bearer is an open relay: anybody who finds the URL
 * can make our domain write to any address, and the reputation cost lands
 * on the sending domain the whole platform uses.
 *
 * So an unset token means this route refuses everything, and says so.
 *
 * ## The message is built next door because the binding takes MIME
 *
 * `send_email` wants a raw RFC 5322 message, not a JSON body — the REST
 * API's shape and the binding's shape are different. Hand-built rather
 * than pulling in a MIME library: it is a header block and a boundary,
 * the failure modes are visible, and a dependency in a Worker is a thing
 * to keep bundling forever.
 *
 * It lives in mailMessage.mjs so it can be tested: `cloudflare:email`
 * resolves only inside the Workers runtime, so anything importing it is
 * unreachable from vitest.
 */

import { EmailMessage } from "cloudflare:email";
import { headerSafe, mime, oneAddress } from "./mailMessage.mjs";
import { acceptedBearers, bearerOk } from "./notifyAuth.mjs";
import { isFresh, newTicketId, safeTicketId, ticketKey } from "./notifyTicket.mjs";

/**
 * POST /notify — send one message.
 *
 * Returns 202 when the binding accepted it. ACCEPTED, never delivered:
 * a message can be refused after this point or land in spam, and saying
 * otherwise would record what we hope.
 */
export async function notifyRoute(request, env, cors, url) {
	const json = (body, status) =>
		Response.json(body, { status, headers: { ...cors, "Content-Type": "application/json" } });

	if (request.method !== "POST") {
		return json({ error: "method not allowed" }, 405);
	}

	// Fails closed. See the header: an unauthenticated mail route is an
	// open relay, and no token configured must mean no sending rather
	// than sending for anyone.
	//
	// Every value we hold, not the first one present — see
	// notifyAuth.mjs for why that distinction is load-bearing.
	const accepted = acceptedBearers(env);
	if (!accepted.length) {
		return json(
			{ error: "notify is not configured", detail: "no NOTIFY_TOKEN, MCP_TOKEN or ROOT_SECRET; this route refuses rather than relaying" },
			503,
		);
	}
	if (!bearerOk(request.headers.get("Authorization"), accepted)) {
		return json({ error: "unauthorized" }, 401);
	}

	// Which of the three. Split after the bearer check, so an
	// unauthenticated caller cannot learn which paths exist.
	const path = (url?.pathname || "").replace(/\/+$/, "");
	if (path === "/notify/ticket") return ticketRoute(request, env, json);
	if (path === "/notify/ready") return readyRoute(request, env, json);
	if (path !== "/notify") return json({ error: "not found" }, 404);

	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: "body must be JSON" }, 400);
	}

	const to = oneAddress(body?.to);
	const subject = typeof body?.subject === "string" ? body.subject.trim() : "";
	const text = typeof body?.text === "string" ? body.text : "";
	if (!to || !subject || !text) {
		return json({ error: "to, subject and text are all required" }, 400);
	}

	return send(env, to, subject, text, json, typeof body.html === "string" ? body.html : undefined);
}

/**
 * POST /notify/ticket — hold an address, hand back an opaque id.
 *
 * The id is what travels to Actions. See notifyTicket.mjs for why the
 * address must not.
 */
async function ticketRoute(request, env, json) {
	if (!env.PROVENANCE) {
		return json({ error: "no bucket bound to hold tickets" }, 503);
	}
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: "body must be JSON" }, 400);
	}
	const to = oneAddress(body?.to);
	if (!to) {
		return json({ error: "a single valid address is required" }, 400);
	}
	const id = newTicketId();
	await env.PROVENANCE.put(
		ticketKey(id),
		JSON.stringify({ to, createdAt: new Date().toISOString() }),
	);
	return json({ ticket: id }, 201);
}

/**
 * POST /notify/ready — redeem a ticket and tell them it is done.
 *
 * Deleted on redemption whatever happens next, so a leaked run log
 * cannot be replayed to mail somebody repeatedly. That means a send that
 * fails is not retried from the ticket — the alternative is a ticket
 * that survives its own use, and a replayable one is worse than a
 * missed notification.
 */
async function readyRoute(request, env, json) {
	if (!env.PROVENANCE) {
		return json({ error: "no bucket bound to hold tickets" }, 503);
	}
	let body;
	try {
		body = await request.json();
	} catch {
		return json({ error: "body must be JSON" }, 400);
	}

	const id = safeTicketId(body?.ticket);
	if (!id) {
		return json({ error: "a ticket is required" }, 400);
	}

	const stored = await env.PROVENANCE.get(ticketKey(id));
	if (!stored) {
		// Says nothing about whether it ever existed. A different answer
		// for a real id would make this a way to test them.
		return json({ error: "no such ticket" }, 404);
	}
	const record = await stored.json().catch(() => null);
	await env.PROVENANCE.delete(ticketKey(id));

	if (!record?.to || !isFresh(record, Date.now())) {
		return json({ error: "ticket expired" }, 410);
	}

	const where = typeof body?.url === "string" && /^https:\/\//.test(body.url) ? body.url : "";
	const subject = "Your generation is ready";
	const lines = [
		"It finished.",
		"",
		where ? where : "It is on the site, under your recent work.",
		"",
		"— Ontold",
	];

	return send(env, record.to, subject, lines.join("\n"), json);
}

/** The one place a message actually goes out. */
async function send(env, to, subject, text, json, html) {
	if (!env.EMAIL) {
		return json({ error: "no send_email binding on this deployment" }, 503);
	}
	const from = headerSafe(env.MAIL_FROM || "no-reply@mail.ontold.site");
	const replyTo = headerSafe(env.MAIL_REPLY_TO || "hello@ontold.site");
	try {
		await env.EMAIL.send(
			new EmailMessage(from, to, mime({ from, to, replyTo, subject, text, html })),
		);
	} catch (err) {
		return json({ error: "refused", detail: String(err?.message || err).slice(0, 300) }, 502);
	}
	return json({ accepted: true }, 202);
}
