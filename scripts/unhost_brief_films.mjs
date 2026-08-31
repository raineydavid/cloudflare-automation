#!/usr/bin/env node
/**
 * Take our films OFF the public bucket. (It used to put them there.)
 *
 *   HOST_SLUG=suite-dreams R2_PUBLIC_BASE=https://… \
 *   node scripts/unhost_brief_films.mjs
 *
 * ## Why this now removes rather than hosts
 *
 * Founder: *"thats not what we want to expose to users, they should
 * only ever see ontold.com"*. Correct, and the version of this that
 * uploaded was wrong in three ways at once: a Cloudflare hostname
 * instead of ours, a permanent unauthenticated URL where the product
 * mints a 5-minute signed one, and `immutable, max-age=31536000` on
 * work we might want to take back.
 *
 * ontold already has the answer and it is /api/watch: the manifest
 * holds the key and an access level, api/_entitlement decides (and
 * fails closed on anything it does not recognise), and only then is a
 * short-lived signed URL minted and 302'd to. The R2 key never
 * reaches the network tab and the bucket behind it is not public.
 *
 * So this exists to undo the upload. The reasons the artefacts were
 * hard to see are still true, and still worth writing down:
 *
 *   * `api/seed/_briefs/_out/**` is deploy-excluded on purpose, so the
 *     takes are visible only to somebody with the repository open.
 *   * `api/seed/examples/*.mp4` IS servable — but through /api/watch,
 *     which 302s to a signed URL on the PRIVATE bucket, and only from
 *     a deploy that has the manifest row. This work is on a branch;
 *     ontold's app is built from main. So the film is real, hosted,
 *     and unreachable.
 *   * The Actions artifact is a 64MB zip behind a GitHub login, which
 *     is not a link you can open on a phone.
 *
 * Three different reasons, one symptom — and none of them is fixed by
 * publishing to a hostname that is not ours. The published advert
 * already has a manifest row, so it serves from ontold.com the moment
 * the branch does; the rushes stay internal, where rushes belong.
 *
 * ## It confirms the objects are gone
 *
 * A delete that reported success and a URL that stops serving are two
 * different facts, the same way an upload and a link were. Each key is
 * fetched afterwards and must answer 404.
 */

import { execFileSync } from 'child_process'
import { existsSync, readdirSync, readFileSync, rmSync } from 'fs'
import { join, resolve, relative } from 'path'

const ROOT = resolve(new URL('..', import.meta.url).pathname)
const SLUG = (process.env.HOST_SLUG || '').trim()
const BUCKET = process.env.R2_BUCKET || 'ontold-public'
const PREFIX = process.env.R2_PREFIX || `films/${SLUG}`
const BASE = (process.env.R2_PUBLIC_BASE || '').replace(/\/+$/, '')
const ACCOUNT = (/[0-9a-f]{32}/i.exec(process.env.R2_ACCOUNT_ID || '') || [''])[0]

if (!SLUG) { console.error('[films] HOST_SLUG is required'); process.exit(2) }
if (!BASE) { console.error('[films] R2_PUBLIC_BASE is not set, so nothing would have an address'); process.exit(1) }
if (!ACCOUNT) { console.error('[films] no 32-character account id inside R2_ACCOUNT_ID'); process.exit(1) }

const ENDPOINT = `https://${ACCOUNT}.r2.cloudflarestorage.com`
const OUT = join(ROOT, 'api/seed/_briefs/_out', SLUG)
const EXAMPLES = join(ROOT, 'api/seed/examples')

/** Every mp4 below a directory, deepest path kept for the key. */
function films(dir) {
  if (!existsSync(dir)) return []
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) found.push(...films(p))
    else if (entry.name.endsWith('.mp4')) found.push(p)
  }
  return found.sort()
}

/** What this brief publishes into the showcase, if anything. */
function published() {
  const brief = join(ROOT, 'api/_briefs', `${SLUG}.json`)
  if (!existsSync(brief)) return []
  const doc = JSON.parse(readFileSync(brief, 'utf8'))
  const id = (doc.publish || {}).id
  if (!id) return []
  return [`${id}-film.mp4`, `${id}-clip.mp4`, `${id}.jpg`]
    .map(n => join(EXAMPLES, n))
    .filter(p => existsSync(p))
}

const wanted = [
  ...films(OUT).map(p => ({ path: p, key: `${PREFIX}/${relative(OUT, p)}`, from: 'take' })),
  ...published().map(p => ({ path: p, key: `${PREFIX}/published/${p.split('/').pop()}`, from: 'published' })),
]

if (wanted.length === 0) {
  console.error(`[films] nothing on disk for '${SLUG}', so there is nothing ` +
                'whose public copy could be named. Check out the branch that ' +
                'has the takes before running this.')
  process.exit(1)
}

console.error(`[films] removing ${wanted.length} object(s) for ${SLUG}`)

const gone = []
const failed = []

for (const item of wanted) {
  const url = `${BASE}/${item.key}`
  try {
    execFileSync('aws', [
      's3', 'rm', `s3://${BUCKET}/${item.key}`,
      '--endpoint-url', ENDPOINT, '--only-show-errors',
    ], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 5 * 60_000 })

    const code = execFileSync('curl', [
      '-sS', '-o', '/dev/null', '--max-time', '60',
      '-w', '%{http_code}', url,
    ]).toString().trim()
    if (code !== '404' && code !== '403') throw new Error(`still serves ${code}`)

    gone.push(item.key)
    console.error(`[films] gone ${item.key} (${code})`)
  } catch (err) {
    failed.push(`${item.key}: ${String(err).slice(0, 160)}`)
    console.error(`[films] STILL THERE ${item.key}: ${String(err).slice(0, 160)}`)
  }
}

// The index of public URLs goes with them: a committed list of
// addresses that must not exist is a map back to the mistake.
const dest = join(ROOT, 'api/_briefs/_sources', `${SLUG}-films.json`)
if (existsSync(dest)) { rmSync(dest); console.error(`[films] removed ${relative(ROOT, dest)}`) }

console.error(`[films] ${gone.length} of ${wanted.length} removed`)
if (failed.length) {
  console.error(`::error::${failed.length} object(s) are STILL PUBLIC:\n  ${failed.join('\n  ')}`)
  process.exit(1)
}
