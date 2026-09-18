#!/usr/bin/env python3
"""Prove storage holds every asset, before anything is deleted.

Founder: *"yes sparse checkout and manifest we need to validate first
before deleting anything"*.

Right instinct, and the reason is in the serving path. api/watch reads
LOCAL-FIRST: a file inside the function bundle is served from the
bundle, and only what is absent falls through to a signed storage URL.
So the repo copy is not dead weight — for anything still in the bundle
it IS the serving path, and for everything else it is the net that
caught the day storage was misconfigured and every clip died silently.

Deleting the repo copy makes storage load-bearing. This says whether
it can take the weight, per file, before that is true.

    python3 scripts/audit_seed_mirror.py                  # report
    python3 scripts/audit_seed_mirror.py --json out.json  # and a file

Exit 0 only when every asset on disk is present in storage AND every
manifest entry resolves. Anything else is a reason not to delete yet.

It never deletes. Not with a flag, not with a force. Deleting is a
separate act by a person who has read this.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from fnmatch import fnmatch
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "api"))
sys.path.insert(0, str(_ROOT))

SEED = _ROOT / "api" / "seed"
MANIFEST = SEED / "manifest.json"
MIRROR = _ROOT / ".github" / "workflows" / "seed-r2.yml"
DEBT = _ROOT / "arch" / "seedAssets.test.ts"

# Keys in the manifest that document it rather than name an asset.
NOTES = ("_comment", "_kinds", "_folders")


def never_mirrored() -> list[str]:
    """Filenames the mirror deliberately skips, read from the mirror.

    Restating the list here is how the vercel exclusion went stale: two
    copies of a rule, one of them wrong and silent. The mirror excludes
    manifest.json (it ships with the function, not to storage) and every
    README. Reporting those as missing is a false alarm that trains
    people to ignore the real ones.
    """
    try:
        rule = MIRROR.read_text()
    except OSError:
        return ["manifest.json", "README.md"]
    return [m.strip("'\"") for m in re.findall(r"--exclude\s+('[^']+'|\"[^\"]+\")", rule)]


def known_debt() -> set[str]:
    """Manifest ids already recorded as never rendered, read from the
    rule that records them.

    Orbital Coffee is a website example whose three page stills have
    briefs and no renders. The page is correct without them — the CSS
    layers the image over a gradient, so a missing asset reads as a
    designed panel — and arch/seedAssets keeps the three in a
    shrink-only list as visible debt.

    That is a different fact from "the mirror failed to upload
    something", and folding them together makes the mirror look broken
    for as long as a render is unpaid for. Read rather than restated,
    for the same reason as the mirror's skip list: two copies drift and
    one of them goes quietly wrong.
    """
    try:
        src = DEBT.read_text()
    except OSError:
        return set()
    block = re.search(r"KNOWN_MISSING\s*=\s*new Set\(\[(.*?)\]\)", src, re.S)
    return set(re.findall(r"'([^']+)'", block.group(1))) if block else set()


def skipped(key: str, patterns: list[str]) -> bool:
    """Whether the mirror would have skipped this key."""
    name = key.rsplit("/", 1)[-1]
    return any(fnmatch(name, p.rsplit("/", 1)[-1]) for p in patterns)


def on_disk() -> dict[str, int]:
    """Every real asset under api/seed, as storage key -> size."""
    out: dict[str, int] = {}
    for p in SEED.rglob("*"):
        if not p.is_file() or p.name == "manifest.json":
            continue
        # seed-r2 mirrors api/seed/<x> to assets/<x>, exactly.
        out[f"assets/{p.relative_to(SEED).as_posix()}"] = p.stat().st_size
    return out


def manifest_keys() -> dict[str, str]:
    """Every key the manifest points at, as key -> the id claiming it."""
    raw = json.loads(MANIFEST.read_text())
    found: dict[str, str] = {}
    for content_id, entry in raw.items():
        if content_id in NOTES or not isinstance(entry, dict):
            continue
        for field, value in entry.items():
            if isinstance(value, str) and value.startswith("assets/"):
                found[value] = f"{content_id}.{field}"
    return found


def in_storage(keys: list[str]) -> tuple[dict[str, bool | None], str | None]:
    """Which keys storage can serve: True, False, or None for "could
    not tell". Second value is why the whole check could not run.

    The three-way answer is the point. An earlier version returned a
    bool and swallowed every exception as False, so a timeout or a
    transient 5xx read as "this file is not in storage" — and one did:
    a pitch take was reported missing in one run and present in the
    next, with no upload in between and the mirror last run fifteen
    hours earlier. A flaky probe that resolves to "missing" cries wolf;
    the same bug resolving the other way would bless a deletion.
    """
    try:
        from _inference import r2_sink  # noqa: PLC0415
    except Exception as e:  # noqa: BLE001
        return {}, f"storage client unavailable: {e}"
    if not r2_sink.is_configured():
        return {}, "storage is not configured in this environment"

    import urllib.error  # noqa: PLC0415
    import urllib.request  # noqa: PLC0415
    from concurrent.futures import ThreadPoolExecutor  # noqa: PLC0415

    access_key, secret, bucket = r2_sink._r2_credentials()
    endpoint = r2_sink._r2_endpoint()
    from _inference.s3_sigv4 import sign_get_url  # noqa: PLC0415

    def once(key: str) -> bool | None:
        """True present, False definitely absent, None could not tell."""
        url = sign_get_url(
            access_key_id=access_key, secret_access_key=secret,
            endpoint=endpoint, bucket=bucket, key=key, expires_in=300,
        )
        # One ranged byte: proves the object is there without paying to
        # pull a 28MB film for an inventory.
        req = urllib.request.Request(url, method="GET", headers={"Range": "bytes=0-0"})
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                return r.status in (200, 206)
        except urllib.error.HTTPError as e:
            # 416: the object is there and empty, which is still there.
            if e.code in (200, 206, 416):
                return True
            # Only the storage service saying "no such key" is absence.
            # 403 counts because a bucket that hides misses answers 403.
            if e.code in (403, 404):
                return False
            return None  # 429, 5xx — a busy service, not an empty one.
        except Exception:  # noqa: BLE001
            return None  # timeout, DNS, reset: unknown, not absent.

    def probe(key: str) -> tuple[str, bool | None]:
        """Whether one key is mirrored, retrying an unknown once."""
        verdict = once(key)
        # Retry only the unknowns, and only once. A present or a
        # definitely-absent answer does not get more truthful by asking
        # again; a timeout does.
        if verdict is None:
            verdict = once(key)
        return key, verdict

    # Sequential, this is one round-trip per file and hundreds of files.
    # Modest width: an inventory should not read as a spike.
    with ThreadPoolExecutor(max_workers=8) as pool:
        return dict(pool.map(probe, keys)), None


def main() -> int:
    """Report which manifest keys are missing from the mirror."""
    ap = argparse.ArgumentParser()
    ap.add_argument("--json", metavar="PATH",
                    help="also write the machine-readable report here")
    args = ap.parse_args()

    disk = on_disk()
    claimed = manifest_keys()

    # An entry naming a file nobody has is a 404 waiting for a viewer.
    dangling = sorted(k for k in claimed if k not in disk)
    # A file nothing names is invisible to /api/watch, deleted or not.
    unlisted = sorted(k for k in disk if k not in claimed)

    # The mirror's own skip list, so a file it never intended to upload
    # is not reported as a gap.
    never = never_mirrored()
    mirrored = sorted(k for k in disk if not skipped(k, never))

    # Dangling keys are probed TOO. They are the only way to tell an
    # entry already published straight to storage from a silent 404,
    # and probing only what is on disk can never answer it.
    present, why = in_storage(mirrored + dangling)
    missing = sorted(k for k in mirrored if present.get(k) is False)
    unknown = sorted(k for k in mirrored + dangling if present.get(k) is None)
    dangling_live = sorted(k for k in dangling if present.get(k) is True)
    # An entry already recorded as never rendered is not a mirror
    # failure, so it does not block a deletion. It is still reported —
    # debt that stops being visible stops getting paid.
    debt = known_debt()
    dangling_dead = sorted(k for k in dangling
                           if present.get(k) is False
                           and claimed[k].rsplit(".", 1)[0] not in debt)
    never_rendered = sorted(k for k in dangling
                            if present.get(k) is False
                            and claimed[k].rsplit(".", 1)[0] in debt)

    mb = lambda ks: round(sum(disk.get(k, 0) for k in ks) / 1048576, 1)  # noqa: E731

    report = {
        "onDisk": len(disk),
        "bytesOnDisk": sum(disk.values()),
        # Counts do not decide anything; size does. 134 files sounds
        # like a rounding error and is more than half the repository.
        "mbUnlisted": mb(unlisted),
        "mbListed": mb(k for k in disk if k in claimed),
        "manifestEntries": len(claimed),
        "danglingManifestEntries": dangling,
        # Split once storage can answer: live means already published
        # straight to storage, which is the shape we are moving toward.
        # Dead means a manifest entry nothing can serve.
        "danglingButInStorage": dangling_live,
        # Registered, never rendered, already on the debt list. Not a
        # gap in the mirror.
        "neverRendered": never_rendered,
        "danglingAndNowhere": dangling_dead,
        "notMirroredByDesign": sorted(k for k in disk if skipped(k, never)),
        "filesNoManifestEntryNames": unlisted,
        "storageChecked": len(present),
        "missingFromStorage": missing,
        # Asked twice and still could not tell. Not absence — but not
        # the proof a deletion needs either.
        "couldNotCheck": unknown,
        "storageUnavailable": why,
        # A dangling entry that storage CAN serve is not a blocker — it
        # is the end state. Only one nothing can serve is.
        "safeToDelete": (bool(disk) and not missing and not dangling_dead
                         and not unknown and why is None),
    }

    if args.json:
        # Written as well as printed, never instead: running the audit
        # twice to get both formats doubles every storage request.
        Path(args.json).write_text(json.dumps(report, indent=2))

    print(f"on disk        {len(disk)} files, {sum(disk.values()) / 1048576:.0f} MB")
    print(f"  reachable    {report['mbListed']:.0f} MB via the manifest")
    print(f"  unreachable  {report['mbUnlisted']:.0f} MB named by nothing")
    print(f"manifest       {len(claimed)} keys")
    if never_rendered:
        print(f"\nNEVER RENDERED — {len(never_rendered)}, already on the debt list "
              "in arch/seedAssets. Briefs exist; the renders were never paid for:")
        for k in never_rendered[:20]:
            print(f"  {k}")
    if dangling_dead:
        print(f"\nDEAD ENTRIES — {len(dangling_dead)} name(s) nothing can serve:")
        for k in dangling_dead[:20]:
            print(f"  {k}  (claimed by {claimed[k]})")
    if dangling_live:
        print(f"\nPUBLISHED DIRECT — {len(dangling_live)} entr(ies) in storage but "
              "not in the repo. This is the shape we are moving toward.")
        for k in dangling_live[:20]:
            print(f"  {k}")
    elif dangling and why:
        print(f"\nDANGLING — {len(dangling)} entr(ies) with no repo copy, unprobed.")
    if unlisted:
        print(f"\nUNLISTED — {len(unlisted)} file(s), {report['mbUnlisted']:.0f} MB, "
              "no manifest entry names.")
        print("  These are invisible to /api/watch whether or not they are deleted.")
        for k in unlisted[:20]:
            print(f"  {k}")
    if why:
        print(f"\nSTORAGE NOT CHECKED — {why}")
        print("  Nothing here says it is safe to delete. Run where storage is reachable.")
    if missing:
        print(f"\nNOT IN STORAGE — {len(missing)} file(s). Deleting these loses them:")
        for k in missing[:20]:
            print(f"  {k}")
    if unknown:
        print(f"\nCOULD NOT CHECK — {len(unknown)} file(s), asked twice. Unknown is "
              "not absent, and it is not proof either:")
        for k in unknown[:20]:
            print(f"  {k}")
    # The all-clear is one line and it only prints when it is true. An
    # earlier version printed "all present" beside "2 not in storage",
    # because a branch inserted between the check and its else stole
    # the else. A report that contradicts itself is worse than a bare
    # number: it teaches people not to read it.
    # Every finding, not most of them. The first version of this guard
    # named missing and unknown and forgot dead entries, so a run with
    # three names nothing could serve still printed the all-clear. And
    # len(present) is how many keys were ASKED about, not how many came
    # back — it read "all 370 present" over a list of absent ones.
    if not why and not missing and not unknown and not dangling_dead:
        # never_rendered is deliberately not a condition here: it is
        # tracked debt, not a mirror gap.
        print(f"\nstorage        all {sum(1 for v in present.values() if v)} present")

    print()
    print("SAFE TO DELETE" if report["safeToDelete"]
          else "NOT SAFE TO DELETE — resolve the above first")

    return 0 if report["safeToDelete"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
