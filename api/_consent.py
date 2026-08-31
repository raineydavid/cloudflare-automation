"""Who said this agent may contact this person, and what it may do.

Ontold can make things and cannot reach anybody. The moment it can —
a phone ringing, a message arriving — the question stops being "can we"
and becomes "who agreed to this", and that question needs an answer
that survives being asked a year later by someone unsympathetic.

The founder's case is an elderly parent with dementia, set up by a
responsible adult: "a responsible adult would have given the consent."
That is a real and defensible model, and it is also the model most
easily abused, so it is worth writing down precisely rather than
implying it in a settings screen.

## It is the same primitive as a spend mandate

Registrack (imperial-canton8 src/canton8/mandates.py) signs "I
authorised this payment" with an Ed25519 key the holder keeps. This
signs "I authorised contact with this person" with the same key, the
same canonical bytes (api/_provenance.canonical) and the same verifier
(api/_ed25519). One key, three claims: I paid for this, I made this, I
agreed to this.

That matters because a consent record kept by the service that benefits
from it is worth nothing. A record signed by the guardian's own key can
be checked by anyone, cannot be minted by us, and cannot be quietly
edited afterwards.

## The recipient can always stop it, consent or not

The guardian gives permission; the person on the other end of the phone
did not. So `stop` from the RECIPIENT ends it immediately and needs no
signature, no key and no verification — asking a distressed person to
authenticate before they can make the calls stop would be the cruellest
possible failure of this design. A guardian can re-consent afterwards,
deliberately; nothing re-enables itself.

## Everything is narrow on purpose

A record permits named CHANNELS for a named PURPOSE until a stated
DATE. There is no "all" and no open-ended grant, because consent that
covers everything forever is consent nobody revisits — and the person
it covers is, by construction, someone who cannot revisit it
themselves.

Quiet hours and a contact ceiling are part of the record rather than
settings elsewhere, because they are the part a distressed person feels
and the part an operator would otherwise tune for engagement.

Stdlib only.
"""

from __future__ import annotations

import hashlib
from typing import Callable

# Imported two ways and it has to survive both. A Vercel handler puts
# api/ on sys.path and imports siblings bare (api/video.py does exactly
# that); the tests and the package shape import `api.x`. A single form
# works in one and raises ModuleNotFoundError in the other, which is
# the class ci.yml's "Import shapes" step exists for — and which this
# module had until it was checked with the repo root off the path.
try:                                    # package shape
    from api._provenance import canonical
except ModuleNotFoundError:             # api/ on sys.path, no package
    from _provenance import canonical     # type: ignore[no-redef]

#: Channels a record can permit. Deliberately enumerated: a new way to
#: reach someone is a decision, not a config value.
CHANNELS = {
    "voice": "a phone call",
    "whatsapp": "a WhatsApp message",
    "sms": "a text message",
    "email": "an email",
}

#: What the contact is FOR. A purpose that is not on this list is a
#: purpose nobody agreed to.
PURPOSES = {
    # The founder's case: a familiar voice, a chapter read aloud, a
    # reminder that today is Tuesday.
    "companionship": "conversation and company",
    "reading": "reading aloud — books, letters, the news",
    "reminder": "medication, appointments, the day of the week",
    "checkin": "a wellbeing check on an agreed schedule",
}

#: Access needs the receiving end has. Not decoration: a surface that
#: ignores these is a surface the person cannot use, and for the people
#: this exists for that means it does not work at all.
NEEDS = {
    # Low or no vision. Nothing may require reading a screen — not a
    # confirmation link, not a code, not a button.
    "audio-only": "everything must work without sight",
    "large-text": "any visual output must be large and high-contrast",
    "slow-speech": "speak slowly, and leave room for an answer",
    "simple-language": "short sentences, no jargon, one idea at a time",
    # Memory loss. Re-introduce every time; never assume the last call
    # is remembered.
    "reintroduce": "say who is calling, every time",
}

#: Nobody is rung in the middle of the night. Local hours, inclusive
#: start, exclusive end — the default is deliberately narrow, and a
#: record may narrow it further but not widen it past this.
DEFAULT_WAKING_HOURS = (9, 20)


class ConsentError(ValueError):
    """A record that could not be built. The message is safe to show —
    it describes what the caller sent, not anything about a person."""


def record(
    *,
    guardian: str,
    recipient_ref: str,
    channels: list[str],
    purposes: list[str],
    expires_at: str,
    needs: list[str] | None = None,
    waking_hours: tuple[int, int] = DEFAULT_WAKING_HOURS,
    max_contacts_per_day: int = 2,
    relationship: str = "",
) -> dict:
    """The permission, before it is signed.

    `recipient_ref` is an OPAQUE reference — an id in the caller's own
    records — never a name, a number or an address. This record is
    checkable by third parties and stored under a key-derived prefix;
    it has no business carrying the identity of a vulnerable person to
    anyone who happens to fetch it. The phone number lives wherever the
    caller keeps it, behind their own auth.
    """
    if not guardian:
        raise ConsentError("a consent record needs the guardian's public key")
    if not recipient_ref:
        raise ConsentError("a consent record needs a recipient reference")
    if not expires_at:
        # Consent that never expires is consent nobody revisits, and the
        # person it covers cannot revisit it themselves.
        raise ConsentError("consent must expire — pick a date you will review")

    bad = [c for c in channels if c not in CHANNELS]
    if bad or not channels:
        raise ConsentError(f"channels must be some of {sorted(CHANNELS)}")
    bad = [p for p in purposes if p not in PURPOSES]
    if bad or not purposes:
        raise ConsentError(f"purposes must be some of {sorted(PURPOSES)}")
    bad = [n for n in (needs or []) if n not in NEEDS]
    if bad:
        raise ConsentError(f"needs must be some of {sorted(NEEDS)}")

    start, end = waking_hours
    if not (0 <= start < end <= 24):
        raise ConsentError("waking hours must be a real window")
    d_start, d_end = DEFAULT_WAKING_HOURS
    if start < d_start or end > d_end:
        # A record may be MORE careful than the default and never less.
        # Widening this is the kind of change that gets made for
        # engagement and felt at four in the morning.
        raise ConsentError(f"waking hours cannot be wider than {d_start}:00-{d_end}:00")
    if not 1 <= max_contacts_per_day <= 6:
        raise ConsentError("a contact ceiling between 1 and 6 a day")

    body = {
        "kind": "consent",
        "guardian": guardian,
        "recipient_ref": recipient_ref,
        "relationship": relationship,
        "channels": sorted(set(channels)),
        "purposes": sorted(set(purposes)),
        "needs": sorted(set(needs or [])),
        "waking_hours": [start, end],
        "max_contacts_per_day": int(max_contacts_per_day),
        "expires_at": expires_at,
    }
    body["id"] = "consent-" + hashlib.sha256(canonical(body)).hexdigest()[:16]
    return body


def revocation(*, consent_id: str, by: str, at: str) -> dict:
    """A guardian withdrawing a consent they gave.

    Signed like the consent itself, so a withdrawal cannot be lost or
    denied. The RECIPIENT's own stop does not come through here — see
    `may_contact`, which honours it with no signature at all.
    """
    if not consent_id or not by or not at:
        raise ConsentError("a revocation names the consent, the signer and the time")
    body = {"kind": "revocation", "consent": consent_id, "by": by, "at": at}
    body["id"] = "rev-" + hashlib.sha256(canonical(body)).hexdigest()[:16]
    return body


def may_contact(
    signed_consent: dict,
    *,
    channel: str,
    purpose: str,
    now_iso: str,
    local_hour: int,
    contacts_today: int = 0,
    recipient_said_stop: bool = False,
    revoked: bool = False,
    verify_bytes: Callable[[bytes, bytes, str], bool] | None = None,
) -> tuple[bool, str]:
    """May this contact happen? Returns (allowed, why).

    Checked in the order a person would care about, so the reason a
    caller logs is the reason that mattered. The recipient's own refusal
    is first, before the signature is even looked at: a system that
    verifies a guardian's key before it will stop ringing a frightened
    person has its priorities inverted.

    A reason is always returned, never a bare False, for the same
    purpose Registrack's `authorize_payment` has one — "denied" tells
    an operator nothing at three in the morning.
    """
    # 1. The person on the other end. No signature, no key, no appeal.
    if recipient_said_stop:
        return False, "the recipient asked us to stop"

    # 2. The guardian took it back.
    if revoked:
        return False, "this consent was withdrawn"

    body = (signed_consent or {}).get("record") or {}
    if body.get("kind") != "consent":
        return False, "not a consent record"

    # 3. Is it real? A record we cannot verify is a record we did not
    #    get, and this is the one place failing open would be indefensible.
    if verify_bytes is not None:
        from api._provenance import verify as verify_record
        ok, why = verify_record(signed_consent, verify_bytes)
        if not ok:
            return False, f"consent does not verify — {why}"
    elif signed_consent.get("signature") is None:
        return False, "consent is unsigned"

    # 4. Still current. String compare is correct for ISO-8601 UTC and
    #    avoids a date library in a stdlib-only module.
    if not body.get("expires_at") or now_iso >= body["expires_at"]:
        return False, "consent has expired — ask again"

    # 5. What was actually agreed to.
    if channel not in body.get("channels", []):
        return False, f"{CHANNELS.get(channel, channel)} was not agreed to"
    if purpose not in body.get("purposes", []):
        return False, f"'{purpose}' is not a purpose this consent covers"

    # 6. Not in the middle of the night.
    start, end = body.get("waking_hours", list(DEFAULT_WAKING_HOURS))
    if not start <= local_hour < end:
        return False, f"outside waking hours ({start}:00-{end}:00 where they are)"

    # 7. Not again and again. Someone who cannot remember the last call
    #    experiences the fourth one as the first, which is worse.
    ceiling = body.get("max_contacts_per_day", 2)
    if contacts_today >= ceiling:
        return False, f"already contacted {contacts_today} times today (limit {ceiling})"

    return True, "permitted"


def needs_of(signed_consent: dict) -> list[str]:
    """The access needs a surface must honour for this person.

    Returned separately from `may_contact` because they are not a gate —
    they do not decide WHETHER to call, they decide what the call has to
    be like, and a caller that only asks the gate will never see them.
    """
    return list(((signed_consent or {}).get("record") or {}).get("needs") or [])


def brief_for(signed_consent: dict) -> str:
    """The access needs as an instruction, for whatever speaks.

    Words rather than flags, because the thing on the other end of this
    is a language model reading a system prompt, and this repo has
    learned twice that a rule the model never reads is a rule the output
    ignores — once on book covers, once on the 217 template blanks.
    """
    needs = needs_of(signed_consent)
    if not needs:
        return ""
    lines = [NEEDS[n] for n in needs if n in NEEDS]
    if not lines:
        return ""
    return "The person you are speaking to needs you to: " + "; ".join(lines) + "."
