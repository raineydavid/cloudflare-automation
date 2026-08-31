/**
 * Building a message, and refusing a bad address.
 *
 * Separate from notify.mjs because that file imports `cloudflare:email`,
 * a Workers builtin that does not resolve anywhere else — so anything
 * beside it is untestable in node. These are the halves worth testing:
 * one composes headers a caller partly controls, the other decides
 * whether a string may be mailed at all.
 */

/** Header values may not carry CR or LF — that is how a header is forged. */
export function headerSafe(value) {
	return String(value).replace(/[\r\n]+/g, " ").trim();
}

/**
 * A minimal multipart/alternative message.
 *
 * Both parts, always, when there is HTML: an HTML-only message with no
 * plain-text alternative is a spam signal on its own, and the text half
 * is what a screen reader, a watch and a terminal client get.
 */
export function mime({ from, to, replyTo, subject, text, html = "" }) {
	const headers = [
		`From: ${headerSafe(from)}`,
		`To: ${headerSafe(to)}`,
		replyTo ? `Reply-To: ${headerSafe(replyTo)}` : "",
		`Subject: ${headerSafe(subject)}`,
		"MIME-Version: 1.0",
	].filter(Boolean);

	if (!html) {
		return [...headers, 'Content-Type: text/plain; charset="utf-8"', "", text].join("\r\n");
	}

	// Fixed rather than random: a boundary only has to not appear in the
	// body, and Math.random() in a Worker is one more thing to reason
	// about. Long enough that it will not.
	const b = "----=_ontold_alt_9f2c1d7b4e";
	return [
		...headers,
		`Content-Type: multipart/alternative; boundary="${b}"`,
		"",
		`--${b}`,
		'Content-Type: text/plain; charset="utf-8"',
		"",
		text,
		`--${b}`,
		'Content-Type: text/html; charset="utf-8"',
		"",
		html,
		`--${b}--`,
		"",
	].join("\r\n");
}

/** One address, or nothing. Never a list — this route sends to one person. */
export function oneAddress(value) {
	const v = typeof value === "string" ? value.trim() : "";
	// Deliberately strict. A comma is how one field becomes a bulk send,
	// and a newline is how it becomes a forged header.
	if (!v || /[,\s;<>]/.test(v) || v.split("@").length !== 2) return null;
	const [local, domain] = v.split("@");
	return local && domain.includes(".") ? v.toLowerCase() : null;
}
