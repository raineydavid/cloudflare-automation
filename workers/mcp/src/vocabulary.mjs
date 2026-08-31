/**
 * Public product vocabulary and the resident cast.
 *
 * Everything in this file is SAFE TO EXPOSE and that is the whole point
 * of it being a file. Ported verbatim from `api/_mcp.py`, which carries
 * the IP boundary the founder drew on 2026-07-11: the MCP surface does
 * not enumerate the template catalogue, because listing all 111
 * template ids in one call hands a competitor the product lineup. What
 * lives here instead is vocabulary — formats, treatments, camera tiers
 * — plus cast names that already appear on the public home wall.
 *
 * If you are adding something to this file, the test is: would you mind
 * a competitor reading it? Template wording, prompt fragments and the
 * supplier catalogue all fail that test and belong nowhere near a
 * Worker, which serves whatever it holds to anyone who asks.
 */

export const FORMATS = [
	"film", "image", "slides", "workbook", "podcast", "comic",
	"poster", "website", "music-video",
];

export const TREATMENTS = {
	"full-video": "Every frame generated — continuous motion (premium).",
	"motion-cut": "A few stills cut on the beat — video energy at image prices.",
	"slideshow": "Stills with slow zooms over an audio bed (cheapest motion).",
	"still-set": "A coordinated set of images — carousel-ready, no motion.",
};

export const CAMERA = {
	basic: "push-in, pull-back, pan, tilt, orbit, handheld, tracking",
	intermediate: "dolly zoom, crane, whip-pan cuts, speed ramping, match cuts, FPV drone",
	advanced: "product-ad chaos, morph transitions, parallax layers, echo trails, glitch, bullet time",
};

/**
 * Public surface ONLY. These names/roles/ids already appear on the home
 * wall and on /character/<id> routes, so listing them leaks nothing —
 * unlike the template catalogue.
 *
 * Parity with data/characters.ts INITIAL_CHARACTERS is pinned by a
 * test, because an id listed here that the app cannot route to is a
 * broken hire link, and the person who finds it is a caller who trusted
 * us enough to try.
 */
export const ROSTER = [
	{ id: "cast-rex", name: "Rex", role: "co-founder of Ontold — product & technology",
	  note: "pitches the deck live, takes investor Q&A" },
	{ id: "cast-lorna", name: "Lorna", role: "poet, the studio's resident host",
	  note: "readings, commissions, workshopping your lines" },
	{ id: "cast-devin", name: "Devin", role: "romantic lead from the third-date films", note: "" },
	{ id: "cast-mara", name: "Mara", role: "romantic lead from the third-date films", note: "" },
	{ id: "cast-mira", name: "Mira", role: "station engineer from the orbital romance", note: "" },
	{ id: "cast-eli", name: "Eli", role: "the nervous romantic from the orbital romance", note: "" },
];

export function capabilitiesText() {
	const lines = [
		"Ontold turns a short brief into finished social-ready content.",
		"",
		`Formats: ${FORMATS.join(", ")}.`,
		"",
		"Treatments (how it's produced — pick for platform + budget):",
	];
	for (const [k, v] of Object.entries(TREATMENTS)) lines.push(`  - ${k}: ${v}`);
	lines.push("", "Camera moves, by tier:");
	for (const [k, v] of Object.entries(CAMERA)) lines.push(`  - ${k}: ${v}`);
	lines.push("", "Compose a brief with compose and start a render with generate.");
	return lines.join("\n");
}

export function rosterText(base) {
	const lines = [
		"Ontold's resident cast — live-callable characters, each with a face, voice, and world:",
		"",
	];
	for (const c of ROSTER) {
		const note = c.note ? ` (${c.note})` : "";
		lines.push(`  - ${c.name} — ${c.role}${note}. Meet live: ${base}/character/${c.id}`);
	}
	lines.push(
		"",
		"To EMBODY A NEW WORKER for a business role — a face, voice, and persona minted by the",
		"Ontold character engine — call mint_worker with the role.",
	);
	return lines.join("\n");
}
