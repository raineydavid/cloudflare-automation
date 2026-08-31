"""Who changed this zone, and when.

    CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \\
      python3 scripts/audit_zone.py screeningstudio.com [--days 90]

## The question this exists for

*"but it was working previously — screening studio was live, emails were
being received, who changed it."*

That is the right question and nothing here could answer it. The estate
report says what is true NOW; a domain that stopped working needs the
moment it stopped and the change that did it, or the same thing happens
again and is diagnosed from scratch.

## The specific suspicion

`screeningstudio.com` is delegated to `rick`/`becky.ns.cloudflare.com`
while Cloudflare has the zone assigned `camilo`/`delilah`. The
delegation was presumably correct once, which means the ASSIGNMENT
changed underneath it — and a Cloudflare zone keeps its nameservers for
life with one exception: delete the zone and re-add it, and it draws a
new pair. The registrar is never told.

So a `zone.delete` followed by a `zone.create` is the shape to look
for. This does not assume it: it prints what the log says.

## Addresses are masked

An actor is a person. The initial and the shape are enough to tell one
colleague from another and to know whether it was an automation, and
the unmasked value is in the Cloudflare dashboard for whoever needs it.
Same rule as everywhere else here — this output goes to a CI log.
"""

from __future__ import annotations

import json
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.email_routing import _call, mask  # noqa: E402

#: Both spellings. The audit log moved from `/audit_logs` to
#: `/logs/audit` and which one an account answers on is not worth
#: guessing — this repository has spent runs on exactly that with the
#: Email Sending endpoints. Ask both, report which answered.
PATHS = ("/accounts/{acc}/audit_logs?since={since}&per_page=1000",
         "/accounts/{acc}/logs/audit?since={since}&per_page=1000")


def actor_of(entry: dict) -> str:
    """Who did it, masked, with automations named as such."""
    actor = entry.get("actor") or {}
    kind = str(actor.get("type") or "")
    email = str(actor.get("email") or "")
    if kind and kind not in {"user", "admin"}:
        # `api_key`, `cloudflare_admin`, `system` and friends. Worth
        # distinguishing: an automated change and a person's click call
        # for different follow-ups.
        return f"{kind}{' ' + mask(email) if email else ''}"
    return mask(email) if email else "(no actor recorded)"


def touching(entries: list[dict], domain: str) -> list[dict]:
    """Entries that mention this domain, newest first.

    Matched on the whole entry rather than one field: a zone delete
    names the domain in `resource`, a nameserver change names it in the
    old or new value, and which field carries it differs per action.
    """
    hits = [e for e in entries if domain.lower() in json.dumps(e).lower()]
    return sorted(hits, key=lambda e: str(e.get("when") or ""), reverse=True)


def describe(entry: dict) -> str:
    """One line: when, who, what."""
    when = str(entry.get("when") or "?")[:19]
    action = (entry.get("action") or {}).get("type") or entry.get("action") or "?"
    resource = (entry.get("resource") or {}).get("type") or ""
    return f"{when}  {actor_of(entry):<22} {action} {resource}".rstrip()


def main(argv: list[str]) -> int:
    """Print every audited change touching a domain. 0 even when none."""
    domain = argv[0] if argv and not argv[0].startswith("-") else ""
    token = (os.environ.get("CLOUDFLARE_API_TOKEN") or "").strip()
    account = (os.environ.get("CLOUDFLARE_ACCOUNT_ID") or "").strip()
    if not domain or not token or not account:
        print("usage: CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... "
              "audit_zone.py <domain> [--days N]", file=sys.stderr)
        return 2

    days = 90
    if "--days" in argv:
        at = argv.index("--days")
        if at + 1 < len(argv) and argv[at + 1].isdigit():
            days = int(argv[at + 1])
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")

    entries, used, why = [], "", []
    for path in PATHS:
        got = _call(path.format(acc=account, since=since), token)
        if got.get("success"):
            entries, used = (got.get("result") or []), path.split("?")[0]
            break
        why.append(f"{path.split('?')[0]}: "
                   + "; ".join(f"{e.get('code')} {e.get('message')}"
                               for e in (got.get("errors") or [])) or "no reason")

    if not used:
        # Named precisely, because the fix differs: a missing permission
        # is a token edit, and an unavailable endpoint is a plan.
        print("could not read the audit log on either path:")
        for line in why:
            print(f"  {line}")
        print("status:  UNKNOWN — a 10000 here is the token missing an audit-log "
              "permission group; the log itself is unaffected and readable in the "
              "dashboard.")
        return 1

    hits = touching(entries, domain)
    print(f"audit log via {used}, last {days} days, {len(entries)} entries, "
          f"{len(hits)} touching {domain}")
    for entry in hits:
        print(f"  {describe(entry)}")
    if not hits:
        print(f"status:  nothing in the last {days} days mentions {domain}. The change "
              "may be older, or made somewhere this log does not cover — a REGISTRAR "
              "is a different system with its own history.")
        return 0
    print(f"status:  {len(hits)} audited change(s) touch {domain}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
