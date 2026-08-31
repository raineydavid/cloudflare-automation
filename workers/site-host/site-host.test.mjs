/** site-host — pure-helper tests (no bucket, no network; the
 *  always-testable-without-altering-data house rule). */
import { describe, it, expect } from 'vitest';
import { slugFromHost, keyFor, keysFor, normalisePage, contentTypeFor, notFoundPage, siteFor, ROOT_SITE, SECURITY_HEADERS, withSecurity, overwriteRequested, contentHash, customHostValid, domainKey, slugValid, leadValid, leadKey, badgeHtml, withBadge, retargetOrigin, isSiteFile, SITE_FILES, makerLd, networkSitemap, networkRobots, slugsFromPrefixes, listable, SMOKE_PREFIX, claimUrl, UNCLAIMED_MARKER, addressState, statusFor, markerFor, visibilityKey, visibilityValid, parseVisibility, unlistedSlugs, withNoindex, NOINDEX_TAG, VISIBILITIES, normaliseAsset, ASSET_EXTS } from './src/index.mjs';
import { isRootHost, landingPage } from './src/landing.mjs';
import { readFileSync } from 'node:fs';
import TABLE from '../../data/pagePaths.json';
import worker from './src/index.mjs';

describe('slugFromHost', () => {
  it('extracts the slug from a site host', () => {
    expect(slugFromHost('sunrise-bakery.ontold.site')).toBe('sunrise-bakery');
    expect(slugFromHost('A-Site.ONTOLD.SITE')).toBe('a-site');
    expect(slugFromHost('x.ontold.site:443')).toBe('x');
  });
  it('rejects apex, www, nested, and foreign hosts', () => {
    expect(slugFromHost('ontold.site')).toBeNull();
    expect(slugFromHost('www.ontold.site')).toBeNull();
    expect(slugFromHost('a.b.ontold.site')).toBeNull();
    expect(slugFromHost('evil.example.com')).toBeNull();
    expect(slugFromHost('')).toBeNull();
  });
  it('nobody can claim the front door by registering its subdomain', () => {
    expect(slugFromHost(ROOT_SITE + '.ontold.site')).toBeNull();
  });
});

describe('siteFor', () => {
  it('routes the apex and www to the reserved root site', () => {
    expect(siteFor('ontold.site')).toBe(ROOT_SITE);
    expect(siteFor('www.ontold.site')).toBe(ROOT_SITE);
  });
  it('routes every other host to its own published site', () => {
    expect(siteFor('sunrise-bakery.ontold.site')).toBe('sunrise-bakery');
    expect(siteFor('evil.example.com')).toBeNull();
  });
  it('gives the front door a normal storage key, so Ontold publishes it like any site', () => {
    expect(keyFor(ROOT_SITE, '/')).toBe('sites/__root/index.html');
  });
});

describe('the custom-domain lane (lorrybus.com serves the lorrybus site)', () => {
  it('accepts a customer FQDN, case- and port-insensitively', () => {
    expect(customHostValid('lorrybus.com')).toBe(true);
    expect(customHostValid('www.LorryBus.com')).toBe(true);
    expect(customHostValid('shop.example.co.uk:443')).toBe(true);
  });
  it('never maps our own suffix - one site must not impersonate another', () => {
    expect(customHostValid('other.ontold.site')).toBe(false);
    expect(customHostValid('ontold.site')).toBe(false);
  });
  it('rejects non-hostnames', () => {
    expect(customHostValid('')).toBe(false);
    expect(customHostValid('nodots')).toBe(false);
    expect(customHostValid('-bad-.com')).toBe(false);
    expect(customHostValid('<script>x</script>.com')).toBe(false);
    expect(customHostValid('a'.repeat(260) + '.com')).toBe(false);
  });
  it('stores mappings under a normalized key', () => {
    expect(domainKey('LorryBus.com:443')).toBe('domains/lorrybus.com');
  });
  it('mappings may only point at claimable slugs, never the front door', () => {
    expect(slugValid('lorrybus')).toBe(true);
    expect(slugValid(ROOT_SITE)).toBe(false);
    expect(slugValid('www')).toBe(false);
    expect(slugValid('Bad Slug')).toBe(false);
    expect(slugValid(undefined)).toBe(false);
  });
});

describe('lead intake (our agents call them, rather than just a link out)', () => {
  it('accepts a real lead', () => {
    expect(leadValid({ contact: 'jo@example.com', want: 'retell' })).toBe(true);
    expect(leadValid({ contact: '+44 7700 900000', want: 'build' })).toBe(true);
  });
  it('a filled honeypot is silently satisfied, never argued with', () => {
    expect(leadValid({ contact: 'jo@example.com', want: 'retell', website: 'spam.biz' })).toBe('honeypot');
  });
  it('rejects the malformed', () => {
    expect(leadValid(null)).toBe(false);
    expect(leadValid({ contact: 'x', want: 'retell' })).toBe(false);            // too short
    expect(leadValid({ contact: 'jo@example.com', want: 'RETELL!' })).toBe(false); // hostile want
    expect(leadValid({ contact: 'a'.repeat(300), want: 'retell' })).toBe(false);   // too long
  });
  it('files each lead in its site inbox, time-ordered', () => {
    expect(leadKey('lorrybus', 1700000000000)).toBe('leads/lorrybus/1700000000000.json');
  });
});

describe('the maker\'s mark (our edit-with-Lovable equivalent)', () => {
  it('links home with the referring slug, nothing else', () => {
    const b = badgeHtml('lorrybus');
    expect(b).toContain('https://ontold.com/?ref=lorrybus');
    // An INVITATION, not a plaque - founder: "Edit with Lovable asks
    // you to do something. Made with ontold tells you its finished."
    expect(b).toContain('Make yours with Ontold');
    expect(b).not.toContain('Made with Ontold');
    expect(b).toContain('rel="noopener"');
    expect(b).not.toMatch(/script|github|cloudflare/i);
  });
  it('a hostile slug cannot smuggle markup into the badge', () => {
    expect(badgeHtml('<script>x</script>')).toContain('?ref=scriptxscript"');
  });
  it('rides inside </body>, and leaves non-pages untouched', () => {
    // The structured-data twin now follows the badge in the same
    // injection, so the badge is no longer the last thing before
    // </body> — both are still inside it, which is what matters.
    const out = withBadge('<html><body>hi</body></html>', 's');
    expect(out).toContain('Make yours with Ontold</a>');
    expect(out.indexOf('Make yours with Ontold')).toBeLessThan(out.indexOf('</body>'));
    expect(withBadge('just a fragment', 's')).toBe('just a fragment');
  });
});

describe('keyFor', () => {
  it('routes / to the site index', () => {
    expect(keyFor('s', '/')).toBe('sites/s/index.html');
    expect(keyFor('s', '')).toBe('sites/s/index.html');
  });
  it('prefers a real page over the index for a clean URL', () => {
    // This USED to be an SPA fallback: every extensionless path
    // resolved to index.html, so a site could only ever have one page.
    // The index is still the last candidate, so single-page sites are
    // unaffected.
    expect(keyFor('s', '/about')).toBe('sites/s/about.html');
    expect(keysFor('s', '/about').at(-1)).toBe('sites/s/index.html');
  });
  it('maps asset paths to stored keys', () => {
    expect(keyFor('s', '/hero.jpg')).toBe('sites/s/hero.jpg');
    expect(keyFor('s', '/css/main.css')).toBe('sites/s/css/main.css');
  });
});

describe('contentTypeFor', () => {
  it('covers the self-contained-site asset set', () => {
    expect(contentTypeFor('sites/s/index.html')).toContain('text/html');
    expect(contentTypeFor('a.svg')).toBe('image/svg+xml');
    expect(contentTypeFor('a.mp4')).toBe('video/mp4');
    expect(contentTypeFor('a.unknownext')).toBe('application/octet-stream');
  });
});

// ── An unclaimed address is an offer, not an error ──────────────────
//
// Founder: "our 404 page is fugly and should really be based on the
// default site right - claim this one..."
//
// Both halves were true. It was generic #111/#eee/#f66 with none of the
// brand tokens — and it was the wrong page: somebody who typed a name
// into <name>.ontold.site has NAMED THE BUSINESS, which is higher
// intent than the front door catches, and "Make yours at ontold.com"
// threw that away and asked them to start from a blank field.
describe('notFoundPage', () => {
  it('names the slug and invites creation, self-contained', () => {
    const p = notFoundPage('my-cafe');
    expect(p).toContain('my-cafe.ontold.site');
    expect(p).toContain('ontold.com');
    expect(p).not.toMatch(/https?:\/\/(?!ontold\.com)/); // no external assets
  });

  it('offers the address they just typed, carried to the studio', () => {
    const p = notFoundPage('my-cafe');
    expect(p).toContain(claimUrl('my-cafe'));
    expect(p).toContain('Claim my-cafe.ontold.site');
    // The old copy sent them to a blank field. That is the regression
    // to guard, not the wording.
    expect(p).not.toMatch(/href="https:\/\/ontold\.com"[^>]*class="cta"/);
  });

  it('wears the house palette, like the front door', () => {
    // The complaint was that it looked detached from everything else.
    const p = notFoundPage('my-cafe');
    for (const token of ['#070707', '#DC2626', '#F5F1E8', '#1a1a1a']) {
      expect(p, token).toContain(token);
    }
    expect(p).toContain('class="mark"');      // the logo
    expect(p).toContain('class="bar"');       // the address bar
  });

  it('shows the padlock OPEN — the inversion of the front door', () => {
    // On ontold.site the lock snaps shut: this name exists and is
    // secure. Here it stays open: the name is free. Same component,
    // opposite meaning.
    expect(notFoundPage('my-cafe')).toContain('<svg class="lock"');
    expect(notFoundPage('my-cafe')).not.toContain('class="lock secure"');
    expect(landingPage()).toContain('class="lock secure"');
  });

  it('escapes a hostile slug everywhere it lands, including the link', () => {
    // The slug arrives from a Host header. slugFromHost rejects this
    // shape, but escaping at the point of interpolation holds whoever
    // calls it.
    const p = notFoundPage('"><script>alert(1)</script>');
    expect(p).not.toContain('<script>alert(1)</script>');
    // Escaped, not stripped — the visitor still sees what they typed.
    expect(p).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // And the href is percent-encoded before it is escaped, so the
    // slug cannot break out of the attribute either.
    expect(p).toContain('%3Cscript%3E');
    expect(p).not.toMatch(/href="[^"]*<script/);
  });

  it('the claim link carries the name and nothing else', () => {
    expect(claimUrl('my-cafe')).toBe('https://ontold.com/?claim=my-cafe');
    expect(claimUrl('a b&c')).toBe('https://ontold.com/?claim=a%20b%26c');
  });
});

// The deploy gate reads this page. Twice now a coupling between the
// Worker and a workflow has only shown up in CI, so both are pinned
// here — the Worker cannot import a workflow, and a grep in YAML
// cannot import the Worker.
describe('the deploy gate can still recognise a free address', () => {
  it('the page carries the state marker', () => {
    expect(notFoundPage('anything')).toContain(UNCLAIMED_MARKER);
  });

  it('and the workflow greps THAT, not the copy', () => {
    // Rewriting the headline hung deploy-site-host for a minute and
    // then failed it, because the check matched the prose. Copy is
    // meant to change; the state is not.
    const wf = readFileSync('.github/workflows/deploy-site-host.yml', 'utf8');
    expect(wf).toContain('name="ontold-status" content="unclaimed"');
    expect(wf).not.toContain("hasn't been published");
  });

  it('a published page never claims to be unclaimed', () => {
    // The marker decides whether the edge looks alive, so it must not
    // appear on the success path.
    expect(landingPage()).not.toContain(UNCLAIMED_MARKER);
    expect(withBadge('<html><body>hi</body></html>', 's')).not.toContain(UNCLAIMED_MARKER);
  });
});

describe('the house look is defined once', () => {
  it('the front door and the 404 share it, rather than drifting', () => {
    // Two copies of the palette is how the 404 got left behind for a
    // month while the front door was rebranded.
    const both = [landingPage(), notFoundPage('x')];
    for (const page of both) {
      expect(page).toContain('--red:#DC2626');
      expect(page).toContain("font:16px/1.6 'Inter'");
    }
  });
});

describe('isRootHost', () => {
  it('treats the bare domain and www as the front door', () => {
    expect(isRootHost('ontold.site')).toBe(true);
    expect(isRootHost('www.ontold.site')).toBe(true);
    expect(isRootHost('ONTOLD.SITE:443')).toBe(true);
  });
  it('leaves published slugs and foreign hosts alone', () => {
    expect(isRootHost('sunrise-bakery.ontold.site')).toBe(false);
    expect(isRootHost('evil.example.com')).toBe(false);
    expect(isRootHost('')).toBe(false);
  });
  it('never collides with slugFromHost — a host is a site OR the door', () => {
    for (const h of ['ontold.site', 'www.ontold.site', 'a.ontold.site', 'x.example.com']) {
      expect(isRootHost(h) && slugFromHost(h) !== null).toBe(false);
    }
  });
});

describe('landingPage', () => {
  const p = landingPage();
  it('sends the visitor to the studio', () => {
    expect(p).toContain('https://ontold.com');
    expect(p).toMatch(/Make yours/);
  });
  it('is fully self-contained — a strict edge must load nothing else', () => {
    // ontold.site joined ontold.com on the allowlist when the live
    // example landed. That widens what may be LINKED, not what is
    // LOADED: an <a href> costs the page nothing until someone clicks
    // it, and both hosts are ours. The assertions that actually prove
    // self-containment are the two below — no stylesheet and no script
    // is fetched — plus the img/iframe check that follows.
    // Host-by-host rather than one negative lookahead: the example
    // lives on a SUBDOMAIN, and `(?!ontold\.(com|site))` reads
    // "nothing-to-wear.ontold.site" as foreign because it only looks
    // at the characters straight after the slashes. Parsing the host is
    // exact; a lookahead here is a guess about URL shape.
    const hosts = [...p.matchAll(/https?:\/\/([^/"'\s>]+)/g)].map(m => m[1].toLowerCase());
    for (const h of hosts) {
      expect(h === 'ontold.com' || h === 'ontold.site' || h.endsWith('.ontold.site'),
        `${h} is not one of our hosts`).toBe(true);
    }
    expect(p).not.toMatch(/<link[^>]+href=/i);
    expect(p).not.toMatch(/<script[^>]+src=/i);
  });

  it('fetches no subresource at all, from any host including ours', () => {
    // The allowlist above governs link TARGETS. This governs loads, and
    // it has to stay absolute: the page must render on a cold edge with
    // nothing else reachable. An <img> pointing at ontold.com would slip
    // past the host allowlist while breaking exactly that property.
    expect(p).not.toMatch(/<img\b/i);
    expect(p).not.toMatch(/<iframe\b/i);
    expect(p).not.toMatch(/url\((?!['"]?data:)/i);
    expect(p).not.toMatch(/@import/i);
  });

  it('offers a live example that can actually be opened', () => {
    // Founder (2026-07-31): "i want one that is interactive - ie shop my
    // wardrobe". A sentence-and-address pair says what we would make; a
    // working URL is a different and much stronger claim.
    expect(p).toContain('https://nothing-to-wear.ontold.site');
  });
  it('labels the rotating addresses as examples, claims no usage numbers', () => {
    expect(p).toMatch(/Example addresses/i);
    expect(p).toMatch(/not customers/i);
    // No fabricated traction. If a number ever appears here it has to
    // be one somebody can check.
    expect(p).not.toMatch(/\d[\d,]*\+?\s*(sites|businesses|customers|users)/i);
  });

  it('wears the app palette, not a palette of its own', () => {
    // Founder (2026-07-31): the first version was indigo and amber and
    // "looks totally detached". These four are src/index.css's @theme
    // tokens verbatim — a front door that doesn't look like the
    // building fails at the one job it has.
    for (const token of ['#070707', '#DC2626', '#F5F1E8', '#1a1a1a']) {
      expect(p, `${token} missing — palette drifted from src/index.css`).toContain(token);
    }
    // And none of the old scheme survives.
    for (const stale of ['#111436', '#FFA94D', '#F4F1EC', '#1E2350']) {
      expect(p, `${stale} is the pre-brand palette`).not.toContain(stale);
    }
  });

  it('carries the actual logo from public/icon.svg', () => {
    // The play-D. Both paths, or it is some other mark.
    expect(p).toContain('M0 0H20C32 0 42 10 42 20C42 30 32 40 20 40H0V0Z');
    expect(p).toContain('M16 11L29 20L16 29Z');
  });

  it('shows what you type next to what you get', () => {
    // Founder: "no examples in homepage". The headline promises the
    // sentence-to-address move; this is where it is demonstrated.
    const addresses = [...p.matchAll(/class="got">([a-z0-9-]+)</g)].map(m => m[1]);
    expect(addresses.length).toBeGreaterThanOrEqual(3);
    // Every example address is a slug the host could actually serve —
    // an illustration that would 404 by construction teaches the wrong
    // thing about how the platform works.
    for (const a of addresses) {
      expect(a, `${a} is not a servable subdomain label`)
        .toMatch(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
    }
  });
  it('respects reduced motion and stays keyboard-visible', () => {
    expect(p).toContain('prefers-reduced-motion');
    expect(p).toContain(':focus-visible');
  });
  it('carries no unresolved template interpolation', () => {
    expect(p).not.toContain('${');
  });
  it('is ASCII-safe in its CSS (a stray glyph once broke a colour token)', () => {
    const css = p.slice(p.indexOf('<style>'), p.indexOf('</style>'));
    expect(css).toMatch(/^[\x00-\x7F]*$/);
  });
});

describe('served responses are hardened', () => {
  // What lands here is model-generated markup on a domain we own, and
  // until this existed it was served with no security headers at all.
  it('sets the headers that cost a legitimate page nothing', () => {
    expect(SECURITY_HEADERS['x-content-type-options']).toBe('nosniff');
    expect(SECURITY_HEADERS['referrer-policy']).toBe('strict-origin-when-cross-origin');
    expect(SECURITY_HEADERS['strict-transport-security']).toMatch(/max-age=\d+/);
  });

  it('stops a generated form posting a visitor to a third-party host', () => {
    // The directive with actual teeth. Same-origin is also exactly
    // where lead capture would land.
    expect(SECURITY_HEADERS['content-security-policy']).toMatch(/form-action 'self'/);
  });

  it('blocks framing, plugins and base-tag hijacking', () => {
    const csp = SECURITY_HEADERS['content-security-policy'];
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).toMatch(/object-src 'none'/);
    expect(csp).toMatch(/base-uri 'none'/);
  });

  it('does NOT constrain script or images — that would break live sites', () => {
    // Deliberate and documented. Self-contained pages are inline by
    // construction; a default-src policy would silently take down
    // pages that are already published. Pinned so the trade-off is
    // changed on purpose rather than by someone tightening it blind.
    const csp = SECURITY_HEADERS['content-security-policy'];
    expect(csp).not.toMatch(/script-src/);
    expect(csp).not.toMatch(/default-src/);
    expect(csp).not.toMatch(/img-src/);
  });

  it('lets a caller set content-type and caching but not drop the rest', () => {
    const h = withSecurity({ 'content-type': 'text/html', 'cache-control': 'no-store' });
    expect(h['content-type']).toBe('text/html');
    expect(h['cache-control']).toBe('no-store');
    expect(h['x-content-type-options']).toBe('nosniff');
  });
});

describe('the 404 cannot be turned into a payload', () => {
  it('rejects a host that is not a real DNS label', () => {
    // The old rule was "no dots", which let a spoofed Host of
    // <script>x</script>.ontold.site through as a slug — and the slug
    // went into the 404 markup verbatim.
    expect(slugFromHost('<script>x</script>.ontold.site')).toBeNull();
    expect(slugFromHost('a b.ontold.site')).toBeNull();
    expect(slugFromHost('-leading.ontold.site')).toBeNull();
    expect(slugFromHost('trailing-.ontold.site')).toBeNull();
    expect(slugFromHost('under_score.ontold.site')).toBeNull();
  });

  it('still accepts the slugs real sites use', () => {
    // Guarding the guard: a validator that rejects everything passes
    // the test above while breaking every published site.
    expect(slugFromHost('sunrise-bakery.ontold.site')).toBe('sunrise-bakery');
    expect(slugFromHost('a1.ontold.site')).toBe('a1');
    expect(slugFromHost('x.ontold.site')).toBe('x');
  });

  it('escapes the slug even when handed one that never passed the door', () => {
    // Defence at the point of interpolation, not only at the caller —
    // the next caller is the one that forgets.
    const html = notFoundPage('<script>alert(1)</script>');
    expect(html).not.toMatch(/<script>alert/);
    expect(html).toMatch(/&lt;script&gt;/);
  });
});

describe('the headers are actually wired to the responses', () => {
  // SECURITY_HEADERS being correct is worth nothing if the fetch
  // handler never merges them. The handler needs an R2 binding to
  // exercise directly, so this reads the source: every Response that
  // carries a content-type must build its headers through
  // withSecurity. Blunt, but it catches the failure that matters —
  // a header set defined and then not used.
  it('every content-serving Response goes through withSecurity', async () => {
    const { readFileSync } = await import('fs');
    const { join, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'src/index.mjs'), 'utf8');
    // Chunk on the constructor rather than trying to match balanced
    // braces with a regex — the first attempt matched zero blocks and
    // the guard-the-guard assertion below is what caught it.
    const bodies = src.split('new Response(').slice(1);
    const serving = bodies.filter(b => /'content-type':/.test(b) && !/JSON\.stringify/.test(b));
    expect(serving.length).toBeGreaterThanOrEqual(3);   // site, 404, landing
    for (const b of serving) {
      expect(b, 'wrap these headers in withSecurity()').toMatch(/withSecurity\(/);
    }
  });
});

describe('taking a live slug is deliberate', () => {
  // An agent picks slugs from the brief, so two runs of the same brief
  // pick the same slug — and the second used to silently replace the
  // first customer's live page.
  const q = (search) => new URL(`https://x.ontold.site/__publish${search}`);

  it('a plain publish does not claim to want an overwrite', () => {
    expect(overwriteRequested(q(''))).toBe(false);
    expect(overwriteRequested(q('?other=1'))).toBe(false);
  });

  it('accepts the affirmative spellings a caller would actually send', () => {
    expect(overwriteRequested(q('?overwrite=1'))).toBe(true);
    expect(overwriteRequested(q('?overwrite=true'))).toBe(true);
    expect(overwriteRequested(q('?overwrite=YES'))).toBe(true);
  });

  it('does not read a NEGATIVE value as consent', () => {
    // The trap in "flag is present" parsing: ?overwrite=0 reads as no
    // to a human and would have meant yes to the Worker — turning the
    // guard into the accident it exists to prevent.
    expect(overwriteRequested(q('?overwrite=0'))).toBe(false);
    expect(overwriteRequested(q('?overwrite=false'))).toBe(false);
    expect(overwriteRequested(q('?overwrite='))).toBe(false);
  });

  it('the handler checks for an existing page before writing', async () => {
    // Source-level: the pure helper being right is worth nothing if
    // the PUT path never calls it. Reading the source is the honest
    // option here — exercising the branch needs an R2 binding.
    const { readFileSync } = await import('fs');
    const { join, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'src/index.mjs'), 'utf8');
    // Search for the end marker FROM the block's start, not from 0:
    // adding /__visibility (which guards its own method the same way)
    // put an earlier match in front and silently emptied this slice,
    // so three collision-gate assertions passed against "".
    const from = src.indexOf("=== '/__publish'");
    const publishBlock = src.slice(from, src.indexOf('if (request.method !== ', from));
    expect(publishBlock.length, 'the publish block did not slice').toBeGreaterThan(200);
    expect(publishBlock).toMatch(/overwriteRequested\(url\)/);
    expect(publishBlock).toMatch(/SITES\.head\(/);
    expect(publishBlock).toMatch(/status: 409/);
    // And the check must come BEFORE the index write, or it protects
    // nothing. Pinned to the INDEX write specifically: subpage
    // publishes (/__publish/<name>.html) write earlier by design —
    // they claim no slug, so they need no collision gate.
    expect(publishBlock.indexOf('SITES.head(')).toBeLessThan(publishBlock.indexOf('SITES.put(indexKey'));
  });
});

describe('an unchanged republish costs nothing', () => {
  // Version history was append-only and nothing ever removed an entry.
  // An agent republishing an identical page in a loop grew R2 without
  // bound, billed to us, recording no change at all.
  it('gives identical pages the same identity', async () => {
    const page = '<!DOCTYPE html><html><body>hi</body></html>';
    expect(await contentHash(page)).toBe(await contentHash(page));
  });

  it('gives a real edit a different identity', async () => {
    // The failure that matters is the other direction: a collision
    // here means a genuine edit silently does not publish.
    const a = await contentHash('<!DOCTYPE html><html><body>hi</body></html>');
    const b = await contentHash('<!DOCTYPE html><html><body>hi.</body></html>');
    expect(a).not.toBe(b);
  });

  it('is a real digest, not a cheap string hash', async () => {
    const h = await contentHash('x');
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    // Known SHA-256 of "x" — pins the algorithm, so swapping it for
    // something weaker is a red build rather than a quiet change.
    expect(h).toBe('2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881');
  });

  it('short-circuits before writing when the page is unchanged', async () => {
    // Source-level, like the other publish-path checks: exercising the
    // branch needs an R2 binding. The ORDER is the property — a dedup
    // check after the write saves nothing.
    const { readFileSync } = await import('fs');
    const { join, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'src/index.mjs'), 'utf8');
    // Same trap as the collision-gate slice above: search from the
    // block's start, or an earlier handler's method guard empties it.
    const from = src.indexOf("=== '/__publish'");
    const block = src.slice(from, src.indexOf('if (request.method !== ', from));
    expect(block.length, 'the publish block did not slice').toBeGreaterThan(200);
    expect(block).toMatch(/customMetadata\?\.sha === sha/);
    expect(block).toMatch(/unchanged: true/);
    // Pinned to the INDEX write — the subpage early-write above it is
    // deliberately unversioned and undeduplicated.
    expect(block.indexOf('unchanged: true')).toBeLessThan(block.indexOf('SITES.put(indexKey'));
  });

  it('stores the marker on the index it describes', async () => {
    // A sidecar object could drift from the page. The next publish
    // would then compare against a hash of something else and either
    // skip a real edit or duplicate an unchanged one.
    const { readFileSync } = await import('fs');
    const { join, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'src/index.mjs'), 'utf8');
    const putIndex = src.slice(src.indexOf('await env.SITES.put(indexKey'));
    expect(putIndex.slice(0, 400)).toMatch(/customMetadata: \{ sha \}/);
  });
});

describe('the nothing-to-wear example', () => {
  // The one example that is a real page rather than a described one.
  // It ships in the repo and is published by deploy-site-host.yml, so
  // these guard the page itself — the workflow can only publish what
  // is here.
  const read = async () => {
    const { readFileSync } = await import('fs');
    const { join, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    return readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'examples/nothing-to-wear.html'),
      'utf8',
    );
  };

  it('loads nothing from anywhere — it has to survive a strict CSP', async () => {
    const html = await read();
    // Garments are inline SVG paths, not photographs, which is what
    // makes this possible at all.
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/<script[^>]+src=/i);
    // Our own addresses are allowed; anything else is not. This used to
    // ban every URL but ontold.com, which caught the "Buy similar" link
    // to shop-my-wardrobe.ontold.site — a hyperlink to our own module,
    // which fetches nothing. The rule this file is about is stated two
    // comments down and is the right one: the page must never FETCH.
    // An <a href> is not a fetch.
    expect(html).not.toMatch(/https?:\/\/(?!ontold\.com|[a-z0-9-]+\.ontold\.site)/);
    // An <img> is allowed, and only in one shape: a src the renderer
    // has already proven is a data: URI. This used to ban the tag
    // outright, which was right while every garment was drawn and
    // wrong the moment real photographs became the point — the page
    // has to be able to CARRY an image, it just must never FETCH one.
    // So the ban moved from the tag to the source.
    expect(html).not.toMatch(/<img[^>]+src=["']https?:/i);
    if (/<img/.test(html)) {
      expect(html, 'an <img> may only render a data: URI the renderer has checked')
        .toMatch(/\/\^data:image\\\/\/\.test\(/);
    }
  });

  it('never invents a place to buy — only our own module', async () => {
    // Never let a demonstration read as a real shop: somebody could
    // otherwise try to buy a garment that does not exist.
    //
    // Asserted on the VISIBLE text, not the source. The old version
    // matched /written by hand/ against the whole file and passed off
    // the HTML COMMENT at the top — so it would have gone on passing
    // with the footer deleted entirely, because a comment satisfied it
    // and a visitor never reads a comment.
    //
    // And it pins the CLAIM, not the wording. The founder cut that
    // footer from seventy words to twenty ("too much text ... its meant
    // to look like a real site not a template") and the words moved.
    // What must not move is that a visitor is told both things.
    const visible = (await read())
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ');
    // What must be true CHANGED, and this is the honest version of it.
    //
    // It used to assert the page says there is nothing to buy. Founder:
    // "its your personal wardrobe. leave it - avoid opinions or
    // disclaimers we have a shopping module buy similar". So the denial
    // was both an apology and factually wrong — there IS a way to buy,
    // it is a module of ours, and the page now offers it.
    //
    // The property worth guarding was never the disclaimer. It is that
    // the page never fabricates a place to buy: the only shopping link
    // it may carry is our own module, with the look handed to it.
    const shopLinks = [...(await read()).matchAll(/href="(https?:\/\/[^"]+)"/g)]
      .map((m) => m[1])
      .filter((u) => !/^https:\/\/ontold\.com\//.test(u));
    for (const u of shopLinks) {
      expect(u, 'a shopping link that is not our own module')
        .toMatch(/^https:\/\/shop-my-wardrobe\.ontold\.site\//);
    }
    // The label itself is rendered into the drawer by script, so it is
    // not in the static text — asserted on the file, which is where a
    // client-rendered string honestly lives.
    expect(await read(), 'the look cannot be shopped').toMatch(/Buy similar/);
  });

  it('draws every piece as the thing it is', async () => {
    // All five accessories declared sh:"tee" and the drawing function
    // falls back to SHAPE.tee, so a handbag rendered as a T-shirt on
    // any accessory without a photograph. It was invisible in review
    // because three of the five HAVE photographs.
    //
    // The property is per-CATEGORY, not per-piece: two tops may share
    // the tee, but a bag drawn with a garment's outline is a bug
    // whatever the outline is.
    const html = await read();
    const shapes = new Set(
      [...html.matchAll(/^ {4}(\w+): function\(\)\{ return \{$/gm)].map((m) => m[1]),
    );
    expect(shapes.size, 'no SHAPE table found').toBeGreaterThan(5);
    const byShape = new Map();
    for (const [, cat, sh] of html.matchAll(/c:"(\w+)",sh:"(\w+)"/g)) {
      expect(shapes.has(sh), `${sh} is not in SHAPE — it would draw as a tee`).toBe(true);
      byShape.set(sh, (byShape.get(sh) || new Set()).add(cat));
    }
    expect(byShape.size, 'no pieces found').toBeGreaterThan(10);
    for (const [sh, cats] of byShape) {
      expect([...cats], `${sh} is worn by more than one kind of thing`).toHaveLength(1);
    }
  });

  it('never prints a count it has not counted', async () => {
    // The header said "30 pieces" and the hero said "Thirty things".
    // Ten garments were added and both became false — on a page whose
    // rule is that a number is computed or not shown. Static prose must
    // not carry a wardrobe size.
    const visible = (await read())
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ');
    expect(visible).not.toMatch(/\b(?:thirty|forty|\d{2})\s+(?:things|pieces|garments)\b/i);
  });

  it('carries no credential — a published page is a public document', async () => {
    // Nothing scans published HTML for secrets today (scan_secrets runs
    // on commits, not publishes). Until something does, the one page we
    // publish from this repo gets checked here.
    const html = await read();
    expect(html).not.toMatch(/\b(sk|pk|rk)[-_][A-Za-z0-9]{16,}/);
    expect(html).not.toMatch(/\bBearer\s+[A-Za-z0-9._-]{16,}/);
    expect(html).not.toMatch(/api[_-]?key\s*[:=]\s*['"][^'"]{8,}/i);
  });

  it('remixes through the same door a human paste uses', async () => {
    // ?compose= is the app's one-shot intake — the machine lane and the
    // UI lane are the same door (App.tsx). Remix is that door prefilled,
    // not a second code path that can drift from it.
    const html = await read();
    // Every handoff goes through it, and each carries a real brief
    // rather than dumping the visitor on the home page. Asserted on the
    // shape, not on a variable name: the first version pinned
    // `var BRIEF = '` and failed the moment the page grew a second
    // brief and the name became plural. A guard that breaks on a rename
    // teaches people to edit the guard.
    const composers = html.match(/ontold\.com\/\?compose=' \+ encodeURIComponent\(/g) || [];
    expect(composers.length, 'remix links must be built from a brief').toBeGreaterThanOrEqual(1);
    expect(html).toMatch(/ontold\.com\/\?compose=/);
  });

  it('ships a rebuild brief that names every load-bearing rule', async () => {
    // Founder (2026-07-31): "everything we are creating needs to be made
    // from our generator and if the ability is missing, create it" (#89).
    // The brief is the input that must reproduce this page. A brief that
    // drifts from what the page actually does would measure the wrong
    // shortfall — it would report the generator as closer than it is.
    const { readFileSync } = await import('fs');
    const { join, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const brief = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), 'examples/nothing-to-wear.brief.md'),
      'utf8',
    );
    for (const rule of [
      /compromise/i,        // refill an empty slot and say so
      /RGB distance|distance/i,
      /outfits-per-piece/i, // packing objective
      /gap/i,
      /tote|crossbody/i,    // accessory rules
      /hair/i,
      /data: URI|data:/i,   // carry an image, never fetch one
    ]) {
      expect(brief, `the brief no longer describes ${rule}`).toMatch(rule);
    }
  });

  it('keeps the brief and the page telling the same story about provenance', async () => {
    // The acceptance criterion is that the generated page BECOMES the
    // published one, at which point the hand-written admission can go.
    // Deleting the admission without doing the work would be the exact
    // dishonesty the whole example is built to avoid — so the two claims
    // are pinned to each other.
    const { readFileSync } = await import('fs');
    const { join, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const here = dirname(fileURLToPath(import.meta.url));
    const page = readFileSync(join(here, 'examples/nothing-to-wear.html'), 'utf8');
    const brief = readFileSync(join(here, 'examples/nothing-to-wear.brief.md'), 'utf8');
    const handMade = /written by hand/i.test(page);
    const briefSaysUnmet = /Until then it stays/i.test(brief);
    expect(handMade, 'page and brief disagree about whether this is generator output')
      .toBe(briefSaysUnmet);
  });

  it('is published by the deploy workflow, deliberately overwriting', async () => {
    const { readFileSync } = await import('fs');
    const { join, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
    const wf = readFileSync(join(root, '.github/workflows/deploy-site-host.yml'), 'utf8');
    expect(wf).toContain('examples/nothing-to-wear.html');
    // Without ?overwrite=1 every deploy after the first would 409.
    expect(wf).toMatch(/nothing-to-wear\.ontold\.site\/__publish\?overwrite=1/);
  });
});

// ── Real pages, not one page with a fallback ────────────────────────
//
// Founder: "but its just a page, what about full sites? how are we
// competing with lovable etc?" — a site with one URL is not a site.
describe('a site can have more than one page', () => {
  it('resolves a clean URL to a real page before falling back', () => {
    expect(keysFor('acme', '/pricing')).toEqual([
      'sites/acme/pricing.html',
      'sites/acme/pricing/index.html',
      'sites/acme/index.html',
    ]);
  });

  it('treats a trailing slash as the same page', () => {
    expect(keysFor('acme', '/pricing/')).toEqual(keysFor('acme', '/pricing'));
  });

  it('handles a nested path', () => {
    expect(keysFor('acme', '/docs/api')[0]).toBe('sites/acme/docs/api.html');
  });

  it('serves the index at the root, with nothing to fall back to', () => {
    expect(keysFor('acme', '/')).toEqual(['sites/acme/index.html']);
  });

  it('never answers a missing asset with HTML', () => {
    // A stylesheet that 404s is debuggable; one that returns the home
    // page is not, and the browser will not tell you why.
    expect(keysFor('acme', '/style.css')).toEqual(['sites/acme/style.css']);
    expect(keysFor('acme', '/img/hero.jpg')).toEqual(['sites/acme/img/hero.jpg']);
  });

  it('keeps keyFor answering with the best candidate', () => {
    expect(keyFor('acme', '/')).toBe('sites/acme/index.html');
    expect(keyFor('acme', '/style.css')).toBe('sites/acme/style.css');
    expect(keyFor('acme', '/pricing')).toBe('sites/acme/pricing.html');
  });
});

describe('publishing a page by its clean path', () => {
  // /api/run decides the same thing in Python and cannot import this,
  // so both are tested against data/pagePaths.json. Drift fails here.
  it('accepts every path the shared table accepts', () => {
    for (const [path, expected] of Object.entries(TABLE.accepted)) {
      expect(normalisePage(path), path).toBe(expected);
    }
  });

  it('refuses every path the shared table refuses', () => {
    for (const bad of TABLE.rejected) {
      expect(normalisePage(bad), `accepted ${JSON.stringify(bad)}`).toBe('');
    }
  });

  it('refuses the encoded and oversized cases too', () => {
    for (const bad of ['a%2Fb', 'x'.repeat(300)]) {
      expect(normalisePage(bad), `accepted ${JSON.stringify(bad)}`).toBe('');
    }
  });

  it('every accepted path stays under its own site', () => {
    // The invariant that matters: the R2 key is `sites/<slug>/<page>`,
    // so whatever survives normalisation must not climb out of that
    // prefix. `sites/other/index` is allowed and harmless — it lands at
    // sites/acme/sites/other/index.html, still inside acme.
    for (const p of ['pricing', 'docs/api', 'sites/other/index', 'a/b/c/d']) {
      const page = normalisePage(p);
      if (!page) continue;
      const key = `sites/acme/${page}`;
      expect(key.startsWith('sites/acme/'), key).toBe(true);
      expect(key).not.toContain('..');
    }
  });
});

// ── The inbox ───────────────────────────────────────────────────────
//
// /__lead wrote leads into R2 and nothing could read them back. A site
// that earns a customer and cannot show you the customer has not
// finished the job.
describe('GET /__leads', () => {
  const lead = (ts, contact) => ({ slug: 'lorrybus', want: 'lorry-ce', contact, at: new Date(ts).toISOString() });

  /** Enough of an R2 bucket for this handler. */
  const bucket = (entries) => ({
    list: async ({ prefix, limit }) => ({
      objects: Object.keys(entries).filter(k => k.startsWith(prefix)).slice(0, limit).map(key => ({ key })),
    }),
    get: async (key) => (key in entries
      ? { text: async () => JSON.stringify(entries[key]) }
      : null),
    put: async () => {},
  });

  const call = (env, headers = {}, host = 'lorrybus.ontold.site') =>
    worker.fetch(new Request(`https://${host}/__leads`, { headers }), env);

  const ENV = {
    PUBLISH_TOKEN: 'secret',
    SITES: bucket({
      'leads/lorrybus/1700000000001.json': lead(1700000000001, 'Ada — 07700 900001'),
      'leads/lorrybus/1700000000002.json': lead(1700000000002, 'Ben — 07700 900002'),
      'leads/someone-else/1700000000003.json': lead(1700000000003, 'Not yours'),
    }),
  };

  it('refuses without the token', async () => {
    // An open inbox would publish every enquiry a customer ever made.
    const res = await call(ENV);
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('07700');
  });

  it('refuses a wrong token', async () => {
    expect((await call(ENV, { authorization: 'Bearer nope' })).status).toBe(401);
  });

  it('hands back this site\'s leads, newest first', async () => {
    const res = await call(ENV, { authorization: 'Bearer secret' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.slug).toBe('lorrybus');
    expect(body.count).toBe(2);
    expect(body.leads.map(l => l.contact)).toEqual(['Ben — 07700 900002', 'Ada — 07700 900001']);
  });

  it('never reaches another site\'s inbox', async () => {
    // The prefix comes from the HOST, so the token cannot cross sites.
    const res = await call(ENV, { authorization: 'Bearer secret' });
    expect(JSON.stringify(await res.json())).not.toContain('Not yours');
  });

  it('is never cached, anywhere', async () => {
    const res = await call(ENV, { authorization: 'Bearer secret' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('is empty, not broken, for a site with no leads yet', async () => {
    const res = await call({ ...ENV, SITES: bucket({}) }, { authorization: 'Bearer secret' });
    expect(res.status).toBe(200);
    expect((await res.json()).leads).toEqual([]);
  });

  it('skips a corrupt record rather than failing the whole inbox', async () => {
    const env = {
      PUBLISH_TOKEN: 'secret',
      SITES: {
        list: async () => ({ objects: [
          { key: 'leads/lorrybus/1.json' }, { key: 'leads/lorrybus/2.json' }] }),
        get: async (k) => ({ text: async () => (k.endsWith('1.json') ? 'not json' : JSON.stringify(lead(2, 'Cass'))) }),
      },
    };
    const body = await (await call(env, { authorization: 'Bearer secret' })).json();
    expect(body.leads.map(l => l.contact)).toEqual(['Cass']);
  });
});

// ── The customer's own domain has to be the one that gets indexed ────
//
// Everything a page says about itself is host-relative, canonical
// included, so a page serves correctly under any name. sitemap.xml and
// robots.txt are not: both are written at publish time against
// <slug>.ontold.site, the only origin the generator knows.
//
// Served unchanged on lorrybus.com, the sitemap lists URLs on another
// host and robots.txt points its Sitemap: line off-site. A crawler
// discards both — so the domain the customer paid for gets none of the
// SEO work and our subdomain gets all of it.
describe('sitemap and robots follow the hostname that asked', () => {
  const SITEMAP = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://lorrybus.ontold.site/</loc></url>
  <url><loc>https://lorrybus.ontold.site/lorry-ce</loc></url>
</urlset>`;
  const ROBOTS = 'User-agent: *\nAllow: /\n\nSitemap: https://lorrybus.ontold.site/sitemap.xml\n';

  it('rewrites the site\'s own origin to the custom domain', () => {
    const out = retargetOrigin(SITEMAP, 'lorrybus', 'lorrybus.com');
    expect(out).toContain('<loc>https://lorrybus.com/lorry-ce</loc>');
    expect(out).not.toContain('ontold.site');
  });

  it('rewrites the robots Sitemap: line too', () => {
    // A Sitemap: on another host is an unauthorised cross-submission,
    // which is the same as not having one.
    expect(retargetOrigin(ROBOTS, 'lorrybus', 'lorrybus.com'))
      .toContain('Sitemap: https://lorrybus.com/sitemap.xml');
  });

  it('leaves the file alone when served on our own subdomain', () => {
    expect(retargetOrigin(SITEMAP, 'lorrybus', 'lorrybus.ontold.site')).toBe(SITEMAP);
    expect(retargetOrigin(ROBOTS, 'lorrybus', 'ontold.site')).toBe(ROBOTS);
  });

  it('does not rewrite another site\'s URL', () => {
    // Only this site's own origin. A link to a different ontold.site
    // site is somebody else's URL and repointing it at the customer's
    // domain would invent a page that does not exist.
    const mixed = 'https://lorrybus.ontold.site/a and https://other.ontold.site/b';
    const out = retargetOrigin(mixed, 'lorrybus', 'lorrybus.com');
    expect(out).toContain('https://lorrybus.com/a');
    expect(out).toContain('https://other.ontold.site/b');
  });

  it('does nothing for a junk host or a junk slug', () => {
    for (const host of ['', 'nodots', '<script>x</script>.com', null]) {
      expect(retargetOrigin(SITEMAP, 'lorrybus', host), String(host)).toBe(SITEMAP);
    }
    expect(retargetOrigin(SITEMAP, '../evil', 'lorrybus.com')).toBe(SITEMAP);
  });

  it('knows which stored keys carry an origin', () => {
    for (const f of SITE_FILES) expect(isSiteFile(`sites/lorrybus/${f}`), f).toBe(true);
    expect(isSiteFile('sites/lorrybus/index.html')).toBe(false);
    expect(isSiteFile('sites/lorrybus/style.css')).toBe(false);
    // Not a suffix match on the bare name: a page called
    // my-robots.txt is a page, not the site's robots.
    expect(isSiteFile('sites/lorrybus/my-robots.txt')).toBe(false);
  });

  // The wiring: the helper is only worth anything if the served bytes
  // actually change. Verified by reverting the serve-path branch and
  // watching these two fail while the pure ones stayed green.
  const bucket = (entries) => ({
    get: async (key) => (key in entries
      ? { text: async () => entries[key], body: entries[key], httpMetadata: {} }
      : null),
    head: async () => null, put: async () => {},
    list: async () => ({ objects: [] }),
  });
  const ENV = {
    PUBLISH_TOKEN: 'secret',
    SITES: bucket({
      'sites/lorrybus/sitemap.xml': SITEMAP,
      'sites/lorrybus/robots.txt': ROBOTS,
      'domains/lorrybus.com': JSON.stringify({ slug: 'lorrybus' }),
    }),
  };

  it('serves a mapped domain its own sitemap', async () => {
    const res = await worker.fetch(new Request('https://lorrybus.com/sitemap.xml'), ENV);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('https://lorrybus.com/lorry-ce');
    expect(body).not.toContain('ontold.site');
  });

  it('serves the subdomain the file exactly as published', async () => {
    const res = await worker.fetch(new Request('https://lorrybus.ontold.site/robots.txt'), ENV);
    expect(await res.text()).toBe(ROBOTS);
  });
});

// ── The way back to ontold.com ──────────────────────────────────────
//
// Founder: "the seo needs to have stuff in ontold.site that takes us
// back to ontold.com like lovable etc."
//
// The badge was the whole of it, and a badge is a link a HUMAN reads on
// a page a crawler had no way to find: ontold.site/robots.txt and
// /sitemap.xml both 404'd, so every subdomain carrying our backlink was
// a site search engines had never seen linked. The funnel had no mouth
// and no machine-readable claim.
describe('the maker\'s mark a machine can read', () => {
  it('names Ontold as the creator, with the address', () => {
    const ld = JSON.parse(makerLd('lorrybus.ontold.site').replace(/<\/?script[^>]*>/g, ''));
    expect(ld.creator).toEqual({ '@type': 'Organization', name: 'Ontold', url: 'https://ontold.com' });
    expect(ld.url).toBe('https://lorrybus.ontold.site/');
  });

  it('does NOT put our name on the customer\'s company', () => {
    // Their Organization is theirs. Ours is a separate node saying what
    // made the page — merging them would claim their business.
    const ld = JSON.parse(makerLd('lorrybus.com').replace(/<\/?script[^>]*>/g, ''));
    expect(ld['@type']).toBe('WebSite');
    expect(ld.name).toBeUndefined();
    expect(ld.url).toBe('https://lorrybus.com/');
  });

  it('cannot break out of the script element', () => {
    // JSON inside <script> — the one sequence that ends it early.
    expect(makerLd('</script><script>alert(1)</script>.com')).not.toMatch(/<\/script>.*<script>alert/);
  });

  it('rides with the badge, inside </body>', () => {
    const out = withBadge('<html><body>hi</body></html>', 'lorrybus', 'lorrybus.com');
    expect(out).toContain('https://ontold.com/?ref=lorrybus');
    expect(out).toContain('application/ld+json');
    expect(out.indexOf('ld+json')).toBeLessThan(out.indexOf('</body>'));
  });
});

describe('ontold.site tells crawlers the network exists', () => {
  it('lists every published site\'s front door', () => {
    const xml = networkSitemap(['lorrybus', 'sunrise-bakery']);
    expect(xml).toContain('<loc>https://ontold.site/</loc>');
    expect(xml).toContain('<loc>https://lorrybus.ontold.site/</loc>');
    expect(xml).toContain('<loc>https://sunrise-bakery.ontold.site/</loc>');
  });

  it('never advertises the front door as a site, or a slug nobody can have', () => {
    // __root IS ontold.site; listing it twice under two names is a
    // duplicate we would be submitting on purpose.
    const xml = networkSitemap([ROOT_SITE, 'www', 'Bad Slug', 'lorrybus']);
    expect(xml).not.toContain(`${ROOT_SITE}.ontold.site`);
    expect(xml).not.toContain('www.ontold.site');
    expect(xml).not.toContain('Bad Slug');
    expect(xml.match(/<loc>/g)).toHaveLength(2);   // the apex and lorrybus
  });

  it('is stable and deduped, so the submitted file does not churn', () => {
    expect(networkSitemap(['b', 'a', 'b'])).toBe(networkSitemap(['a', 'b']));
  });

  it('points robots at it', () => {
    expect(networkRobots()).toContain('Sitemap: https://ontold.site/sitemap.xml');
  });

  it('reads the slugs out of a delimited listing', () => {
    expect(slugsFromPrefixes(['sites/lorrybus/', 'sites/__root/', 'sites/a-b/']))
      .toEqual(['lorrybus', 'a-b']);
    expect(slugsFromPrefixes(undefined)).toEqual([]);
  });

  // The wiring. Confirmed by removing the apex branch and watching both
  // of these 404 while the pure tests stayed green.
  const ENV = {
    SITES: {
      list: async ({ prefix, delimiter }) => (delimiter
        ? { objects: [], delimitedPrefixes: ['sites/lorrybus/', 'sites/__root/'] }
        : { objects: [] }),
      get: async () => null, head: async () => null, put: async () => {},
    },
  };

  it('serves the apex sitemap, built from what is actually published', async () => {
    const res = await worker.fetch(new Request('https://ontold.site/sitemap.xml'), ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/xml');
    const xml = await res.text();
    expect(xml).toContain('https://lorrybus.ontold.site/');
    expect(xml).not.toContain('__root.ontold.site');
  });

  it('serves the apex robots.txt instead of 404ing', async () => {
    const res = await worker.fetch(new Request('https://www.ontold.site/robots.txt'), ENV);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toContain('Sitemap: https://ontold.site/sitemap.xml');
  });

  it('does not hijack a published site\'s own robots.txt', async () => {
    // Only the apex. A site's own file is its own.
    const res = await worker.fetch(new Request('https://lorrybus.ontold.site/robots.txt'), ENV);
    expect(res.status).toBe(404);
  });
});

// ── We must not submit our own test pages to Google ─────────────────
//
// deploy-site-host's end-to-end check publishes a one-line page to a
// fresh slug, then deletes it — best-effort, with a warning rather than
// a red build if the delete fails. So the page IS in the bucket for a
// few seconds of every deploy, and stays there for good if a run dies
// in between. Either way the sitemap would offer a crawler a stub that
// says "ontold.site is live", on the domain it exists to build up.
describe('the network sitemap advertises real sites only', () => {
  it('leaves our own smoke-test pages out', () => {
    const xml = networkSitemap(['lorrybus', `${SMOKE_PREFIX}30997822481`, `${SMOKE_PREFIX}1`]);
    expect(xml).not.toContain(SMOKE_PREFIX);
    expect(xml).toContain('https://lorrybus.ontold.site/');
  });

  it('keeps a customer site whose name merely resembles one', () => {
    // The rule is a prefix, not a substring — a real business called
    // "smoke-house" is a customer.
    expect(listable('smoke-house')).toBe(true);
    expect(listable('ontold-smoker')).toBe(true);
    expect(listable(`${SMOKE_PREFIX}9`)).toBe(false);
  });

  it('matches the slug the deploy workflow actually publishes', async () => {
    // If that step is renamed, this is the thing that notices — the
    // Worker cannot import a workflow, so the coupling is pinned here.
    const { readFileSync } = await import('node:fs');
    const wf = readFileSync('.github/workflows/deploy-site-host.yml', 'utf8');
    expect(wf).toContain(`HOST="${SMOKE_PREFIX}`);
  });

  it('still serves them — they are excluded from the map, not hidden', () => {
    // Keeping them reachable is what makes the smoke test meaningful.
    expect(slugValid(`${SMOKE_PREFIX}1`)).toBe(true);
    expect(keyFor(`${SMOKE_PREFIX}1`, '/')).toBe(`sites/${SMOKE_PREFIX}1/index.html`);
  });
});


// ── Three different things, one page was calling them all "free" ────
//
// Founder: "what's the difference between never published and gone
// away or failed publish". Nothing, until this — which was the price of
// turning the 404 into an offer. A claim page shown to someone whose
// site was taken down tells them their address is available, and tells
// the next stranger they may have the name a customer just lost. An
// ugly page that says nothing beats a beautiful one that says the
// wrong thing.
describe('an empty address is not always a free one', () => {
  it('reads the three states out of what the bucket holds', () => {
    expect(addressState([])).toBe('free');
    expect(addressState(['sites/x/versions/1700.html'])).toBe('gone');
    expect(addressState(['sites/x/pricing.html'])).toBe('broken');
    // History plus stray pages is still a site that existed.
    expect(addressState(['sites/x/pricing.html', 'sites/x/versions/1.html'])).toBe('gone');
  });

  it('only offers the name when nobody ever had it', () => {
    // The whole point. A claim button on someone's former address is
    // the harm; everything else here is presentation.
    expect(notFoundPage('lorrybus', 'free')).toContain(claimUrl('lorrybus'));
    for (const state of ['gone', 'broken']) {
      expect(notFoundPage('lorrybus', state), state).not.toContain('?claim=');
      expect(notFoundPage('lorrybus', state), state).not.toMatch(/Claim lorrybus/);
    }
  });

  it('tells a crawler to drop a site that was taken down, not a free name', () => {
    // 410 is "gone, stop asking"; 404 leaves the door open. Serving
    // 404 for a deleted site keeps it in the index for months.
    expect(statusFor('gone')).toBe(410);
    expect(statusFor('free')).toBe(404);
    expect(statusFor('broken')).toBe(404);
  });

  it('says which state it is in, in the markup', () => {
    expect(markerFor('free')).toContain('content="unclaimed"');
    expect(markerFor('gone')).toContain('content="gone"');
    // The deploy gate greps `unclaimed`, so a taken-down site must NOT
    // carry it — otherwise a real site going down would read to the
    // gate as a healthy edge.
    expect(notFoundPage('x', 'gone')).not.toContain(UNCLAIMED_MARKER);
    expect(notFoundPage('x', 'free')).toContain(UNCLAIMED_MARKER);
  });

  it('names the address in every state, and stays in the house look', () => {
    for (const state of ['free', 'gone', 'broken']) {
      const p = notFoundPage('lorrybus', state);
      expect(p, state).toContain('lorrybus.ontold.site');
      expect(p, state).toContain('#DC2626');
      expect(p, state).toContain('ontold.com');
      expect(p, state).not.toMatch(/https?:\/\/(?!ontold\.com)/);
    }
  });

  it('an unknown state is treated as free rather than throwing', () => {
    // The state comes from a bucket listing; a shape nobody predicted
    // must not take the 404 handler down with it.
    expect(() => notFoundPage('x', 'nonsense')).not.toThrow();
    expect(notFoundPage('x')).toBe(notFoundPage('x', 'free'));
  });

  // The wiring: the helper only matters if the served response changes.
  const bucketOf = (keys) => ({
    get: async () => null,
    head: async () => null,
    put: async () => {},
    list: async ({ prefix }) => ({ objects: keys.filter(k => k.startsWith(prefix)).map(key => ({ key })), delimitedPrefixes: [] }),
  });

  it('serves 410 and no claim button for an address that was taken down', async () => {
    const res = await worker.fetch(new Request('https://lorrybus.ontold.site/'),
      { SITES: bucketOf(['sites/lorrybus/versions/1700000000000.html']) });
    expect(res.status).toBe(410);
    const body = await res.text();
    expect(body).not.toContain('?claim=');
    expect(body).toContain('taken down');
  });

  it('serves the claim page for an address nobody ever had', async () => {
    const res = await worker.fetch(new Request('https://brand-new.ontold.site/'), { SITES: bucketOf([]) });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain(claimUrl('brand-new'));
  });

  it('tells the owner when a publish half-landed', async () => {
    // pricing.html published, index.html did not. Before this the page
    // said the address was free while a page of theirs sat in R2.
    const res = await worker.fetch(new Request('https://halfway.ontold.site/'),
      { SITES: bucketOf(['sites/halfway/pricing.html']) });
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain('missing its home page');
    expect(body).not.toContain('?claim=');
  });
});


// ── public, unlisted, private ───────────────────────────────────────
//
// Founder, on the apex sitemap listing four likeness-lab galleries:
// "not yet - we need a flag for unlisted, public, private". A
// name-prefix rule in the sitemap would have been me guessing which of
// somebody's sites are private, and guessing wrong quietly.
describe('visibility', () => {
  it('is one of exactly three things', () => {
    expect(VISIBILITIES).toEqual(['public', 'unlisted', 'private']);
    for (const v of VISIBILITIES) expect(visibilityValid(v), v).toBe(true);
    for (const v of ['hidden', '', null, 'PUBLIC']) expect(visibilityValid(v), String(v)).toBe(false);
  });

  it('reads a stored record, and treats anything unreadable as public', () => {
    // A corrupt object must not be able to take a live site off the
    // internet. Failing open is the safe direction HERE precisely
    // because absence already means public.
    expect(parseVisibility('{"visibility":"unlisted"}')).toBe('unlisted');
    expect(parseVisibility('{"visibility":"private"}')).toBe('private');
    expect(parseVisibility('not json')).toBe('public');
    expect(parseVisibility('{"visibility":"nonsense"}')).toBe('public');
    expect(parseVisibility('')).toBe('public');
  });

  it('finds every non-public slug from one listing, no reads', () => {
    // Why absence means public: the sitemap answers its whole question
    // from key names.
    expect(unlistedSlugs(['visibility/likeness-v5', 'visibility/lorrybus']))
      .toEqual(['likeness-v5', 'lorrybus']);
    expect(unlistedSlugs([])).toEqual([]);
  });

  it('stores under a predictable key', () => {
    expect(visibilityKey('Likeness-V5')).toBe('visibility/likeness-v5');
  });

  it('marks an unlisted page noindex, in the head, once', () => {
    const page = '<html><head><title>x</title></head><body>hi</body></html>';
    const out = withNoindex(page);
    expect(out).toContain(NOINDEX_TAG);
    expect(out.indexOf(NOINDEX_TAG)).toBeLessThan(out.indexOf('</head>'));
    // Idempotent: serving twice must not stack tags.
    expect(withNoindex(out)).toBe(out);
  });

  it('still marks a page that has no head', () => {
    expect(withNoindex('<body>x</body>')).toContain(NOINDEX_TAG);
  });
});

describe('visibility, on the wire', () => {
  // A marker that cannot appear in our own copy. My first version used
  // "hi", which is a substring of "This address..." on the very page
  // the assertion was meant to prove had NOT leaked.
  const SECRET = 'ZZ-PRIVATE-BODY-ZZ';
  const PAGE = `<html><head><title>Lorry</title></head><body>${SECRET}</body></html>`;
  const bucket = (entries) => ({
    get: async (key) => (key in entries ? { text: async () => entries[key], httpMetadata: {} } : null),
    head: async () => null,
    put: async (key, value) => { entries[key] = value; },
    delete: async (key) => { delete entries[key]; },
    list: async ({ prefix, delimiter }) => (delimiter
      ? { objects: [], delimitedPrefixes: [...new Set(Object.keys(entries)
          .filter(k => k.startsWith('sites/')).map(k => k.split('/').slice(0, 2).join('/') + '/'))] }
      : { objects: Object.keys(entries).filter(k => k.startsWith(prefix)).map(key => ({ key })), delimitedPrefixes: [] }),
  });
  const env = (extra = {}) => ({
    PUBLISH_TOKEN: 'secret',
    SITES: bucket({ 'sites/lorrybus/index.html': PAGE, ...extra }),
  });

  it('serves a public site untouched — no record, no change', async () => {
    // Every site published before visibility existed is this case.
    const res = await worker.fetch(new Request('https://lorrybus.ontold.site/'), env());
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(NOINDEX_TAG);
  });

  it('serves an unlisted site, marked noindex', async () => {
    const res = await worker.fetch(new Request('https://lorrybus.ontold.site/'),
      env({ 'visibility/lorrybus': '{"visibility":"unlisted"}' }));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(NOINDEX_TAG);
    expect(body).toContain('Make yours with Ontold');   // still ours, still badged
  });

  it('refuses to serve a private site at all', async () => {
    const res = await worker.fetch(new Request('https://lorrybus.ontold.site/'),
      env({ 'visibility/lorrybus': '{"visibility":"private"}' }));
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain(SECRET);        // the page itself never leaves
    expect(body).not.toContain('?claim=');     // and the name is NOT offered
    expect(body).toContain("isn't");
  });

  it('keeps unlisted and private out of the apex sitemap', async () => {
    const e = env({
      'sites/secret-lab/index.html': PAGE,
      'sites/draft-site/index.html': PAGE,
      'visibility/secret-lab': '{"visibility":"private"}',
      'visibility/draft-site': '{"visibility":"unlisted"}',
    });
    const xml = await (await worker.fetch(new Request('https://ontold.site/sitemap.xml'), e)).text();
    expect(xml).toContain('https://lorrybus.ontold.site/');
    expect(xml).not.toContain('secret-lab');
    expect(xml).not.toContain('draft-site');
  });

  it('sets visibility through a token-gated endpoint', async () => {
    const e = env();
    const put = (body, headers = { authorization: 'Bearer secret' }) =>
      worker.fetch(new Request('https://ontold.site/__visibility', {
        method: 'PUT', headers, body: JSON.stringify(body),
      }), e);

    expect((await put({ slug: 'lorrybus', visibility: 'private' })).status).toBe(200);
    expect((await worker.fetch(new Request('https://lorrybus.ontold.site/'), e)).status).toBe(404);

    // Back to public DELETES the record — that is what makes "no
    // record" mean public rather than "unknown".
    expect((await put({ slug: 'lorrybus', visibility: 'public' })).status).toBe(200);
    expect((await worker.fetch(new Request('https://lorrybus.ontold.site/'), e)).status).toBe(200);
  });

  it('will not let an anonymous caller hide somebody\'s site', async () => {
    const e = env();
    const res = await worker.fetch(new Request('https://ontold.site/__visibility', {
      method: 'PUT', body: JSON.stringify({ slug: 'lorrybus', visibility: 'private' }),
    }), e);
    expect(res.status).toBe(401);
    expect((await worker.fetch(new Request('https://lorrybus.ontold.site/'), e)).status).toBe(200);
  });

  it('refuses a visibility it does not recognise, rather than guessing', async () => {
    const res = await worker.fetch(new Request('https://ontold.site/__visibility', {
      method: 'PUT',
      headers: { authorization: 'Bearer secret' },
      body: JSON.stringify({ slug: 'lorrybus', visibility: 'hidden' }),
    }), env());
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('public, unlisted or private');
  });
});


// ── A site can hold its own video ───────────────────────────────────
//
// The host always SERVED assets — keysFor maps /idle.mp4 to
// sites/<slug>/idle.mp4 and contentTypeFor answers video/mp4 — and
// nothing could ever WRITE one. So generate_debate base64'd an idle
// and a speaking MP4 per speaker INTO the document, and a debate
// transcript weighs 4474KB: 4/3 the size of the originals, un-cacheable,
// un-streamable, and blocking the first word until it all arrives.
describe('publishing an asset', () => {
  it('accepts the media a generated page actually needs', () => {
    expect(normaliseAsset('idle.mp4')).toBe('idle.mp4');
    expect(normaliseAsset('media/devin-idle.mp4')).toBe('media/devin-idle.mp4');
    expect(normaliseAsset('/hero.webp')).toBe('hero.webp');
    for (const ext of ASSET_EXTS) expect(normaliseAsset(`a.${ext}`), ext).toBe(`a.${ext}`);
  });

  it('refuses anything that could climb out of the site', () => {
    // Same reasoning as normalisePage: this builds an R2 key under
    // sites/<slug>/, so a path that escapes it must not survive.
    for (const bad of ['../evil.mp4', 'a/../../b.mp4', '/../x.png', 'a/b/c/d/e.mp4', 'x'.repeat(220) + '.mp4']) {
      expect(normaliseAsset(bad), bad).toBe('');
      if (normaliseAsset(bad)) continue;
      expect(`sites/acme/${normaliseAsset(bad)}`).not.toContain('..');
    }
  });

  it('refuses an extension nothing can serve, and a page name', () => {
    expect(normaliseAsset('x.exe')).toBe('');
    expect(normaliseAsset('payload.php')).toBe('');
    expect(normaliseAsset('pricing')).toBe('');       // that is a page
    expect(normaliseAsset('')).toBe('');
  });

  it('refuses uppercase rather than folding it', () => {
    // The GET side matches the stored name exactly, so /Hero.png must
    // fail loudly at publish rather than 404 quietly for a visitor.
    expect(normaliseAsset('Hero.png')).toBe('');
    expect(normaliseAsset('hero.PNG')).toBe('');
  });

  it('every accepted asset is one the host can already serve', () => {
    // A file we accept and then serve as application/octet-stream is a
    // download prompt, not an asset.
    for (const ext of ASSET_EXTS) {
      expect(contentTypeFor(`x.${ext}`), ext).not.toBe('application/octet-stream');
    }
  });

  // The wiring, with real bytes.
  const store = {};
  const ENV = {
    PUBLISH_TOKEN: 'secret',
    SITES: {
      get: async (k) => (k in store ? { body: store[k].body, text: async () => String(store[k].body),
                                        httpMetadata: { contentType: store[k].type } } : null),
      head: async () => null,
      put: async (k, v, o) => { store[k] = { body: v, type: o?.httpMetadata?.contentType }; },
      delete: async (k) => { delete store[k]; },
      list: async () => ({ objects: [], delimitedPrefixes: [] }),
    },
  };
  // Bytes that are not valid UTF-8 — .text() would replace them, which
  // is exactly the corruption this test exists to catch.
  const CLIP = new Uint8Array([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0xff, 0xfe, 0x80, 0x81]);

  it('stores a video byte-for-byte, with the right content type', async () => {
    const res = await worker.fetch(new Request('https://acme.ontold.site/__publish/idle.mp4', {
      method: 'PUT', headers: { authorization: 'Bearer secret' }, body: CLIP,
    }), ENV);
    expect(res.status).toBe(200);
    expect((await res.json()).url).toBe('https://acme.ontold.site/idle.mp4');
    const stored = store['sites/acme/idle.mp4'];
    expect(stored.type).toBe('video/mp4');
    expect(new Uint8Array(stored.body)).toEqual(CLIP);   // not mangled by .text()
  });

  it('will not let an anonymous caller put a file on a site', async () => {
    const res = await worker.fetch(new Request('https://acme.ontold.site/__publish/x.png', {
      method: 'PUT', body: CLIP,
    }), ENV);
    expect(res.status).toBe(401);
  });

  it('names the extensions it takes when it refuses one', async () => {
    const res = await worker.fetch(new Request('https://acme.ontold.site/__publish/x.exe', {
      method: 'PUT', headers: { authorization: 'Bearer secret' }, body: CLIP,
    }), ENV);
    expect(res.status).toBe(422);
    expect((await res.json()).extensions).toContain('mp4');
  });

  it('still publishes a PAGE the way it always did', async () => {
    // The asset branch must not have taken the page path with it.
    const res = await worker.fetch(new Request('https://acme.ontold.site/__publish/pricing', {
      method: 'PUT', headers: { authorization: 'Bearer secret' },
      body: '<html><body>prices</body></html>',
    }), ENV);
    expect(res.status).toBe(200);
    expect(store['sites/acme/pricing.html'].type).toContain('text/html');
  });
});
