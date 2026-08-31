"""Give a domain's inbound mail back to the provider that had it.

    ZONE=ontold.com python3 scripts/restore_inbound.py           # report
    ZONE=ontold.com RESTORE_APPLY=1 python3 scripts/restore_inbound.py

## What this is undoing

On 2026-08-28T11:59Z `scripts/inbound_switch.py` removed
`mxa.mailgun.org` and `mxb.mailgun.org` from ontold.com and moved
inbound to Cloudflare Email Routing. Those records were **Squarespace
Email Forwarding**, which runs on Mailgun — so what looked like a
stale provider was the founder's live forwarding, and every
pre-existing address on the domain stopped that minute.

The reasoning that led there was wrong in a specific, avoidable way.
The evidence was "ontold.site works, ontold.com does not". Both zones
were ours and configured alike on the SENDING side, so I concluded the
difference must be the inbound provider failing. The actual difference
was that ontold.site had a Cloudflare routing rule to a verified
address and ontold.com had somebody else's forwarding — a difference in
what was being tested, not in what was broken. An MX belonging to a
provider we did not configure is somebody's arrangement, and "I cannot
see why it is there" is the reason to leave it alone, not to remove it.

## This is probably NOT the fix — read this first

Founder: *"but cf can send - thats what we've been doing previously
with the workers right"*. Yes, and I had said otherwise. `ontold-mcp`
holds the `send_email` binding, `mail.ontold.com` is an onboarded
Cloudflare sending domain with its own DKIM and bounce records, and
that is the outbound lane this whole programme built.

Which changes the answer. Squarespace Email Forwarding was
FORWARD-ONLY, and so is Cloudflare Email Routing — neither ever gave
anybody a mailbox to send from. So restoring Mailgun buys nothing that
Cloudflare does not already do, and costs the coherence of having both
halves in one place. The smaller fix is a routing RULE (or a catch-all)
plus a verified destination: no DNS change, no propagation.

This script stays because undoing the damage by hand should be
possible, and because a zone whose owner really does want their old
provider back should not need one written from scratch. It is not the
recommended path for ontold.com.

## Two halves, and only one of them moves

Sending is on `mail.ontold.com` — SPF, DKIM and the bounce MX all sit
on that subdomain and are untouched by anything here. Receiving is
decided by the APEX MX. They are independent names, which is why
restoring inbound does not cost the sending lane, and also why "can we
have both" is yes across the two halves and no within one: Email
Routing requires the apex MX to be its records alone.

## Routing is disabled, not just out-voted

Leaving Email Routing enabled while pointing the MX elsewhere invites
Cloudflare to reassert its own records and undo this quietly. So the
routing service is turned off for the zone first, and the MX is written
second.

## It touches the apex and nothing else

Every record on a subdomain is left exactly as found. A restore that
also rearranged the sending domain would be a second outage wearing the
clothes of a fix.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"

ZONE = (os.environ.get("ZONE") or "").strip().lower()
APPLY = bool(os.environ.get("RESTORE_APPLY"))
TOKEN = (os.environ.get("CLOUDFLARE_API_TOKEN") or "").strip()

#: Exactly what was removed, from the run log that removed it
#: (run 33169146241): priority 10, both hosts. Squarespace's own panel
#: shows the same pair at priority 10, which is the state to return to.
WANT = [("mxa.mailgun.org", 10), ("mxb.mailgun.org", 10)]

#: Five minutes, not Cloudflare's "automatic". The zone's DNS is ours,
#: so the 4 hours Squarespace's panel displays is not a constraint we
#: have to accept — and after an outage the difference between a fix
#: that lands in five minutes and one that lands in four hours is the
#: whole point. Worth raising again once delivery is confirmed.
TTL = int(os.environ.get("RESTORE_TTL", "300"))

#: Cloudflare Email Routing's own MX. Removed from the APEX only.
CF_MX = ("route1.mx.cloudflare.net", "route2.mx.cloudflare.net",
         "route3.mx.cloudflare.net")


def call(method: str, path: str, body: dict | None = None) -> dict:
    """One Cloudflare API call, with the body inlined into the error.

    A 403 that does not say WHICH token was refused sent the last
    attempt at this down a wrong path, so the detail is kept.
    """
    req = urllib.request.Request(
        f"{API}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
        headers={"Authorization": f"Bearer {TOKEN}",
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        detail = e.read(600).decode("utf-8", "replace")
        raise RuntimeError(f"{method} {path} -> {e.code}: {detail}") from e


def zone_id(name: str) -> str:
    """The zone id for a domain, or a clear "not in this account"."""
    got = call("GET", f"/zones?name={name}")
    rows = got.get("result") or []
    if not rows:
        raise RuntimeError(f"no zone '{name}' in this account")
    return rows[0]["id"]


def apex_mx(zid: str, name: str) -> list[dict]:
    """MX on the APEX only. Subdomain MX is somebody else's business."""
    got = call("GET", f"/zones/{zid}/dns_records?type=MX&per_page=100")
    return [r for r in (got.get("result") or []) if r["name"] == name]


def apex_txt(zid: str, name: str) -> list[str]:
    """TXT records on the apex, unquoted — SPF lives here."""
    got = call("GET", f"/zones/{zid}/dns_records?type=TXT&per_page=100")
    return [r["content"].strip('"') for r in (got.get("result") or [])
            if r["name"] == name]


def dkim_present(zid: str, name: str) -> bool:
    """Is Squarespace's `smtp._domainkey` there? Reported, never written.

    It carries a key, and a key is not something to ask anybody to
    paste into a chat window or a build log. If it is missing, the
    person who has it adds it; this only says whether it is.
    """
    got = call("GET", f"/zones/{zid}/dns_records?type=TXT&per_page=100")
    return any(r["name"] == f"smtp._domainkey.{name}"
               for r in (got.get("result") or []))


def main() -> int:
    """Report the zone's inbound state; write it back only on APPLY."""
    if not ZONE:
        print("ZONE is required", file=sys.stderr)
        return 2
    if not TOKEN:
        print("CLOUDFLARE_API_TOKEN is required", file=sys.stderr)
        return 2

    zid = zone_id(ZONE)
    have = apex_mx(zid, ZONE)
    print(f"{ZONE} apex MX today:")
    for r in have:
        print(f"  MX {r['name']} -> {r['content']} (priority {r['priority']})")
    if not have:
        print("  (none)")

    targets = {h for h, _ in WANT}
    already = {r["content"].rstrip(".").lower() for r in have}
    cf_here = [r for r in have if r["content"].rstrip(".").lower() in CF_MX]
    foreign = [r for r in have
               if r["content"].rstrip(".").lower() not in CF_MX
               and r["content"].rstrip(".").lower() not in targets]

    # The same guard the removal had, pointed the other way: a record
    # belonging to neither side is an arrangement this does not
    # understand, and the last time something here acted on a provider
    # it could not account for, it took down a live forwarder.
    if foreign:
        for r in foreign:
            print(f"  UNEXPECTED {r['content']} — not Cloudflare, not the "
                  f"provider being restored")
        print("REFUSING: this zone has an MX nobody here can account for. "
              "Restoring around it could split delivery.", file=sys.stderr)
        return 3

    missing = [(h, p) for h, p in WANT if h not in already]
    print("")
    print(f"plan: disable Email Routing on {ZONE}; "
          f"remove {len(cf_here)} Cloudflare MX; add {len(missing)} "
          f"Mailgun MX ({', '.join(h for h, _ in missing) or 'none'})")
    print("sending stays on mail." + ZONE + " — untouched, including the "
          "bounce MX and DKIM")

    # Squarespace's own instructions ask for three things beside the MX.
    # Forwarding needs the MX; the other two decide whether forwarded
    # mail survives the receiving end's checks, so they are reported
    # even though this does not write them.
    spf = [t for t in apex_txt(zid, ZONE) if t.lower().startswith("v=spf1")]
    print("")
    for t in spf or ["(no SPF on the apex)"]:
        ok = "include:mailgun.org" in t
        print(f"  SPF {'ok  ' if ok else 'CHECK'} {t[:100]}")
    if spf and not any("include:mailgun.org" in t for t in spf):
        print("  → Squarespace expects include:mailgun.org in the apex SPF, "
              "or forwarded mail can fail SPF at the receiving end")
    if not dkim_present(zid, ZONE):
        print("  smtp._domainkey  MISSING — Squarespace lists it. It carries "
              "a key, so nobody should paste it here: add it in the "
              "Cloudflare DNS panel from the Squarespace page you were shown.")
    else:
        print("  smtp._domainkey  present")

    if not APPLY:
        print("\nreport only. Set RESTORE_APPLY=1 to make the change.")
        return 0

    # Routing OFF first, so Cloudflare does not rewrite the MX back
    # underneath us a minute after this finishes.
    try:
        call("PATCH", f"/zones/{zid}/email/routing/disable", {})
        print("[restore] Email Routing disabled")
    except RuntimeError as exc:
        # Not fatal: a zone that never had it enabled answers an error
        # here, and the MX work is what actually matters.
        print(f"[restore] routing disable said: {str(exc)[:200]}")

    for h, prio in missing:
        call("POST", f"/zones/{zid}/dns_records",
             {"type": "MX", "name": ZONE, "content": h,
              "priority": prio, "ttl": TTL})
        print(f"[restore] added MX {ZONE} -> {h} (priority {prio}, ttl {TTL}s)")

    for r in cf_here:
        call("DELETE", f"/zones/{zid}/dns_records/{r['id']}")
        print(f"[restore] removed MX -> {r['content']}")

    after = apex_mx(zid, ZONE)
    print(f"\n{ZONE} apex MX now:")
    for r in after:
        print(f"  MX {r['name']} -> {r['content']} (priority {r['priority']})")

    # Say what is true rather than "done": DNS has to travel, and the
    # thing that proves it is a message arriving, not this script.
    ok = {r["content"].rstrip(".").lower() for r in after} == targets
    print("\n" + (f"records restored at ttl {TTL}s — that is the MECHANISM "
                  "back, not a delivered message. Send a test."
                  if ok else
                  "NOT the expected end state — check the list above"))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
