#!/usr/bin/env node
/**
 * Publish a generated site to its OWN git repository.
 *
 * Founder: *"not this repos git, but in its own git - thats how the UI
 * works"*, and tonight: *"we need to deploy to github"*.
 *
 * WHY GIT AND NOT JUST THE BUCKET. The Cloudflare Worker serves
 * <slug>.ontold.site from R2 and keeps old pages as versions, which is
 * enough to serve and not enough to OWN. A repo is the thing a customer
 * can be handed: a diffable history of every change to their own site,
 * a place their domain settings and their spec live, and something that
 * survives us. expert-station already works this way — its
 * api/_handlers/publish.js commits to main and tags v1/v2/v3 — and
 * Ontold had none of it.
 *
 * The site keeps being SERVED from Cloudflare. Git is the record;
 * *.ontold.site is the address. That split is deliberate: Cloudflare's
 * wildcard certificate covers a new subdomain instantly, and GitHub
 * Pages would need a DNS record and a certificate per site before
 * anyone could look at it.
 *
 * WHAT IT COMMITS, and why each one:
 *   index.html   — the page itself, so the repo is the site
 *   site.spec.json — the source it was rendered from. Without this the
 *                    repo holds an artefact nobody can regenerate, which
 *                    is the thing this whole architecture exists to avoid
 *   README.md    — what it is, what made it, how to change it
 *
 * Photographs stay out. They are hundreds of kilobytes of base64 inside
 * index.html already; committing the cache as well would double a repo
 * for no gain.
 *
 *   SLUG=lorrybus PAGE=build/sites/lorrybus.html \
 *   SPEC=data/sites/lorrybus.spec.json node scripts/publish_site_repo.mjs
 *
 * Needs a token that can CREATE repositories — Administration: write on
 * a fine-grained token, or classic `repo`. The GH_PAT this project
 * already holds is scoped "Actions: Read & Write on this repo only"
 * (README, Tier 3), which dispatches workflows and cannot do this. It
 * exits 0 without one, because a site that published to Cloudflare and
 * failed to reach git is still a live site.
 */

import { readFileSync } from 'fs';
import { resolve, basename } from 'path';

// The DERIVED assumptions, from the same module the generator uses.
// Reading spec.assumptions alone showed the owner nothing: a spec
// declares none, and every real assumption is computed from what the
// spec actually says. Absent bundle = the declared ones only, which is
// what this did before.
let assumptionsFor = null;
const RENDERER = resolve(process.env.RENDERER_PATH || 'build/render.mjs');
try {
  ({ assumptionsFor } = await import(`file://${RENDERER}`));
} catch {
  // Warned about at the point of USE, not here. The league page
  // publishes with no spec at all, and warning on the import made a
  // real run shout about a section that case does not have — a
  // warning nobody can act on is one everybody learns to scroll past.
  assumptionsFor = null;
}

const SLUG = (process.env.SLUG || '').trim().toLowerCase();
const PAGE = (process.env.PAGE || '').trim();
const SPEC = (process.env.SPEC || '').trim();
const OWNER = (process.env.GITHUB_ORG || process.env.SITE_REPO_OWNER || '').trim();
/** Every name a repo-creating token might arrive under, most specific
 *  first. SYSTEM_GITHUB_TOKEN is what expert-station calls it. */
const TOKEN = ['SYSTEM_GITHUB_TOKEN', 'SITE_REPO_TOKEN', 'GH_PAT', 'GITHUB_PAT', 'GH_TOKEN']
  .map((n) => (process.env[n] || '').trim()).find(Boolean) || '';
/** A prefix keeps a customer's site repo from colliding with a name
 *  they already use for something else. */
const NAME = process.env.SITE_REPO_NAME || `${SLUG}-site`;
/** The org scaffold every new site repo is generated FROM, so each one
 *  carries a "generated from …/site-template" provenance banner — the
 *  Lovable-shaped move the founder asked for ("doesnt use our
 *  templates"). Auto-created on first need; override to use another. */
const TEMPLATE = process.env.SITE_TEMPLATE_REPO || 'site-template';
// GITHUB_API_URL is what Actions already sets, so this works unchanged
// on GitHub Enterprise — and lets the whole path be exercised against a
// stub, which is the only way to test this without a token that can
// create repositories.
const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');

/** Templates-only mode: ensure the org scaffolds exist and stop —
 *  touches no site repo. Asked for via SEED_TEMPLATES=1. */
const SEED_ONLY = process.env.SEED_TEMPLATES === '1';

if ((!SLUG || !PAGE) && !SEED_ONLY) {
  console.error('[repo] SLUG and PAGE are required');
  process.exit(1);
}
if (!TOKEN) {
  console.log('[repo] no repo-creating token — skipping. The site is published and served either way.');
  console.log('[repo] set SYSTEM_GITHUB_TOKEN (Administration: write) to give this site its own git.');
  process.exit(0);
}

async function gh(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      'x-github-api-version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  return { ok: res.ok, status: res.status, body };
}

/** Who the repo belongs to. An org if one is configured, otherwise the
 *  authenticated user — asked rather than assumed, because guessing the
 *  owner is how a site lands in the wrong account. */
async function owner() {
  if (OWNER) return OWNER;
  const me = await gh('/user');
  if (!me.ok) throw new Error(`cannot identify the token's owner (${me.status})`);
  return me.body.login;
}

/**
 * The repo's front matter: description, homepage, topics, template flag.
 *
 * Founder, on opening the first created repo: "basics not populated" —
 * a repo with an empty description and no website link reads as a
 * dump, not a product. These are the fields the org page and search
 * actually show, so they are part of the record, not decoration.
 *
 * The template flag is opt-in per publish (SITE_IS_TEMPLATE=1) for
 * repos deliberately offered as Classroom starters — Classroom
 * assignments can only start from template-flagged repositories. It
 * is never the default: a site repo is someone's site.
 */
function basicsFor(specJson) {
  // The description is about THE SITE, never about our plumbing —
  // founder, reading the first one: "why would you write stuff like
  // this... just needs to be description of the app." The contract
  // (index.html / site.spec.json) already lives in the README, which
  // is where a developer looks; the description is what everyone else
  // reads. The homepage field carries the live URL.
  let business = '';
  let proposition = '';
  try {
    const s = JSON.parse(specJson);
    business = String(s.business || '');
    proposition = typeof s.proposition === 'string' ? s.proposition : String(s.proposition?.headline || '');
  } catch { /* spec optional */ }
  const description = (
    (process.env.SITE_DESCRIPTION || '').trim()
    || [business, proposition].filter(Boolean).join(' — ')
    || `The ${SLUG} site.`
  ).slice(0, 350);
  const topic = SLUG.replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '').slice(0, 35);
  return {
    description,
    homepage: `https://${SLUG}.ontold.site`,
    // OPT-IN, default off — founder: "why is the likeness site also
    // published as a template?" A site repo is someone's site, not
    // starter code. Only repos deliberately offered as Classroom /
    // use-this-template starters set SITE_IS_TEMPLATE=1; the org's
    // site-template scaffold keeps its own flag separately.
    is_template: process.env.SITE_IS_TEMPLATE === '1',
    topics: ['ontold', 'generated-site', ...(topic ? [topic] : [])],
  };
}

/** Idempotent, and runs on EVERY publish — so a repo created before
 *  this existed gets its front matter on the next publish rather than
 *  staying bare forever. A failure here warns and moves on: the files
 *  and the tag matter more than the blurb. */
async function ensureBasics(who, specJson) {
  const { topics, ...fields } = basicsFor(specJson);
  const patched = await gh(`/repos/${who}/${NAME}`, { method: 'PATCH', body: JSON.stringify(fields) });
  if (!patched.ok) console.log(`::warning::${NAME}: could not set description/homepage/template (${patched.status})`);
  const topped = await gh(`/repos/${who}/${NAME}/topics`, { method: 'PUT', body: JSON.stringify({ names: topics }) });
  if (!topped.ok) console.log(`::warning::${NAME}: could not set topics (${topped.status})`);
  if (patched.ok && topped.ok) console.log(`[repo] basics set: description, homepage, topics [${topics.join(', ')}]${fields.is_template ? ', template' : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The second scaffold: full-stack app repos (the non-fun lane). */
const APP_TEMPLATE = process.env.APP_TEMPLATE_REPO || 'app-template';

/**
 * Template repos are README-only, the way the founder's reference
 * templates work ("thats how google gemini template works - just the
 * readme"): the README is the contract, the banner is the provenance,
 * and the generator pushes the real files at creation.
 */
const TEMPLATE_DEFS = {
  [TEMPLATE]: {
    description: 'The scaffold every generated site repository starts from.',
    commit: 'The contract every site repo follows',
    readme: (who, name) => `# ${name}

The scaffold every generated site repository is stamped from — which is
why site repos say "generated from ${who}/${name}".

Every site repo holds the same three files:

- \`index.html\` — the page as served. Generated, never hand-edited.
- \`site.spec.json\` — the source the page renders from. The file to change.
- \`README.md\` — what the site assumed, and which field overrules each assumption.
`,
  },
  [APP_TEMPLATE]: {
    description: 'The scaffold every generated full-stack app starts from.',
    commit: 'The contract every app repo follows',
    readme: (who, name) => `# ${name}

The scaffold every generated full-stack app repository is stamped from —
which is why app repos say "generated from ${who}/${name}".

Every app repo shares one shape:

- \`app/\` — the application source: pages, layout, styles. The code to change.
- \`app.spec.json\` — the source of record the app was generated from.
- \`db/\` — the database schema and bindings, empty until the app needs one.
- \`package.json\` — \`dev\`, \`build\`, \`start\` and \`test\` scripts.

Generated apps are runnable: \`npm install && npm run dev\`.
`,
  },
};

/**
 * The scaffold a repo is stamped from. Auto-created (private,
 * template-flagged, seeded with its contract README) the first time
 * anything needs it, so nobody has to remember a setup step. Returns
 * true when the template is there and usable.
 */
async function ensureTemplateRepo(who, name = TEMPLATE) {
  const def = TEMPLATE_DEFS[name] || TEMPLATE_DEFS[TEMPLATE];
  const found = await gh(`/repos/${who}/${name}`);
  if (found.ok) {
    if (found.body.is_template) return true;
    const fix = await gh(`/repos/${who}/${name}`, { method: 'PATCH', body: JSON.stringify({ is_template: true }) });
    return fix.ok;
  }
  if (found.status !== 404) return false;
  const body = JSON.stringify({
    name,
    private: true,
    auto_init: true,
    is_template: true,
    description: def.description,
  });
  const made = OWNER
    ? await gh(`/orgs/${OWNER}/repos`, { method: 'POST', body })
    : await gh('/user/repos', { method: 'POST', body });
  if (!made.ok) {
    console.log(`::warning::could not create ${who}/${name} (${made.status}) — repos will be created plain`);
    return false;
  }
  await putFile(who, name, 'README.md', def.readme(who, name), def.commit, made.body.default_branch || 'main')
    .catch((e) => console.log(`::warning::${name} readme: ${e.message}`));
  console.log(`[repo] created ${who}/${name} (private template)`);
  return true;
}

if (SEED_ONLY) {
  try {
    const who = await owner();
    for (const name of Object.keys(TEMPLATE_DEFS)) await ensureTemplateRepo(who, name);
    console.log('[repo] templates ensured');
  } catch (e) {
    console.log(`::warning::templates: ${e.message}`);
  }
  process.exit(0);
}

async function ensureRepo(who) {
  const found = await gh(`/repos/${who}/${NAME}`);
  // The template is ensured on EVERY publish, not just creation, so the
  // scaffold exists before the day a new site needs it and a deleted
  // one heals. One GET when it is already there.
  const templated = await ensureTemplateRepo(who);
  if (found.ok) {
    // Repos born before the template can never gain the "generated
    // from" banner in place — founder, on lorrybus-site: "the
    // generated sites also didn't use our site-template - i cant see
    // it here." SITE_RECREATE=1 (a request-file ask, never a default)
    // renames the old repo aside as an archive and falls through to a
    // fresh generate FROM the template. Nothing is deleted.
    if (process.env.SITE_RECREATE === '1' && templated) {
      const archive = `${NAME}-pre-template`;
      const moved = await gh(`/repos/${who}/${NAME}`, { method: 'PATCH', body: JSON.stringify({ name: archive }) });
      if (!moved.ok) {
        console.log(`::warning::could not archive ${NAME} (${moved.status}) — keeping it as is`);
        return found.body;
      }
      console.log(`[repo] archived ${NAME} → ${archive}`);
    } else {
      console.log(`[repo] ${who}/${NAME} exists`);
      return found.body;
    }
  } else if (found.status !== 404) throw new Error(`lookup failed (${found.status})`);
  // PRIVATE. Making a private repo public is one click; un-publishing a
  // public one does not un-clone it, and these are real businesses.
  if (templated) {
    const gen = await gh(`/repos/${who}/${TEMPLATE}/generate`, {
      method: 'POST',
      body: JSON.stringify({ owner: who, name: NAME, private: true }),
    });
    if (gen.ok) {
      console.log(`[repo] created ${who}/${NAME} from ${TEMPLATE} (private)`);
      // Generation copies the template's files asynchronously; give the
      // contents API a moment before writing over them.
      for (let i = 0; i < 5; i += 1) {
        const ready = await gh(`/repos/${who}/${NAME}/contents/README.md`);
        if (ready.ok) break;
        await sleep(1000);
      }
      return gen.body;
    }
    console.log(`::warning::generate from ${TEMPLATE} failed (${gen.status}) — creating plain`);
  }
  const made = OWNER
    ? await gh(`/orgs/${OWNER}/repos`, { method: 'POST', body: JSON.stringify({ name: NAME, private: true, auto_init: false }) })
    : await gh('/user/repos', { method: 'POST', body: JSON.stringify({ name: NAME, private: true, auto_init: false }) });
  if (!made.ok) throw new Error(`create failed (${made.status}): ${JSON.stringify(made.body).slice(0, 200)}`);
  console.log(`[repo] created ${who}/${NAME} (private)`);
  return made.body;
}

/** Write one file, creating or updating. The API needs the blob's
 *  current sha to update, so an existing file is looked up first. */
/** Encode a repo path for the contents API.
 *
 *  Per SEGMENT, never whole: encodeURIComponent('media/a.webp') gives
 *  'media%2Fa.webp', which lands as one oddly-named file at the root
 *  instead of a file in a directory. Everything published here was
 *  top-level until media arrived, so nothing had caught it. */
//  Declared as a FUNCTION, not a const: putFile is hoisted and gets
//  called during module top-level (the template seed at
//  ensureTemplate), which runs before a const here would initialise.
//  As an arrow const it threw ReferenceError from the temporal dead
//  zone, and putFile's caller .catch()es — so the template README
//  silently never got written and the run reported a warning.
function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function putFile(who, repo, path, content, message, branch) {
  // Buffers go through untouched; text is encoded once. A webp read as
  // utf8 and re-encoded is a corrupt file that still uploads happily.
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  const existing = await gh(`/repos/${who}/${repo}/contents/${encodePath(path)}?ref=${branch}`);
  const payload = {
    message,
    content: bytes.toString('base64'),
    branch,
  };
  if (existing.ok && existing.body.sha) payload.sha = existing.body.sha;
  const res = await gh(`/repos/${who}/${repo}/contents/${encodePath(path)}`, {
    method: 'PUT', body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
  return res.body.commit?.sha;
}

const page = readFileSync(resolve(PAGE), 'utf8');
// The spec is wanted, not required: a generated-not-from-spec site
// (the demo) writes its spec beside the built page, and an absent file
// must not crash the record-keeping for a site that is already live.
let spec = '';
if (SPEC) {
  try { spec = readFileSync(resolve(SPEC), 'utf8'); }
  catch { console.log(`[repo] no spec at ${SPEC} — publishing page + readme only`); }
}

/**
 * What the site assumed about this business, in the README, where the
 * owner will actually read it.
 *
 * They typed a sentence and got a site that quietly settled which
 * country's fees apply, which currency, whether the figures are
 * checked, whether the form goes anywhere. Buried in a JSON file those
 * are decisions nobody made and nobody can find. Listed here with the
 * field that overrules each, a wrong one costs an edit instead of a
 * customer.
 *
 * `default` first — those are the ones nothing in the brief touched,
 * so they are the likeliest to be wrong.
 */
function assumptionSection(json) {
  let list = [];
  try {
    const spec = JSON.parse(json);
    if (!assumptionsFor) {
      // Now it matters: there IS a spec, and the derived assumptions
      // are exactly what this section exists to carry.
      console.warn(`::warning::[repo] no renderer bundle at ${RENDERER} — this README will show only DECLARED assumptions, which for a real spec is none. Bundle it first: npx esbuild scaffolding/renderEntry.ts --bundle --platform=node --format=esm --outfile=build/render.mjs`);
    }
    list = assumptionsFor ? assumptionsFor(spec) : (spec.assumptions || []);
  } catch { return ''; }
  if (!list.length) return '';
  const rows = list.map((a) => {
    const mark = a.basis === 'default' ? '**Nobody chose this.** ' : '';
    return `- ${mark}${a.assumed}\n  <br>Because ${a.because}. Change it: \`${a.field}\` in \`site.spec.json\`.`;
  });
  return `\n## What this site assumed about you\n\nEach line is a decision made on your behalf. Change the named field and\nre-render — nothing here is fixed.\n\n${rows.join('\n')}\n`;
}

/** SVG-escape for text nodes. */
const svgEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The repo's face: a banner in the house colourway (near-black,
 * brass, display serif) generated per site and COMMITTED — GitHub
 * renders repo-relative SVGs, so the README never hotlinks anyone.
 * Founder: "just needs an ontold.com image and some blurb… and some
 * other gems like badges".
 */
function bannerSvg(name) {
  const size = name.length > 18 ? 46 : 64;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 240" role="img" aria-label="${svgEsc(name)}">
  <defs><radialGradient id="g" cx="72%" cy="-10%" r="90%">
    <stop offset="0%" stop-color="#232028"/><stop offset="60%" stop-color="#141318"/><stop offset="100%" stop-color="#0b0b0e"/>
  </radialGradient></defs>
  <rect width="1200" height="240" fill="url(#g)"/>
  <circle cx="150" cy="46" r="1.6" fill="#fff" opacity=".5"/><circle cx="930" cy="30" r="1.2" fill="#fff" opacity=".4"/>
  <circle cx="1080" cy="150" r="1.6" fill="#fff" opacity=".35"/><circle cx="420" cy="200" r="1.2" fill="#fff" opacity=".3"/>
  <rect x="64" y="60" width="44" height="3" fill="#c9a35c"/>
  <text x="64" y="132" font-family="Georgia, 'Times New Roman', serif" font-size="${size}" fill="#e8e4dc">${svgEsc(name)}</text>
  <text x="64" y="180" font-family="ui-sans-serif, system-ui, sans-serif" font-size="15" letter-spacing="5" fill="#c9a35c">MADE WITH ONTOLD &#183; ONTOLD.COM</text>
</svg>`;
}

/** A flat self-made badge — the shields look without the third-party
 *  hotlink. `tone` colours the value half. */
function badgeSvg(label, value, tone) {
  const colour = tone === 'green' ? '#3d7a4e' : '#8a6d3b';
  const lw = 12 + label.length * 7.2;
  const vw = 14 + value.length * 7.6;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(lw + vw)}" height="24" role="img" aria-label="${svgEsc(label)}: ${svgEsc(value)}">
  <rect width="${Math.round(lw)}" height="24" rx="4" fill="#1d1a15"/>
  <rect x="${Math.round(lw) - 4}" width="${Math.round(vw) + 4}" height="24" rx="4" fill="${colour}"/>
  <text x="${Math.round(lw / 2)}" y="16" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="11" fill="#e8e4dc">${svgEsc(label)}</text>
  <text x="${Math.round(lw + vw / 2)}" y="16" text-anchor="middle" font-family="ui-sans-serif, system-ui, sans-serif" font-size="11" font-weight="600" fill="#fff">${svgEsc(value)}</text>
</svg>`;
}

/**
 * The README is a WORKING document, modelled on the founder's
 * vinext-starter example: every section is operational — what is in
 * the repo, how to run it, how changes flow, how versions work.
 * ("readme isnt doing what I need to but see the template etc.")
 * It speaks to the site's owner: no third-party vendor names, no
 * philosophy, no operator notes. Ontold is our own name.
 */
let siteName = SLUG;
try { siteName = String(JSON.parse(spec).business || '') || SLUG; } catch { /* spec optional */ }
const makeReadme = (version) => `![${siteName}](banner.svg)

# ${siteName}

[![live](badge-live.svg)](https://${SLUG}.ontold.site) ![version](badge-version.svg) [![made with Ontold](badge-ontold.svg)](https://ontold.com)

${basicsFor(spec).description}

Live at https://${SLUG}.ontold.site — this repository is its complete,
versioned record (currently \`v${version}\`).

## Included Shape

- \`index.html\` — the published page, exactly as served. It is
  generated output: direct edits here are replaced by the next publish.
- \`site.spec.json\` — the source of record. Every section, figure and
  fee on the page comes from this file; the page cannot say something
  the spec does not contain.

The page is fully self-contained — styles, scripts and images are all
inside \`index.html\`, so there is no build step and no dependencies.

## Run It Locally

Any static file server works:

\`\`\`sh
npx serve .
\`\`\`

Then open the address it prints. Opening \`index.html\` straight in a
browser works too.

## Making Changes

Edit the site in your Ontold studio (or change \`site.spec.json\` and
re-render there): each publish rebuilds the page from the spec and
updates this repository. Change the named field in the spec rather
than the HTML — the HTML is regenerated every time.

## Versions

Every publish is tagged (\`v1\`, \`v2\`, …). To look at an earlier
version locally:

\`\`\`sh
git checkout v1 -- index.html
\`\`\`

To put an earlier version back live, ask for a revert in your studio —
the exact bytes of that tag are republished.
${assumptionSection(spec)}`;

try {
  const who = await owner();
  const repo = await ensureRepo(who);
  await ensureBasics(who, spec);
  const branch = repo.default_branch || 'main';

  // The version number is known BEFORE writing, so the badge and the
  // README can both say it and the tag can confirm it.
  const tags = await gh(`/repos/${who}/${NAME}/tags?per_page=100`);
  const n = (tags.ok && Array.isArray(tags.body) ? tags.body.length : 0) + 1;

  await putFile(who, NAME, 'index.html', page, `Publish ${SLUG}`, branch);
  if (spec) await putFile(who, NAME, 'site.spec.json', spec, `Publish ${SLUG}: spec`, branch);
  await putFile(who, NAME, 'banner.svg', bannerSvg(siteName), `Publish ${SLUG}: banner`, branch);
  await putFile(who, NAME, 'badge-live.svg', badgeSvg('site', 'live', 'green'), `Publish ${SLUG}: badges`, branch);
  await putFile(who, NAME, 'badge-version.svg', badgeSvg('version', `v${n}`, 'brass'), `Publish ${SLUG}: badges`, branch);
  await putFile(who, NAME, 'badge-ontold.svg', badgeSvg('made with', 'Ontold', 'brass'), `Publish ${SLUG}: badges`, branch);
  await putFile(who, NAME, 'README.md', makeReadme(n), `Publish ${SLUG}: readme`, branch);

  // The media the page is made of, into the site's OWN repo.
  //
  // Until now this lane shipped the rendered index.html and left the
  // source media behind in ontold — so the app's repo accumulated
  // everybody's generations while the slug's repo held a page whose
  // pictures existed nowhere in it. MEDIA is a newline or comma list of
  // local paths; each lands under media/ with its own name.
  //
  // Binary, so putFile's Buffer path matters: these are webp and mp4.
  for (const rel of (process.env.MEDIA || '').split(/[\n,]+/).map(x => x.trim()).filter(Boolean)) {
    try {
      const bytes = readFileSync(rel);
      const name = rel.split('/').pop();
      await putFile(who, NAME, `media/${name}`, bytes, `Publish ${SLUG}: ${name}`, branch);
      console.log(`[publish] media/${name} (${bytes.length} bytes)`);
    } catch (e) {
      // A missing still must not lose the page that is already written.
      console.log(`::warning::could not publish ${rel}: ${e.message}`);
    }
  }

  // A tag per publish, so "the version that was live on Tuesday" is a
  // thing you can check out rather than a thing you remember.
  const head = await gh(`/repos/${who}/${NAME}/git/ref/heads/${branch}`);
  if (head.ok) {
    const tag = await gh(`/repos/${who}/${NAME}/git/refs`, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/tags/v${n}`, sha: head.body.object.sha }),
    });
    console.log(tag.ok ? `[repo] tagged v${n}` : `[repo] could not tag (${tag.status})`);
  }
  console.log(`[repo] https://github.com/${who}/${NAME}`);
} catch (e) {
  // The site is already live on Cloudflare by the time this runs. A git
  // failure is worth shouting about and is not worth un-publishing over.
  console.log(`::warning::${SLUG}: could not publish to its own repo — ${e.message}`);
  console.log(`[repo] ${basename(PAGE)} is live regardless; the repo is the record, not the server.`);
  process.exit(0);
}
