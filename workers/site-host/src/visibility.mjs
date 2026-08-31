/**
 * Who can find a site: public, unlisted, private.
 *
 * Founder, on the apex sitemap listing every slug in the bucket
 * including four likeness-lab galleries: *"not yet - we need a flag for
 * unlisted, public, private"*. Right. A name-prefix rule in the sitemap
 * would have been me guessing which of somebody's sites are private,
 * and guessing wrong quietly. Visibility is a property of the site, set
 * by whoever owns it, and every surface reads the same flag.
 *
 * YouTube's three, meaning the same things:
 *
 *   PUBLIC    serves, and is offered to crawlers. The default.
 *   UNLISTED  serves to anyone with the address, and is offered to
 *             nobody — out of the sitemap, and noindex on the page, or
 *             a crawler that finds the link indexes it anyway.
 *   PRIVATE   does not serve at all.
 *
 * ## Why absence means public
 *
 * Only non-public sites get a record, so setting a site public DELETES
 * its record. Two things fall out, both wanted: every site published
 * before this existed keeps serving exactly as it did — no migration,
 * no silent change of behaviour — and the sitemap can exclude every
 * non-public site with ONE list and no reads, because presence of the
 * record is the whole question it needs answered.
 *
 * The serve path does need to tell unlisted from private, so it reads
 * the record — fetched alongside the page rather than before it, so it
 * costs no added latency.
 */

export const VISIBILITIES = ['public', 'unlisted', 'private'];

/** R2 key holding a site's visibility. Public sites have none. */
export const visibilityKey = (slug) => `visibility/${String(slug).toLowerCase()}`;

export function visibilityValid(v) {
  return VISIBILITIES.includes(v);
}

/** The visibility a stored record means. Anything unreadable reads as
 *  public — the state the site was in before the record existed, so a
 *  corrupt object cannot take a live site off the internet. */
export function parseVisibility(text) {
  if (!text) return 'public';
  try {
    const v = JSON.parse(text)?.visibility;
    return visibilityValid(v) ? v : 'public';
  } catch {
    return 'public';
  }
}

/** Slugs that must stay out of the sitemap, from one listing of the
 *  visibility prefix. Unlisted and private are both "not offered". */
export function unlistedSlugs(keys) {
  return (keys || [])
    .map((k) => String(k).replace(/^visibility\//, ''))
    .filter(Boolean);
}

/** Told to a crawler that reaches an unlisted page by following a link
 *  somebody shared. Without this, "unlisted" only means "not in our
 *  sitemap", which is not what the word means to anyone. */
export const NOINDEX_TAG = '<meta name="robots" content="noindex, nofollow">';

/** Put the noindex in <head>, where a crawler reads it. Falls back to
 *  prepending when there is no head — a fragment is still better
 *  marked than not. */
export function withNoindex(html) {
  if (html.includes(NOINDEX_TAG)) return html;
  const i = html.search(/<head[^>]*>/i);
  if (i === -1) return NOINDEX_TAG + html;
  const end = html.indexOf('>', i) + 1;
  return html.slice(0, end) + NOINDEX_TAG + html.slice(end);
}
