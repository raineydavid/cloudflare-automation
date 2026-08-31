"""What Cloudflare Email Routing is actually doing for a zone.

    ZONE=ontold.com python3 scripts/routing_state.py

Read-only, and deliberately so. The question after an outage is not
"what could we configure" but "what is configured right now": is
routing enabled, which addresses have a rule, is there a catch-all,
and which destinations are verified.

That last one is the one that bites. A rule pointing at an UNVERIFIED
destination silently delivers nothing, which looks exactly like a
missing rule and is fixed a completely different way.

Addresses are masked. A previous script in this repository printed a
customer's inbox into a public build log; the local part keeps its
first character and nothing else.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
ZONE = (os.environ.get("ZONE") or "").strip().lower()
TOKEN = (os.environ.get("CLOUDFLARE_API_TOKEN") or "").strip()


def call(path: str) -> dict:
    """One GET against the Cloudflare API, or a readable error.

    Read-only by construction: this module has no other verb.
    """
    req = urllib.request.Request(
        f"{API}{path}", headers={"Authorization": f"Bearer {TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raise RuntimeError(
            f"GET {path} -> {e.code}: {e.read(400).decode('utf-8','replace')}") from e


def mask(addr: str) -> str:
    """r*@r*.com — both halves, because the domain is the name too."""
    if "@" not in addr:
        return addr[:1] + "*"
    local, _, host = addr.partition("@")
    bits = host.split(".")
    return f"{local[:1]}*@{bits[0][:1]}*.{'.'.join(bits[1:]) or '?'}"


def main() -> int:
    """Print what the zone's mail routing actually is today."""
    if not ZONE or not TOKEN:
        print("ZONE and CLOUDFLARE_API_TOKEN are required", file=sys.stderr)
        return 2
    zid = (call(f"/zones?name={ZONE}").get("result") or [{}])[0].get("id")
    if not zid:
        print(f"no zone '{ZONE}'", file=sys.stderr)
        return 1

    settings = call(f"/zones/{zid}/email/routing").get("result") or {}
    print(f"{ZONE} Email Routing: enabled={settings.get('enabled')} "
          f"status={settings.get('status')}")

    rules = call(f"/zones/{zid}/email/routing/rules").get("result") or []
    print(f"\n{len(rules)} rule(s):")
    for r in rules:
        froms = [m.get("value", "") for m in (r.get("matchers") or [])
                 if m.get("field") == "to"]
        tos = [a.get("value", "") for a in (r.get("actions") or [])
               for a in ([a] if isinstance(a.get("value"), str) else
                         [{"value": v} for v in (a.get("value") or [])])]
        kind = "catch-all" if not froms else ", ".join(mask(f) for f in froms)
        print(f"  {'on ' if r.get('enabled') else 'OFF'} {kind} -> "
              f"{', '.join(mask(t) for t in tos) or '(no destination)'}")
    if not rules:
        print("  (none — every address on this domain bounces)")

    # The account-level list, because verification is per DESTINATION
    # and not per zone. An unverified destination delivers nothing and
    # looks exactly like a missing rule.
    acct = os.environ.get("CF_ACCOUNT_ID", "").strip()
    if acct:
        dests = call(f"/accounts/{acct}/email/routing/addresses").get("result") or []
        print(f"\n{len(dests)} destination(s):")
        for d in dests:
            print(f"  {'verified' if d.get('verified') else 'UNVERIFIED'}  "
                  f"{mask(d.get('email', ''))}")
    else:
        print("\n(set CF_ACCOUNT_ID to also list destination verification)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
