"""Does mail sent TO this zone reach a person?

    CLOUDFLARE_API_TOKEN=... python3 scripts/email_routing.py ontold.site
    CLOUDFLARE_API_TOKEN=... python3 scripts/email_routing.py ontold.site --ensure hello

Reports whether Email Routing is on, which rules exist, and which
destination addresses are verified. With `--ensure <local-part>` it
creates the missing rule.

## Routing is not Sending

Two products, one word. Sending is what lets `no-reply@mail.<zone>`
leave (see scripts/sending_domains.py); routing is what makes
`hello@<zone>` arrive. Each can be perfect while the other is absent,
and the dashboards sit in different places — which is most of why "it
looks configured" has been wrong twice here.

`hello@<zone>` is the Reply-To on everything outbound. A buyer replying
to a receipt is usually asking something we would want to answer, and
with no routing rule they get a bounce from an address that looks
staffed. That is worse than having no reply path at all.

## A destination has to be VERIFIED, and that part is not automatable

Cloudflare will not forward to an address until its owner clicks a link
it emails them. So this creates rules, never destinations: an
unverified address silently drops mail, and a rule pointing at one is a
rule that looks right and loses messages.

## It will not pick a destination for you when there is a choice

Forwarding a domain's mail somewhere is not a guess worth making. With
MAIL_DESTINATION set it uses that; with exactly one verified address on
the account it uses that; otherwise it lists them and does nothing.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
USER_AGENT = "ontold/1.0 (+https://ontold.com)"


def _call(path: str, token: str, body: dict | None = None, method: str = "") -> dict:
    """One Cloudflare call. GET, or POST when there is a body.

    `method` overrides that pair. Only PUT needs it so far — the zone
    activation check takes an empty body and is not a POST — and it is
    an argument rather than a second function so every call keeps the
    same error handling, which is where the useful codes live.
    """
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{API}{path}",
        data=data,
        headers={
            "authorization": f"Bearer {token}",
            "content-type": "application/json",
            "user-agent": USER_AGENT,
        },
        method=method or ("POST" if data else "GET"),
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


def rule_for(rules: list[dict], address: str) -> dict | None:
    """The existing rule that already delivers `address`, if any.

    Matched on the matcher, not the rule's name: a name is a label
    somebody typed and two rules can share one, while the `to` matcher
    is what actually decides where a message goes.
    """
    for rule in rules:
        for matcher in rule.get("matchers") or []:
            if (matcher.get("field") == "to"
                    and str(matcher.get("value", "")).lower() == address.lower()):
                return rule
    return None


def verified(addresses: list[dict]) -> list[str]:
    """Destination addresses Cloudflare will actually forward to.

    `verified` is a timestamp when set and absent otherwise. An
    unverified destination accepts a rule and drops the mail, which is
    the failure mode this whole file exists to avoid.
    """
    return sorted(
        a["email"] for a in addresses
        if a.get("email") and a.get("verified")
    )


def choose_destination(addresses: list[dict], preferred: str = "") -> tuple[str, str]:
    """Where to forward, and why. ('', reason) when it must not guess."""
    ok = verified(addresses)
    if not ok:
        unverified = sorted(a.get("email", "") for a in addresses if a.get("email"))
        if unverified:
            return "", (
                "no VERIFIED destination — "
                + masked(unverified)
                + " exist but nobody has clicked the confirmation Cloudflare emailed. "
                "A rule pointing at an unverified address drops mail silently."
            )
        return "", "no destination addresses at all on this account"
    if preferred:
        if preferred in ok:
            return preferred, "MAIL_DESTINATION"
        return "", (
            f"MAIL_DESTINATION is {mask(preferred)}, which is not a verified "
            f"destination. Verified: {masked(ok)}"
        )
    if len(ok) == 1:
        return ok[0], "the only verified destination on the account"
    # Deliberately refuses. Picking one would forward a domain's mail to
    # an address nobody named, and the wrong choice is invisible until
    # somebody reports a reply that went nowhere.
    return "", (
        f"{len(ok)} verified destinations and no MAIL_DESTINATION to choose between "
        f"them: {masked(ok)}"
    )


def mask(address: str) -> str:
    """`rainey@raineydavid.com` -> `r*@r*.com`.

    A destination address is a PERSON'S INBOX. This printed them whole
    into CI logs and, from there, into an issue comment — the exact leak
    class this repo runs a pre-commit hook and a CI scan for, in a file
    written to fix an email problem.

    THE DOMAIN IS MASKED TOO. The first attempt kept it, on the
    reasoning that the domain is the half carrying the meaning — which
    is exactly backwards for a personal domain, where the domain IS the
    name. `r****y@raineydavid.com` identifies somebody completely while
    looking careful, and looking careful is worse than not trying.

    What survives is a first initial per label and the TLD: enough for
    the person who configured it to recognise their own address, not
    enough to be anybody's address.
    """
    local, at, domain = str(address).partition("@")
    if not at or not domain or "." not in domain:
        return "(not an address)"
    labels = domain.split(".")
    # Every label but the TLD. A subdomain names things too.
    hidden = [f"{lab[:1]}*" if lab else "*" for lab in labels[:-1]]
    return f"{local[:1]}*@{'.'.join(hidden)}.{labels[-1]}"


def masked(addresses) -> str:
    """A list of them, for a log line."""
    return ", ".join(mask(a) for a in addresses) or "NONE"


def is_cloudflare_mx(host: str) -> bool:
    """Is this MX host Cloudflare Email Routing's own?

    READ from a live zone rather than recalled: screeningstudio.com and
    studentaccount.com carry `route1.mx.cloudflare.net`,
    `route2.mx.cloudflare.net` and `route3.mx.cloudflare.net`. The
    suffix is matched rather than those three names, so a fourth does
    not silently read as somebody else's mail server.

    This repository has been wrong before about a vendor string it
    remembered instead of reading — a DKIM selector, invented and then
    widened into a catch-all when the guess failed. If Cloudflare
    changes these, the fix is to look at a zone, not to add a pattern
    that matches more.
    """
    return str(host).split(" ")[0].strip().lower().endswith(".mx.cloudflare.net")


def may_enable(mx_hosts: list[str] | None) -> tuple[bool, str]:
    """Whether turning Email Routing on is safe, from the zone's own MX.

    Enabling REWRITES the zone's MX records. If something already
    receives for the domain, that takes delivery away from it — a blast
    radius well past one reply address, and not a call a provisioning
    run should make.

    With NO MX at all there is nothing to displace: the domain receives
    nothing today, so enabling can only add.

    `None` means THE READ FAILED, and it is a separate answer from the
    empty list. This guard ran estate-wide against a token without DNS
    read, got an empty result for every zone, and reported "MX: NONE —
    nothing receives for this domain" about a zone Cloudflare then
    refused with `2008 Non-Cloudflare MX records exist`. The guard was
    not guarding; Cloudflare's own check was doing the work. An
    unreadable zone is refused here, because a safety check that cannot
    see is not a safety check.
    """
    if mx_hosts is None:
        return False, (
            "cannot read this zone's MX records, so there is no way to tell whether "
            "enabling would take delivery away from an existing provider"
        )
    incumbent = [h for h in mx_hosts if not is_cloudflare_mx(h)]
    if incumbent:
        return False, (
            "MX already points somewhere — enabling would take delivery for the whole "
            f"domain away from {', '.join(incumbent)}"
        )
    if mx_hosts:
        # Cloudflare's own routing MX, and nothing else. The service
        # reads as off while the records are already in place: a
        # half-finished setup, not somebody else's mail. Refusing here
        # was wrong — it blocked screeningstudio.com and
        # studentaccount.com, whose MX are route1..3.mx.cloudflare.net,
        # from ever getting a reply path.
        return True, ("the only MX are Cloudflare's own routing hosts, so there is no "
                      "other provider to take delivery from")
    return True, "the zone has no MX at all, so there is no delivery to take away"


def verdict(enabled: bool, zone: str, what: str) -> int:
    """The only place that says whether a reply reaches anybody.

    A rule on a zone with Email Routing OFF delivers nothing, however it
    got there — created just now or already present. Both of those read
    as done from inside their own branch, which is why this is one
    function and not a check repeated at each exit.
    """
    if enabled:
        print(f"status:  {what}")
        return 0
    print(f"status:  NOT READY: {what}, and Email Routing is OFF on {zone}, so it "
          f"delivers nothing. Enabling it REWRITES THE ZONE'S MX RECORDS and takes "
          f"delivery for the whole domain away from whatever holds it now — see the MX "
          f"line above. That is a decision, not a step.")
    return 1


def main(argv: list[str]) -> int:
    """Report routing, and with --ensure create the missing rule. 0 when reachable."""
    zone = argv[0] if argv and not argv[0].startswith("-") else ""
    token = (os.environ.get("CLOUDFLARE_API_TOKEN") or "").strip()
    if not zone or not token:
        print("usage: CLOUDFLARE_API_TOKEN=... email_routing.py <zone> [--ensure <local>]",
              file=sys.stderr)
        return 2
    want_enable = "--enable" in argv
    ensure = ""
    if "--ensure" in argv:
        at = argv.index("--ensure")
        ensure = argv[at + 1] if at + 1 < len(argv) else ""

    zones = _call(f"/zones?name={zone}", token)
    rows = zones.get("result") or []
    if not zones.get("success") or not rows:
        print(f"cannot see the zone {zone} — {json.dumps(zones.get('errors') or [])[:200]}")
        return 1
    zone_id = rows[0]["id"]
    account_id = (rows[0].get("account") or {}).get("id", "")

    status = _call(f"/zones/{zone_id}/email/routing", token)
    if not status.get("success"):
        errors = json.dumps(status.get("errors") or [])
        # 10000 here is the CREDENTIAL, exactly as it is on the sending
        # side. Reading it as "routing is broken" sends somebody to a
        # zone that may be configured perfectly.
        if "10000" in errors:
            print(f"cannot tell: CLOUDFLARE_API_TOKEN cannot read Email Routing on {zone} "
                  "(Authentication error 10000). That is a missing permission group — "
                  "Email Routing Rules and Addresses, read and write — and says NOTHING "
                  "about how routing is actually configured. The same token is also short "
                  "Email Sending; one edit fixes both, and editing preserves the value.")
        else:
            print(f"cannot read Email Routing on {zone} — {errors[:200]}")
        return 1
    enabled = (status.get("result") or {}).get("enabled")
    print(f"routing: {'enabled' if enabled else 'DISABLED'} on {zone}")
    if not enabled:
        print("Nothing addressed to this zone is delivered anywhere while it is off.")

    # WHO DELIVERS THIS DOMAIN'S MAIL RIGHT NOW. Cloudflare Routing
    # being off does not mean nothing receives — it means CLOUDFLARE
    # does not. The zone carries DKIM keys that are not Cloudflare's,
    # so another provider may hold the mail, and enabling Routing would
    # take it away from them.
    mx = _call(f"/zones/{zone_id}/dns_records?type=MX&per_page=50", token)
    if not mx.get("success"):
        # NOT the same as an empty list, and reading it as one is how
        # this reported "nothing receives for this domain" about a zone
        # with a live mail provider on it.
        hosts = None
        print(f"MX: UNREADABLE — {json.dumps(mx.get('errors') or [])[:120]}")
    else:
        hosts = sorted(
            f"{r.get('content')} (pri {r.get('priority')})"
            for r in (mx.get("result") or []) if r.get("content")
        )
        print(f"MX: {', '.join(hosts) if hosts else 'NONE — nothing receives for this domain'}")

    rules = (_call(f"/zones/{zone_id}/email/routing/rules", token).get("result") or [])
    for rule in rules:
        tos = [m.get("value") for m in (rule.get("matchers") or []) if m.get("field") == "to"]
        # The `to` side is ours and belongs in a log; the forward
        # target is somebody's inbox and does not.
        dests = [v for a in (rule.get("actions") or [])
                 for v in (a.get("value") or []) if isinstance(v, str)]
        state = "on" if rule.get("enabled") else "off"
        print(f"  rule ({state}): {', '.join(filter(None, tos)) or 'catch-all'} "
              f"-> {masked(dests)}")

    addresses = (_call(f"/accounts/{account_id}/email/routing/addresses", token).get("result") or [])
    ok = verified(addresses)
    print(f"verified destinations: {masked(ok)}")

    if want_enable and not enabled:
        allowed, why = may_enable(hosts)
        if not allowed:
            print(f"status:  REFUSED to enable routing on {zone} — {why}")
            # 3, not 1, and the difference is not cosmetic. A zone whose
            # mail another provider holds is CORRECT as it is: refusing
            # is the guard working, not a job failing. Estate-wide, a
            # handful of such zones made every run red, and a workflow
            # that is always red is one nobody reads — which is how the
            # genuinely broken domains stay broken.
            #
            # An UNREADABLE zone is a real failure and keeps 1: there,
            # something needs fixing before the answer can be trusted.
            return 3 if hosts else 1
        turned = _call(f"/zones/{zone_id}/email/routing/enable", token, body={})
        if not turned.get("success"):
            print(f"status:  NOT READY: could not enable routing on {zone} — "
                  f"{json.dumps(turned.get('errors') or [])[:200]}")
            return 1
        print(f"routing: ENABLED on {zone} ({why})")
        enabled = True

    if not ensure:
        return 0

    wanted = f"{ensure}@{zone}"

    # ONE place decides whether a reply actually reaches anybody, at the
    # end, because every early return is a chance to report ready on a
    # zone that delivers nothing. This had three exits and the check sat
    # below two of them: the run that created the rule said "now
    # forwards" under its own `routing: DISABLED`, and the next one said
    # "already has a rule — nothing to do", which is true and useless.
    if rule_for(rules, wanted):
        return verdict(enabled, zone, f"{wanted} already has a rule")

    dest, why = choose_destination(addresses, os.environ.get("MAIL_DESTINATION", "").strip())
    if not dest:
        print(f"status:  NOT READY: cannot create a rule for {wanted} — {why}")
        return 1

    made = _call(
        f"/zones/{zone_id}/email/routing/rules", token,
        body={
            "name": f"{wanted} -> {dest}",
            "enabled": True,
            "matchers": [{"type": "literal", "field": "to", "value": wanted}],
            "actions": [{"type": "forward", "value": [dest]}],
        },
    )
    if not made.get("success"):
        print(f"status:  NOT READY: {wanted} rule refused — "
              f"{json.dumps(made.get('errors') or [])[:200]}")
        return 1
    return verdict(enabled, zone, f"{wanted} forwards to {mask(dest)} ({why})")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
