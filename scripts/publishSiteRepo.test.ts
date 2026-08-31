/**
 * The site's own repository, exercised against a stub GitHub.
 *
 * This test exists because of a specific lie. The first stub written
 * for this script always returned an empty tag list, so `[repo] tagged
 * v1` printed on every run and "versioning works" was reported twice
 * before anyone noticed that v2 could never happen. A stub that cannot
 * fail proves nothing — so this one records every request and the
 * assertions read what was actually sent.
 *
 * What it pins:
 *   - a fresh site repo is generated FROM the org site-template (the
 *     provenance banner), and the template itself is auto-created the
 *     first time anything needs it
 *   - the basics are populated: description, homepage, topics, template
 *   - the README a customer opens carries the assumptions the site made
 *     about their business, and the field that overrules each
 *   - a second publish tags v2, not v1 again
 *   - a missing token is a skip, not a failure: the site is already
 *     live on Cloudflare by the time this runs
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { readFileSync } from 'fs';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SCRIPT = join(__dirname, 'publish_site_repo.mjs');
/**
 * Async on purpose. The stub server lives in THIS process, so a
 * synchronous child (execFileSync) blocks the very event loop that has
 * to answer its requests: the script waits for a reply that cannot be
 * written until the script exits. It deadlocks in silence until the
 * test times out, and reads like a hung script rather than a hung test.
 */
const run = promisify(execFile);

interface Seen { method: string; path: string; body: any }

let server: Server;
let base = '';
let seen: Seen[] = [];
/** Repositories the stub is holding, by name. Tracking a single boolean
 *  here once made the template repo's creation flip the site repo into
 *  "exists" — repos have names, so the stub keys by them. */
let repos = new Map<string, { is_template?: boolean }>();
/** Files the stub is holding, keyed `${repo}/${path}`, so an update
 *  finds a sha like the real API does. */
let files = new Map<string, string>();
let tags: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const path = req.url || '';
      const body = raw ? JSON.parse(raw) : undefined;
      seen.push({ method: req.method || '', path, body });
      const send = (code: number, obj: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      if (path === '/user') return send(200, { login: 'stub-owner' });
      if (path.startsWith('/user/repos') && req.method === 'POST') {
        repos.set(body.name, { is_template: !!body.is_template });
        return send(201, { default_branch: 'main', private: body.private });
      }
      // Repo generation: copies the template's files, like the real API.
      const generate = path.match(/^\/repos\/[^/]+\/([^/]+)\/generate$/);
      if (generate && req.method === 'POST') {
        if (!repos.get(generate[1])?.is_template) return send(422, { message: 'not a template' });
        repos.set(body.name, {});
        for (const [key, content] of files) {
          const [repo, file] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)];
          if (repo === generate[1]) files.set(`${body.name}/${file}`, content);
        }
        return send(201, { default_branch: 'main' });
      }
      const contents = path.match(/^\/repos\/[^/]+\/([^/]+)\/contents\/([^?]+)/);
      if (contents) {
        const key = `${contents[1]}/${decodeURIComponent(contents[2])}`;
        if (req.method === 'PUT') {
          files.set(key, Buffer.from(body.content, 'base64').toString('utf8'));
          return send(200, { commit: { sha: 'deadbeef' } });
        }
        return files.has(key) ? send(200, { sha: `sha-${key}` }) : send(404, {});
      }
      if (path.includes('/git/ref/heads/')) return send(200, { object: { sha: 'headsha' } });
      if (path.endsWith('/topics') && req.method === 'PUT') return send(200, { names: body.names });
      if (path.includes('/tags')) return send(200, tags.map((t) => ({ name: t })));
      if (path.endsWith('/git/refs') && req.method === 'POST') {
        tags.push(String(body.ref).replace('refs/tags/', ''));
        return send(201, {});
      }
      // The repo lookup (GET) and the basics patch (PATCH), by name.
      // A PATCH carrying a different name is a rename, like the real API.
      const repo = path.match(/^\/repos\/[^/]+\/([^/]+)$/);
      if (repo) {
        const held = repos.get(repo[1]);
        if (!held) return send(404, {});
        if (req.method === 'PATCH') {
          if (body?.name && body.name !== repo[1]) {
            repos.set(body.name, held);
            repos.delete(repo[1]);
          }
          return send(200, body);
        }
        return send(200, { default_branch: 'main', is_template: !!held.is_template });
      }
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});

afterAll(() => server.close());

async function publish(extraEnv: Record<string, string> = {}, specOver: object | null = null) {
  const dir = mkdtempSync(join(tmpdir(), 'site-'));
  const page = join(dir, 'index.html');
  const spec = join(dir, 'site.spec.json');
  writeFileSync(page, '<!doctype html><html><body>hi</body></html>');
  writeFileSync(spec, JSON.stringify(specOver ?? {
    business: 'Test Training',
    proposition: 'Lessons that stick.',
    assumptions: [
      { id: 'no-phone', assumed: 'No phone number is shown.', because: 'you did not give one', field: 'contact.phone', basis: 'default' },
      { id: 'jurisdiction', assumed: 'Prices are in £.', because: 'the trade is local', field: 'jurisdiction.country', basis: 'inferred' },
    ],
  }));
  const { stdout, stderr } = await run('node', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_API_URL: base,
      SYSTEM_GITHUB_TOKEN: 'stub-token',
      GITHUB_ORG: '',
      SITE_REPO_OWNER: '',
      SLUG: 'testsite',
      PAGE: page,
      SPEC: spec,
      ...extraEnv,
    },
  });
  return stdout + stderr;
}

describe('publish_site_repo', () => {
  it('auto-creates the template, generates the site repo FROM it, and writes the files', async () => {
    const out = await publish();
    // Founder: "doesnt use our templates - ie work like lovable" — a
    // fresh site repo is stamped from the org scaffold so it carries
    // the "generated from …/site-template" banner.
    expect(out).toContain('created stub-owner/site-template (private template)');
    expect(out).toContain('created stub-owner/testsite-site from site-template (private)');
    const templated = seen.find((s) => s.path.endsWith('/site-template/generate') && s.method === 'POST');
    expect(templated?.body.private).toBe(true);
    expect(templated?.body.name).toBe('testsite-site');
    const madeTemplate = seen.find((s) => s.path.startsWith('/user/repos') && s.method === 'POST');
    expect(madeTemplate?.body.name).toBe('site-template');
    expect(madeTemplate?.body.is_template).toBe(true);
    expect(madeTemplate?.body.private).toBe(true);
    expect([...files.keys()].filter((k) => k.startsWith('testsite-site/')).sort())
      .toEqual([
        'testsite-site/README.md', 'testsite-site/badge-live.svg', 'testsite-site/badge-ontold.svg',
        'testsite-site/badge-version.svg', 'testsite-site/banner.svg', 'testsite-site/index.html',
        'testsite-site/site.spec.json',
      ]);
  });

  it('the repo arrives dressed: committed banner, self-made badges, a blurb', () => {
    // Founder: "just needs an ontold.com image and some blurb in
    // readme right. and some other gems like badges etc". All SVGs are
    // generated and COMMITTED — the README hotlinks nobody.
    const readme = files.get('testsite-site/README.md')!;
    expect(readme).toContain('![Test Training](banner.svg)');
    expect(readme).toContain('badge-live.svg');
    expect(readme).toContain('badge-version.svg');
    expect(readme).toContain('Test Training —');
    expect(readme).not.toContain('shields.io');
    const banner = files.get('testsite-site/banner.svg')!;
    expect(banner).toContain('MADE WITH ONTOLD');
    expect(banner).toContain('Test Training');
    expect(files.get('testsite-site/badge-version.svg')).toContain('>v1<');
  });

  it('populates the basics: description, homepage, topics, and the template flag', () => {
    // Founder, opening the first repo this script created: "basics not
    // populated. doesnt use our templates... also we aren't able to do
    // github classrooms yet". The PATCH runs on EVERY publish so
    // already-created bare repos get repaired, and is_template is the
    // Classroom prerequisite (assignments start from template repos).
    const patched = seen.find((s) => s.method === 'PATCH' && s.path.endsWith('/testsite-site'));
    // The description describes THE SITE, never our plumbing — founder:
    // "just needs to be description of the app". The live URL lives in
    // the homepage field; the file contract lives in the README.
    expect(patched?.body.description).toContain('Test Training');
    expect(patched?.body.description).not.toMatch(/index\.html|page as served|renders from/);
    expect(patched?.body.homepage).toBe('https://testsite.ontold.site');
    // A site repo is someone's site, not starter code: the template
    // flag is opt-in (SITE_IS_TEMPLATE=1), never the default.
    expect(patched?.body.is_template).toBe(false);
    const topics = seen.find((s) => s.method === 'PUT' && s.path.endsWith('/topics'));
    expect(topics?.body.names).toEqual(['ontold', 'generated-site', 'testsite']);
  });

  it('tells the owner what the site assumed, and which field changes it', () => {
    // The product half of "assumptions which can be replaced by the
    // user". A list of decisions with no field to change is a
    // disclaimer; with the field it is an instruction.
    const readme = files.get('testsite-site/README.md')!;
    // A working document, not a description: the vinext-starter shape
    // the founder pointed at — included shape, run, change, versions.
    for (const section of ['## Included Shape', '## Run It Locally', '## Making Changes', '## Versions']) {
      expect(readme).toContain(section);
    }
    expect(readme).not.toMatch(/cloudflare|liability/i);
    expect(readme).toContain('What this site assumed about you');
    expect(readme).toContain('No phone number is shown.');
    expect(readme).toContain('`contact.phone` in `site.spec.json`');
    // The ones nothing in the brief touched are marked, not blended in.
    expect(readme).toContain('**Nobody chose this.** No phone number is shown.');
    expect(readme).not.toContain('**Nobody chose this.** Prices are in £.');
  });

  it('tags v2 on the second publish, and does not re-create the template', async () => {
    expect(tags).toEqual(['v1']);
    const creates = seen.filter((s) => s.method === 'POST' && (s.path.startsWith('/user/repos') || s.path.endsWith('/generate'))).length;
    const out = await publish();
    expect(out).toContain('exists');
    expect(tags).toEqual(['v1', 'v2']);
    const createsAfter = seen.filter((s) => s.method === 'POST' && (s.path.startsWith('/user/repos') || s.path.endsWith('/generate'))).length;
    expect(createsAfter).toBe(creates);
  });

  it('recreates from the template when asked, archiving the old repo first', async () => {
    // A repo born before the template can never gain the provenance
    // banner in place. "recreate": true renames it aside and generates
    // a fresh one FROM the template. Nothing is deleted.
    const out = await publish({ SITE_RECREATE: '1' });
    expect(out).toContain('archived testsite-site → testsite-site-pre-template');
    expect(out).toContain('created stub-owner/testsite-site from site-template (private)');
    expect(repos.has('testsite-site-pre-template')).toBe(true);
    expect(repos.has('testsite-site')).toBe(true);
  });

  it('seed mode ensures both templates and touches no site repo', async () => {
    // README-only templates, the aistudio-repository-template pattern
    // the founder pointed at: the README is the contract, the banner
    // is the provenance, the generator pushes the real files later.
    const before = [...repos.keys()].filter((r) => r.endsWith('-site')).length;
    const { stdout: out } = await run('node', [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env, GITHUB_API_URL: base, SYSTEM_GITHUB_TOKEN: 'stub-token',
        GITHUB_ORG: '', SITE_REPO_OWNER: '', SLUG: '', PAGE: '', SPEC: '',
        SEED_TEMPLATES: '1',
      },
    });
    expect(out).toContain('templates ensured');
    expect(repos.has('site-template')).toBe(true);
    expect(repos.has('app-template')).toBe(true);
    // The contract describes the SHAPE; the stack is an implementation
    // detail that lives in the generated package.json where it is
    // unavoidable. No third-party names in our repos' front matter —
    // founder: "why would you write a third party stuff into our git".
    const tpl = files.get('app-template/README.md')!;
    expect(tpl).toContain('app.spec.json');
    expect(tpl).not.toMatch(/vinext|cloudflare|vercel|next\.js/i);
    expect([...repos.keys()].filter((r) => r.endsWith('-site')).length).toBe(before);
  });

  it('skips without a token rather than failing the run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'site-'));
    const page = join(dir, 'index.html');
    writeFileSync(page, '<!doctype html>');
    const { stdout: out } = await run('node', [SCRIPT], {
      encoding: 'utf8',
      env: {
        ...process.env, GITHUB_API_URL: base, SLUG: 'x', PAGE: page, SPEC: '',
        SYSTEM_GITHUB_TOKEN: '', SITE_REPO_TOKEN: '', GH_PAT: '', GITHUB_PAT: '', GH_TOKEN: '',
      },
    });
    expect(out).toContain('no repo-creating token');
  });
});

// ── A real spec declares no assumptions ─────────────────────────────
//
// The fixture above hands the script a spec with `assumptions` already
// written in, so it passed whether or not anything derived them. Real
// specs declare NONE — data/sites/lorrybus.spec.json has zero — and
// every genuine assumption is computed from what the spec says. So the
// owner's README carried an empty section while the generator knew
// four things it had decided for them.
// SKIPPED ON EXTRACTION: this suite bundles scaffolding/renderEntry.ts —
// ontold's site renderer (trade sites, debates, wizard), which is app code
// and not part of this repo's Cloudflare surface. publish_site_repo.mjs
// itself treats that bundle as OPTIONAL at runtime: with no renderer it
// warns and publishes a README carrying only declared assumptions, so
// nothing this repo runs depends on it. Re-enable by vendoring
// scaffolding/ or pointing esbuild at the source repo.
describe.skip('the assumptions a real spec does not declare', () => {
  // The renderer bundle is what derives them, and only generate-site
  // builds it. Depending on one lying around is how these two tests
  // passed here and failed in CI — so build it.
  const BUNDLE = join(mkdtempSync(join(tmpdir(), 'render-')), 'render.mjs');
  beforeAll(async () => {
    await run('npx', ['esbuild', 'scaffolding/renderEntry.ts', '--bundle',
                      '--platform=node', '--format=esm', `--outfile=${BUNDLE}`],
              { encoding: 'utf8' });
  }, 60_000);

  const REAL_SHAPE = {
    business: 'Test Training',
    proposition: 'Lessons that stick.',
    jurisdiction: { country: 'GB', regulator: 'DVSA' },
    provenance: { verified: 'July 2026' },
    pathways: [{
      slug: 'lorry-ce', name: 'Lorry and trailer', summary: 'The artic licence.',
      steps: [{ order: 1, title: 'Medical', fees: [] }],
      outcomes: [{ jobTitle: 'Class 1 driver' }],
    }],
    // No `assumptions` key at all — the real case.
  };

  it('names them anyway, derived from the spec', async () => {
    const out = await publish({ RENDERER_PATH: BUNDLE }, REAL_SHAPE);
    expect(out).toContain('testsite-site');
    // The stub already decodes; reading it as base64 again was my bug.
    const readme = files.get('testsite-site/README.md')!;
    expect(readme).toContain('What this site assumed about you');
    // The ones assumptionsFor derives for a spec of this shape.
    expect(readme).toContain('No phone number is shown.');
    expect(readme).toContain('**Nobody chose this.**');
    expect(readme).toContain('contact.phone');
  });

  it('still says which field overrules each', async () => {
    await publish({ RENDERER_PATH: BUNDLE }, REAL_SHAPE);
    const readme = files.get('testsite-site/README.md')!;
    expect(readme).toContain('site.spec.json');
    expect(readme).toMatch(/Because .+\. Change it:/);
  });
});

// ── A warning nobody can act on is one everybody scrolls past ───────
//
// The league page publishes with SPEC= (empty) — it has no owner spec
// and therefore no assumptions. Warning about a missing renderer
// bundle on IMPORT made that healthy run shout about a section it does
// not have. The real lorrybus run did exactly this.
describe('the missing-bundle warning', () => {
  it('stays quiet for a page published without a spec', async () => {
    const out = await publish({ SPEC: '', RENDERER_PATH: '/nope/render.mjs' });
    expect(out).not.toContain('no renderer bundle');
  });

  it('says so when there IS a spec whose assumptions would be lost', async () => {
    // The case worth shouting about: a real spec, and nothing to
    // derive its assumptions with.
    const out = await publish({ RENDERER_PATH: '/nope/render.mjs' },
                              { business: 'T', proposition: 'P' });
    expect(out).toContain('no renderer bundle');
  });
});

describe('the media a slug is made of', () => {
  // The lane shipped index.html and left the source media behind in
  // ontold, so the app's repo accumulated everybody's generations while
  // the slug's repo held a page whose pictures existed nowhere in it.
  const SRC = readFileSync(join(__dirname, 'publish_site_repo.mjs'), 'utf8');

  it('encodes a repo path per segment, so a directory stays a directory', () => {
    // encodeURIComponent on the WHOLE path gives 'media%2Fa.webp' —
    // one oddly-named file at the root. Nothing published was nested
    // until media arrived, so nothing had caught it.
    expect(SRC).toMatch(/function encodePath/);
    expect(SRC).not.toMatch(/contents\/\$\{encodeURIComponent\(path\)\}/);
    expect(encodeURIComponent('media/a.webp')).toContain('%2F');
  });

  it('declares encodePath as a hoisted function, not a const', () => {
    // putFile is hoisted and runs during module top-level via the
    // template seed. A const here sat in the temporal dead zone, threw
    // ReferenceError, and putFile's caller .catch()es it — so the
    // template README silently never got written.
    expect(SRC).toMatch(/^function encodePath/m);
    expect(SRC).not.toMatch(/const encodePath\s*=/);
  });

  it('passes Buffers through instead of re-encoding them as text', () => {
    // A webp read as utf8 and re-encoded uploads happily and is corrupt.
    expect(SRC).toContain('Buffer.isBuffer(content)');
  });

  it('warns on a missing still rather than losing the page', () => {
    expect(SRC).toMatch(/could not publish/);
  });

  // REMOVED ON EXTRACTION: 'the debate lane hands each slug only its own
  // media' asserted against .github/workflows/generate-debate.yml, an
  // ontold *content* workflow that generates debate footage. That lane is
  // not Cloudflare automation and does not live in this repo, so the
  // assertion could only ever fail here. It still guards the real thing in
  // the source repo, which is where generate-debate.yml is maintained —
  // this is a scope boundary, not a relaxed invariant. Everything above
  // covers publish_site_repo.mjs itself, which deploy-site-host.yml calls.
});
