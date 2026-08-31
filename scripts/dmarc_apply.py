"""Publish a DMARC policy on a zone that has none.

    CLOUDFLARE_API_TOKEN=... python3 scripts/dmarc_apply.py <zone> [--apply]

Reports by default. `--apply` creates the record.

## Why p=none, and why that is not a cop-out

`p=none` tells receivers to evaluate DMARC and take no action on
failure. It cannot reject, quarantine or delay a single message — the
delivery behaviour of a domain with `p=none` is identical to one with no
record at all. That is exactly why it is the right first step: it is
safe to publish without knowing every system that sends as you, and
publishing it is what lets you find out.

Going straight to `p=reject` on a domain whose senders have not been
inventoried is how a company stops its own invoices arriving. The order
is: publish `p=none`, read the reports, fix what is signing badly, then
tighten. This tool does the first step only, deliberately.

## It will never change a policy that exists

If `_dmarc.<zone>` is already published this refuses and prints what is
there. A weaker policy overwriting a stronger one is a security
regression that looks like a successful run, and `ontold.site` already
carries `p=reject; sp=reject; adkim=s; aspf=s` — publishing `p=none`
over that would quietly disarm the domain.

So: creates, never updates. Tightening an existing policy is a decision
with a blast radius and belongs to a person.

## The apex is the point

A policy on `mail.<zone>` does not cover `<zone>`. ontold.com had
exactly that — `p=reject` on the sending subdomain, nothing on the
domain customers see — and it reads as coverage at a glance.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.email_routing import _call  # noqa: E402

#: Monitor-only, and no `rua=`. A reporting address has to be one
#: somebody actually reads, and aggregate reports arrive as daily XML
#: from every receiver — pointing them at a person's inbox without
#: asking is its own small unkindness. Added when there is somewhere for
#: them to go.
POLICY = "v=DMARC1; p=none;"


def existing(records: list[dict], zone: str) -> dict | None:
    """The DMARC record already on the apex, if there is one."""
    want = f"_dmarc.{zone}".lower()
    for r in records:
        if (str(r.get("type")).upper() == "TXT"
                and str(r.get("name", "")).lower() == want
                and "v=dmarc1" in str(r.get("content", "")).lower()):
            return r
    return None


def main(argv: list[str]) -> int:
    """Report, and with --apply publish p=none where nothing is published."""
    zone = argv[0] if argv and not argv[0].startswith("-") else ""
    token = (os.environ.get("CLOUDFLARE_API_TOKEN") or "").strip()
    if not zone or not token:
        print("usage: CLOUDFLARE_API_TOKEN=... dmarc_apply.py <zone> [--apply]",
              file=sys.stderr)
        return 2

    zones = _call(f"/zones?name={zone}", token)
    rows = zones.get("result") or []
    if not zones.get("success") or not rows:
        print(f"cannot see the zone {zone} — {json.dumps(zones.get('errors') or [])[:200]}")
        return 1
    zone_id = rows[0]["id"]

    got = _call(f"/zones/{zone_id}/dns_records?type=TXT&per_page=100", token)
    if not got.get("success"):
        # Unreadable is not empty. Publishing over a policy we could not
        # see is the one outcome this must never produce.
        print(f"status:  REFUSED — cannot read {zone}'s TXT records, so whether a policy "
              f"already exists is unknown: {json.dumps(got.get('errors') or [])[:160]}")
        return 1

    have = existing(got.get("result") or [], zone)
    if have:
        print(f"_dmarc.{zone} already published: {str(have.get('content'))[:120]}")
        print("status:  nothing to do — an existing policy is never overwritten")
        return 0

    print(f"_dmarc.{zone}: NO POLICY. Receivers are given no instruction about mail "
          f"forged as {zone}.")
    if "--apply" not in argv:
        print(f"status:  would publish `{POLICY}` (monitor-only; cannot affect delivery)")
        return 0

    made = _call(
        f"/zones/{zone_id}/dns_records", token,
        body={"type": "TXT", "name": f"_dmarc.{zone}", "content": POLICY,
              "comment": "DMARC monitor-only; tighten to p=reject once reports are clean"},
    )
    if not made.get("success"):
        print(f"status:  NOT PUBLISHED — {json.dumps(made.get('errors') or [])[:200]}")
        return 1
    print(f"status:  published `{POLICY}` on _dmarc.{zone}. Monitor-only: delivery is "
          "unchanged. Next is a reporting address, then p=reject.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
