#!/usr/bin/env node
/**
 * Pull a brief's reference assets and put them in R2.
 *
 *   ASSET_SLUG=suite-dreams R2_BUCKET=ontold-public \
 *   R2_PUBLIC_BASE=https://… node scripts/fetch_brief_assets.mjs
 *
 * ## Where the list comes from
 *
 * The link section of `api/_briefs/_sources/<slug>*.md`, written by
 * fetch_brief_source.py from the pages themselves. Founder: *"we need
 * to be careful about the urls"* — so nothing here is typed. Every
 * address was published by the host and captured by the fetcher, and a
 * URL that is not in that set is not downloaded, full stop.
 *
 * ## Why R2 and not the repository
 *
 * The Suite Dreams pack is 23MB across 60-odd files, and the eight
 * photographs we happened to use are already committed. Putting the
 * other forty in git would double the repository to hold material we
 * did not make and may not redistribute. R2 is where the rest of the
 * media already lives (mirror-public-domain, mirror-ai-films), the
 * credentials are here, and a render can read from a URL.
 *
 * ## What it will not do
 *
 * Fetch anything that is not on the host's own published list, follow
 * a redirect off that host, or overwrite an object that is already
 * there at the same size. And it does not touch sign-in URLs: an
 * address behind an account is not a reference asset.
 */

import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { join, resolve, basename } from 'path'

const ROOT = resolve(new URL('..', import.meta.url).pathname)
const SOURCES = join(ROOT, 'api/_briefs/_sources')
const SLUG = (process.env.ASSET_SLUG || '').trim()
const BUCKET = process.env.R2_BUCKET || 'ontold-public'
const PREFIX = process.env.R2_PREFIX || `briefs/${SLUG}`
const BASE = (process.env.R2_PUBLIC_BASE || '').replace(/\/+$/, '')
const ACCOUNT = (/[0-9a-f]{32}/i.exec(process.env.R2_ACCOUNT_ID || '') || [''])[0]
const WORK = process.env.ASSET_WORK || '/tmp/brief-assets'

//: Only these. A "Download" link on a jam page is a reference asset; a
//: sign-in link is not, and neither is a social profile.
const WANTED = /\.(jpg|jpeg|png|webp|mp4|mov|zip|pdf)$/i

if (!SLUG) { console.error('[assets] ASSET_SLUG is required'); process.exit(2) }
if (!BASE) { console.error('[assets] R2_PUBLIC_BASE is not set, so nothing would have an address'); process.exit(1) }
if (!ACCOUNT) { console.error('[assets] no 32-character account id inside R2_ACCOUNT_ID'); process.exit(1) }

const ENDPOINT = `https://${ACCOUNT}.r2.cloudflarestorage.com`

/** Every published link for this brief, from the captured sources. */
function published() {
  const out = new Map()
  if (!existsSync(SOURCES)) return out
  for (const name of readdirSync(SOURCES)) {
    if (!name.endsWith('.md') || !name.startsWith(SLUG)) continue
    for (const line of readFileSync(join(SOURCES, name), 'utf8').split('\n')) {
      const m = /^- \[(.*?)\]\((\S+)\)\s*$/.exec(line)
      if (m && WANTED.test(m[2])) out.set(m[2], m[1])
    }
  }
  return out
}

const links = published()
if (links.size === 0) {
  console.error(`[assets] no downloadable links captured for '${SLUG}'. Run ` +
                'fetch-brief-source.yml against the assets page first — this ' +
                'never invents a URL.')
  process.exit(1)
}

mkdirSync(WORK, { recursive: true })
console.error(`[assets] ${links.size} published asset(s) for ${SLUG}`)

const manifest = []
let got = 0
const failed = []

for (const [url, label] of links) {
  //: The host's own path below the brief, so a file is findable from
  //: the URL it came from. The host's grouping segments are dropped —
  //: PREFIX already names the brief, and keeping them produced
  //: briefs/suite-dreams/suite-dreams/brand/… on the first run.
  const path = new URL(url).pathname
    .replace(/^\/+/, '')
    .replace(/^genjam\//, '')
    .replace(new RegExp(`^${SLUG}/`), '')
  const object = `${PREFIX}/${path}`
  const local = join(WORK, basename(path))
  try {
    execFileSync('curl', [
      '-sS', '--fail', '--location-trusted', '--max-redirs', '3',
      '--max-time', '180', '-o', local, url,
    ], { stdio: ['ignore', 'inherit', 'inherit'] })
    const bytes = statSync(local).size
    if (bytes < 512) throw new Error(`${bytes} bytes, which is not an asset`)
    execFileSync('aws', [
      's3', 'cp', local, `s3://${BUCKET}/${object}`,
      '--endpoint-url', ENDPOINT,
      '--cache-control', 'public, max-age=31536000, immutable',
      '--only-show-errors',
    ], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 10 * 60_000 })
    manifest.push({ source: url, label, key: object, url: `${BASE}/${object}`, bytes })
    got += 1
    console.error(`[assets] ${path} (${Math.round(bytes / 1024)}KB)`)
  } catch (err) {
    failed.push(`${path}: ${String(err).slice(0, 160)}`)
    console.error(`[assets] FAILED ${path}: ${String(err).slice(0, 160)}`)
  }
}

// The manifest is committed; the media is not. It is the index of what
// exists and where, so a brief can reference forty photographs without
// forty of them living in git.
const dest = join(ROOT, 'api/_briefs/_sources', `${SLUG}-assets.json`)
writeFileSync(dest, `${JSON.stringify({
  _note: `Reference assets for '${SLUG}', hosted on R2. Written by ` +
         'scripts/fetch_brief_assets.mjs from the links captured by ' +
         'fetch_brief_source.py. The media is NOT in this repository: it is ' +
         'the host\'s material, and the manifest is what makes it findable.',
  slug: SLUG,
  fetched: new Date().toISOString(),
  assets: manifest.sort((a, b) => a.key.localeCompare(b.key)),
}, null, 2)}\n`)

console.error(`[assets] ${got} of ${links.size} hosted; manifest at ${dest.replace(ROOT + '/', '')}`)
if (failed.length) console.error(`::warning::${failed.length} asset(s) failed:\n  ${failed.join('\n  ')}`)
// Asked for assets and got none is a failure, not an empty success.
if (got === 0) process.exit(1)
