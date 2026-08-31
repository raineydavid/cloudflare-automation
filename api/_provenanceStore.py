"""Where a provenance record lives, and who is allowed to enumerate it.

`api/_provenance.py` mints signed records and nothing keeps them. So
lineage exists as a data structure and not as a fact: close the tab and
the claim is gone.

The obvious fix is the one this repo has already refused. Generations
were being written into `data/` and committed, which put everybody's
work in a public file in a public repo — "not acceptable at all", and
right. But the answer is not simply "put it in a bucket", because the
bucket has the same question in it: whose prefix, and who may read it.

## The key is the identity

`api/_inference/r2_sink.py` scopes objects by an owner id and says so
honestly in its own docstring: the id arrives in a header from
`services/auth.ts`, which is a localStorage dev-stub, so a client can
send any owner id it likes. Groundwork, not a boundary.

A provenance record does not have that problem, because its creator
field IS a public key. So here the storage prefix is DERIVED from that
key rather than supplied alongside it. A caller cannot choose where its
records land, which means it cannot write into somebody else's prefix,
and there is no header to forge — you either hold the private key or
you do not.

That is the whole reason this file is separate from r2_sink rather than
another function inside it. They scope by different things, and only
one of them is checkable.

## Three rules

A RECORD IS ONLY STORED IF IT VERIFIES. An unsigned record, or one
signed by a key other than the creator it names, is refused at the
door. A store that keeps unverified claims is a store whose contents
prove nothing, and provenance that proves nothing is worse than none —
it looks like evidence.

ONE RECORD IS PUBLIC; THE LIST IS NOT. A record is a signed public
claim: prompt hashed, no personal data, meant to be checked by whoever
holds the derivative. Fetching one by id is fine. ENUMERATING a
creator's records is not — that is the "everybody's generations"
problem again, one directory listing away. So listing takes a signed
challenge: prove you hold the key whose prefix you are asking about.

NOTHING IS OVERWRITTEN. A record id is a hash of its own contents, so a
second write of the same id is the same record; a DIFFERENT record
claiming an id that exists is somebody trying to rewrite history and is
refused.

Storage is a port — three callables passed in — so this module is
testable without a bucket and the same logic serves R2, Drive or
OneDrive (issue #102). Stdlib only.
"""

from __future__ import annotations

import hashlib
from typing import Callable, Iterable, Optional

# Absolute, matching the dominant convention among api/_*.py modules
# (_alerts, _catalogue, _entitlement all do this). A RELATIVE import
# here worked under `python -m unittest api.test_...` and failed the
# moment anything imported this module the way a Vercel handler does —
# api/ on sys.path, no package context. That is the exact class of bug
# ci.yml's "Import shapes" step exists for.
# Imported two ways and it has to survive both. A Vercel handler puts
# api/ on sys.path and imports siblings bare (api/video.py does exactly
# that); the tests and the package shape import `api.x`. A single form
# works in one and raises ModuleNotFoundError in the other, which is
# the class ci.yml's "Import shapes" step exists for — and which this
# module had until it was checked with the repo root off the path.
try:                                    # package shape
    from api._provenance import canonical, verify
except ModuleNotFoundError:             # api/ on sys.path, no package
    from _provenance import canonical, verify     # type: ignore[no-redef]

#: Where records live, under whatever bucket the caller configured.
PREFIX = "provenance"

#: How much of the key hash names the prefix. 32 hex characters is 128
#: bits — collision-proof for this purpose, and short enough that an
#: operator can read a key path in a log line.
_PREFIX_LEN = 32


def owner_prefix(public_key: str) -> str:
    """The storage prefix for a creator, derived from their key.

    Hashed rather than used raw for two reasons. Keys are long and may
    contain characters an object store dislikes, and a raw key in a
    path turns every access log and error message into a list of who
    uses the service. The hash is one-way and stable — the same key
    always lands in the same place, and no other key does.
    """
    if not public_key:
        raise ValueError("a record with no creator has nowhere to live")
    digest = hashlib.sha256(public_key.encode("utf-8")).hexdigest()[:_PREFIX_LEN]
    return f"{PREFIX}/{digest}"


def key_for(signed: dict) -> str:
    """The object key for one signed record.

    Derived entirely from the record: prefix from the creator's key, id
    from the record's own content hash. Nothing a caller passes chooses
    a path, which is what makes writing into someone else's prefix
    impossible rather than merely discouraged.
    """
    body = (signed or {}).get("record") or {}
    record_id = body.get("id")
    creator = body.get("creator")
    if not record_id or not creator:
        raise ValueError("a record needs an id and a creator before it can be stored")
    return f"{owner_prefix(creator)}/{record_id}.json"


class Refused(RuntimeError):
    """The store would not accept this. The message is for an operator
    log; a caller may show it, because none of these reasons disclose
    anything the requester did not already send."""


def put(
    signed: dict,
    *,
    write: Callable[[str, bytes], None],
    read: Callable[[str], Optional[bytes]],
    verify_bytes: Callable[[bytes, bytes, str], bool],
) -> str:
    """Store a signed record. Returns the key it landed at.

    Verifies BEFORE writing, and refuses to replace an existing record
    with different contents. The idempotent case — the same record
    stored twice — succeeds silently, because a retry after a dropped
    connection must not read as an attack.
    """
    ok, why = verify(signed, verify_bytes)
    if not ok:
        raise Refused(f"not stored — {why}")

    key = key_for(signed)
    existing = read(key)
    if existing is not None:
        if existing != canonical(signed):
            # The id is a hash of the record's contents, so this means
            # somebody built a different record that claims an id
            # already taken. Nothing legitimate does that.
            raise Refused("a different record already exists at this id")
        return key

    write(key, canonical(signed))
    return key


def get(
    record_id: str,
    creator: str,
    *,
    read: Callable[[str], Optional[bytes]],
) -> Optional[bytes]:
    """One record, by id, for anyone who knows where to look.

    Deliberately open. A record is a signed public claim — the prompt
    is a hash, the creator is a public key, and the point of publishing
    it is that a person holding a derivative can check where it came
    from. Requiring permission to read one would make lineage
    unverifiable by exactly the people it is for.

    The creator's key is required because it is half the address, not
    as a credential: you cannot ask for a record without already
    knowing whose it is, so this is not a route to enumeration.
    """
    if not record_id or not creator:
        return None
    return read(f"{owner_prefix(creator)}/{record_id}.json")


def challenge(public_key: str, nonce: str) -> bytes:
    """The bytes a creator signs to prove they hold their key.

    Binds the nonce to the key being claimed. Signing a bare nonce
    would let a signature captured from one exchange be replayed to
    claim a different key — the signature is valid, it just was not
    about this.
    """
    if not public_key or not nonce:
        raise ValueError("a challenge needs both a key and a nonce")
    return canonical({"claim": "list", "key": public_key, "nonce": nonce})


def list_records(
    public_key: str,
    nonce: str,
    signature: bytes,
    *,
    list_keys: Callable[[str], Iterable[str]],
    verify_bytes: Callable[[bytes, bytes, str], bool],
) -> list[str]:
    """Every record id under a creator's prefix — to that creator only.

    This is the call that would otherwise recreate the problem the repo
    already rejected: a listing endpoint is one request away from
    "everybody's generations in a public file", whether the file is in
    git or in a bucket.

    So it takes a signature over `challenge()`, not a token. A token can
    be stolen and replayed; this proves possession of the private key
    for the prefix being asked about, and nothing else grants it —
    including us. We cannot enumerate a creator's work on their behalf,
    which is the property worth having.

    Raises Refused rather than returning empty: "you may not" and "you
    have none" are different answers and a caller needs to tell them
    apart.
    """
    try:
        msg = challenge(public_key, nonce)
    except ValueError as exc:
        raise Refused(str(exc)) from exc
    try:
        if not verify_bytes(msg, signature, public_key):
            raise Refused("that signature does not prove you hold this key")
    except (ValueError, TypeError) as exc:
        raise Refused("malformed signature") from exc

    prefix = owner_prefix(public_key)
    out: list[str] = []
    for key in list_keys(prefix):
        name = key.rsplit("/", 1)[-1]
        if name.endswith(".json"):
            out.append(name[: -len(".json")])
    # Sorted so a listing is stable between calls — an unstable one
    # makes a diff between two snapshots unreadable.
    return sorted(out)
