#!/usr/bin/env python3
"""Upload the assets the audit found missing from storage. Nothing else.

Founder: *"get the 2 files in then"*, and *"no deletions"*.

The mirror is a directory-wide `aws s3 sync`, which is the right shape
for keeping storage current and the wrong shape for closing a known
two-file gap: it walks 700MB to decide it has nothing to do, and it
only runs when something happens to push under api/seed. This asks the
audit what is missing and uploads exactly that.

    python3 scripts/push_missing_to_storage.py            # say what it would do
    python3 scripts/push_missing_to_storage.py --push     # do it

It uploads and it does not delete. There is no flag that deletes, and
it refuses to touch a key that already has an object, so a re-run after
a successful one is a no-op rather than a needless overwrite.

Bounded on purpose: past MAX_FILES it stops and asks, because "the
audit says a lot is missing" is a reason to look at the mirror rather
than to push half a repository through this script.
"""

from __future__ import annotations

import argparse
import importlib.util
import mimetypes
import sys
import urllib.error
import urllib.request
from pathlib import Path

_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_ROOT / "api"))
sys.path.insert(0, str(_ROOT))

_spec = importlib.util.spec_from_file_location(
    "audit_seed_mirror", _ROOT / "scripts" / "audit_seed_mirror.py")
audit = importlib.util.module_from_spec(_spec)
assert _spec.loader
_spec.loader.exec_module(audit)

# More than a handful missing is a mirror problem, not an upload job.
MAX_FILES = 25


def missing_keys() -> tuple[list[str], str | None]:
    """Keys on disk that storage does not have. Never guesses: a key we
    could not check is not returned, because uploading over something
    that might already be there is a write we did not need to make."""
    disk = audit.on_disk()
    never = audit.never_mirrored()
    mirrored = sorted(k for k in disk if not audit.skipped(k, never))
    present, why = audit.in_storage(mirrored)
    if why:
        return [], why
    return sorted(k for k in mirrored if present.get(k) is False), None


def local_path(key: str) -> Path:
    """The file behind a storage key. Mirrors seed-r2's mapping."""
    return audit.SEED / key[len("assets/"):]


def upload(keys: list[str]) -> int:
    """Put each file. Returns the number that landed."""
    from _inference import r2_sink  # noqa: PLC0415
    from _inference.s3_sigv4 import sign_put_request  # noqa: PLC0415

    access_key, secret, bucket = r2_sink._r2_credentials()
    endpoint = r2_sink._r2_endpoint()
    done = 0
    for key in keys:
        path = local_path(key)
        body = path.read_bytes()
        ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        url, headers = sign_put_request(
            access_key_id=access_key, secret_access_key=secret,
            endpoint=endpoint, bucket=bucket, key=key,
            body=body, content_type=ctype,
        )
        req = urllib.request.Request(url, data=body, method="PUT", headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                ok = r.status in (200, 201)
        except urllib.error.HTTPError as e:
            print(f"  FAILED {key} — {e.code}", file=sys.stderr)
            continue
        except Exception as e:  # noqa: BLE001
            print(f"  FAILED {key} — {type(e).__name__}", file=sys.stderr)
            continue
        if ok:
            done += 1
            print(f"  uploaded {key} ({len(body) / 1024:.0f} KB, {ctype})")
    return done


def main() -> int:
    """Upload the assets the mirror is missing."""
    ap = argparse.ArgumentParser()
    ap.add_argument("--push", action="store_true",
                    help="actually upload (default is to say what it would do)")
    args = ap.parse_args()

    keys, why = missing_keys()
    if why:
        print(f"storage not reachable: {why}", file=sys.stderr)
        return 1
    if not keys:
        print("nothing missing — storage already has every mirrored asset")
        return 0

    total = sum(local_path(k).stat().st_size for k in keys)
    print(f"{len(keys)} file(s) missing from storage, {total / 1048576:.1f} MB:")
    for k in keys:
        print(f"  {k}")

    if len(keys) > MAX_FILES:
        print(f"\n{len(keys)} is more than {MAX_FILES}. That is a mirror problem, "
              "not an upload job — run the full sync and find out why.", file=sys.stderr)
        return 1

    if not args.push:
        print("\nwould upload the above. Re-run with --push.")
        return 0

    landed = upload(keys)
    print(f"\n{landed} of {len(keys)} uploaded")
    return 0 if landed == len(keys) else 1


if __name__ == "__main__":
    raise SystemExit(main())
