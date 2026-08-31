/**
 * An unclaimed address — the offer, not the error.
 *
 * Founder: *"our 404 page is fugly and should really be based on the
 * default site right — claim this one..."*
 *
 * Both halves. It was fugly: generic #111 on #eee with a coral link,
 * none of the brand tokens, no mark, no address bar — a page with no
 * relation to the site the visitor had just been looking at, on a
 * domain whose entire pitch is that the address IS the product.
 *
 * And it was the wrong page. Somebody who typed a name into
 * <name>.ontold.site and pressed Enter has done more than express
 * interest — they have NAMED THE BUSINESS. That is a higher-intent
 * moment than the front door, which only catches someone deleting a
 * subdomain out of curiosity. "Make yours at ontold.com" threw it away
 * and asked them to start again from a blank field.
 *
 * So the front door's signature element is inverted. There, the lock
 * snaps SHUT as the name is typed: this address exists and is already
 * secure. Here it stays OPEN and the address is theirs to take — the
 * same component saying the opposite thing, which is why it reads
 * instantly to anyone who has seen the other page.
 */

import { BRAND_CSS, MARK_SVG, lockSvg, esc } from './brand.mjs';

/**
 * The machine-readable "this address is free".
 *
 * deploy-site-host proves the edge is alive by asking for a slug that
 * cannot exist and checking it gets our 404. It used to grep the PROSE
 * — "hasn't been published" — so rewriting the copy on this page hung
 * the deploy for a minute and then failed it, which is exactly what
 * happened the first time I rewrote it.
 *
 * Copy is meant to change. The state is not. The gate reads this.
 */
export const UNCLAIMED_MARKER = '<meta name="ontold-status" content="unclaimed">';

/** The marker for whichever state the address is in. The gate greps
 *  the unclaimed one; the others exist so a human reading source, or a
 *  future check, can tell the three apart. */
export const markerFor = (state) => `<meta name="ontold-status" content="${state === 'free' ? 'unclaimed' : state}">`;

/** What each state says. Only `free` offers the address: inviting a
 *  stranger to claim the name a customer just lost is the failure mode
 *  this whole distinction exists to avoid. */
const COPY = {
  free: {
    title: (s) => `${s}.ontold.site — this address is free`,
    description: (s) => `Nobody has published ${s}.ontold.site. Describe the business to Ontold and it is yours.`,
    body: (s, claim) => `  <p class="flag">Unclaimed</p>
  <h1>This address is <em>still free</em>.</h1>
  <p class="lede">Nobody has published <strong>${s}.ontold.site</strong>. Describe the business and Ontold writes the site, publishes it, and hands this address back live.</p>
  <a class="cta" href="${claim}">Claim ${s}.ontold.site</a>

  <ol class="steps">
    <li><b>01</b> Say what the business does, in a sentence.</li>
    <li><b>02</b> Ontold writes and publishes the pages.</li>
    <li><b>03</b> ${s}.ontold.site goes live, over HTTPS, immediately.</li>
  </ol>`,
  },
  gone: {
    title: (s) => `${s}.ontold.site — no longer published`,
    description: () => 'This address is not currently serving a site.',
    // No claim button. Somebody had this name; offering it to whoever
    // arrives next is how you hand a competitor a customer's address.
    body: (s) => `  <p class="flag">Not published</p>
  <h1>This site has been <em>taken down</em>.</h1>
  <p class="lede"><strong>${s}.ontold.site</strong> was published and is no longer live. If it is yours, it can be republished from the studio — the previous versions are kept.</p>
  <a class="cta" href="https://ontold.com">Go to the studio</a>`,
  },
  private: {
    title: (s) => `${s}.ontold.site — not available`,
    description: () => 'This address is not publicly available.',
    // Deliberately says less than the others. It must not offer the
    // name (it is in use) and it should not describe the site behind
    // it. That the slug is taken is already discoverable — publishing
    // to it answers 409 — so this is not pretending, just not helpful
    // to someone who has no business here.
    body: (s) => `  <p class="flag">Not available</p>
  <h1>This address isn't <em>publicly available</em>.</h1>
  <p class="lede"><strong>${s}.ontold.site</strong> is in use and not published publicly. If it is yours, its visibility is set in the studio.</p>
  <a class="cta" href="https://ontold.com">Go to the studio</a>`,
  },
  broken: {
    title: (s) => `${s}.ontold.site — incomplete`,
    description: () => 'This site published partially and has no home page.',
    // The owner is the audience here, not a visitor: this is a state
    // only a failed publish produces, and it is fixable.
    body: (s) => `  <p class="flag">Incomplete</p>
  <h1>This site is <em>missing its home page</em>.</h1>
  <p class="lede">Some pages of <strong>${s}.ontold.site</strong> published and the home page did not. That is a publish that half-landed, not a site that was never made. Publishing again from the studio fixes it.</p>
  <a class="cta" href="https://ontold.com">Go to the studio</a>`,
  },
};

/**
 * What a missing page actually MEANS — three states one 404 was
 * flattening into "this address is free".
 *
 * Founder: *"what's the difference between never published and gone
 * away or failed publish"*. Nothing, until now, and that was the cost
 * of turning the 404 into an offer: a confident claim page shown to
 * someone whose site had just been taken down would tell them their
 * address is available, and tell a stranger they can have the name a
 * customer just lost. An ugly page that says nothing is better than a
 * beautiful page that says the wrong thing.
 *
 * The bucket already knew. Nothing was asking it:
 *
 *   FREE     nothing under sites/<slug>/ at all — nobody ever had it.
 *   GONE     versions/ exists but the live page does not. History
 *            outlives the page, so this is somebody's former address.
 *   BROKEN   other pages published but no index. A multi-page publish
 *            that landed a subpage and lost the index leaves exactly
 *            this, and it is the site's owner who needs to know.
 *
 * A genuinely failed publish that wrote NOTHING is indistinguishable
 * from never-published, at the edge, and this does not pretend
 * otherwise — a publish either reached R2 or it did not.
 */
export function addressState(keys) {
  const found = (keys || []).filter(Boolean);
  if (!found.length) return 'free';
  return found.some((k) => k.includes('/versions/')) ? 'gone' : 'broken';
}

/** Where an unclaimed name sends someone: the studio, with the name
 *  they already chose carried across. */
export function claimUrl(slug) {
  return `https://ontold.com/?claim=${encodeURIComponent(slug)}`;
}

/** The state's HTTP status. 410 tells a crawler to drop a page that
 *  is deliberately gone; 404 leaves the door open for later. */
export const statusFor = (state) => (state === 'gone' ? 410 : 404);

/** The page for an address with nothing at it. Only the free state
 *  offers the name — the other two would be offering someone else's. */
export function notFoundPage(slug, state = 'free') {
  const s = esc(slug);
  // Never interpolated raw: the slug reaches here from a Host header,
  // and a spoofed one is the only way a hostile value arrives.
  const claim = esc(claimUrl(String(slug)));
  const copy = COPY[state] || COPY.free;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(copy.title(s))}</title>
<meta name="description" content="${esc(copy.description(s))}">
<meta name="theme-color" content="#070707">
${markerFor(state)}
<style>${BRAND_CSS}
  .flag{
    font:700 10px/1 ui-monospace,"SF Mono","Cascadia Code",Menlo,monospace;
    letter-spacing:.22em; text-transform:uppercase; color:var(--red);
    margin:0 0 1.25rem;
  }
  .steps{
    list-style:none; margin:3.5rem auto 0; padding:0; max-width:520px; text-align:left;
  }
  .steps li{
    display:flex; gap:1rem; align-items:baseline;
    padding:.9rem 0; border-top:1px solid var(--rule); color:var(--muted); font-size:14.5px;
  }
  .steps b{
    flex:0 0 auto; color:var(--red);
    font:700 12px/1.5 ui-monospace,"SF Mono","Cascadia Code",Menlo,monospace;
  }
</style></head>
<body><main>
  ${MARK_SVG}
  <p class="eyebrow">ontold.site</p>

  <div class="bar">
    ${lockSvg(false)}
    <div class="addr"><span class="slug">${s}</span><span class="rest">.ontold.site</span></div>
  </div>

  ${copy.body(s, claim)}

  <footer>Every address here started as a sentence. The studio lives at <a href="https://ontold.com">ontold.com</a>.</footer>
</main></body></html>`;
}
