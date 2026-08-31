/**
 * The seven tools, and the three that touch the world.
 *
 * `capabilities`, `compose`, `roster` and `mint_worker` are pure and
 * live in vocabulary.mjs / brief.mjs. What is here is the rest:
 * `generate` (queues a render), `status` (reads artefacts) and
 * `publish` (writes a page live).
 *
 * ## What the move to a Worker actually bought
 *
 * `publish` used to be: caller → Vercel /mcp → HTTPS PUT to
 * `https://<slug>.ontold.site/__publish` → the site-host Worker → R2.
 * Two hops and a shared bearer (`PUBLISH_TOKEN`) presented over the
 * public internet, to write an object we own.
 *
 * Here it is one `env.SITES.put()`. The hop is gone, and so is the
 * token — not rotated, not moved, GONE, because a binding is not a
 * credential and cannot be replayed by anyone who reads a log. The
 * overwrite guard and the version history that the site-host Worker
 * enforced now have to be enforced HERE, which is the cost of removing
 * the middleman and is why they are written out explicitly below rather
 * than assumed.
 *
 * ## What deliberately did NOT move
 *
 * `generate` still dispatches a GitHub workflow, and the generation
 * credentials still live in GitHub secrets and are read only on the
 * runner. This Worker holds two things: who may call, and permission to
 * queue a job. If it were ever compromised, an attacker could enqueue a
 * render — not read the model keys. That property is worth more than
 * the convenience of moving the keys closer, and it should survive any
 * future refactor of this file.
 */

import { buildBrief, composeText, mintWorkerText, newRunId, ToolError, RUN_ID_RE } from './brief.mjs';
import { capabilitiesText, rosterText } from './vocabulary.mjs';

/** A DNS label — what the site-host Worker can actually serve. Dots
 *  are excluded deliberately: its `slugFromHost` rejects any slug
 *  containing one, so accepting it here would mint a link that 404s
 *  forever. */
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** `__root` is the apex's own site and `www` resolves to it.
 *  Publishing to either overwrites the front door.
 *
 *  `mcp` is here for a different reason: this Worker's own route,
 *  `mcp.ontold.site/*`, is more specific than site-host's
 *  `*.ontold.site/*` wildcard and therefore wins. A page published to
 *  that slug would land in R2 and never be served — the visitor gets
 *  JSON-RPC, and nobody connects the 404 to a routing rule. Refusing
 *  the slug is cheaper than explaining it later. */
const RESERVED_SLUGS = new Set(["__root", "www", "mcp"]);

const PUBLISH_DOMAIN = "ontold.site";

/** The site host's own ceiling, enforced here too so an oversized page
 *  fails with a sentence instead of after a 5MB write. */
const MAX_SITE_BYTES = 5 * 1024 * 1024;

/**
 * Is a cost-bearing or world-writing tool switched on at all?
 *
 * Mirrors api/_secrets: an explicit per-tool token wins, otherwise it
 * is derived from the root secret. A deployment that set only
 * ROOT_SECRET and reasonably expected every bearer to come with
 * it must not find generation silently switched off.
 */
export function mcpEnabled(env) {
	return Boolean((env.MCP_TOKEN || env.ROOT_SECRET || "").trim());
}

function validatedSlug(raw) {
	const slug = String(raw ?? "").trim().toLowerCase();
	if (!slug) throw new ToolError("slug is required — it becomes <slug>.ontold.site");
	if (RESERVED_SLUGS.has(slug)) throw new ToolError(`'${slug}' is reserved — it is the front door, not a site`);
	if (!SLUG_RE.test(slug)) {
		throw new ToolError(
			"slug must be a subdomain label: lowercase letters, digits and " +
			"hyphens, starting and ending alphanumeric, no dots",
		);
	}
	return slug;
}

// ── generate ─────────────────────────────────────────────────────────

async function generate(args, ctx) {
	if (!mcpEnabled(ctx.env)) {
		throw new ToolError(
			"generation isn't enabled on this server (set ROOT_SECRET, " +
			"or MCP_TOKEN to override just this one). " +
			"Use compose for a brief + open-in-Ontold link instead.",
		);
	}
	const brief = buildBrief(args);

	const supplied = String(args.runId ?? "").trim();
	if (supplied && !RUN_ID_RE.test(supplied)) {
		// Caught here rather than at dispatch so the caller learns
		// immediately, instead of after a workflow has been queued under a
		// name that nothing can poll.
		throw new ToolError("runId must be 6-64 characters of letters, digits, underscore or hyphen");
	}
	const runId = supplied || newRunId();

	const token = (ctx.env.GH_PAT || ctx.env.GITHUB_TOKEN || "").trim();
	if (!token) throw new ToolError("render dispatch isn't wired on this deploy yet — nothing was started");

	const owner = ctx.env.GH_OWNER || "raineydavid";
	const repo = ctx.env.GH_REPO || "ontold";
	const workflow = ctx.env.GH_WORKFLOW || "demo.yml";
	const ref = ctx.env.GH_REF || "main";

	const res = await fetch(
		`https://api.github.com/repos/${owner}/${repo}/actions/workflows/${workflow}/dispatches`,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
				"Content-Type": "application/json",
				// GitHub rejects API requests with no User-Agent. Vercel's
				// urllib sent one by default; `fetch` in a Worker does not.
				"User-Agent": "ontold-mcp-worker",
			},
			body: JSON.stringify({ ref, inputs: { brief, run_id: runId } }),
		},
	);

	if (!res.ok) {
		// The upstream status and body stay in the log. A caller gets the
		// shape of the problem and no detail about our GitHub setup —
		// the same I11 posture the Python handlers hold.
		console.log(`[mcp] dispatch upstream ${res.status} for run ${runId}`);
		if (res.status === 401 || res.status === 403) {
			throw new ToolError("the render pipeline rejected our credentials — nothing was started");
		}
		throw new ToolError("couldn't start the render just now — nothing was charged. Try again shortly.");
	}

	const workflowUrl = `https://github.com/${owner}/${repo}/actions/workflows/${workflow}`;
	return `Started your creation.\n\nBrief: ${brief}\nRun id: ${runId}\n\n`
		+ `Poll it with status(runId="${runId}") — a full film takes 4-7 minutes.\n\n`
		+ `Track it in a browser:\n${workflowUrl}`;
}

// ── status ───────────────────────────────────────────────────────────

/** GET a JSON artefact, or null if it is not there yet.
 *
 *  A 404 is the NORMAL case — it means the pipeline has not written
 *  that file — so it collapses to null like any other failure. Callers
 *  distinguish states by which artefacts EXIST, never by an exception. */
async function fetchJson(url) {
	try {
		const res = await fetch(url, { headers: { Accept: "application/json" } });
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

async function status(args, ctx) {
	const runId = String(args.runId ?? "").trim();
	if (!runId) throw new ToolError("runId is required — the generate tool returns one");
	if (!RUN_ID_RE.test(runId)) throw new ToolError("that is not a run id this server would have issued");

	const result = await fetchJson(`${ctx.base}/runs/${runId}/result.json`);
	if (result) return renderResult(runId, result, ctx.base);

	const stage = await fetchJson(`${ctx.base}/runs/${runId}/status.json`);
	if (!stage) {
		return `Nothing yet for run ${runId}.\n\n`
			+ "Either the first stage has not written its artefact (the pipeline "
			+ "writes on stage completion, so a fresh run is briefly silent), or no "
			+ "run with that id was ever dispatched. If the generate tool returned "
			+ "this id within the last minute or so, it is the former — poll again.";
	}
	const at = stage.stage || stage.step || "running";
	return `Run ${runId} is still going.\n\nStage: ${at}\n\nA full film takes 4-7 minutes end to end.`;
}

function renderResult(runId, result, base) {
	if (result.error || result.ok === false) {
		return `Run ${runId} failed.\n\nThe run failed. Nothing was produced; dispatch a new one.`;
	}
	const lines = [`Run ${runId} is done.`, ""];
	const urls = Array.isArray(result.assets) ? result.assets
		: Array.isArray(result.videos) ? result.videos : [];
	for (const u of urls) lines.push(`  ${typeof u === "string" ? u : (u && u.url) || ""}`);
	if (!urls.length && result.url) lines.push(`  ${result.url}`);
	lines.push("", `Watch it: ${base}/watch/${runId}`);
	return lines.join("\n");
}

// ── publish ──────────────────────────────────────────────────────────

async function publish(args, ctx) {
	if (!mcpEnabled(ctx.env)) {
		throw new ToolError(
			"publishing isn't enabled on this server (set ROOT_SECRET, " +
			"or MCP_TOKEN to override just this one)",
		);
	}
	if (!ctx.env.SITES) {
		throw new ToolError("this deploy has no site storage bound — nothing was published");
	}

	const slug = validatedSlug(args.slug);
	const html = String(args.html ?? "");
	if (!html.toLowerCase().includes("</html>")) {
		throw new ToolError(
			"html must be a complete document — a fragment publishes as a " +
			"broken page, which is worse than not publishing",
		);
	}
	const body = new TextEncoder().encode(html);
	if (body.byteLength > MAX_SITE_BYTES) {
		throw new ToolError(
			`page is ${Math.floor(body.byteLength / 1024)}KB; the host accepts up to ` +
			`${MAX_SITE_BYTES / (1024 * 1024)}MB. Inline fewer assets.`,
		);
	}

	const key = `sites/${slug}/index.html`;

	// Default NO. An agent picks slugs from the brief, and two runs of
	// the same brief pick the SAME slug — so the safe default is to
	// refuse the second one rather than replace a live page. This guard
	// used to live in the site-host Worker behind the HTTP hop; removing
	// the hop means owning it here.
	const overwrite = args.overwrite === true;
	if (!overwrite && (await ctx.env.SITES.head(key))) {
		throw new ToolError(
			`${slug}.${PUBLISH_DOMAIN} already has a page. Pass overwrite: true to replace it — ` +
			"publishing over a live site has to be deliberate.",
		);
	}

	// History first. If the version write succeeds and the live write
	// fails, the worst case is an orphan version nobody reads; the other
	// order can replace a live page with no copy of what was there.
	if (overwrite) {
		const existing = await ctx.env.SITES.get(key);
		if (existing) {
			await ctx.env.SITES.put(`sites/${slug}/versions/${ctx.now()}.html`, await existing.arrayBuffer(), {
				httpMetadata: { contentType: "text/html; charset=utf-8" },
			});
		}
	}

	await ctx.env.SITES.put(key, body, { httpMetadata: { contentType: "text/html; charset=utf-8" } });

	return `Published to https://${slug}.${PUBLISH_DOMAIN}\n\n`
		+ (overwrite ? "The previous page was kept in version history.\n\n" : "")
		+ "It is live now — the edge serves it straight from storage, so there is no build to wait for.";
}

// ── registry ─────────────────────────────────────────────────────────

export const SCHEMAS = [
	{
		name: "capabilities",
		description: "What Ontold can make — formats, treatments, and camera moves. Call this first to learn the vocabulary.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "compose",
		description: "Compose an Ontold creation brief from an idea (and/or a template id + optional format/treatment/camera) and get a link to generate it in Ontold.",
		inputSchema: {
			type: "object",
			properties: {
				idea: { type: "string", description: "The core idea for the piece." },
				templateId: { type: "string", description: "An Ontold template id, if you already have one." },
				format: { type: "string", description: "e.g. film, image, slides, workbook, music-video." },
				treatment: { type: "string", description: "e.g. full-video, motion-cut, slideshow, still-set." },
				camera: { type: "string", description: "e.g. slow push-in, whip-pan cuts, product-ad chaos." },
			},
			additionalProperties: false,
		},
	},
	{
		name: "generate",
		description: "Start a real Ontold render from an idea (and/or template + optional format/treatment/camera) and get a link to track progress. Requires the server to have generation enabled.",
		inputSchema: {
			type: "object",
			properties: {
				idea: { type: "string", description: "The core idea for the piece." },
				templateId: { type: "string" },
				format: { type: "string" },
				treatment: { type: "string" },
				camera: { type: "string" },
				runId: { type: "string", description: "Your own correlation id (6-64 chars of [a-zA-Z0-9_-]). Omit and one is minted and returned." },
			},
			additionalProperties: false,
		},
	},
	{
		name: "status",
		description: "Check a render started by generate: which stage it's on, and the finished film once it lands. Poll this instead of asking a human to open the tracking link.",
		inputSchema: {
			type: "object",
			properties: { runId: { type: "string", description: "The run id the generate tool returned." } },
			required: ["runId"],
			additionalProperties: false,
		},
	},
	{
		name: "publish",
		description: "Put a self-contained HTML page live at <slug>.ontold.site. Requires the server to have publishing enabled.",
		inputSchema: {
			type: "object",
			properties: {
				slug: { type: "string", description: "Subdomain label the site lives on — lowercase letters, digits, hyphens." },
				html: { type: "string", description: "The complete HTML document. Self-contained: inline the CSS, no external requests." },
				overwrite: { type: "boolean", description: "Replace the page already live on this slug. Defaults to false — publishing over a live site must be deliberate." },
			},
			required: ["slug", "html"],
			additionalProperties: false,
		},
	},
	{
		name: "roster",
		description: "Ontold's resident cast — live-callable characters (face, voice, world) with links to meet each one.",
		inputSchema: { type: "object", properties: {}, additionalProperties: false },
	},
	{
		name: "mint_worker",
		description: "Embody an AI worker: give a business role (plus optional name/company/traits) and get a link that mints them in Ontold — persona, portrait, and a live-call page. Built for workforce platforms that want their agents to have a face.",
		inputSchema: {
			type: "object",
			properties: {
				role: { type: "string", description: "The job they hold — e.g. 'Head of Growth', 'Support lead'." },
				name: { type: "string", description: "Their name, if you've chosen one." },
				company: { type: "string", description: "The company they work for." },
				traits: { type: "string", description: "Personality / working-style notes to fold into the persona." },
				ref: { type: "string", description: "Opaque correlation id. When the mint link is opened from your app's tab, Ontold posts the minted character (id + portrait) back to the opener window tagged with this ref." },
			},
			required: ["role"],
			additionalProperties: false,
		},
	},
];

export const IMPLS = {
	capabilities: () => capabilitiesText(),
	compose: (args, ctx) => composeText(args, ctx.base),
	generate,
	status,
	publish,
	roster: (_args, ctx) => rosterText(ctx.base),
	mint_worker: (args, ctx) => mintWorkerText(args, ctx.base),
};

export const TOOLS = { schemas: SCHEMAS, impls: IMPLS };
