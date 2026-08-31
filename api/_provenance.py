"""Who made this, from what, and what you may do with it.

Copying is the mechanic, not the problem. Short-form culture runs on
people remaking each other's formats, and this repo's own trending lane
says so — recreating is never refused. What copying breaks is the
RECORD: once a thing has been remade twenty times, nobody can say where
it started, and the person who started it can prove nothing.

So this does not try to stop a copy. It makes lineage provable.

Every artefact gets a record signed by its creator's own key — the
Registrack keypair, self-custody, the same one that signs an AP2 spend
mandate (imperial-canton8 src/canton8/mandates.py). One key, two
claims: "I authorised this spend" and "I made this".

Why a KEYPAIR and not this repo's existing HMAC. api/_requestAuth.py
signs with a shared secret, so only Ontold can verify it and Ontold
could forge it. That is fine for "did this request come from our app"
and worthless for provenance: a record the host can mint is a record
that proves nothing about the creator. A signature anyone can verify
and only the holder can produce is the whole point.

Two decisions worth stating.

The prompt is HASHED, never stored. A provenance record travels
publicly; the brief that produced the work is the creator's IP and this
repo has spent a lot of effort keeping prompts server-side. A hash
proves "this came from that brief" to anyone holding the brief, and
discloses nothing to anyone who does not.

Lineage is a PARENT POINTER, not a copy. A derivative names the record
it descends from by id. Walk the pointers and you have the creative
graph; you never have to trust the derivative's account of its own
origins, because each ancestor is signed by whoever actually made it.

Canonical form matches Registrack's `_canonical` exactly — sorted keys,
no whitespace — so a record signed by one verifies under the other.
See issue #100.
"""

from __future__ import annotations

import hashlib
import json
from typing import Any, Callable

# What made it, as far as a public record is concerned. Deliberately
# one name: ours. Never the supplier's — see record().
TOOL = "ontold"

# What a creator permits when they publish. Deliberately the vocabulary
# a person would use, not a licence identifier: the trending lane
# already proved that a rule the model never reads is a rule the output
# ignores, and the same is true of a rule a human cannot parse.
GRANTS = {
    # Anyone may remake it, no strings.
    "open": "remake it freely",
    # Remake it, but say where it came from.
    "credit": "remake it, credit the original",
    # Remake the shape; make the substance yourself.
    "shape-only": "take the format, bring your own audio, cast and footage",
    # No permission given. Recorded so the refusal is on the record too.
    "reserved": "the creator has not granted a remake",
}


def canonical(payload: dict) -> bytes:
    """Deterministic JSON for signing — sorted keys, no whitespace.

    Byte-identical to Registrack's `_canonical`. A record signed there
    must verify here; drift in this one function silently breaks every
    signature ever made.
    """
    return json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode()


def prompt_fingerprint(prompt: str) -> str:
    """A stable hash of the brief that produced the work.

    Whitespace-normalised so a reflowed prompt still matches — the same
    brief typed with a different line wrap is the same brief, and a
    fingerprint that disagrees is a provenance claim that fails for no
    reason.
    """
    return hashlib.sha256(" ".join((prompt or "").split()).encode("utf-8")).hexdigest()


def record(
    *,
    artefact_id: str,
    creator: str,
    prompt: str = "",
    parent: str | None = None,
    grant: str = "credit",
    seconds: int = 0,
    created_at: str = "",
) -> dict:
    """The claim, before it is signed.

    `creator` is a public key, not a username: the owner is whoever
    holds the key, which is why this works with no account and no user
    table.

    NO MODEL NAMES. An earlier version carried the models used, on the
    theory that attribution is provenance. It is not — it is our
    supplier list, and this record is public. Three reasons it stays out:

      * ci.yml already greps the built bundle for exactly this and
        fails the build. Publishing it in a signed record we hand out
        would defeat a check the repo runs on every push.
      * It goes stale. Swap a model and every record ever signed now
        makes a false claim that cannot be corrected — a signature is
        not editable.
      * It is not what the holder is buying. They bought the artefact
        and the rights to it; which engine turned the handle is ours,
        the same way the contact sheet is.

    The disclosure that DOES matter — that a machine made this — is the
    `tool` field, and it names Ontold, not whatever Ontold called.

    The debate lane is the deliberate exception and stays that way: it
    names models ON THE PAGE, because four companies' models reaching
    different conclusions IS the content there. That is a thing we
    chose to publish, not a fact leaking out of the plumbing.
    """
    if not artefact_id:
        raise ValueError("artefact_id required — a record about nothing proves nothing")
    if not creator:
        raise ValueError("creator public key required")
    if grant not in GRANTS:
        raise ValueError(f"grant must be one of {sorted(GRANTS)}")

    body: dict[str, Any] = {
        "artefact": artefact_id,
        "creator": creator,
        "grant": grant,
        # Our name, not our suppliers'. This is the AI-disclosure a
        # platform or a jurisdiction actually asks for: that a machine
        # made it, and who to ask about it.
        "tool": TOOL,
        "seconds": int(seconds),
        "created_at": created_at,
    }
    # Absent rather than empty: a record with no prompt is different
    # from one whose prompt hashed to nothing, and an empty string in
    # the signed payload changes the signature for no reason.
    if prompt:
        body["prompt_sha256"] = prompt_fingerprint(prompt)
    if parent:
        body["parent"] = parent
    body["id"] = "prv-" + hashlib.sha256(canonical(body)).hexdigest()[:16]
    return body


def sign(body: dict, sign_bytes: Callable[[bytes], bytes], public_key: str) -> dict:
    """Sign a record with the creator's key.

    Takes the signing FUNCTION rather than a key, so the private key
    never enters this module and this stays testable without one — the
    caller passes Registrack's `keypair.sign_bytes`.
    """
    msg = canonical(body)
    return {
        "record": body,
        "digest": hashlib.sha256(msg).hexdigest(),
        "signature": sign_bytes(msg).hex(),
        "public_key": public_key,
    }


def verify(signed: dict, verify_bytes: Callable[[bytes, bytes, str], bool]) -> tuple[bool, str]:
    """Is this record what its creator signed? Returns (ok, reason).

    A reason, not a bare False, for the same purpose Registrack's
    authorize_payment has one: "invalid" tells a user nothing and tells
    an operator less.
    """
    if not isinstance(signed, dict) or "record" not in signed:
        return False, "not a signed record"
    body = signed.get("record") or {}
    msg = canonical(body)

    if signed.get("digest") != hashlib.sha256(msg).hexdigest():
        return False, "digest does not match the record"
    # The creator field IS the identity. A record signed by some other
    # key is somebody else's claim about your work.
    if body.get("creator") != signed.get("public_key"):
        return False, "signed by a different key than the one claiming authorship"
    try:
        if not verify_bytes(msg, bytes.fromhex(signed.get("signature") or ""), signed["public_key"]):
            return False, "signature invalid"
    except (ValueError, TypeError):
        return False, "signature malformed"
    return True, "verified"


def may_remake(signed_parent: dict) -> tuple[bool, str]:
    """What the parent's creator permits. Returns (allowed, what to do).

    `reserved` returns False and still explains, because a refusal that
    teaches nothing sends people off to copy it badly somewhere else.
    """
    grant = ((signed_parent or {}).get("record") or {}).get("grant")
    if grant not in GRANTS:
        # No grant on the record means nobody decided. Treated as
        # reserved: guessing permissively is how a copy ships.
        return False, "no grant on this record — ask before remaking"
    return grant != "reserved", GRANTS[grant]


def lineage(record_id: str, index: dict[str, dict], limit: int = 64) -> list[str]:
    """Walk parent pointers from a record back to its origin.

    Stops on a cycle and on `limit`. A forged record can name any
    parent, so a long chain is not proof of anything on its own — each
    ancestor still has to verify under its own key. This returns the
    path; it does not vouch for it.
    """
    out: list[str] = []
    seen: set[str] = set()
    current: str | None = record_id
    while current and current not in seen and len(out) < limit:
        seen.add(current)
        out.append(current)
        entry = index.get(current) or {}
        current = ((entry.get("record") or {}).get("parent")) or None
    return out
