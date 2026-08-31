"""Which names on a zone carry a DKIM key, and who wrote it?

    python3 scripts/sending_domains.py ontold.site

Reads the zone's DNS and reports every name carrying one, with its
selector. Names and selectors only — a public TXT record either way,
but there is no reason to page a key through a log.

A key is EVIDENCE, not proof. Onboarding a sending domain writes one,
so a name without a key certainly cannot send; a name with one may
carry a key another provider wrote, and only a real send settles it.
The selector is the tell — Cloudflare's own is `cf2024-1`.

## Why ask DNS instead of asking Cloudflare

The first send that reached the binding was refused `could not find
domain config of sending domain`, and the obvious next move is to
onboard the domain in the code. That is backwards: the code names
`mail.<zone>` because a transactional sender wants its own subdomain,
and nothing has ever checked that the name in the code is the name that
was onboarded.

It has already gone wrong exactly that way once on this account —
nationalff carried `mail.` in code while `mx.` was the onboarded one —
and the symptom is nothing at all until a real send is refused, with
the credential present and the DNS looking correct.

A DKIM selector record is the fact on the ground. If it is on `mx.`,
`MAIL_FROM` fixes this with no deploy and no dashboard visit. If there
is none anywhere, the domain genuinely has to be onboarded and this
says so without anybody guessing.

Never prints the token, and asks for nothing it cannot read: the same
zone permission the Worker deploy already uses.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"

#: What a DKIM record's name looks like.
DKIM_MARK = "._domainkey."

#: Cloudflare Email Sending's own DKIM selectors. THE distinction this
#: script exists to draw.
#:
#: `ontold.site` carried a DKIM key, this reported it as onboarded, the
#: sender was moved to the apex on the strength of that — and the send
#: was refused `could not find domain config of sending domain` exactly
#: as before. The key was somebody else's. A DKIM record means SOME
#: provider can sign for the name; only a Cloudflare selector is
#: evidence that CLOUDFLARE can.
#:
#: TWO spellings, and guessing one of them cost a wrong answer in the
#: other direction. `mail.ontold.site` was onboarded and signs with
#: `cf-bounce._domainkey.mail.ontold.site`, alongside `cf-bounce` MX and
#: TXT records for the return path. Matching only `cf2024-` called that
#: NOT onboarded — a false negative on a domain that was working, which
#: is worse than the false positive it was written to prevent, because
#: it sends somebody to re-do something already done.
#:
#: A prefix rather than exact names: Cloudflare has changed this
#: spelling at least once, and the next change should degrade to
#: "recognised" rather than to "not ours".
CF_SELECTORS = ("cf2024-", "cf-bounce", "cf-")


def _get(path: str, token: str) -> dict:
    req = urllib.request.Request(
        f"{API}{path}",
        headers={"authorization": f"Bearer {token}", "user-agent": "ontold/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as err:
        try:
            return json.loads(err.read().decode())
        except Exception:
            return {"success": False, "errors": [{"message": f"HTTP {err.code}"}]}
    except Exception as err:  # pragma: no cover - network shapes vary
        return {"success": False, "errors": [{"message": str(err)}]}


def sending_names(records: list[dict]) -> list[str]:
    """The domains a DKIM key was written for, one entry each.

    `cf2024-1._domainkey.mail.ontold.site` means a key exists for
    `mail.ontold.site`. The selector in front is not part of the answer.
    """
    found = set()
    for r in records:
        name = str(r.get("name") or "")
        if DKIM_MARK in name:
            found.add(name.split(DKIM_MARK, 1)[1])
    return sorted(found)


def selectors_by_domain(records: list[dict]) -> dict[str, set[str]]:
    """Every DKIM selector found, grouped by the domain it signs for."""
    out: dict[str, set[str]] = {}
    for r in records:
        name = str(r.get("name") or "")
        if DKIM_MARK in name:
            selector, domain = name.split(DKIM_MARK, 1)
            out.setdefault(domain, set()).add(selector)
    return out


def cloudflare_ready(records: list[dict]) -> list[str]:
    """The domains CLOUDFLARE can send for — a cf2024-* key, not any key.

    The one that answers the question. A domain with somebody else's
    DKIM key reads as configured from every direction and is refused on
    the first real send, which is the whole failure this script was
    written after.
    """
    return sorted(
        d for d, sels in selectors_by_domain(records).items()
        if any(s.startswith(CF_SELECTORS) for s in sels)
    )


def main(argv: list[str]) -> int:
    """Report the zone's onboarded sending domains. 1 when there are none."""
    zone = argv[0] if argv else ""
    token = (os.environ.get("CLOUDFLARE_API_TOKEN") or "").strip()
    if not zone or not token:
        print("usage: CLOUDFLARE_API_TOKEN=... sending_domains.py <zone>", file=sys.stderr)
        return 2

    zones = _get(f"/zones?name={zone}", token)
    result = zones.get("result") or []
    if not zones.get("success") or not result:
        why = json.dumps(zones.get("errors") or [])[:200]
        print(f"cannot see the zone {zone} — {why}")
        return 1
    zone_id = result[0].get("id", "")

    # TXT only: DKIM, SPF and DMARC are all TXT, and nothing else on the
    # zone is relevant to whether mail can leave it.
    records = _get(f"/zones/{zone_id}/dns_records?type=TXT&per_page=200", token)
    if not records.get("success"):
        why = json.dumps(records.get("errors") or [])[:200]
        print(f"cannot read DNS on {zone} — {why}")
        return 1

    rows = records.get("result") or []
    ready = cloudflare_ready(rows)
    if ready:
        print(f"{zone}: Cloudflare can send for — {', '.join(ready)}")
        print("MAIL_FROM has to be an address on one of these; anything else is")
        print("refused with the credential present and the DNS looking correct.")
        return 0

    print(f"{zone}: NOTHING here is onboarded with Cloudflare Email Sending.")
    others = selectors_by_domain(rows)
    if others:
        # Named, because this is the trap: a key here reads as
        # configured and is refused on the first real send.
        listed = ", ".join(f"{d} ({', '.join(sorted(others[d]))})" for d in sorted(others))
        print(f"There are DKIM keys — {listed} — but none is a Cloudflare selector,")
        print("so they are another provider's and Cloudflare will not send under them.")
    print("Add a sending domain under Email → Email Sending on this zone; it writes")
    print("its own DKIM, SPF and return-path records.")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
