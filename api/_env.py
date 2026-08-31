"""Settings by their plain name.

Founder: *"i dont want ontold prefixes for variable names"*, on
`PAYMENTS_KEY` specifically *"its very poor naming"*, and
again on `PRICE_LIST`: *"is just PRICE_LIST"*.

`SECRET` and `KEY` said the same thing twice, `CARD` named how the money
arrives rather than what the setting is for, and a prefix on every
variable is noise in an environment we control.

There is no prefixed fallback. There was one, to protect a running
deployment through the rename — but nothing has launched, so there is no
deployment to protect and a fallback would only be a second name for
every setting, quietly answering when the real one is missing. If a
setting reads as unset, it is unset.

## Except that a deployment DOES now hold the old names

The sentence above was true when it was written and is not any more:
the prefixed spellings are set on the live project (see LEGACY_PREFIX).
Merging this branch as it stands makes every one of them read as unset —
and the most expensive one fails **silently**, because an unset signing
secret does not stop the site, it stops the render meter from recording a
spend, so every visitor renders unlimited video for free.

The answer is still not a fallback. A second name that quietly answers is
how a rotated secret goes on working from a stale variable nobody
remembers setting. The answer is to make the mismatch impossible to miss:
`misnamed()` below reports any setting whose prefixed form is present
while the plain name is absent. It never READS the old value — it says
the name is wrong and leaves the setting unset, so the failure is loud
and the fix is a rename in the dashboard, done once.

`extra_aliases` remains for THIRD-PARTY names — `STRIPE_SECRET_KEY`,
`RUNWAY_API_KEY` — where honouring a provider's own convention saves
someone retyping a `.env` they were handed. Never for a prefixed form of
one of our own names.

## The one caveat, recorded rather than argued

A bare name shares a namespace with the platform's own variables and
every SDK's. Short generic words are the ones at risk — `MODE`,
`SECRET`, `TOKEN`, `ORIGIN` — because another tool may set them for its
own reasons and the value we read would be theirs. The names we use are
chosen to be specific enough that this is unlikely (`PAYMENTS_KEY`, not
`KEY`).

If a setting ever reads as a value nobody set, this is the first place
to look.
"""

from __future__ import annotations

import os

#: Our own settings, by the plain name each is read under.
#:
#: Kept here so `misnamed()` can check a whole deployment rather than
#: only the settings a given request happens to touch. A key that is
#: wrong is wrong at boot; discovering it when the first buyer hits
#: `/api/video` is discovering it too late.
#:
#: Third-party names are deliberately absent — `STRIPE_SECRET_KEY` and
#: friends arrive through `extra_aliases` and are theirs to name.
#: The spelling a live deployment still holds, defined once.
#:
#: Every other module names it through this rather than as a literal, so
#: `api/test_env_naming` can keep failing on a stray prefixed name
#: anywhere else in the tree. A migration needs to say the old name out
#: loud exactly once; saying it twice is how the rename half-reverts.
LEGACY_PREFIX = "ONTOLD_"

OURS = (
    "ALERTS_WEBHOOK",
    "CATALOGUE_OVERRIDE",
    "FILM_DISPATCH_LIMIT",
    "FLOOR_FRACTION",
    "FREE_FILM_SECONDS",
    "FREE_RENDERS",
    "FREE_VIEWS",
    "GENERATION_RPM",
    "MODE",
    "PAID_FILM_SECONDS_MAX",
    "PAYMENTS_KEY",
    "PAYMENT_RECIPIENT",
    "PRICE_BANDS",
    "PRICE_LIST",
    "PUBLIC_ORIGIN",
    "QUOTE_TTL_SECONDS",
    "ROOT_SECRET",
    "SETTLEMENT_CHAIN",
    "SETTLEMENT_NETWORK",
    "SIGNING_SECRET",
    "SITE_ORIGIN",
    "STORAGE_RPM",
    "SUNO_API_BASE",
)

def setting(name: str, *extra_aliases: str) -> str | None:
    """Read a setting by its plain name. None when nothing is set.

    Resolution order: the plain name, then any `extra_aliases` in the
    order given. Aliases exist only for third-party conventions worth
    honouring — a `.env` copied from a provider's own docs. Never for a
    prefixed form of our own name.

    Empty string counts as unset — an environment variable present but
    blank is the shape a half-finished config takes, and treating it as
    configured is how a deployment ends up armed with nothing.
    """
    for candidate in (name, *extra_aliases):
        value = os.environ.get(candidate)
        if value:
            return value
    return None


def flag(name: str, *extra_aliases: str) -> bool:
    """Whether `name` is set to something truthy.

    Deliberately strict: only `1`, `true`, `yes`, `on` (case-insensitive)
    are true. A variable set to the literal string `"false"` is false,
    which is the reading a human intends and the opposite of what a bare
    truthiness check would give them.
    """
    value = (setting(name, *extra_aliases) or "").strip().lower()
    return value in ("1", "true", "yes", "on")


def misnamed(prefix: str = LEGACY_PREFIX, environ: dict[str, str] | None = None) -> list[str]:
    """Settings whose prefixed form is set while the plain name is not.

    The rename to plain names left a live deployment
    holding the old spellings, and `setting()` has no fallback, so each
    one silently reads as unset. The dangerous case is not the loud one:
    an unset `SIGNING_SECRET` does not take the site down, it stops the
    render meter recording a spend, and unlimited free video has no
    symptom until the invoice.

    Deliberately does NOT return the value. Reading it would be the
    fallback this module refuses to have — and a fallback is how a
    rotated secret keeps working from a stale variable nobody remembers
    setting. This reports a naming fault and nothing else; the fix is a
    rename in the dashboard, once.

    Returns the PLAIN names, sorted, so the message can say what to
    create rather than what to look for.
    """
    env = os.environ if environ is None else environ
    return sorted(
        name
        for name in OURS
        if env.get(f"{prefix}{name}") and not env.get(name)
    )
