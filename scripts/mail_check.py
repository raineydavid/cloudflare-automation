"""Can this platform send mail, and to whom?

## What it asks

Mail goes through `ontold-mcp`, which holds the `send_email` binding —
authority the Worker has rather than a key we present. So the questions
are not about a Cloudflare token:

  1. Is a bearer configured at all? Without one, `/notify` refuses rather
     than relaying, which is the correct behaviour for a mail route and
     also means nothing can be sent.
  2. Is the Worker there, and does it accept our bearer?
  3. Does a real send reach an address that is NOT a verified
     destination?

## Three is the one that matters

Cloudflare permits sending to VERIFIED DESTINATION ADDRESSES long before
a sending domain is onboarded. Those are inboxes the account already
controls, so a check that mails our own address passes happily on a
platform that cannot reach a single customer.

`hello@ontold.site` is ours — it lands somewhere we read — and it is a
routing rule rather than a verified destination, so it is refused while
the domain is un-onboarded and accepted once it is not. That difference
is the entire test.

`accepted` is still not `delivered`. A message can be refused after this
point or land in spam; what this proves is that we are permitted to try.

    python3 scripts/mail_check.py          # says what is configured
    python3 scripts/mail_check.py --send   # sends one real message to ours

Never takes a recipient as an argument. A script that will mail whatever
it is handed is a way to make our domain write to a stranger.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request

sys.path.insert(0, __file__.rsplit("scripts/", 1)[0] or ".")

from api._mail import (  # noqa: E402
    HELLO,
    USER_AGENT,
    mail_from,
    notify_token,
    notify_url,
    sending_domain,
    verdict_for,
)


def main(argv: list[str]) -> int:
    """Report what is configured, and with --send, prove it. 0 when ready."""
    sender = mail_from()
    domain = sending_domain(sender)
    url = notify_url()
    token = notify_token()

    print(f"from:    {sender}")
    print(f"domain:  {domain}")
    print(f"worker:  {url}")
    print(f"bearer:  {'present' if token else 'ABSENT'}")

    if not token:
        print("status:  NOT READY: no MCP_TOKEN, ROOT_SECRET or SIGNING_SECRET, so /notify refuses")
        return 1

    if "--send" not in argv:
        print(f"status:  configured. Re-run with --send to prove it, which mails {HELLO}")
        return 0

    req = urllib.request.Request(
        url,
        data=json.dumps(
            {
                "to": HELLO,
                "subject": "Mail check",
                "text": "Sent by scripts/mail_check.py to prove this platform can send.",
            }
        ).encode(),
        headers={
            "authorization": f"Bearer {token}",
            "content-type": "application/json",
            # See api/_mail.USER_AGENT — the default urllib one draws a 403
            # from the edge and never reaches the Worker.
            "user-agent": USER_AGENT,
        },
        method="POST",
    )

    status, errors = 0, ""
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            status = res.status
    except urllib.error.HTTPError as err:
        status = err.code
        try:
            payload = json.loads(err.read().decode())
            errors = f"{payload.get('error', '')} {payload.get('detail', '')}".strip()
        except Exception:
            errors = ""
    except Exception as err:
        # An unreachable Worker is a different answer from a refused send,
        # and saying "not onboarded" here would send somebody to the
        # dashboard to fix a deploy.
        print(f"status:  NOT READY: cannot reach {url} — {err}")
        return 1

    print(f"status:  {verdict_for(status, errors, domain)}")
    return 0 if 200 <= status < 300 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
