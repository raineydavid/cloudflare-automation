"""Which domains can send, which can receive, and which only look like it.

    CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... python3 scripts/mail_estate.py

One row per zone in the account, two columns that matter: OUT (can
`no-reply@mail.<zone>` leave?) and IN (does a reply to `hello@<zone>`
reach a person?). Read-only — it changes nothing, ever.

## Why estate-wide rather than one zone at a time

Every mail failure in this programme has been a domain where one half
was configured and the other was not, and each was found by hand, months
apart, after somebody noticed mail going missing. `email_routing.py`
answers the question for a zone you already suspect. This one asks it
about every zone, so a domain nobody is thinking about cannot sit broken
without saying so.

The zone list comes from the ACCOUNT, not from a list in this file. Two
reasons, and the second is the one that matters:

  * a domain onboarded later is covered without an edit here, and
  * this repository has no business naming its sibling sites. Which
    domains exist is a fact about the Cloudflare account; hard-coding
    them here would put one product's roadmap in another product's
    source, which is what issues are for.

## OUT and IN are separate products with one word between them

Sending is what lets `no-reply@mail.<zone>` leave: onboarded under
Email Sending, with its own DKIM. Routing is what makes `hello@<zone>`
arrive: enabled per zone, with MX pointing at Cloudflare and a rule
forwarding to a VERIFIED destination.

Neither implies the other, and both have now been "already configured"
here while doing nothing. So each column is read from the API that
actually decides it, and a cell says NO whenever the answer is not a
definite yes.

## What it will not do

It never prints a destination address — `mask()` from email_routing, for
the reason recorded there. And it applies nothing: enabling routing
rewrites a zone's MX, which is a decision with a blast radius past this
script.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.email_routing import _call, is_cloudflare_mx, mask, rule_for  # noqa: E402


def zones(token: str, account_id: str) -> list[dict]:
    """Every zone in the account: name, id and STATUS, name-sorted.

    The status matters and was missing. screeningstudio.com carries
    Cloudflare's MX records and refused to enable routing with `2009
    Active zone required` — it is a PENDING zone, so its nameservers are
    not delegated to Cloudflare and none of its DNS is being served.
    Without the status the report could only say "MX points at
    Cloudflare but routing is off", which describes the symptom and
    sends somebody to the wrong dashboard.
    """
    got = _call(f"/zones?account.id={account_id}&per_page=50", token)
    rows = got.get("result") or []
    return sorted(
        ({"name": z.get("name", ""), "id": z.get("id", ""),
          "status": str(z.get("status") or "unknown"),
          # What Cloudflare expects the registrar to point at, and what
          # it currently sees. A pending zone is only actionable if you
          # know both: the fix is to make the second match the first.
          "name_servers": list(z.get("name_servers") or []),
          "original_name_servers": list(z.get("original_name_servers") or [])}
         for z in rows if z.get("id")),
        key=lambda z: z["name"],
    )


def activation_check(token: str, zone_id: str) -> tuple[bool, str]:
    """Ask Cloudflare to re-check this zone's nameserver delegation.

    A zone goes active when Cloudflare notices the registrar pointing at
    its nameservers, and it does not poll forever. If delegation has
    already been done and the check simply has not run since, this is
    the whole fix — so it is worth asking before telling somebody the
    domain needs work at the registrar.

    Never destructive: it re-reads DNS and updates a status. It cannot
    move a domain or change what the registrar says.
    """
    got = _call(f"/zones/{zone_id}/activation_check", token, body={}, method="PUT")
    if got.get("success"):
        return True, "activation check accepted"
    return False, json.dumps(got.get("errors") or [])[:160]


DOMAINISH = re.compile(r"\b([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.[a-z]{2,})\b", re.I)


def sending_domains(text: str, ok: bool) -> tuple[set[str], str]:
    """Domains onboarded for sending, and a note when the answer is unknown.

    Read from `wrangler email sending list` rather than from the REST
    API. Not a preference — `/accounts/{id}/email/sending/domains`
    answers 404 with code 10001 on every token this account has,
    including one that holds Email Sending Read and Write at account
    scope and can POST to `/email/sending/send` successfully. Two repos
    have now spent runs on that 404. wrangler reaches the same resource
    and works, so this asks the thing that answers.

    An empty set is ambiguous — nothing onboarded, or a command that
    failed — and those two mean opposite things. `ok` carries the
    difference, so this never reports "cannot send" about a domain that
    sends fine.
    """
    if not ok:
        head = " ".join(text.split())[:160] or "no output"
        return set(), f"could not list the sending domains ({head})"
    return {m.group(1).lower() for m in DOMAINISH.finditer(text)}, ""


def routing(token: str, zone_id: str) -> tuple[bool, list[dict]]:
    """(Email Routing enabled, the zone's rules). Off on any doubt."""
    status = _call(f"/zones/{zone_id}/email/routing", token)
    enabled = bool((status.get("result") or {}).get("enabled"))
    rules = _call(f"/zones/{zone_id}/email/routing/rules", token).get("result") or []
    return enabled, rules


def mx_of(token: str, zone_id: str) -> list[str] | None:
    """The zone's MX hosts, or None when the read failed.

    None and [] are different answers and the difference matters: an
    unreadable zone was once read as an empty one, and a guard that
    proceeds on "I could not look" is not a guard. Same distinction as
    may_enable in email_routing.
    """
    got = _call(f"/zones/{zone_id}/dns_records?type=MX&per_page=50", token)
    if not got.get("success"):
        return None
    return sorted(str(r.get("content")) for r in (got.get("result") or []) if r.get("content"))


def registry_ns(domain: str) -> list[str] | None:
    """The delegation the TLD registry publishes, or None if it could not be asked.

    Asked of the registry rather than a recursive resolver, because a
    resolver faced with a broken delegation answers SERVFAIL and tells
    you nothing about why. The registry always answers.

    Two things this got wrong first time, both worth keeping written
    down because the wrong version was ALARMING rather than merely
    unhelpful — it reported every one of eighteen live domains as a
    lapsed registration:

    * `dig +short` returns nothing here. A non-recursive query to a TLD
      server produces a REFERRAL: the nameservers are in the AUTHORITY
      section, and `+short` prints only the answer section. Empty output
      meant "no delegation" and every domain looked dead.
    * The TLD's own nameserver cannot be guessed from the suffix.
      `a.gtld-servers.net` serves .com and .net; `a.nic.uk` does not
      serve .uk the way the pattern assumed. It is resolved instead.

    None means COULD NOT ASK and is not an empty list. That distinction
    is the whole subject of this file, and the first version of this
    function broke it.
    """
    tld = domain.rsplit(".", 1)[-1]
    try:
        servers = subprocess.run(
            ["dig", "+short", "+time=3", "+tries=2", "NS", f"{tld}."],
            capture_output=True, text=True, timeout=20,
        ).stdout.split()
    except Exception:
        return None
    for server in servers[:3]:
        try:
            out = subprocess.run(
                ["dig", "+norecurse", "+time=5", "+tries=2", f"@{server}", "NS", domain],
                capture_output=True, text=True, timeout=25,
            ).stdout
        except Exception:
            continue
        # The AUTHORITY section: `<domain>.  172800  IN  NS  <host>.`
        hosts = re.findall(
            rf"^{re.escape(domain)}\.\s+\d+\s+IN\s+NS\s+(\S+)\.$",
            out, re.MULTILINE | re.IGNORECASE,
        )
        if hosts:
            return hosts
        # An authoritative NXDOMAIN from the registry is a real answer:
        # the name genuinely does not exist. Anything else is silence.
        if "status: NXDOMAIN" in out:
            return []
    return None


def delegation_verdict(assigned: list[str],
                       delegated: list[str] | None,
                       status: str | None = None) -> tuple[bool, str]:
    """Does the registry point at the nameservers this zone was assigned?

    The failure this exists for took most of a day to find by hand and
    is invisible from every dashboard involved. screeningstudio.com was
    delegated to `rick`/`becky.ns.cloudflare.com` while Cloudflare had
    assigned it `camilo`/`delilah`. Both pairs are Cloudflare's, so the
    delegation looks right in the registrar UI and Cloudflare's zone
    page looks right too, and the domain returned SERVFAIL. Site and
    mail both dark, for one wrong pair of names.

    ## The first version of this overstated it, and was measurably wrong

    It said a mismatch means the domain "resolves NOWHERE", on the
    reasoning that a Cloudflare nameserver answers only for the zones
    assigned to it. screening.studio then held a mismatched pair for
    hours while resolving perfectly and serving the site through
    Cloudflare's edge — measured, not assumed. So that reasoning is
    false for an ACTIVE zone: Cloudflare's nameservers answer for an
    active zone in the account whichever assigned pair the registry
    names.

    What actually took screeningstudio.com down was the mismatch on a
    zone Cloudflare did NOT consider active. A zone that is `moved` or
    `pending` is served by nobody, and then the delegation pointing
    somewhere unexpected is what keeps it that way.

    Hence `status`. A mismatch is always worth fixing — Cloudflare
    documents the assigned pair as the one to use, and an unfixed
    mismatch is a domain that goes dark the day the zone is touched —
    but calling a working domain dead is the alarm that gets the whole
    report ignored. That mistake has been made twice here now: once
    reporting eighteen live domains as lapsed registrations, once
    reporting this. Both times the fix was to say only what was
    measured.

    Compared as SETS and case-insensitively, with the trailing dot
    stripped: order is not meaningful, and a registry answer is
    fully-qualified where Cloudflare's is not.
    """
    def norm(hosts):
        """Comparable set: lower-cased, trailing dot dropped, blanks gone."""
        return {str(h).strip().rstrip(".").lower() for h in hosts if str(h).strip()}

    if delegated is None:
        # Could not ask. Saying "lapsed" here reported eighteen live
        # domains as expired registrations, which is worse than saying
        # nothing at all.
        return True, "could not ask the registry, so the delegation is unchecked"
    want, got = norm(assigned), norm(delegated)
    if not got:
        return False, ("the registry has no delegation for this domain — the registration "
                       "itself has lapsed, and no nameserver change will help")
    if not want:
        return True, "no assigned nameservers to compare against"
    if want == got:
        return True, "the registry points at the nameservers this zone was assigned"
    where = (f"the registry says {', '.join(sorted(got))} but this zone is assigned "
             f"{', '.join(sorted(want))}. Fixed at the registrar, by setting the "
             "assigned pair.")
    if (status or "").lower() == "active":
        # Serving today. Say that, because a report that calls a working
        # domain dead is a report people stop reading.
        return False, (
            f"delegated to a different Cloudflare pair than it was assigned: {where} "
            "The zone is ACTIVE and resolving, so nothing is down right now — but the "
            "delegation and the assignment disagree, and that is the state this domain "
            "goes dark from the next time the zone is touched.")
    return False, (
        "DELEGATED TO THE WRONG NAMESERVERS: "
        f"{where} The zone is {status or 'not active'} in Cloudflare, so nothing serves "
        "it — site and mail alike are dark until the delegation matches.")


def dmarc_verdict(zone: str, records: list[str]) -> tuple[bool, str]:
    """Does this zone tell receivers what to do with mail forged as it?

    Found by hand on ontold.com, which has a DMARC policy on
    `mail.ontold.com` and NONE on the apex — so the domain customers
    actually see gives receivers no instruction, and anyone may forge
    it. screeningstudio.com has one; the product domain did not.

    Not required for mail to work, which is exactly why it goes
    unnoticed: everything functions, and the gap only shows when
    somebody is impersonating you.

    Reported per zone rather than judged: a zone that sends nothing
    still benefits from `p=reject`, and a zone mid-rollout at `p=none`
    is doing the right thing in the right order. So this says what is
    there and flags only ABSENCE.
    """
    want = f"_dmarc.{zone}".lower()
    for r in records:
        # `TXT _dmarc.example.com -> "v=DMARC1; p=..."`
        parts = r.split(" ", 2)
        if len(parts) == 3 and parts[0].upper() == "TXT" and parts[1].lower() == want:
            policy = "".join(parts[2].split("->", 1)[-1]).strip().strip('"')
            if "v=dmarc1" in policy.lower():
                return True, policy[:80]
    return False, (f"no DMARC on {zone} — receivers are given no instruction about mail "
                   "forged as this domain, and nothing reports it when somebody tries")


def out_verdict(zone: str, onboarded: set[str], note: str, prefix: str,
                status: str = "active") -> tuple[bool, str]:
    """Can this zone send? The sending SUBDOMAIN is what gets onboarded.

    Being onboarded is not the same as being able to send, and
    screeningstudio.com is the proof. wrangler lists
    `mail.screeningstudio.com` as onboarded, this column said yes, and a
    real send was refused `400 10202 email.sending.error.email.invalid`
    — for BOTH probes, including one to a verified destination. The zone
    is PENDING, so Cloudflare serves none of its DNS and the DKIM record
    it wrote is published nowhere. A signature nothing can look up is
    not a signature.
    """
    if status != "active":
        return False, (f"the zone is {status.upper()} in Cloudflare, so its DKIM is "
                       "published nowhere and sends are refused however onboarded "
                       f"{prefix}.{zone} looks")
    if note:
        return False, f"unknown — {note}"
    want = f"{prefix}.{zone}".lower()
    if want in onboarded:
        return True, f"{want} is onboarded"
    # The apex counts: a zone onboarded at its own name can send from it,
    # even though a subdomain is the arrangement we prefer.
    if zone.lower() in onboarded:
        return True, f"{zone} is onboarded at the apex"
    return False, f"{want} is NOT onboarded, so every send from it is refused"


def in_verdict(zone: str, enabled: bool, rules: list[dict], addresses: list[dict],
               local: str, mx_hosts: list[str] | None = None,
               status: str = "active") -> tuple[bool, str]:
    """Does a reply to `<local>@<zone>` reach a person?

    Three things must all hold when Cloudflare carries the mail, and
    each has been the missing one at least once: routing on, a rule for
    the address, and a destination somebody has actually verified.

    But Cloudflare Routing is not the only way a domain receives.
    `blackin.education` has a mail provider of its own — Cloudflare
    refuses to enable routing there, with `2008 Non-Cloudflare MX
    records exist` — and reporting it as NO would be false: mail to it
    arrives, it simply does not arrive through us. A report that calls a
    working domain broken gets ignored, and then it is no use for the
    domains that really are.
    """
    address = f"{local}@{zone}"
    rule = rule_for(rules, address)
    if status != "active":
        # Nothing else about the zone can be true while this is so.
        # Cloudflare serves no DNS for a pending zone, so its records
        # exist in a dashboard and nowhere a resolver will look, and
        # every mail API refuses it with `2009 Active zone required`.
        # The fix is at the REGISTRAR, not here.
        return False, (f"the zone is {status.upper()} in Cloudflare, not active — its "
                       "nameservers are not delegated, so none of its DNS is served and "
                       "no mail setting on it can take effect. Fixed at the registrar.")
    if not enabled:
        elsewhere = [h for h in (mx_hosts or []) if not is_cloudflare_mx(h)]
        if elsewhere:
            # Another provider holds this domain's mail. Nothing to do,
            # and nothing we should do — enabling here would take
            # delivery away from them.
            return True, (f"received by {', '.join(elsewhere)}, not by us — "
                          "Cloudflare Routing is off and should stay off")
        if mx_hosts:
            # Cloudflare's own MX with the service off. The records
            # point at a service that is not running, so this domain
            # receives NOTHING while looking configured — the worst of
            # the states, and the one a glance at DNS gets wrong.
            return False, (f"MX points at Cloudflare but Email Routing is OFF, so "
                           f"{address} is accepted by nothing")
        if mx_hosts is None:
            return False, (f"Email Routing is OFF and this zone's MX is unreadable, so "
                           f"whether {address} reaches anybody cannot be established")
        return False, f"Email Routing is OFF, so {address} delivers nothing"
    if not rule:
        return False, f"routing is on but nothing routes {address} — it bounces"
    if not rule.get("enabled", True):
        return False, f"the rule for {address} exists but is disabled"
    targets = [t for a in (rule.get("actions") or []) for t in (a.get("value") or [])]
    if not targets:
        return False, f"the rule for {address} forwards nowhere"
    live = {a.get("email") for a in addresses if a.get("verified")}
    unverified = [t for t in targets if t not in live]
    if unverified:
        # The silent one. Cloudflare accepts the rule and drops the mail.
        return False, (
            f"{address} forwards to {', '.join(mask(t) for t in unverified)}, "
            "which nobody has verified — mail is accepted and dropped"
        )
    return True, f"{address} forwards to {', '.join(mask(t) for t in targets)}"


def report(rows: list[dict]) -> int:
    """Print the table. 0 only when every zone is green both ways."""
    width = max((len(r["zone"]) for r in rows), default=4)
    print(f"{'domain'.ljust(width)}  OUT  IN")
    for r in rows:
        print(f"{r['zone'].ljust(width)}  {'yes' if r['out'] else 'NO ':<3}  "
              f"{'yes' if r['in'] else 'NO'}")
    print()
    for r in rows:
        print(f"{r['zone']}:")
        print(f"  out: {r['out_why']}")
        print(f"  in:  {r['in_why']}")
    broken = [r["zone"] for r in rows if not (r["out"] and r["in"])]
    print()
    if not rows:
        print("status:  NO ZONES — the token cannot see any, which is not the same "
              "as an account with none.")
        return 1
    if broken:
        print(f"status:  NOT READY: {len(broken)} of {len(rows)} domains — "
              f"{', '.join(broken)}")
        return 1
    print(f"status:  all {len(rows)} domains send and receive")
    return 0


def main(argv: list[str]) -> int:
    """Report every zone. 0 only when all of them send and receive."""
    token = os.environ.get("CLOUDFLARE_API_TOKEN", "").strip()
    account_id = os.environ.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
    if not token or not account_id:
        print("usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... mail_estate.py",
              file=sys.stderr)
        return 2

    # `--names` exists so the provisioning workflow can loop over the
    # same zones this reports on. One source for "which domains are
    # there", rather than a list in a workflow that drifts from a list
    # in a script — which is how a domain gets provisioned and never
    # reported, or reported and never provisioned.
    # Pending zones, with the two nameserver lists that make the
    # difference actionable, and an activation re-check. A zone goes
    # active when Cloudflare notices the registrar pointing at it, and
    # the check does not run forever — so ask before concluding a person
    # has to do something.
    if "--pending" in argv:
        rc = 0
        for z in zones(token, account_id):
            if z["status"] == "active":
                continue
            rc = 1
            print(f"{z['name']}: {z['status'].upper()}")
            print(f"  set these at the registrar: {', '.join(z['name_servers']) or 'unknown'}")
            print(f"  Cloudflare currently sees:  {', '.join(z['original_name_servers']) or 'nothing'}")
            if "--activate" in argv:
                ok, why = activation_check(token, z["id"])
                print(f"  re-check: {'requested' if ok else 'refused — ' + why}")
            # Is the delegation ours to change at all? A domain
            # registered AT Cloudflare has settable nameservers; one
            # registered elsewhere does not, and no permission fixes
            # that. Worth asking before concluding a person must act.
            reg = registrar_domain(token, account_id, z["name"])
            if reg.get("_error"):
                print(f"  registrar: not Cloudflare's to manage, or unreadable — {reg['_error']}")
            else:
                print(f"  registrar: CLOUDFLARE — expires {reg.get('expires_at', '?')}, "
                      f"locked={reg.get('locked')}")
            # And what moving the delegation would cost. Cloudflare
            # serving a zone means serving ALL of it, so a site whose
            # records are not here goes down the moment the nameservers
            # move. Never make that trade without showing it.
            held = zone_records(token, z["id"])
            print(f"  this zone holds {len(held)} record(s):")
            for r in held:
                print(f"    {r}")
        if rc == 0:
            print("every zone is active")
        return rc

    # Delegation, for every zone. screeningstudio.com was delegated to
    # one Cloudflare nameserver pair while assigned another: both pairs
    # are Cloudflare's, so the registrar UI and the Cloudflare zone page
    # each looked right, and the domain resolved nowhere. It took most
    # of a day to find by hand and appeared in no dashboard. One query
    # per zone catches it.
    if "--delegation" in argv:
        bad = 0
        for z in zones(token, account_id):
            got = registry_ns(z["name"])
            ok, why = delegation_verdict(z.get("name_servers") or [], got,
                                         z.get("status"))
            if not ok:
                bad += 1
                print(f"{z['name']}: {why}")
        print(f"status:  {bad} zone(s) delegated where they are not served" if bad
              else "status:  every zone is delegated to the nameservers it was assigned")
        return 1 if bad else 0

    # One zone, in full. "What is actually set up for this domain" is a
    # question worth being able to answer without reading a whole
    # estate report, and the records are the answer rather than a
    # summary of them.
    # DMARC across the estate. Absence is the finding; a policy that
    # exists is printed as-is rather than graded, because p=none during
    # a rollout is correct and p=reject on a silent domain is also
    # correct.
    if "--dmarc" in argv:
        missing = 0
        for z in zones(token, account_id):
            if z["status"] != "active":
                continue
            ok, why = dmarc_verdict(z["name"], zone_records(token, z["id"]))
            print(f"{z['name']}: {'DMARC ' + why if ok else why}")
            missing += 0 if ok else 1
        print(f"status:  {missing} zone(s) with no DMARC policy" if missing
              else "status:  every active zone publishes a DMARC policy")
        return 1 if missing else 0

    if "--records" in argv:
        at = argv.index("--records")
        want = argv[at + 1] if at + 1 < len(argv) else ""
        for z in zones(token, account_id):
            if z["name"] != want:
                continue
            print(f"{z['name']} ({z['status']})")
            for r in zone_records(token, z["id"]):
                print(f"  {r}")
            return 0
        print(f"no zone named {want} in this account", file=sys.stderr)
        return 1

    if "--names" in argv:
        found = zones(token, account_id)
        if not found:
            print("no zones visible to this token", file=sys.stderr)
            return 1
        for z in found:
            print(z["name"])
        return 0

    # Both read from the same place the Worker sends and replies from, so
    # this cannot report on an arrangement nothing uses.
    local = os.environ.get("REPLY_LOCAL", "hello").strip() or "hello"
    prefix = os.environ.get("MAIL_PREFIX", "mail").strip() or "mail"

    found = zones(token, account_id)
    # Written by the workflow step that ran wrangler. Absent means
    # nobody asked, which is not the same as nothing being onboarded.
    listing = os.environ.get("SENDING_LIST", "").strip()
    text, ok = "", False
    if listing and Path(listing).exists():
        text = Path(listing).read_text(errors="replace")
        ok = os.environ.get("SENDING_LIST_OK", "") == "1"
    else:
        text = "SENDING_LIST was not set, so nothing asked wrangler"
    onboarded, note = sending_domains(text, ok)
    addresses = (_call(f"/accounts/{account_id}/email/routing/addresses?per_page=50",
                       token).get("result") or [])

    rows = []
    for z in found:
        enabled, rules = routing(token, z["id"])
        out_ok, out_why = out_verdict(z["name"], onboarded, note, prefix,
                                      z.get("status", "active"))
        in_ok, in_why = in_verdict(z["name"], enabled, rules, addresses, local,
                                   mx_of(token, z["id"]), z.get("status", "active"))
        records = zone_records(token, z["id"])
        dmarc_ok, dmarc_why = dmarc_verdict(z["name"], records)
        deleg_ok, deleg_why = delegation_verdict(
            z.get("name_servers") or [], registry_ns(z["name"]),
            z.get("status", "active"))
        rows.append({"zone": z["name"], "status": z.get("status", "active"),
                     "out": out_ok, "out_why": out_why,
                     "in": in_ok, "in_why": in_why,
                     "dmarc": dmarc_ok, "dmarc_why": dmarc_why,
                     "delegation": deleg_ok, "delegation_why": deleg_why})

    if os.environ.get("MAIL_ESTATE_JSON"):
        # Everything a dashboard needs, in one document: the two mail
        # columns plus the facts that explain them. A renderer that has
        # to re-derive "why" from prose is a renderer that will get it
        # wrong.
        print(json.dumps({
            "measured": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "reply_local": local,
            "sending_prefix": prefix,
            "zones": rows,
        }, indent=2))
        return 0
    return report(rows)


def registrar_domain(token: str, account_id: str, name: str) -> dict:
    """What Cloudflare Registrar knows about this domain, if anything.

    The one avenue that could change a delegation from here: a domain
    registered AT Cloudflare has its nameservers settable through the
    API. A domain registered elsewhere does not, and no amount of
    Cloudflare permission changes that.

    Returns {} when the domain is not Cloudflare's to manage — which
    includes the case where the token cannot see the registrar at all,
    and those are reported separately by the caller, because "not
    registered here" and "cannot tell" are not the same answer.
    """
    got = _call(f"/accounts/{account_id}/registrar/domains/{name}", token)
    if got.get("success"):
        return got.get("result") or {}
    return {"_error": json.dumps(got.get("errors") or [])[:160]}


def zone_records(token: str, zone_id: str) -> list[str]:
    """Every record Cloudflare holds for the zone, as `type name -> value`.

    Needed before anyone moves a delegation. Cloudflare serving a zone
    means it serves ALL of it: if the site's A and CNAME records are not
    in this list, pointing the nameservers here takes the site down to
    fix the mail. That trade is never worth making silently.
    """
    got = _call(f"/zones/{zone_id}/dns_records?per_page=100", token)
    if not got.get("success"):
        return []
    return sorted(
        f"{r.get('type')} {r.get('name')} -> {r.get('content')}"
        for r in (got.get("result") or []) if r.get("type")
    )

if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
