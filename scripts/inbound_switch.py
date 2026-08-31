"""Move a zone's inbound mail from another provider to Cloudflare Routing.

    CLOUDFLARE_API_TOKEN=... python3 scripts/inbound_switch.py ontold.com mailgun.org
    CLOUDFLARE_API_TOKEN=... python3 scripts/inbound_switch.py ontold.com mailgun.org --apply

Reports by default. `--apply` removes the named provider's MX records so
Cloudflare Email Routing can be enabled on the zone.

## Why this is separate, and deliberately awkward

Everything else in this repository REFUSES to do this. `may_enable()` in
email_routing.py exists to stop a provisioning run taking a domain's
mail away from whoever currently holds it, because that is a blast
radius well past one reply address and never a call automation should
make on its own.

So this is the manual override, and it is written to be used once, with
evidence, on a domain whose current inbound is known not to work. Here
that evidence is direct: `hello@ontold.com` goes to Mailgun and does
not arrive, while the identical arrangement on ontold.site delivers.

## It prints what it deletes, in a form you can paste back

Every record is printed with type, name, content and priority BEFORE it
goes, so restoring the previous provider is copy-paste rather than
archaeology. A destructive change that cannot be undone from its own
output is a change nobody should run.

## It will not touch a provider you did not name

The suffix is an argument, matched against the record's content. A zone
whose MX includes something outside both the named provider and
Cloudflare's own is left completely alone: that is a zone with an
arrangement this does not understand, and guessing there is how you
take down mail somebody depends on.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.email_routing import _call, is_cloudflare_mx  # noqa: E402


def classify(records: list[dict], provider: str) -> tuple[list[dict], list[dict], list[dict]]:
    """(the named provider's MX, Cloudflare's own, anything else).

    The third list is the one that matters. Anything in it means the
    zone has an arrangement beyond "provider X holds the mail", and this
    refuses rather than guessing.
    """
    theirs, cf, other = [], [], []
    want = provider.lower().rstrip(".")
    for r in records:
        content = str(r.get("content") or "").lower().rstrip(".")
        # On a LABEL BOUNDARY, not a bare suffix. `notmailgun.org` ends
        # with `mailgun.org`, so a plain endswith would sweep up a
        # lookalike domain and delete its MX — in the one script here
        # allowed to delete anything.
        if content == want or content.endswith("." + want):
            theirs.append(r)
        elif is_cloudflare_mx(content):
            cf.append(r)
        else:
            other.append(r)
    return theirs, cf, other


def describe(r: dict) -> str:
    """One record, in a form that can be recreated from this line alone."""
    return (f"{r.get('type')} {r.get('name')} -> {r.get('content')} "
            f"(priority {r.get('priority')}, ttl {r.get('ttl')})")


def main(argv: list[str]) -> int:
    """Report, and with --apply remove the named provider's MX records."""
    args = [a for a in argv if not a.startswith("-")]
    zone = args[0] if args else ""
    provider = args[1] if len(args) > 1 else ""
    token = (os.environ.get("CLOUDFLARE_API_TOKEN") or "").strip()
    if not zone or not provider or not token:
        print("usage: CLOUDFLARE_API_TOKEN=... inbound_switch.py <zone> <provider-suffix> [--apply]",
              file=sys.stderr)
        return 2

    zones = _call(f"/zones?name={zone}", token)
    rows = zones.get("result") or []
    if not zones.get("success") or not rows:
        print(f"cannot see the zone {zone} — {json.dumps(zones.get('errors') or [])[:200]}")
        return 1
    zone_id = rows[0]["id"]

    got = _call(f"/zones/{zone_id}/dns_records?type=MX&per_page=100", token)
    if not got.get("success"):
        # Unreadable is not empty, and deleting on a read we could not
        # make is the worst outcome available here.
        print(f"status:  REFUSED — cannot read {zone}'s MX records: "
              f"{json.dumps(got.get('errors') or [])[:160]}")
        return 1

    theirs, cf, other = classify(got.get("result") or [], provider)

    print(f"{zone} MX today:")
    for r in theirs + cf + other:
        print(f"  {describe(r)}")

    if other:
        print(f"status:  REFUSED — {len(other)} MX record(s) belong to neither {provider} "
              "nor Cloudflare. This zone has an arrangement beyond one provider holding "
              "the mail, and guessing there takes down mail somebody depends on.")
        return 1
    if not theirs:
        print(f"status:  nothing to do — no MX record on {zone} points at {provider}")
        return 0

    print("")
    print(f"To restore {provider} afterwards, recreate exactly these:")
    for r in theirs:
        print(f"  {describe(r)}")
    print("")

    if "--apply" not in argv:
        print(f"status:  would remove {len(theirs)} {provider} MX record(s), leaving "
              f"{zone} with no MX at all — which is what lets Email Routing be enabled on it.")
        return 0

    removed = 0
    for r in theirs:
        gone = _call(f"/zones/{zone_id}/dns_records/{r.get('id')}", token, method="DELETE")
        if gone.get("success"):
            removed += 1
            print(f"removed: {describe(r)}")
        else:
            print(f"FAILED to remove {describe(r)} — "
                  f"{json.dumps(gone.get('errors') or [])[:160]}")

    if removed != len(theirs):
        # A half-removed MX set is the worst state: mail split between a
        # provider that no longer has all of it and a service not yet
        # enabled. Say so loudly rather than proceeding.
        print(f"status:  PARTIAL — {removed} of {len(theirs)} removed. {zone} is now in a "
              "split state and Email Routing must NOT be enabled until the rest are gone "
              "or the removed ones are restored from the lines above.")
        return 1

    print(f"status:  {zone} now has no MX. Enable Email Routing on it "
          "(provision-email-routing.yml) to give it a reply path.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
