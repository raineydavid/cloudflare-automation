/**
 * The contract this port had to preserve.
 *
 * `api/test_mcp.py` and `api/test_mcp_loop.py` describe how the Vercel
 * surface behaves in 78 assertions. Moving to the edge is only safe if
 * that behaviour comes with it, so the load-bearing ones are here —
 * particularly the refusals, which are the part a port quietly loses:
 * a tool that used to say no and now says yes fails silently and costs
 * money or publishes over a live page.
 *
 * The R2 binding is faked rather than mocked away. A fake that stores
 * bytes in a Map exercises the real key layout and the real overwrite
 * check; a mock that records calls would pass whatever the code did.
 */

import { describe, it, expect } from 'vitest';
import { handle, handleBody, SERVER_INFO, COST_BEARING_TOOLS } from './src/protocol.mjs';
import { TOOLS, SCHEMAS, mcpEnabled } from './src/tools.mjs';
import { buildBrief, composeText, mintWorkerText, newRunId, ToolError } from './src/brief.mjs';
import { ROSTER, capabilitiesText, rosterText } from './src/vocabulary.mjs';

const BASE = 'https://ontold.com';

/** An R2 bucket that actually stores things. */
function fakeR2(seed = {}) {
	const store = new Map(Object.entries(seed));
	return {
		store,
		async head(k) { return store.has(k) ? { key: k } : null; },
		async get(k) {
			if (!store.has(k)) return null;
			const v = store.get(k);
			return { async arrayBuffer() { return new TextEncoder().encode(v).buffer; } };
		},
		async put(k, v) {
			store.set(k, typeof v === 'string' ? v : new TextDecoder().decode(v));
		},
	};
}

const ctx = (over = {}) => ({
	base: BASE,
	env: {},
	caller: 'test',
	tools: TOOLS,
	now: () => 1_700_000_000_000,
	generationAllowed: async () => true,
	...over,
});

const req = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });
const call = (name, args) => req('tools/call', { name, arguments: args });
const textOf = (r) => r.result.content[0].text;

describe('protocol', () => {
	it('initialize echoes the client protocol version', async () => {
		const r = await handle(req('initialize', { protocolVersion: '2024-11-05' }), ctx());
		expect(r.result.protocolVersion).toBe('2024-11-05');
		expect(r.result.serverInfo).toEqual(SERVER_INFO);
	});

	it('a notification gets no response at all', async () => {
		// No `id` key — distinct from id:null, which IS a request.
		expect(await handle({ jsonrpc: '2.0', method: 'initialized' }, ctx())).toBeNull();
		expect(await handle({ jsonrpc: '2.0', id: null, method: 'ping' }, ctx())).not.toBeNull();
	});

	it('a body of only notifications is 202 with no body', async () => {
		const { status, body } = await handleBody(JSON.stringify([{ jsonrpc: '2.0', method: 'x' }]), ctx());
		expect(status).toBe(202);
		expect(body).toBeNull();
	});

	it('malformed JSON is a parse error, not a crash', async () => {
		const { status, body } = await handleBody('{oh no', ctx());
		expect(status).toBe(200);
		expect(JSON.parse(body).error.code).toBe(-32700);
	});

	it('rejects anything that is not jsonrpc 2.0', async () => {
		expect((await handle({ id: 1, method: 'ping' }, ctx())).error.code).toBe(-32600);
		expect((await handle('nope', ctx())).error.code).toBe(-32600);
	});

	it('an unknown method and an unknown tool report differently', async () => {
		expect((await handle(req('tools/nope'), ctx())).error.code).toBe(-32601);
		expect((await handle(call('nope', {}), ctx())).error.code).toBe(-32602);
	});

	it('answers the WorkAIs health probe without letting it shadow a real request', async () => {
		const probe = await handleBody(JSON.stringify({ ping: true }), ctx());
		expect(JSON.parse(probe.body)).toEqual({ ok: true, server: SERVER_INFO });
		// A real JSON-RPC ping must still take the protocol path.
		const real = await handleBody(JSON.stringify(req('ping', {})), ctx());
		expect(JSON.parse(real.body).result).toEqual({});
	});

	it('a batch answers each request', async () => {
		const { body } = await handleBody(JSON.stringify([req('ping', {}, 1), req('tools/list', {}, 2)]), ctx());
		expect(JSON.parse(body).map((r) => r.id)).toEqual([1, 2]);
	});
});

describe('the IP boundary', () => {
	it('exposes no way to enumerate the template catalogue', async () => {
		const names = new Set(SCHEMAS.map((t) => t.name));
		expect(names.has('list_templates')).toBe(false);
		// Nor a resource or description that hands the lineup over.
		expect(JSON.stringify(SCHEMAS)).not.toMatch(/list.?templates/i);
	});

	it('passes a templateId through without validating it', async () => {
		// Validating would make this a probing oracle: valid/invalid
		// answers enumerate the catalogue one guess at a time.
		const out = textOf(await handle(call('compose', { templateId: 'tpl-does-not-exist' }), ctx()));
		expect(out).toContain('tpl-does-not-exist');
	});

	it('no tool name repeats the server name', async () => {
		// The host namespaces by server; ontold_compose would render as
		// mcp__ontold__ontold_compose.
		for (const t of SCHEMAS) expect(t.name.toLowerCase().startsWith(SERVER_INFO.name)).toBe(false);
		expect(SERVER_INFO.name).toBeTruthy();
	});

	it('has no post tool', async () => {
		expect(SCHEMAS.map((t) => t.name)).not.toContain('post');
	});
});

describe('brief composition', () => {
	it('refuses a brief made of nothing', () => {
		expect(() => buildBrief({})).toThrow(ToolError);
	});

	it('brackets the qualifiers ahead of the idea', () => {
		expect(buildBrief({ idea: 'a lighthouse', format: 'film', camera: 'slow push-in' }))
			.toBe('[Format: film | Camera: slow push-in] a lighthouse');
	});

	it('a template alone is a valid brief', () => {
		expect(buildBrief({ templateId: 'tpl-7' })).toBe('[Template: tpl-7]');
	});

	it('the compose link round-trips the brief', () => {
		const brief = 'a lighthouse / at dusk & alone';
		const out = composeText({ idea: brief }, BASE);
		const encoded = out.split('?compose=')[1];
		expect(decodeURIComponent(encoded)).toBe(brief);
	});

	it('a minted run id fits run.py grammar', () => {
		expect(newRunId()).toMatch(/^mcp-[0-9a-f]{16}$/);
	});
});

describe('mint_worker', () => {
	it('requires a role', () => {
		expect(() => mintWorkerText({}, BASE)).toThrow(ToolError);
	});

	it('folds company and traits into one persona and round-trips it', () => {
		const out = mintWorkerText({ role: 'Head of Growth', company: 'Acme', traits: 'blunt' }, BASE);
		const persona = decodeURIComponent(out.split('?mint=')[1].split('&')[0].split('\n')[0]);
		expect(persona).toContain('Head of Growth at Acme.');
		expect(persona).toContain('blunt.');
	});

	it('carries the correlation ref so the opener can match the result', () => {
		expect(mintWorkerText({ role: 'x', ref: 'r-42' }, BASE)).toContain('mintRef=r-42');
	});
});

describe('roster', () => {
	it('gives every character a live-call link', () => {
		const out = rosterText(BASE);
		for (const c of ROSTER) expect(out).toContain(`${BASE}/character/${c.id}`);
	});

	it('names the vocabulary the capabilities tool teaches', () => {
		expect(capabilitiesText()).toContain('motion-cut');
	});
});

describe('generate — the tool that spends', () => {
	it('is the only cost-bearing tool', () => {
		expect([...COST_BEARING_TOOLS]).toEqual(['generate']);
	});

	it('refuses when the server has generation switched off', async () => {
		const r = await handle(call('generate', { idea: 'x' }), ctx());
		expect(r.result.isError).toBe(true);
		expect(textOf(r)).toContain("isn't enabled");
	});

	it('refuses a runId the pipeline could never poll', async () => {
		const r = await handle(call('generate', { idea: 'x', runId: 'no' }),
			ctx({ env: { MCP_TOKEN: 't', GH_PAT: 'p' } }));
		expect(r.result.isError).toBe(true);
		expect(textOf(r)).toContain('6-64');
	});

	it('refuses when the spend window says no, without calling GitHub', async () => {
		let called = false;
		const spy = globalThis.fetch;
		globalThis.fetch = async () => { called = true; return new Response('{}'); };
		try {
			const r = await handle(call('generate', { idea: 'x' }),
				ctx({ env: { MCP_TOKEN: 't', GH_PAT: 'p' }, generationAllowed: async () => false }));
			expect(r.result.isError).toBe(true);
			expect(textOf(r)).toContain('rate limit');
			expect(called).toBe(false);
		} finally { globalThis.fetch = spy; }
	});

	it('does not forward GitHub failure detail to the caller', async () => {
		const spy = globalThis.fetch;
		globalThis.fetch = async () => new Response('{"message":"Bad credentials for tok_secret"}', { status: 401 });
		try {
			const r = await handle(call('generate', { idea: 'x' }),
				ctx({ env: { MCP_TOKEN: 't', GH_PAT: 'p' } }));
			expect(r.result.isError).toBe(true);
			expect(textOf(r)).not.toContain('tok_secret');
			expect(textOf(r)).toContain('nothing was started');
		} finally { globalThis.fetch = spy; }
	});
});

describe('publish — the tool that writes to the internet', () => {
	const enabled = (sites) => ctx({ env: { MCP_TOKEN: 't', SITES: sites } });
	const page = '<html><body>hi</body></html>';

	it('refuses when publishing is switched off', async () => {
		const r = await handle(call('publish', { slug: 'a', html: page }), ctx());
		expect(r.result.isError).toBe(true);
	});

	it('refuses the reserved front-door slugs', async () => {
		// `mcp` is reserved for this Worker's own route, which beats
		// site-host's wildcard — a page published there would sit in R2
		// and never be served.
		for (const slug of ['__root', 'www', 'mcp']) {
			const r = await handle(call('publish', { slug, html: page }), enabled(fakeR2()));
			expect(r.result.isError, slug).toBe(true);
			expect(textOf(r)).toContain('reserved');
		}
	});

	it('refuses a slug the site host could never serve', async () => {
		for (const slug of ['has.dot', '-lead', 'UPPER!', '']) {
			const r = await handle(call('publish', { slug, html: page }), enabled(fakeR2()));
			expect(r.result.isError, slug).toBe(true);
		}
	});

	it('refuses a fragment, which would publish as a broken page', async () => {
		const r = await handle(call('publish', { slug: 'ok', html: '<div>hi</div>' }), enabled(fakeR2()));
		expect(r.result.isError).toBe(true);
		expect(textOf(r)).toContain('complete document');
	});

	it('writes the page at the key site-host reads', async () => {
		const sites = fakeR2();
		const r = await handle(call('publish', { slug: 'bakery', html: page }), enabled(sites));
		expect(r.result.isError).toBeUndefined();
		expect(sites.store.get('sites/bakery/index.html')).toBe(page);
	});

	it('will not replace a live page unless told to', async () => {
		const sites = fakeR2({ 'sites/bakery/index.html': '<html>original</html>' });
		const r = await handle(call('publish', { slug: 'bakery', html: page }), enabled(sites));
		expect(r.result.isError).toBe(true);
		expect(textOf(r)).toContain('overwrite');
		// And the live page is untouched.
		expect(sites.store.get('sites/bakery/index.html')).toBe('<html>original</html>');
	});

	it('keeps the replaced page in version history', async () => {
		const sites = fakeR2({ 'sites/bakery/index.html': '<html>original</html>' });
		await handle(call('publish', { slug: 'bakery', html: page, overwrite: true }), enabled(sites));
		expect(sites.store.get('sites/bakery/index.html')).toBe(page);
		const versions = [...sites.store.keys()].filter((k) => k.includes('/versions/'));
		expect(versions).toHaveLength(1);
		expect(sites.store.get(versions[0])).toBe('<html>original</html>');
	});

	it('refuses a page too large for the host', async () => {
		const huge = `<html>${'x'.repeat(6 * 1024 * 1024)}</html>`;
		const r = await handle(call('publish', { slug: 'big', html: huge }), enabled(fakeR2()));
		expect(r.result.isError).toBe(true);
		expect(textOf(r)).toContain('Inline fewer assets');
	});
});

describe('status', () => {
	it('requires a run id and rejects one it could not have issued', async () => {
		expect((await handle(call('status', {}), ctx())).result.isError).toBe(true);
		expect((await handle(call('status', { runId: '../etc' }), ctx())).result.isError).toBe(true);
	});

	it('says "not yet" rather than "failed" when no artefact exists', async () => {
		const spy = globalThis.fetch;
		globalThis.fetch = async () => new Response('', { status: 404 });
		try {
			const out = textOf(await handle(call('status', { runId: 'mcp-abc123' }), ctx()));
			expect(out).toContain('Nothing yet');
			expect(out).not.toMatch(/failed/i);
		} finally { globalThis.fetch = spy; }
	});
});

describe('failures on our side stay on our side', () => {
	it('an unexpected throw is not forwarded to the caller', async () => {
		const boom = { schemas: SCHEMAS, impls: { ...TOOLS.impls,
			capabilities: () => { throw new Error('connect ECONNREFUSED 10.0.0.7:5432'); } } };
		const r = await handle(call('capabilities', {}), ctx({ tools: boom }));
		expect(r.result.isError).toBe(true);
		expect(textOf(r)).not.toContain('10.0.0.7');
		expect(textOf(r)).toContain('Nothing was charged');
	});
});

describe('enablement', () => {
	it('derives from the root secret when no per-tool token is set', () => {
		expect(mcpEnabled({})).toBe(false);
		expect(mcpEnabled({ ROOT_SECRET: 'r' })).toBe(true);
		expect(mcpEnabled({ MCP_TOKEN: 't' })).toBe(true);
	});
});
