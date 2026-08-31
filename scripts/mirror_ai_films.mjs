#!/usr/bin/env node
/**
 * Host the films we made and tell Screening Studio where they are.
 *
 *   FILMS=studio/data/aiFilms/films.json \
 *   R2_BUCKET=ontold-public R2_PUBLIC_BASE=https://... \
 *   node scripts/mirror_ai_films.mjs
 *
 * Founder: *"films go in screening studio of course"*. ontold renders
 * them, the studio screens them, and the media travels the way it
 * already does for the public-domain reel — this repository holds the
 * R2 credentials, so this repository does the hosting and pushes back a
 * URL. scripts/mirror_public_domain.mjs is the precedent and this
 * follows it deliberately rather than inventing a second arrangement.
 *
 * ## What it uploads
 *
 * The assembled film from `api/seed/_briefs/_out/<key>/<key>.mp4` and,
 * when one exists, the poster frame beside it. Both go up as-is: these
 * are finished pieces, so unlike the public-domain mirror there is
 * nothing to cut and nothing to re-encode.
 *
 * ## What it refuses to do
 *
 * Write a URL for a film that is not there. The studio reads this file
 * and screens whatever it names, so a key written optimistically is a
 * tile that opens onto a 404 — and the person who finds it is a
 * visitor, not us. Missing films are reported and skipped.
 *
 * The caller commits the file.
 */

import { readFileSync, writeFileSync, statSync, existsSync, readdirSync } from 'fs'
import { execFileSync } from 'child_process'
import { resolve, join } from 'path'

const ROOT = resolve(new URL('..', import.meta.url).pathname)
const FILMS = resolve(process.env.FILMS || '')
const OUT_DIR = process.env.OUT_DIR || join(ROOT, 'api/seed/_briefs/_out')
const EXAMPLES = process.env.EXAMPLES_DIR || join(ROOT, 'api/seed/examples')
const BUCKET = process.env.R2_BUCKET || 'ontold-public'
const PREFIX = process.env.R2_PREFIX || 'screening/ai-films'
const BASE = (process.env.R2_PUBLIC_BASE || '').replace(/\/+$/, '')
//: The secret is not a bare id; seed-r2.yml and the public-domain
//: mirror both pull the 32 hex characters out the same way.
const ACCOUNT = (/[0-9a-f]{32}/i.exec(process.env.R2_ACCOUNT_ID || '') || [''])[0]

//: Which films to mirror. Defaults to every key the studio's editorial
//: list already knows about, passed in by the workflow — this script
//: does not decide what the studio screens.
const KEYS = (process.env.FILM_KEYS || '')
  .split(',').map(s => s.trim()).filter(Boolean)

if (!FILMS || !existsSync(FILMS)) {
  console.error(`[ai] FILMS must point at the studio's aiFilms/films.json (got "${FILMS}")`)
  process.exit(1)
}
if (!BASE) {
  // Upload without an address and the studio would reference a URL that
  // does not resolve, which is worse than not uploading at all.
  console.error('[ai] R2_PUBLIC_BASE is not set, so an uploaded film would have no address')
  process.exit(1)
}
if (!ACCOUNT) {
  console.error('[ai] no 32-character account id inside R2_ACCOUNT_ID')
  process.exit(1)
}
if (KEYS.length === 0) {
  console.error('[ai] FILM_KEYS is empty — nothing asked for')
  process.exit(1)
}

const ENDPOINT = `https://${ACCOUNT}.r2.cloudflarestorage.com`
const films = JSON.parse(readFileSync(FILMS, 'utf8'))

/** Seconds, read out of the mp4's own header.
 *
 *  ffprobe is not on every runner that has ffmpeg, and a duration is
 *  what the studio shows as the runtime — so it is parsed rather than
 *  assumed, and a file it cannot read raises instead of reporting zero.
 *  A zero-second film is a page that says the film is empty. */
function seconds(path) {
  const b = readFileSync(path)
  const walk = function* (start, end) {
    let i = start
    while (i + 8 <= end) {
      let size = b.readUInt32BE(i)
      const type = b.toString('latin1', i + 4, i + 8)
      if (size === 1) size = Number(b.readBigUInt64BE(i + 8))
      if (size < 8) return
      yield [type, i, size]
      i += size
    }
  }
  for (const [type, i, size] of walk(0, b.length)) {
    if (type !== 'moov') continue
    for (const [t2, j] of walk(i + 8, i + size)) {
      if (t2 !== 'mvhd') continue
      const v = b[j + 8]
      const scale = v === 0 ? b.readUInt32BE(j + 20) : b.readUInt32BE(j + 28)
      const dur = v === 0 ? b.readUInt32BE(j + 24) : Number(b.readBigUInt64BE(j + 32))
      if (!scale) break
      return dur / scale
    }
  }
  throw new Error('no duration in the mp4 header')
}

function upload(local, object, contentType) {
  execFileSync(
    'aws',
    ['s3', 'cp', local, `s3://${BUCKET}/${object}`,
     '--endpoint-url', ENDPOINT,
     '--content-type', contentType,
     '--cache-control', 'public, max-age=31536000, immutable',
     '--only-show-errors'],
    { stdio: ['ignore', 'inherit', 'inherit'], timeout: 20 * 60_000 },
  )
  return `${BASE}/${object}`
}

let changed = 0
const missing = []
const failed = []

/** The newest ASSEMBLED take, or null.
 *
 *  Takes sit beside each other -- `_out/<slug>/v1`, `v2`, ... -- so a
 *  brief keeps every version it has ever had. Newest that actually
 *  ASSEMBLED, not newest attempted: a v2 whose shots failed must not
 *  shadow a v1 that plays. Same rule as render_brief.latest_film, and
 *  the two must not disagree about which take is the film. */
function latestFilm(key) {
  const root = join(OUT_DIR, key)
  if (!existsSync(root)) return null
  const versions = readdirSync(root)
    .filter(n => /^v\d+$/.test(n))
    .map(n => Number(n.slice(1)))
    .sort((a, b) => b - a)
  for (const v of versions) {
    const film = join(root, `v${v}`, `${key}.mp4`)
    if (existsSync(film)) return { film, version: v }
  }
  return null
}

for (const key of KEYS) {
  const take = latestFilm(key)
  const film = take ? take.film : ''
  if (!take) {
    // Not an error: a film in the studio's list that nobody has
    // rendered yet is an ordinary state, and the studio already knows
    // to screen only what is here.
    missing.push(key)
    console.error(`[ai] ${key}: no assembled take under ${join(OUT_DIR, key).replace(ROOT + '/', '')}`)
    continue
  }

  const bytes = statSync(film).size
  //: Keyed on size, so a re-render of the same brief re-uploads and a
  //: rerun of the same bytes does not pay to move them twice.
  const stamp = `${bytes}`
  const existing = films[key]
  if (existing && existing.stamp === stamp && existing.video_url?.startsWith(BASE)) {
    console.error(`[ai] ${key} already hosted`)
    continue
  }

  try {
    const object = `${PREFIX}/${key}.mp4`
    const url = upload(film, object, 'video/mp4')
    const entry = {
      video_url: url,
      take: `v${take.version}`,
      duration_seconds: Math.round(seconds(film) * 100) / 100,
      size_bytes: bytes,
      stamp,
    }

    // The poster is a nicety: without it the tile shows the first frame
    // instead of nothing, so a missing one never blocks the film.
    const poster = join(EXAMPLES, `example-${key}.jpg`)
    if (existsSync(poster)) {
      entry.poster_url = upload(poster, `${PREFIX}/${key}.jpg`, 'image/jpeg')
    } else {
      console.error(`[ai]   ${key}: no poster frame, the tile will use frame one`)
    }

    films[key] = entry
    changed += 1
    console.error(`[ai] ${key} v${take.version} -> ${Math.round(bytes / 1e6)}MB, ${entry.duration_seconds}s at ${url}`)
  } catch (err) {
    // One bad film must not cost the others.
    failed.push(`${key}: ${String(err).slice(0, 200)}`)
    console.error(`[ai] ${key} failed: ${String(err).slice(0, 200)}`)
  }
}

if (changed > 0) writeFileSync(FILMS, `${JSON.stringify(films, null, 2)}\n`)
console.error(`[ai] ${changed} hosted, ${missing.length} not rendered, ${failed.length} failed`)

if (failed.length > 0) {
  console.error(`::warning::${failed.length} film(s) could not be hosted:\n  ${failed.join('\n  ')}`)
}

// Green with nothing hosted is how the public-domain mirror once
// reported total failure as success. Asked for films, hosted none of
// them, and none was already up: that is a failure.
const hosted = KEYS.filter(k => films[k]?.video_url).length
if (hosted === 0) {
  console.error(`[ai] nothing is hosted: ${missing.length} unrendered, ${failed.length} failed`)
  process.exit(1)
}
