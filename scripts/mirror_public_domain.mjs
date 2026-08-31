#!/usr/bin/env node
/**
 * Cut Screening Studio's public domain reel and host it on R2.
 *
 *   FILMS=studio/data/publicDomain/films.json \
 *   R2_BUCKET=ontold-public R2_PUBLIC_BASE=https://... \
 *   node scripts/mirror_public_domain.mjs
 *
 * The studio was pointing a <video> tag at 200MB+ archive.org originals,
 * which 500s. It only ever plays the opening three minutes. The R2
 * credentials live in this repo, so the hosting does too, the same way
 * mint-audience-images keeps the Runware key here.
 *
 * Writes clip_url back into the studio's films.json. The caller commits.
 */

import { readFileSync, writeFileSync, statSync, existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { resolve, join } from 'path'
import { tmpdir } from 'os'

const FILMS = resolve(process.env.FILMS || '')
const SECONDS = Number(process.env.EXCERPT_SECONDS || 180)
const BUCKET = process.env.R2_BUCKET || 'ontold-public'
const PREFIX = process.env.R2_PREFIX || 'screening/public-domain'
const BASE = (process.env.R2_PUBLIC_BASE || '').replace(/\/+$/, '')
// The secret is not a bare id - aws rejected the endpoint built from it
// as invalid. seed-r2.yml pulls the 32 hex characters out the same way.
const ACCOUNT = (/[0-9a-f]{32}/i.exec(process.env.R2_ACCOUNT_ID || '') || [''])[0]

if (!FILMS || !existsSync(FILMS)) {
  console.error(`[pd] FILMS must point at the studio's films.json (got "${FILMS}")`)
  process.exit(1)
}
if (!BASE) {
  // Without it the clip would be uploaded and then referenced by a URL
  // that does not resolve, which is worse than not uploading at all.
  console.error('[pd] R2_PUBLIC_BASE is not set, so an uploaded clip would have no address')
  process.exit(1)
}
if (!ACCOUNT) {
  console.error('[pd] no 32-character account id inside R2_ACCOUNT_ID')
  process.exit(1)
}

const ENDPOINT = `https://${ACCOUNT}.r2.cloudflarestorage.com`
const films = JSON.parse(readFileSync(FILMS, 'utf8'))
const keys = Object.keys(films)

if (keys.length === 0) {
  console.error('[pd] the studio has resolved no films yet')
  process.exit(0)
}

let changed = 0
const failed = []


for (const key of keys) {
  const film = films[key]

  // Keyed on what it was cut from and how long, so a re-resolve that
  // finds a different file re-cuts and a rerun does not pay twice.
  const stamp = `${film.identifier}-${SECONDS}s`
  const object = `${PREFIX}/${key}-${SECONDS}s.mp4`

  if (film.clip_stamp === stamp && film.clip_url) {
    // The bytes are already up. If only the address has moved - the first
    // runs wrote the S3 endpoint, which serves 400 - repoint without
    // paying to cut and upload the same clip again.
    const want = `${BASE}/${object}`
    if (film.clip_url !== want) {
      film.clip_url = want
      changed += 1
      console.error(`[pd] ${key} repointed to ${BASE}`)
    } else {
      console.error(`[pd] ${key} already mirrored`)
    }
    continue
  }

  const local = join(tmpdir(), `${key}.mp4`)

  // /download/ 5XX'd every film; direct_url addresses the node metadata
  // named. Derive it here when the studio has not recorded one, rather
  // than waiting for a resolve to succeed on a later day.
  let direct = film.direct_url
  if (!direct && film.file) {
    try {
      const res = await fetch(`https://archive.org/metadata/${encodeURIComponent(film.identifier)}`, {
        signal: AbortSignal.timeout(20_000),
      })
      const meta = await res.json()
      if (meta.server && meta.dir) {
        direct = `https://${meta.server}${meta.dir}/${encodeURIComponent(film.file)}`
        console.error(`[pd]   ${key}: derived node ${meta.server}`)
      }
    } catch {
      console.error(`[pd]   ${key}: could not read metadata for a node URL`)
    }
  }
  const sources = [direct, film.video_url].filter(Boolean)

  try {
    let cut = null
    for (const src of sources) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          // -ss before -i seeks without decoding and -c copy avoids
          // re-encoding, so ffmpeg pulls roughly the excerpt, not the film.
          execFileSync(
            'ffmpeg',
            ['-y', '-loglevel', 'error', '-ss', '0', '-t', String(SECONDS),
             '-i', src, '-c', 'copy', '-movflags', '+faststart', local],
            { stdio: ['ignore', 'ignore', 'inherit'], timeout: 12 * 60_000 },
          )
          cut = src
          break
        } catch {
          console.error(`[pd]   ${key}: attempt ${attempt} failed on ${new URL(src).host}`)
          execFileSync('sleep', [String(attempt * 5)])
        }
      }
      if (cut) break
    }
    if (!cut) throw new Error(`no source would open (${sources.length} tried, 3 attempts each)`)

    const bytes = statSync(local).size
    if (bytes < 10_000) throw new Error(`cut to ${bytes} bytes, which is not a film`)

    execFileSync(
      'aws',
      ['s3', 'cp', local, `s3://${BUCKET}/${object}`,
       '--endpoint-url', ENDPOINT,
       '--content-type', 'video/mp4',
       '--cache-control', 'public, max-age=31536000, immutable',
       '--only-show-errors'],
      { stdio: ['ignore', 'inherit', 'inherit'], timeout: 10 * 60_000 },
    )

    film.clip_url = `${BASE}/${object}`
    film.clip_bytes = bytes
    film.clip_seconds = SECONDS
    film.clip_stamp = stamp
    changed += 1

    // ## The poster travels with the clip
    //
    // Founder: *"we need to put all clips in R2"*. The clip was only
    // half of it — every one of these also carries a thumb_url on
    // archive.org, which the home carousel and the reel render through
    // next/image. So the reel could be served entirely from our own
    // bucket and still show four holes if archive.org is slow, down, or
    // simply declines a hotlink, which is a fair thing for an archive
    // to do.
    //
    // Best effort on purpose: a missing poster is a grey rectangle and
    // a missing clip is a screening with nothing in it. Failing the
    // whole film over the smaller one would be the wrong trade.
    if (film.thumb_url) {
      try {
        const pobj = `public-domain/${key}-poster.jpg`
        const plocal = join(tmpdir(), `${key}-poster.jpg`)
        execFileSync('curl', ['-sS', '--fail', '--location', '--max-time', '120',
                              '-o', plocal, film.thumb_url], { stdio: ['ignore', 'inherit', 'inherit'] })
        const pbytes = statSync(plocal).size
        if (pbytes < 2_000) throw new Error(`${pbytes} bytes, which is not a poster`)
        execFileSync('aws', ['s3', 'cp', plocal, `s3://${BUCKET}/${pobj}`,
          '--endpoint-url', ENDPOINT, '--content-type', 'image/jpeg',
          '--cache-control', 'public, max-age=31536000, immutable',
          '--only-show-errors'], { stdio: ['ignore', 'inherit', 'inherit'], timeout: 5 * 60_000 })
        film.poster_url = `${BASE}/${pobj}`
        console.error(`[pd] ${key} poster -> ${Math.round(pbytes / 1024)}KB`)
      } catch (err) {
        console.error(`[pd] ${key} poster NOT hosted: ${String(err).slice(0, 120)}`)
      }
    }
    console.error(`[pd] ${key} -> ${Math.round(bytes / 1e6)}MB at ${film.clip_url}`)
  } catch (err) {
    // One bad film must not cost the others; the studio keeps playing that
    // one through the archive's own player, which is where it was.
    failed.push(`${key}: ${String(err).slice(0, 200)}`)
    console.error(`[pd] ${key} failed: ${String(err).slice(0, 200)}`)
  }
}

if (changed > 0) writeFileSync(FILMS, `${JSON.stringify(films, null, 2)}\n`)
console.error(`[pd] ${changed} mirrored of ${keys.length}`)

if (failed.length > 0) {
  console.error(`::warning::${failed.length} film(s) still stream from archive.org:\n  ${failed.join('\n  ')}`)
}

// Run 2 hosted nothing and went green, because every film failed and the
// caller then read "no diff" as "nothing to do". Hosting none of them is a
// failure unless they were all already hosted.
const hosted = keys.filter(k => films[k].clip_url).length
if (hosted === 0) {
  console.error(`[pd] nothing is hosted: ${failed.length} of ${keys.length} could not be cut`)
  process.exit(1)
}
