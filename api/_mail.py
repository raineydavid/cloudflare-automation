"""Sending mail.

This platform had no transport at all, which was fine while nothing here
talked to a person and stopped being fine at the till: `api/_receipts.py`
writes a receipt that `docs/refunds.md` §4 promises to honour, and
nothing could send it. See #143.

## Through our own Worker, not a token

The first version POSTed to Cloudflare's Email Sending REST API from
here, and the first real run was refused `401 10000`: this deployment's
token has no Email Sending permission. Granting it would have meant a
credential in Vercel that can mail anyone, to be rotated and watched.

`ontold-mcp` already holds a `send_email` binding, which is authority the
Worker has rather than a key it presents — nothing to grant, rotate or
leak. Same move as #116, which put publish behind the SITES binding
instead of "presenting a bearer to our own site-host Worker over the
public internet".

So this posts to `/notify` on that Worker, authenticated with the bearer
it already uses. One secret, already there, instead of a new one.

## A send must never change what the caller returns

Here that is about money. Somebody who has paid has finished what they
came to do the moment the receipt is stored; telling them the purchase
failed because our mail was having a bad minute would be a lie about
their own transaction.

So `send()` returns a bool and raises nothing. The caller logs it. What
it must not do is gate the response.

## Transport only

No templates and no renderer — those belong in the shared package (#142).
This takes `text` and optional `html` so one can be dropped in without
touching a call site.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request

# Both spellings — which one resolves depends on the loader, and
# api/run.py imports this with `api/` itself on sys.path. Same pair as
# api/_filmGate.py.
try:
    from _env import setting
except ModuleNotFoundError:  # pragma: no cover - depends on the loader
    from api._env import setting

#: The zone mail belongs to. NOT necessarily the domain a reader sees.
#:
#: ## A correction, because the reason recorded here was wrong
#:
#: This used to say ontold.com is NOT a zone in this Cloudflare account,
#: inferred from the token holding Workers Routes over `workais.app /
#: ontold.site / onloved.com` and not ontold.com. That inference does not
#: hold: which zones a token may route WORKERS on says nothing about
#: which zones exist. `scripts/mail_estate.py` lists the account's zones
#: and ontold.com is among them — and `mail.ontold.com` is now onboarded
#: for sending, which the old note said could never happen.
#:
#: So the two domains are a product decision, not a constraint:
#: ontold.com is the product, ontold.site the UGC surface, and both can
#: carry mail.
#:
#: ## The zone stays ontold.site, by decision
#:
#: ontold.com now has working mail of its own — its own DKIM, its own
#: MX on Cloudflare Routing, `hello@ontold.com` forwarding to a verified
#: destination. That is deliberately NOT a reason to move this constant.
#: The founder's instruction is that the two are separate things: the
#: product domain and the UGC surface each carry their own mail, and
#: this app sends and replies as ontold.site.
#:
#: So ontold.com's provisioning is not this constant's business, and a
#: future run finding `mail.ontold.com` healthy should leave this alone.
#: MAIL_DOMAIN exists for a deployment that genuinely needs a different
#: zone, not as an invitation to merge the two.
#:
#: What must never happen is moving one without the other: the address
#: and its configuration are a single decision, and splitting them is
#: how every send got refused with the credential present twice already.
MAIL_ZONE = "ontold.site"


def mail_zone() -> str:
    """The zone mail is sent from and replied to."""
    return setting("MAIL_DOMAIN") or MAIL_ZONE

#: Where a person writes to. The Reply-To on everything outbound.
#:
#: People reply to no-reply addresses — that is not a user error, it is
#: what people do with email. A buyer replying to a receipt is usually
#: asking something we would want to answer, and with no reply path they
#: get a bounce from a mailbox nobody reads.
HELLO = f"hello@{MAIL_ZONE}"

#: Outbound transactional mail. Receives nothing.
#:
#: On a sending subdomain, which carries its own SPF, DKIM and bounce
#: records and keeps a bounce rate off the reputation of the domain the
#: site is served on.
#:
#: NOT YET ONBOARDED, and nothing here sends until it is. This briefly
#: moved to the apex, because the zone carried a DKIM key for it and
#: that looked like onboarding — it was another provider's key, the
#: selector was not `cf2024-*`, and the send was refused `could not find
#: domain config of sending domain` exactly as before. A DKIM record
#: means SOME provider can sign for the name; only a Cloudflare selector
#: means Cloudflare can, and `scripts/sending_domains.py` now reports
#: that difference rather than the bare presence of a key.
#:
#: The onboarded domain and the From address are ONE decision: onboard
#: first, change this second. MAIL_FROM overrides it without a deploy.
#:
#: NOTE this is not what puts the address on the wire — the Worker holds
#: the binding and its own MAIL_FROM var, in workers/mcp/wrangler.toml.
#: This is what mail_check.py reports, and the two must agree or the
#: report describes a send that did not happen.
DEFAULT_MAIL_FROM = f"no-reply@mail.{MAIL_ZONE}"

#: The Worker that holds the binding. Overridable for a preview deploy.
DEFAULT_NOTIFY_URL = "https://mcp.ontold.site/notify"

#: What we call ourselves on the wire.
#:
#: urllib sends `Python-urllib/3.x`, which Cloudflare's bot protections
#: treat as exactly what it looks like. The first send through the
#: Worker came back 403 — a status /notify does not return, from
#: something in front of it — and a default user agent is the cheapest
#: explanation to remove. Naming the caller is also just good manners
#: for traffic to our own edge.
USER_AGENT = "ontold/1.0 (+https://ontold.com)"


def mail_from() -> str:
    """The sender, overridable without a deploy."""
    return setting("MAIL_FROM") or DEFAULT_MAIL_FROM


def sending_domain(sender: str | None = None) -> str:
    """The domain part of whatever address we would actually send from."""
    return (sender or mail_from()).rpartition("@")[2]


def notify_url() -> str:
    """Where the Worker that can actually send is listening."""
    return setting("NOTIFY_URL") or DEFAULT_NOTIFY_URL


def notify_token() -> str | None:
    """The bearer /notify expects.

    NOTIFY_TOKEN first, because mail should not govern anything else.
    MCP_TOKEN drives three unrelated policies on the Worker — whether
    /mcp needs a bearer, whether the cost-bearing tools are on, and what
    /notify accepts — so provisioning a mailer by setting it closed an
    MCP surface that was deliberately open. A name of its own costs one
    secret and stops that.

    The rest stay, in the order the Worker accepts them, so a deployment
    configured before the split keeps working and there is nothing to
    coordinate.
    """
    return (
        setting("NOTIFY_TOKEN")
        or setting("MCP_TOKEN")
        or setting("ROOT_SECRET")
        or setting("SIGNING_SECRET")
    )


def configured() -> bool:
    """Whether a send could be attempted at all."""
    return bool(notify_token())


def send(
    to: str,
    subject: str,
    text: str,
    html: str | None = None,
    timeout: float = 10.0,
) -> bool:
    """Send one message. True when Cloudflare accepted it.

    ACCEPTED, never delivered. A message can still be refused after this
    point or land in spam; what a True means is that we were permitted to
    hand it over. Anything claiming more would be recording what we hope.

    Never raises. A send is always a side effect of something the caller
    has already succeeded at, and a mail outage must not become a failed
    purchase.
    """
    token = notify_token()
    if not token:
        # A valid state, and the right one for a preview deploy: the flow
        # works end to end and nobody is emailed by a test.
        return False

    payload: dict[str, object] = {"to": to, "subject": subject, "text": text}
    if html:
        payload["html"] = html

    req = urllib.request.Request(
        notify_url(),
        data=json.dumps(payload).encode(),
        headers={
            "authorization": f"Bearer {token}",
            "content-type": "application/json",
            "user-agent": USER_AGENT,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            return 200 <= res.status < 300
    except urllib.error.HTTPError as err:
        # Carries the Worker's reason. Before the sending domain is
        # onboarded this is where "only verified destinations" appears,
        # and it is the difference between a permission problem and a
        # domain problem.
        detail = ""
        try:
            detail = err.read().decode()[:300]
        except Exception:  # pragma: no cover - the body is best effort
            pass
        print(f"[mail] refused {err.code}: {detail}")
        return False
    except Exception as err:  # pragma: no cover - network shapes vary
        print(f"[mail] send failed: {err}")
        return False


def ticket(to: str, timeout: float = 10.0) -> str | None:
    """Hold an address for later, and get back an opaque id.

    A render finishes minutes after the request that queued it returned,
    in a GitHub Actions run — so the thing that knows it is done is the
    workflow, not this process. The obvious wiring is to pass the
    address as a workflow input, and it is wrong twice: a dispatch input
    is recorded on the run and readable by anyone with repository read,
    and it makes the workflow a relay that mails whatever it is handed.

    So the address stops here. What travels is this id, which means
    nothing without the Worker and the bucket behind it.

    Returns None when no ticket could be held — the caller carries on
    without a notification rather than failing the thing the person
    actually asked for.
    """
    token = notify_token()
    if not token or not to:
        return None

    req = urllib.request.Request(
        notify_url().rstrip("/") + "/ticket",
        data=json.dumps({"to": to}).encode(),
        headers={
            "authorization": f"Bearer {token}",
            "content-type": "application/json",
            "user-agent": USER_AGENT,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            got = json.loads(res.read().decode())
    except urllib.error.HTTPError as err:
        detail = ""
        try:
            detail = err.read().decode()[:200]
        except Exception:  # pragma: no cover - the body is best effort
            pass
        print(f"[mail] ticket refused {err.code}: {detail}")
        return None
    except Exception as err:  # pragma: no cover - network shapes vary
        print(f"[mail] ticket failed: {err}")
        return None

    value = got.get("ticket") if isinstance(got, dict) else None
    return value if isinstance(value, str) and value else None


def verdict_for(status: int, errors: str, domain: str) -> str:
    """What a probe result means, in a sentence somebody can act on.

    Separate from the request so it can be tested without a credential.

    Read against what /notify ACTUALLY RETURNS, which is a short list:
    202, 401, 400, 404, 405, 502 and 503. A status outside it did not
    come from the Worker, and saying "the domain is not onboarded"
    because a status was non-2xx sends somebody to the wrong dashboard —
    which is how the first version of this cost several diagnoses by
    reporting a token problem as a domain problem.
    """
    if 200 <= status < 300:
        return (
            f"onboarded — a non-verified address was accepted, so mail from "
            f"{domain} can reach a customer"
        )
    lowered = errors.lower()

    if status == 401:
        return (
            "NOT READY: the Worker refused this bearer — the value here and "
            "env.MCP_TOKEN on ontold-mcp are different. provision-notify-bearer "
            "sets both in one act"
        )
    if status == 403:
        # /notify never returns one. Something in front of the Worker
        # did: a WAF rule, Bot Fight Mode, or Access on the hostname.
        return (
            "NOT READY: refused with 403, which /notify does not return — the "
            "request was blocked BEFORE it reached the Worker (a WAF rule, Bot "
            "Fight Mode, or Access on the hostname), so this says nothing yet "
            "about whether mail can be sent"
        )
    if status == 503:
        return f"NOT READY: the Worker is reachable but cannot send — {errors or 'no bearer configured on it, or no send_email binding on the deployment'}"
    # The binding refused, and its own words are the answer this whole
    # probe exists to get. Two phrasings mean the same thing:
    #
    #   "could not find domain config of sending domain" — the sending
    #   domain has never been onboarded, so there is no SPF/DKIM/bounce
    #   configuration to send under. This is the one the first real send
    #   returned.
    #
    #   "...not verified" — onboarding is under way and Cloudflare is
    #   still accepting verified destinations only.
    #
    # Both need the same fix and neither is a credential problem.
    if "sending domain" in lowered or "domain config" in lowered or "verif" in lowered:
        return (
            f"NOT READY: {domain} is not onboarded for sending — Cloudflare has no "
            f"configuration for it, so no customer can be reached. Add it under "
            f"Email → Email Sending on the zone, which writes its SPF, DKIM and "
            f"return-path records ({errors})"
        )
    if status == 502:
        return f"NOT READY: the send was refused — {errors or 'no reason given'}"
    if not errors:
        return f"NOT READY: refused with {status} and no reason given"
    return f"NOT READY: {errors}"
