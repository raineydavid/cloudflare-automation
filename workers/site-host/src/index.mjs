/**
 * ontold-site-host — serves every published Ontold site at
 * https://<slug>.ontold.site from R2.
 *
 * Why this exists (founder, 2026-07-24): published Ontold sites must
 * live like a THIRD PARTY's would — on Ontold's own infrastructure,
 * not inside the WorkAIs GitHub org. A Cloudflare Worker on the
 * *.ontold.site wildcard route, reading from the `ontold-sites` R2
 * bucket, also erases the GitHub-Pages per-site certificate
 * provisioning lag (the ERR_CERT_COMMON_NAME_INVALID window every
 * first publish hit): Cloudflare's wildcard edge cert covers every
 * slug the instant it exists.
 *
 * Use cases:
 *  - GET https://sunrise-bakery.ontold.site/          → the site
 *  - GET https://sunrise-bakery.ontold.site/anything  → asset if
 *    stored, else the site's index (SPA-friendly fallback)
 *  - GET https://lorrybus.com/ (a mapped custom domain) → the mapped
 *    site; custom-hostname traffic reaches this Worker via the zone's
 *    fallback origin + catch-all route, Host intact
 *  - PUT /__publish with the publish token             → write a site
 *    (the Ontold app's publish rung calls this; one R2 write = live)
 *  - PUT/DELETE /__domain with the publish token       → map/unmap a
 *    customer domain to a slug (attach-domain workflow calls this)
 *
 * Key layout in R2 (bucket `ontold-sites`, binding SITES):
 *  sites/<slug>/index.html            — the live page
 *  sites/<slug>/versions/<ts>.html    — every prior publish (history)
 *
 * Config:
 *  PUBLISH_TOKEN (secret) — bearer the Ontold API presents on PUT.
 *    Serving is public; WRITING requires this. Set via the deploy
 *    workflow or `wrangler secret put PUBLISH_TOKEN`.
 *
 * Testing without altering data (house rule): every exported helper is
 * pure; site-host.test.mjs covers slug/key/content-type logic with no
 * bucket involved.
 */

import { isRootHost, landingPage } from './landing.mjs';
import { notFoundPage, addressState, statusFor } from './notFound.mjs';
import { visibilityKey, visibilityValid, parseVisibility, unlistedSlugs, withNoindex } from './visibility.mjs';
export { visibilityKey, visibilityValid, parseVisibility, unlistedSlugs, withNoindex, NOINDEX_TAG, VISIBILITIES } from './visibility.mjs';
export { notFoundPage, claimUrl, UNCLAIMED_MARKER, addressState, statusFor, markerFor } from './notFound.mjs';

/** The apex's own site, stored like any other but unclaimable. The
 *  front door is PUBLISHED FROM ONTOLD (founder: "not sure why we can't
 *  create the page from the ontold platform") rather than hand-written
 *  here — the platform's job is making pages, so its own front door
 *  should be one of them, and improving it should mean talking to
 *  Ontold, not editing CSS in a Worker. landing.mjs stays only as the
 *  floor for before that first publish exists. */
export const ROOT_SITE = '__root';

/** Slugs a visitor may never claim by registering a subdomain. */
const RESERVED = new Set([ROOT_SITE, 'www']);

/** Extract the site slug from a request Host header. Returns null for
 *  the apex, www, reserved names, or a host outside ontold.site. */
export function slugFromHost(host) {
  const h = (host || '').toLowerCase().split(':')[0];
  const suffix = '.ontold.site';
  if (!h.endsWith(suffix)) return null;
  const slug = h.slice(0, -suffix.length);
  if (!slug || RESERVED.has(slug)) return null;
  // A real DNS label, not merely "no dots". The old rule accepted
  // anything dotless, and the slug is interpolated into notFoundPage —
  // so a Host of `<script>x</script>.ontold.site` came back as a slug
  // and went into the 404 markup verbatim. Reaching that needs a
  // spoofed Host, which is why it was low severity rather than none;
  // it is also a value that can never name a site, because no such
  // subdomain can exist. Rejecting it here removes the class.
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) return null;
  return slug;
}

/** Which stored site a request is for: the apex and www resolve to the
 *  reserved root site, every other host to its own slug. */
export function siteFor(host) {
  return isRootHost(host) ? ROOT_SITE : slugFromHost(host);
}

/**
 * May a foreign hostname be MAPPED to a site (the custom-domain lane —
 * lorrybus.com serving the lorrybus site)? Anything on our own suffix
 * must use its subdomain directly, never a mapping — a mapping for
 * other.ontold.site would let one site impersonate another. Beyond
 * that: a real FQDN, lowercase, with at least one dot.
 */
export function customHostValid(host) {
  const h = (host || '').toLowerCase().split(':')[0];
  if (!h || h.length > 253) return false;
  if (h === 'ontold.site' || h.endsWith('.ontold.site')) return false;
  if (!h.includes('.')) return false;
  return h.split('.').every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l));
}

/** R2 key holding a custom hostname's mapping to its slug. */
export const domainKey = (host) => `domains/${String(host).toLowerCase().split(':')[0]}`;

/**
 * Lead intake — the founder's "our agents can call them or help them
 * do it, rather than just go direct to the site." A published page
 * POSTs {want, contact} to its OWN origin's /__lead; the lead lands
 * in R2 under the site that earned it, where the follow-up agents
 * read. Same-origin by construction: no keys in the page, no CORS,
 * works identically on ontold.site subdomains and custom domains.
 */
export function leadValid(body) {
  if (!body || typeof body !== 'object') return false;
  // The honeypot: a hidden field humans never see. Filled means bot;
  // the caller answers success and stores nothing — bots learn less
  // from a 200 than from a 400.
  if (body.website) return 'honeypot';
  const contact = String(body.contact || '').trim();
  if (contact.length < 3 || contact.length > 200) return false;
  if (!/^[a-z][a-z-]{1,39}$/.test(String(body.want || ''))) return false;
  return true;
}

/** R2 key for one lead: per-site inbox, time-ordered. */
export const leadKey = (slug, ts) => `leads/${slug}/${ts}.json`;

/**
 * The "Made with Ontold" badge — our answer to the edit-with-Lovable
 * corner pill. Injected AT SERVE TIME by this Worker rather than
 * baked into pages: every site past and future carries it uniformly,
 * and removing it later is a paid-plan flag flipped server-side, no
 * republish. Inline-styled (the CSP restricts neither styles nor
 * same-page anchors), house palette, links home with the referring
 * slug so the funnel knows which site earned the click.
 */
export function badgeHtml(slug) {
  const s = String(slug).replace(/[^a-z0-9-]/g, '');
  return `<a href="https://ontold.com/?ref=${s}" target="_blank" rel="noopener" `
    + `style="position:fixed;right:14px;bottom:14px;z-index:2147483000;font:600 12px/1 system-ui,sans-serif;`
    + `color:#e8e4dc;background:#0b0b0e;border:1px solid #c9a35c;border-radius:999px;`
    + `padding:7px 12px;text-decoration:none;opacity:.92">Make yours with Ontold</a>`;
}

/**
 * The same mark, in the form a machine reads.
 *
 * The badge is for a visitor. A crawler and an answer engine read
 * structured data, and they were being told nothing — every published
 * page credited the customer's business and no page anywhere said what
 * made it. A "Made with Ontold" that only a human can see earns us the
 * click and none of the standing.
 *
 * Its own node rather than folded into the page's Organization, because
 * the business on the page is the customer's and the tool that made the
 * page is ours: two separate true statements, and merging them would
 * put our name on their company.
 */
export function makerLd(host) {
  const h = String(host || '').toLowerCase().split(':')[0];
  return `<script type="application/ld+json">${JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    ...(customHostValid(h) || h.endsWith('ontold.site') ? { url: `https://${h}/` } : {}),
    creator: { '@type': 'Organization', name: 'Ontold', url: 'https://ontold.com' },
  }).replace(/</g, '\\u003c')}</script>`;
}

/** Inject the maker's mark — the badge a visitor clicks and the
 *  structured data a crawler indexes — just inside </body>.
 *  Pages without a </body> (fragments, assets) pass through untouched. */
export function withBadge(html, slug, host) {
  const i = html.lastIndexOf('</body>');
  if (i === -1) return html;
  return html.slice(0, i) + badgeHtml(slug) + makerLd(host) + html.slice(i);
}

/**
 * ontold.site's own robots and sitemap — the front-of-house SEO for the
 * whole network.
 *
 * Both 404'd. Every published site is a subdomain, and a subdomain a
 * crawler has never seen a link to is a site that does not exist as far
 * as search is concerned. So the pages carrying our backlink were the
 * pages least likely to be crawled — the funnel had no mouth.
 *
 * The sitemap is derived from the bucket rather than maintained, so it
 * cannot list a site that was never published or miss one that was. It
 * lists front doors only: every one of those pages carries the badge
 * and the maker's mark, which is the whole point of them being found.
 */
/** The prefix deploy-site-host's end-to-end check publishes under. */
export const SMOKE_PREFIX = 'ontold-smoke-';

/** Should a stored site be advertised to search engines?
 *
 *  Our own end-to-end test page must not be. It is live for a few
 *  seconds of every deploy before the job deletes it, and that deletion
 *  is best-effort — so a crawler timing the window, or any run that
 *  dies between the publish and the cleanup, puts a one-line stub in
 *  the sitemap of the domain the sitemap exists to build up. */
export function listable(slug) {
  return slugValid(slug) && !slug.startsWith(SMOKE_PREFIX);
}

export function networkSitemap(slugs) {
  const urls = ['https://ontold.site/',
    ...[...new Set(slugs.filter(listable))].sort().map((s) => `https://${s}.ontold.site/`)];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n')}
</urlset>
`;
}

export function networkRobots() {
  return 'User-agent: *\nAllow: /\n\nSitemap: https://ontold.site/sitemap.xml\n';
}

/** Slugs from one delimited R2 listing of `sites/`. */
export function slugsFromPrefixes(prefixes) {
  return (prefixes || [])
    .map((p) => String(p).replace(/^sites\//, '').replace(/\/$/, ''))
    .filter(slugValid);
}

/** Is this string a claimable site slug (a valid label, not reserved)? */
export function slugValid(slug) {
  return typeof slug === 'string'
    && !RESERVED.has(slug)
    && /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug);
}

/** R2 object key for a request path within a site. '/' → index.html;
 *  a path with an extension maps to the stored asset; extensionless
 *  paths fall back to index.html (SPA-style). */
export function keyFor(slug, pathname) {
  return keysFor(slug, pathname)[0];
}

/** Every R2 key a request could mean, best first.
 *
 *  A clean URL is what a real site has and what a crawler indexes, so
 *  `/pricing` tries `pricing.html` and `pricing/index.html` before it
 *  falls back to the site's index. A request WITH an extension is an
 *  asset: it resolves to exactly one key and 404s if that is missing,
 *  because answering a missing stylesheet with HTML is worse than
 *  answering with nothing. */
export function keysFor(slug, pathname) {
  const clean = (pathname || '/').replace(/\/+$/, '') || '/';
  if (clean === '/') return [`sites/${slug}/index.html`];
  if (/\.[a-z0-9]+$/i.test(clean)) return [`sites/${slug}${clean}`];
  return [
    `sites/${slug}${clean}.html`,
    `sites/${slug}${clean}/index.html`,
    `sites/${slug}/index.html`,
  ];
}

/** The site-level files a crawler asks for by name. */

/** A publish path turned into a key, or '' when it is not one.
 *
 *  Accepts `pricing`, `pricing.html`, `docs/api`, and the SITE_FILES
 *  allowlist. The R2 key is built from this, so a path that escapes
 *  the site's prefix must not survive. */
export const SITE_FILES = ['sitemap.xml', 'robots.txt'];

/**
 * Re-point a site-level file at the hostname that actually asked for it.
 *
 * The pages themselves are host-relative — canonical included — so they
 * serve correctly under any name. sitemap.xml and robots.txt are the
 * exception: both are written once at publish time against
 * `https://<slug>.ontold.site`, because that is the only origin the
 * generator knows.
 *
 * Served unchanged on a customer's own domain, that sitemap lists URLs
 * on a DIFFERENT host and that robots.txt points its `Sitemap:` line
 * off-site. A crawler discards both — so the domain the customer paid
 * for and put on the van gets none of the indexing work, and our
 * subdomain gets all of it.
 *
 * Rewritten at serve time rather than published twice: the stored
 * object stays the single record, and a domain attached months later
 * needs no republish. Only THIS site's own origin is rewritten — a link
 * to another ontold.site site is somebody else's URL and stays put.
 */
export function retargetOrigin(text, slug, host) {
  const h = String(host || '').toLowerCase().split(':')[0];
  // customHostValid is false for our own suffix, so serving on
  // <slug>.ontold.site is a no-op by construction.
  if (!customHostValid(h) || !slugValid(slug)) return text;
  return String(text).split(`https://${slug}.ontold.site`).join(`https://${h}`);
}

/** Is this key one of the site-level files that carries an origin? */
export function isSiteFile(key) {
  return SITE_FILES.some((f) => key === f || key.endsWith(`/${f}`));
}

export function normalisePage(path) {
  const raw = String(path || '').replace(/^\/+/, '');
  // A crawler asks for these by exact name, so they are published
  // verbatim. An allowlist rather than opening publish to arbitrary
  // extensions, which would let anything be written under a site.
  if (SITE_FILES.includes(raw)) return raw;
  const bare = raw.replace(/\.html$/i, '');
  if (!bare || bare.length > 200) return '';
  const parts = bare.split('/');
  if (parts.length > 4) return '';
  for (const p of parts) {
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(p)) return '';
  }
  return `${parts.join('/')}.html`;
}

/**
 * Assets a site may publish alongside its pages.
 *
 * The host has always SERVED these — keysFor maps /idle.mp4 to
 * sites/<slug>/idle.mp4 and contentTypeFor answers video/mp4 — but
 * nothing could ever WRITE one: normalisePage rejects any name with a
 * dot in it, and the publish allowlist held two files. So every
 * generated page had to inline its media as base64, and a debate
 * transcript is 4474KB because it carries an idle and a speaking MP4
 * per speaker at 4/3 the size of the original.
 *
 * That is not self-containment, it is a page that cannot be streamed,
 * cannot be cached separately, and has to finish downloading before
 * the first word is readable. Self-containment means the SITE depends
 * on nothing off its own origin, and an asset published to that origin
 * satisfies it.
 */
export const ASSET_EXTS = ['mp4', 'webm', 'webp', 'png', 'jpg', 'jpeg', 'gif',
                           'svg', 'ico', 'css', 'js', 'json', 'txt', 'woff2'];

/** An asset publish path turned into a key, or '' when it is not one.
 *
 *  Same shape as normalisePage and the same reason: this builds an R2
 *  key under the site's prefix, so a path that could escape it must not
 *  survive. Uppercase is rejected rather than folded, because the GET
 *  side matches the stored name exactly and a page linking /Hero.png
 *  should fail loudly at publish, not silently 404 for a visitor. */
export function normaliseAsset(path) {
  const raw = String(path || '').replace(/^\/+/, '');
  const ext = (raw.match(/\.([a-z0-9]+)$/) || [])[1];
  if (!ext || !ASSET_EXTS.includes(ext)) return '';
  if (raw.length > 200) return '';
  const parts = raw.split('/');
  if (parts.length > 4) return '';
  for (let i = 0; i < parts.length; i++) {
    const last = i === parts.length - 1;
    const ok = last
      ? /^[a-z0-9][a-z0-9-]{0,62}\.[a-z0-9]{1,8}$/.test(parts[i])
      : /^[a-z0-9][a-z0-9-]{0,62}$/.test(parts[i]);
    if (!ok) return '';
  }
  return parts.join('/');
}

/** Content-Type by extension — published sites are self-contained
 *  HTML, but a few asset types ride along. */
export function contentTypeFor(key) {
  const ext = (key.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase();
  return {
    html: 'text/html; charset=utf-8',
    css:  'text/css; charset=utf-8',
    js:   'text/javascript; charset=utf-8',
    json: 'application/json',
    xml:  'application/xml; charset=utf-8',
    jpg:  'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml',
    mp4:  'video/mp4', webm: 'video/webm', ico: 'image/x-icon',
    txt:  'text/plain; charset=utf-8',
    // A page may not fetch a font off-domain, but it may carry one on
    // its own — which is the only way a generated site gets real
    // typography under the self-containment rule.
    woff2: 'font/woff2',
  }[ext] ?? 'application/octet-stream';
}

/**
 * Headers every served response carries.
 *
 * What is being served here is MODEL-GENERATED markup on a domain we
 * own. Nothing had checked it and nothing had constrained it: no CSP,
 * no nosniff, no referrer policy, no framing rule.
 *
 * ## Why this CSP is deliberately partial
 *
 * The obvious `default-src 'self'` would break most of what we publish.
 * Self-contained pages are inline by construction — inline <style>,
 * often a small inline <script> for a menu or a smooth scroll, images
 * as data: URIs or from a remote host. A policy that blocked those
 * would take down sites that are already live, silently, and the first
 * report would come from a customer. Breaking a published page is a
 * worse outcome than the marginal hardening.
 *
 * So this sets only the directives that cost a legitimate page nothing:
 *
 *   object-src 'none'      plugins; no generated page has ever wanted one
 *   base-uri 'none'        a <base> tag repoints every relative URL on
 *                          the page at once — pure attack surface
 *   frame-ancestors 'none' clickjacking. Our own preview surfaces use
 *                          <iframe srcDoc>, never the live URL, so this
 *                          costs us nothing
 *   form-action 'self'     the one with teeth: a generated form cannot
 *                          post a visitor's details to a third-party
 *                          host. Same-origin is also exactly where lead
 *                          capture would land
 *   upgrade-insecure-requests
 *                          an http:// subresource on an https:// page
 *                          becomes https rather than mixed content
 *
 * script-src and img-src are LEFT OPEN on purpose. That is a real limit
 * of this policy, not an oversight: a page that runs script still runs
 * it. What it cannot do is frame-bait, hijack relative URLs, or
 * exfiltrate a form submission — and it is confined to its own
 * subdomain origin, which is not the app's.
 */
export const SECURITY_HEADERS = {
  'content-security-policy': [
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    'upgrade-insecure-requests',
  ].join('; '),
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'strict-transport-security': 'max-age=31536000',
};

/** Merge the security headers into a response's own headers. Callers
 *  keep control of content-type and caching; they cannot forget the
 *  rest. */
export function withSecurity(headers) {
  return { ...SECURITY_HEADERS, ...headers };
}

/** Did this publish ask to replace a live page?
 *
 *  Only an explicit, affirmative value counts. `?overwrite=0` and
 *  `?overwrite=false` read as "no" to a human, and a flag that means
 *  yes whenever it is merely PRESENT would turn both into a silent
 *  replacement — the exact accident the 409 exists to prevent. */
export function overwriteRequested(url) {
  const v = (url.searchParams.get('overwrite') || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

/** SHA-256 of a page, hex — the identity a republish is compared against.
 *
 *  WebCrypto rather than a cheap string hash: collisions here would
 *  mean a real edit silently not publishing, which is a far worse
 *  failure than the duplicate write this avoids. */
export async function contentHash(html) {
  const bytes = new TextEncoder().encode(html);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  /** Route: front door on the apex/www, public GET/HEAD serving of a
   *  published site on a slug, token-gated PUT publishing. */
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── Custom-domain admin: PUT/DELETE /__domain (token-gated) ──
    // The attach-domain workflow calls this after registering the
    // hostname with the edge; the mapping is one small R2 object, so
    // domains survive deploys and are versionless by design.
    if (url.pathname === '/__domain') {
      const auth = request.headers.get('authorization') || '';
      if (!env.PUBLISH_TOKEN || auth !== `Bearer ${env.PUBLISH_TOKEN}`) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      }
      if (!['PUT', 'DELETE'].includes(request.method)) {
        return new Response('method not allowed', { status: 405 });
      }
      let body = {};
      try { body = await request.json(); } catch { /* falls through to 422 */ }
      const host = String(body.host || '').toLowerCase();
      if (!customHostValid(host)) {
        return new Response(JSON.stringify({ error: 'not a mappable hostname', host }), { status: 422 });
      }
      if (request.method === 'DELETE') {
        await env.SITES.delete(domainKey(host));
        return new Response(JSON.stringify({ status: 'success', removed: host }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (!slugValid(body.slug)) {
        return new Response(JSON.stringify({ error: 'not a mappable slug', slug: body.slug ?? null }), { status: 422 });
      }
      await env.SITES.put(domainKey(host), JSON.stringify({ slug: body.slug, ts: Date.now() }), {
        httpMetadata: { contentType: 'application/json' },
      });
      return new Response(JSON.stringify({ status: 'success', host, slug: body.slug }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }

    // ── Visibility: PUT /__visibility (token-gated) ──
    // public/unlisted/private, set by whoever owns the site. Public
    // DELETES the record rather than storing one, which is what makes
    // "no record" mean public for every site published before this.
    if (url.pathname === '/__visibility') {
      const auth = request.headers.get('authorization') || '';
      if (!env.PUBLISH_TOKEN || auth !== `Bearer ${env.PUBLISH_TOKEN}`) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      }
      if (request.method !== 'PUT') return new Response('method not allowed', { status: 405 });
      let body = {};
      try { body = await request.json(); } catch { /* falls through to 422 */ }
      if (!slugValid(body.slug)) {
        return new Response(JSON.stringify({ error: 'not a site slug', slug: body.slug ?? null }), { status: 422 });
      }
      if (!visibilityValid(body.visibility)) {
        return new Response(JSON.stringify({
          error: 'visibility must be public, unlisted or private', got: body.visibility ?? null,
        }), { status: 422 });
      }
      if (body.visibility === 'public') {
        await env.SITES.delete(visibilityKey(body.slug));
      } else {
        await env.SITES.put(visibilityKey(body.slug), JSON.stringify({ visibility: body.visibility, ts: Date.now() }),
          { httpMetadata: { contentType: 'application/json' } });
      }
      return new Response(JSON.stringify({ status: 'success', slug: body.slug, visibility: body.visibility }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }

    // ── Lead inbox: GET /__leads, for whoever owns the site ──
    //
    // Leads were written and nothing could read them, which is the same
    // failure as a form posting nowhere: the site earns a customer and
    // the customer is invisible. Scoped to the host it is called on, so
    // one site's token never reads another's inbox.
    if (url.pathname === '/__leads' && request.method === 'GET') {
      const auth = request.headers.get('authorization') || '';
      if (!env.PUBLISH_TOKEN || auth !== `Bearer ${env.PUBLISH_TOKEN}`) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      }
      let owner = siteFor(url.hostname);
      if (!owner && customHostValid(url.hostname)) {
        const map = await env.SITES.get(domainKey(url.hostname));
        if (map) { try { owner = JSON.parse(await map.text()).slug || null; } catch { owner = null; } }
      }
      if (!owner) return new Response('not found', { status: 404 });
      const listing = await env.SITES.list({ prefix: `leads/${owner}/`, limit: 1000 });
      // Newest first — an inbox reads backwards. The key is the
      // timestamp, so sorting the keys sorts the leads.
      const keys = listing.objects.map((o) => o.key).sort().reverse().slice(0, 100);
      const leads = [];
      for (const key of keys) {
        const obj = await env.SITES.get(key);
        if (!obj) continue;
        try { leads.push(JSON.parse(await obj.text())); } catch { /* skip a corrupt one */ }
      }
      return new Response(JSON.stringify({ slug: owner, count: leads.length, leads }), {
        status: 200,
        headers: withSecurity({ 'content-type': 'application/json', 'cache-control': 'no-store' }),
      });
    }

    // ── Lead intake: POST /__lead from a page's OWN origin ──
    if (url.pathname === '/__lead' && request.method === 'POST') {
      let owner = siteFor(url.hostname);
      if (!owner && customHostValid(url.hostname)) {
        const map = await env.SITES.get(domainKey(url.hostname));
        if (map) { try { owner = JSON.parse(await map.text()).slug || null; } catch { owner = null; } }
      }
      if (!owner) return new Response('not found', { status: 404 });
      const raw = await request.text();
      if (raw.length > 2048) return new Response(JSON.stringify({ error: 'too large' }), { status: 422 });
      let body = {};
      try { body = JSON.parse(raw); } catch { /* falls through to 422 */ }
      const verdict = leadValid(body);
      if (verdict === 'honeypot') {
        return new Response(JSON.stringify({ status: 'success' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (!verdict) return new Response(JSON.stringify({ error: 'need contact and want' }), { status: 422 });
      const ts = Date.now();
      await env.SITES.put(leadKey(owner, ts), JSON.stringify({
        slug: owner,
        want: body.want,
        contact: String(body.contact).trim().slice(0, 200),
        note: String(body.note || '').slice(0, 500),
        host: url.hostname,
        at: new Date(ts).toISOString(),
      }), { httpMetadata: { contentType: 'application/json' } });
      return new Response(JSON.stringify({ status: 'success' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }

    // The apex resolves to the reserved __root site, so the front door
    // travels the SAME publish and serve path as every customer site —
    // it is a page Ontold makes, not a special case in this Worker.
    let slug = siteFor(url.hostname);
    // A host outside our suffix may be a customer's own domain: custom-
    // hostname traffic reaches this Worker with the original Host intact
    // (the zone's fallback-origin + catch-all route), and the mapping
    // written by /__domain says which site it serves.
    if (!slug && customHostValid(url.hostname)) {
      const map = await env.SITES.get(domainKey(url.hostname));
      if (map) {
        try { slug = JSON.parse(await map.text()).slug || null; } catch { slug = null; }
        if (slug && !slugValid(slug)) slug = null;
      }
    }
    if (!slug) return new Response('not found', { status: 404 });
    const isRoot = slug === ROOT_SITE;

    // ── Publish: PUT /__publish (Ontold API → here; one write = live) ──
    if (request.method === 'PUT' && (url.pathname === '/__publish' || url.pathname.startsWith('/__publish/'))) {
      const auth = request.headers.get('authorization') || '';
      if (!env.PUBLISH_TOKEN || auth !== `Bearer ${env.PUBLISH_TOKEN}`) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
      }
      // Subpages: PUT /__publish/<path> writes another page on the same
      // site. One segment or several, with or without .html — the GET
      // side resolves /pricing to pricing.html, so a site can publish
      // the clean URLs it wants to be indexed under. No slug claim and
      // no version history; the index remains the site of record.
      const rawSub = url.pathname === '/__publish' ? null
        : decodeURIComponent(url.pathname.slice('/__publish/'.length));
      // An asset first — a name with a real extension is never a page,
      // and normalisePage would strip nothing and reject the dot.
      const asset = rawSub === null ? null : normaliseAsset(rawSub);
      const sub = rawSub === null || asset ? null : normalisePage(rawSub);
      if (rawSub !== null && !asset && sub === '') {
        return new Response(JSON.stringify({
          error: 'path must be a page (<name>, .html optional) or an asset with a known extension',
          extensions: ASSET_EXTS,
        }), { status: 422 });
      }

      // Assets are BYTES. Reading an MP4 with .text() mangles it into
      // replacement characters and stores a file no player can open.
      if (asset) {
        const bytes = await request.arrayBuffer();
        // Larger than a page, because that is the point: a video that
        // had to be base64'd into the HTML cost 4/3 its size AND blocked
        // the first paint. 25MB is a clip, not a film.
        if (!bytes.byteLength || bytes.byteLength > 25 * 1024 * 1024) {
          return new Response(JSON.stringify({ error: 'empty or larger than 25MB' }), { status: 422 });
        }
        await env.SITES.put(`sites/${slug}/${asset}`, bytes, {
          httpMetadata: { contentType: contentTypeFor(asset) },
        });
        return new Response(JSON.stringify({
          status: 'success', url: `https://${slug}.ontold.site/${asset}`, bytes: bytes.byteLength,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }

      const html = await request.text();
      if (!html || html.length > 5 * 1024 * 1024) {
        return new Response(JSON.stringify({ error: 'empty or too large' }), { status: 422 });
      }
      if (sub) {
        // A sitemap served as text/html is a sitemap no crawler reads.
        await env.SITES.put(`sites/${slug}/${sub}`, html, {
          httpMetadata: { contentType: contentTypeFor(sub) },
        });
        return new Response(JSON.stringify({ status: 'success', url: `https://${slug}.ontold.site/${sub}` }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      // Taking a live slug must be DELIBERATE.
      //
      // Every publish went straight to sites/<slug>/index.html, so
      // whoever wrote last owned the name. That was survivable while a
      // person typed each slug into the app. It stopped being
      // survivable when ontold_publish landed: an agent pursuing a goal
      // picks slugs from the brief, and two runs of "a lead generation
      // site for driving instructors" pick the same one. The second
      // silently replaces the first customer's live page.
      //
      // Be exact about what this is: NOT authorization. There is no
      // user-identity system here (api/_requestAuth says so in as many
      // words — it is an anti-scraping gate), so any owner id would be
      // client-supplied and spoofable, and an owner.json keyed on one
      // would look like protection while providing none. That is worse
      // than the honest state, because people would trust it.
      //
      // What this IS: collision protection. It converts silently
      // clobbering a live site into a 409 that the caller must answer
      // by asking again with intent. It stops the accident, which is
      // the failure that will actually happen, and claims nothing about
      // the attack, which needs auth we do not have.
      const indexKey = `sites/${slug}/index.html`;
      const existing = await env.SITES.head(indexKey);
      if (existing && !overwriteRequested(url)) {
        return new Response(JSON.stringify({
          error: 'slug already published',
          slug,
          hint: 'choose another slug, or repeat with ?overwrite=1 to replace the live page',
        }), { status: 409, headers: { 'content-type': 'application/json' } });
      }

      // An unchanged republish writes NOTHING.
      //
      // Version history was append-only: every publish wrote
      // sites/<slug>/versions/<ts>.html and nothing ever removed one.
      // Fine at the rate a person clicks Publish. Not fine once
      // ontold_publish exists — an agent in a loop republishing an
      // identical page grows R2 without bound, billed to us, and the
      // history it grows records no change at all.
      //
      // Deduplicating is the fix rather than pruning, because pruning
      // means deleting a customer's history to save our money, and the
      // pathological case is not "too many versions" — it is "the same
      // version over and over". A history should record CHANGES. Two
      // identical publishes are one version, and saying so costs
      // nobody anything.
      const sha = await contentHash(html);
      if (existing?.customMetadata?.sha === sha) {
        return new Response(JSON.stringify({
          status: 'success',
          unchanged: true,
          url: `https://${slug}.ontold.site`,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      // History first, then the live pointer — a crash between the two
      // leaves the previous live page intact.
      const ts = Date.now();
      await env.SITES.put(`sites/${slug}/versions/${ts}.html`, html);
      await env.SITES.put(indexKey, html, {
        httpMetadata: { contentType: 'text/html; charset=utf-8' },
        // The dedup marker for the next publish. On the index rather
        // than a sidecar object so it can never drift from the page it
        // describes.
        customMetadata: { sha },
      });
      return new Response(JSON.stringify({ status: 'success', url: `https://${slug}.ontold.site`, version: ts }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed', { status: 405 });
    }

    // ── The network's front-of-house: ontold.site/robots.txt and
    //    /sitemap.xml, so the subdomains are discoverable at all ──
    if (isRoot && (url.pathname === '/sitemap.xml' || url.pathname === '/robots.txt')) {
      const map = url.pathname === '/sitemap.xml';
      let body = networkRobots();
      if (map) {
        // One delimited listing: the prefixes ARE the published slugs,
        // so this stays a single call however many sites exist.
        // Two listings, no reads: the prefixes are the published
        // slugs, and any slug with a visibility record is not public.
        const [listing, hidden] = await Promise.all([
          env.SITES.list({ prefix: 'sites/', delimiter: '/', limit: 1000 }),
          env.SITES.list({ prefix: 'visibility/', limit: 1000 }),
        ]);
        const notPublic = new Set(unlistedSlugs((hidden.objects || []).map((o) => o.key)));
        body = networkSitemap(slugsFromPrefixes(listing.delimitedPrefixes).filter((s) => !notPublic.has(s)));
      }
      return new Response(body, {
        status: 200,
        headers: withSecurity({
          'content-type': map ? 'application/xml; charset=utf-8' : 'text/plain; charset=utf-8',
          'cache-control': 'public, max-age=300',
        }),
      });
    }

    // The site's visibility, fetched ALONGSIDE the page rather than
    // before it, so the flag costs no added latency. No record means
    // public — which is why every site published before visibility
    // existed still serves exactly as it did.
    const visP = isRoot ? Promise.resolve(null) : env.SITES.get(visibilityKey(slug));

    let key = null;
    let obj = null;
    for (const candidate of keysFor(slug, url.pathname)) {
      obj = await env.SITES.get(candidate);
      if (obj) { key = candidate; break; }
    }

    const visObj = await visP;
    const visibility = visObj ? parseVisibility(await visObj.text()) : 'public';
    // Private serves nothing — not the page, and not the claim page
    // either: telling a stranger a private site's address is "free"
    // would invite them to take a name that is in use.
    if (visibility === 'private') {
      return new Response(notFoundPage(slug, 'private'), {
        status: 404,
        headers: withSecurity({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }),
      });
    }
    if (!obj) {
      // The floor: until Ontold has published the front door, the apex
      // still greets people properly instead of 404-ing. Any published
      // __root page supersedes this automatically.
      if (isRoot) {
        return new Response(landingPage(), {
          status: 200,
          headers: withSecurity({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' }),
        });
      }
      // Never published, taken down, or a publish that half-landed are
      // three different things to whoever is looking, and the bucket
      // can tell them apart: history outlives the live page, and a
      // subpage without an index is a publish that broke. Only the
      // first is an address anyone may be offered.
      const held = await env.SITES.list({ prefix: `sites/${slug}/`, limit: 4 });
      const state = addressState((held.objects || []).map((o) => o.key));
      return new Response(notFoundPage(slug, state), {
        status: statusFor(state),
        headers: withSecurity({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }),
      });
    }
    const contentType = obj.httpMetadata?.contentType || contentTypeFor(key);
    // HTML pages leave wearing the maker's mark; assets pass through.
    // Short edge/browser cache on both: republish shows within a
    // minute without a purge; sites are small enough that this is cheap.
    if (contentType.startsWith('text/html')) {
      let page = withBadge(await obj.text(), slug, url.hostname);
      // Unlisted means "reachable by link, findable by nobody". Out of
      // the sitemap is only half of that; a crawler following a shared
      // link would index it anyway without this.
      if (visibility === 'unlisted') page = withNoindex(page);
      return new Response(page, {
        status: 200,
        headers: withSecurity({ 'content-type': contentType, 'cache-control': 'public, max-age=60' }),
      });
    }
    // A sitemap and a robots.txt name their own origin. On a customer's
    // own domain that origin has to be theirs, or the crawler throws
    // both away.
    if (isSiteFile(key)) {
      return new Response(retargetOrigin(await obj.text(), slug, url.hostname), {
        status: 200,
        headers: withSecurity({ 'content-type': contentType, 'cache-control': 'public, max-age=60' }),
      });
    }
    return new Response(obj.body, {
      status: 200,
      headers: withSecurity({ 'content-type': contentType, 'cache-control': 'public, max-age=60' }),
    });
  },
};
