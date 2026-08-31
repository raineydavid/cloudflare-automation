"""One secret to set, many keys in use.

Founder (2026-07-27): *"why do we have so many secret keys - its getting
ridiculous"* … *"can keep them but maybe make it a copy of one?"*

Both halves of that are right, and this does exactly it: keep the
separate keys, stop making a human generate and set each one.

## The distinction that makes this safe

There are two kinds of secret in this system and only one of them can
collapse:

  * **Ours.** Bearer tokens WE mint to gate our own endpoints —
    `MCP_TOKEN`, `FOUNDER_TOKEN`, `DISPATCH_TOKEN`
    and friends. Nobody else issues them, nothing outside validates
    them, so their only requirement is that they be unguessable and
    *distinct from each other*. Those are derivable.

  * **Somebody else's.** `PAYMENTS_KEY`, the inference
    provider keys, the Cloudflare tokens. These are issued by a third
    party and validated by that third party. **They cannot be derived
    from anything**, and no amount of wanting fewer variables changes
    that. They are not in scope here and never will be.

So this shrinks the list of things a human invents from seven to one.
It does not shrink the list of things a human *pastes*, because those
were never ours to generate.

## Why derive rather than reuse

The lazy version — use one token everywhere — would mean leaking the
MCP bearer, which lives in a third-party connector config, also grants
founder-grounding access and the ability to dispatch workflows. That
trade is not worth the convenience.

HMAC derivation keeps every key cryptographically independent: each is
`HMAC-SHA256(root, purpose)`, so learning one reveals nothing about the
root or about any sibling. One value to set, full separation preserved
— the property that makes "a copy of one" safe rather than merely
convenient.

## Precedence, so nothing breaks and rotation stays possible

An explicit per-purpose variable always wins. `ROOT_SECRET` is
the fallback. That ordering matters twice over: every existing
deployment keeps working untouched, and a single compromised token can
be rotated on its own by setting just that one, without re-issuing
every other key in the system.

Absent root and absent explicit value means **no token**, which every
caller already treats as fail-closed. A derived-secrets helper must
never invent a default — a predictable token is worse than no token,
because the endpoint looks guarded.

## Reading the derived values

They are not printable from the server (that would be a log line
containing a live credential). `scripts/derive_tokens.py` prints them
locally from the root, which is where a human is already holding the
secret anyway.
"""

from __future__ import annotations

import hashlib
import hmac

from api._env import setting

#: Purpose labels. These strings are part of the contract — changing one
#: silently invalidates every token derived under it, which reads as
#: "auth randomly broke" rather than "someone edited a constant".
PURPOSE_MCP = "mcp"
PURPOSE_FOUNDER = "founder"
PURPOSE_DISPATCH = "dispatch"
PURPOSE_DIAGNOSE = "diagnose"
PURPOSE_DERIVE = "derive"
PURPOSE_WARMER = "warmer"

#: Every derivable token: explicit env var → purpose label.
#:
#: These are read by their PLAIN names. The note that used to sit here
#: argued the old prefix earned its place in a server environment
#: as collision avoidance — a fair argument, and not the one that was
#: settled. Founder, twice: *"not sure why we need a prefix for our own
#: stuf"* and *"PRICE_LIST is just PRICE_LIST"*, on the grounds
#: that a prefix makes the code less reusable across the properties.
#:
#: The collision risk it raised is real and is answered where it belongs
#: — in api/_env.py, by choosing names specific enough that nothing else
#: sets them (`PAYMENTS_KEY`, never `KEY`), and by recording what to
#: check first if a setting ever reads as a value nobody set.
#:
#: Leaving both arguments in the tree, in two files, is how a rename gets
#: half-reverted by whoever reads the other one.
#:
#: `PUBLISH_TOKEN` is deliberately NOT in this map. It lives in GitHub
#: Actions and is pushed to the Cloudflare Worker by
#: `deploy-site-host.yml`; no Vercel function ever reads it. Deriving
#: it here would print a value that is NOT what the Worker holds, so
#: someone could paste the derived token and break publishing while
#: believing the two were in sync. Only tokens this runtime actually
#: validates belong in this map.
DERIVABLE = {
    "MCP_TOKEN": PURPOSE_MCP,
    "FOUNDER_TOKEN": PURPOSE_FOUNDER,
    "DISPATCH_TOKEN": PURPOSE_DISPATCH,
    "DIAGNOSE_TOKEN": PURPOSE_DIAGNOSE,
    "DERIVE_TOKEN": PURPOSE_DERIVE,
    "WARMER_HIT_TOKEN": PURPOSE_WARMER,
}

#: Namespace prefix so a root shared with some future non-token use
#: cannot collide with a token purpose.
_NS = "ontold/token/v1/"


def root_secret() -> str | None:
    """The one secret an operator sets. None when unset.

    Falls back to `SIGNING_SECRET` so a deployment that already
    set the signing secret gets derived tokens for free. That is a
    deliberate convenience and a deliberate limit: the signing secret is
    already required for the product to function at all, so reusing it
    as a derivation root adds no new thing to protect. Setting
    `ROOT_SECRET` separately is still better hygiene, because
    rotating the signing key then does not rotate every bearer token
    with it.
    """
    # setting() resolves the plain name ONLY. The old prefixed
    # spellings do NOT work — this comment used to say they did, which
    # is the sentence that would let somebody read the live project's
    # prefixed signing secret, see this line, and conclude it resolves.
    # It does not. See api/_env.misnamed().
    return setting("ROOT_SECRET") or setting("SIGNING_SECRET")


def derive(purpose: str, root: str | None = None) -> str | None:
    """Derive the token for `purpose`. None when no root is configured.

    Returns a URL-safe hex digest — usable verbatim in an
    `Authorization: Bearer` header, a query string, or a connector
    config, with no escaping surprises.
    """
    key = root if root is not None else root_secret()
    if not key:
        return None
    mac = hmac.new(key.encode("utf-8"), (_NS + purpose).encode("utf-8"), hashlib.sha256)
    return mac.hexdigest()


def token(env_name: str) -> str | None:
    """The effective value of a derivable token.

    Explicit env var first, then derivation from the root, then None.
    `None` means unconfigured, and every caller already fails closed on
    it — this helper never manufactures a fallback value.
    """
    explicit = setting(env_name)
    if explicit:
        return explicit
    purpose = DERIVABLE.get(env_name)
    if not purpose:
        return None
    return derive(purpose)


def matches(env_name: str, presented: str | None) -> bool:
    """Constant-time check of a presented bearer against `env_name`.

    False when unconfigured — an endpoint with no token configured
    refuses everyone rather than accepting anyone, which is the only
    safe reading of "nobody set this up".
    """
    expected = token(env_name)
    if not expected or not presented:
        return False
    return hmac.compare_digest(expected, presented)
