"""Storing lineage without recreating the file everyone could read.

The repo already rejected one answer to "where do generations go" —
committed into `data/`, which put everybody's work in a public file.
Every test here is about the ways a bucket quietly becomes the same
thing: writing into somebody else's prefix, listing a stranger's
records, or keeping a claim nobody can check.
"""

import hashlib
import unittest

from api._provenance import canonical, record, sign
from api._provenanceStore import (
    PREFIX,
    Refused,
    challenge,
    get,
    key_for,
    list_records,
    owner_prefix,
    put,
)


# The same toy keypair as test_provenance: signature = sha256(key||msg).
def _signer(secret: str):
    def sign_bytes(msg: bytes) -> bytes:
        return hashlib.sha256(secret.encode() + msg).digest()
    return sign_bytes


def _verifier(mapping: dict[str, str]):
    def verify_bytes(msg: bytes, sig: bytes, pub: str) -> bool:
        secret = mapping.get(pub)
        return secret is not None and hashlib.sha256(secret.encode() + msg).digest() == sig
    return verify_bytes


ALICE, BOB = "pub-alice", "pub-bob"
KEYS = {ALICE: "sec-alice", BOB: "sec-bob"}
V = _verifier(KEYS)


class FakeStore:
    """An object store in a dict. Enough to exercise the contract."""

    def __init__(self):
        self.objects: dict[str, bytes] = {}

    def write(self, key: str, data: bytes) -> None:
        self.objects[key] = data

    def read(self, key: str):
        return self.objects.get(key)

    def list_keys(self, prefix: str):
        return [k for k in self.objects if k.startswith(prefix + "/")]


def _signed(creator=ALICE, **kw):
    body = record(artefact_id=kw.pop("artefact_id", "film-1"), creator=creator, **kw)
    return sign(body, _signer(KEYS[creator]), creator)


class ThePrefixIsDerived(unittest.TestCase):
    def test_the_same_key_always_lands_in_the_same_place(self):
        self.assertEqual(owner_prefix(ALICE), owner_prefix(ALICE))

    def test_two_creators_never_share_a_prefix(self):
        self.assertNotEqual(owner_prefix(ALICE), owner_prefix(BOB))

    def test_the_raw_key_is_not_in_the_path(self):
        # A raw key in a path turns every access log into a list of who
        # uses the service.
        self.assertNotIn(ALICE, owner_prefix(ALICE))
        self.assertTrue(owner_prefix(ALICE).startswith(PREFIX + "/"))

    def test_a_caller_cannot_choose_where_its_record_lands(self):
        # The difference from r2_sink's owner id, which arrives in a
        # header and can be anything the client says.
        s = _signed()
        self.assertTrue(key_for(s).startswith(owner_prefix(ALICE)))

    def test_a_record_with_no_creator_has_nowhere_to_live(self):
        with self.assertRaises(ValueError):
            owner_prefix("")
        with self.assertRaises(ValueError):
            key_for({"record": {"id": "prv-1"}})

    def test_a_path_separator_in_a_key_cannot_escape_the_prefix(self):
        # The key is hashed, so even a key built to look like a path
        # produces one flat directory name.
        evil = owner_prefix("../../etc/passwd")
        self.assertEqual(evil.count("/"), 1)
        self.assertNotIn("..", evil)


class OnlyVerifiedRecordsAreKept(unittest.TestCase):
    def setUp(self):
        self.store = FakeStore()

    def _put(self, signed):
        return put(signed, write=self.store.write, read=self.store.read, verify_bytes=V)

    def test_a_genuine_record_is_stored(self):
        key = self._put(_signed())
        self.assertIn(key, self.store.objects)

    def test_an_edited_record_is_refused(self):
        # A store that keeps unverified claims is worse than no store:
        # it looks like evidence.
        s = _signed()
        s["record"]["artefact"] = "someone-elses-film"
        with self.assertRaises(Refused):
            self._put(s)
        self.assertEqual(self.store.objects, {})

    def test_a_record_signed_by_the_wrong_key_is_refused(self):
        body = record(artefact_id="film-1", creator=ALICE)
        s = sign(body, _signer(KEYS[BOB]), BOB)
        with self.assertRaises(Refused):
            self._put(s)

    def test_junk_is_refused(self):
        for junk in ({}, {"nope": 1}, {"record": {}}):
            with self.assertRaises(Refused):
                self._put(junk)

    def test_the_stored_bytes_are_the_canonical_form(self):
        # Byte-for-byte what was signed, so a reader can re-verify
        # without trusting our serialiser.
        s = _signed()
        self.assertEqual(self.store.objects[self._put(s)], canonical(s))


class HistoryIsNotRewritten(unittest.TestCase):
    def setUp(self):
        self.store = FakeStore()

    def _put(self, signed):
        return put(signed, write=self.store.write, read=self.store.read, verify_bytes=V)

    def test_storing_the_same_record_twice_is_fine(self):
        # A retry after a dropped connection must not read as an attack.
        s = _signed()
        self.assertEqual(self._put(s), self._put(s))
        self.assertEqual(len(self.store.objects), 1)

    def test_a_different_record_may_not_take_an_existing_id(self):
        s = _signed()
        key = self._put(s)
        impostor = _signed(artefact_id="something-else")
        impostor["record"]["id"] = s["record"]["id"]
        # Re-sign so it verifies — the point is that verification alone
        # is not enough to let it overwrite.
        impostor = sign(impostor["record"], _signer(KEYS[ALICE]), ALICE)
        with self.assertRaises(Refused):
            self._put(impostor)
        self.assertEqual(self.store.objects[key], canonical(s))


class ReadingOne(unittest.TestCase):
    def setUp(self):
        self.store = FakeStore()
        self.s = _signed()
        put(self.s, write=self.store.write, read=self.store.read, verify_bytes=V)

    def test_anyone_who_knows_where_to_look_can_read_it(self):
        # Deliberate. A record is a signed public claim, and requiring
        # permission would make lineage unverifiable by the people it
        # is for — whoever is holding a derivative.
        got = get(self.s["record"]["id"], ALICE, read=self.store.read)
        self.assertEqual(got, canonical(self.s))

    def test_a_record_that_is_not_there_is_none_not_an_error(self):
        self.assertIsNone(get("prv-nothing", ALICE, read=self.store.read))

    def test_the_wrong_creator_finds_nothing(self):
        self.assertIsNone(get(self.s["record"]["id"], BOB, read=self.store.read))

    def test_missing_arguments_are_none_rather_than_a_lookup(self):
        self.assertIsNone(get("", ALICE, read=self.store.read))
        self.assertIsNone(get("prv-1", "", read=self.store.read))


class ListingIsTheDangerousOne(unittest.TestCase):
    """A listing endpoint is one request away from the file the repo
    already rejected — whether that file is in git or in a bucket."""

    def setUp(self):
        self.store = FakeStore()
        self.ids = []
        for i in range(3):
            s = _signed(artefact_id=f"film-{i}")
            put(s, write=self.store.write, read=self.store.read, verify_bytes=V)
            self.ids.append(s["record"]["id"])
        # Bob has work of his own in the same store.
        b = _signed(creator=BOB, artefact_id="bobs-film")
        put(b, write=self.store.write, read=self.store.read, verify_bytes=V)
        self.bob_id = b["record"]["id"]

    def _list(self, key, nonce, sig):
        return list_records(key, nonce, sig,
                            list_keys=self.store.list_keys, verify_bytes=V)

    def test_a_creator_can_list_their_own(self):
        sig = _signer(KEYS[ALICE])(challenge(ALICE, "n1"))
        self.assertEqual(self._list(ALICE, "n1", sig), sorted(self.ids))

    def test_a_listing_never_includes_somebody_else_s_work(self):
        sig = _signer(KEYS[ALICE])(challenge(ALICE, "n1"))
        self.assertNotIn(self.bob_id, self._list(ALICE, "n1", sig))

    def test_you_cannot_list_a_prefix_you_cannot_sign_for(self):
        # Bob signing Alice's challenge: a valid signature that is not
        # about him being Alice.
        sig = _signer(KEYS[BOB])(challenge(ALICE, "n1"))
        with self.assertRaises(Refused):
            self._list(ALICE, "n1", sig)

    def test_a_signature_from_one_exchange_cannot_claim_another_key(self):
        # The reason the challenge binds the key, not just the nonce.
        sig = _signer(KEYS[BOB])(challenge(BOB, "n1"))
        with self.assertRaises(Refused):
            self._list(ALICE, "n1", sig)

    def test_the_nonce_is_part_of_what_was_signed(self):
        sig = _signer(KEYS[ALICE])(challenge(ALICE, "n1"))
        with self.assertRaises(Refused):
            self._list(ALICE, "n2", sig)

    def test_no_signature_is_a_refusal(self):
        with self.assertRaises(Refused):
            self._list(ALICE, "n1", b"")

    def test_a_malformed_signature_is_refused_not_raised(self):
        with self.assertRaises(Refused):
            self._list(ALICE, "n1", "not-bytes")

    def test_a_missing_nonce_is_refused(self):
        with self.assertRaises(Refused):
            self._list(ALICE, "", b"whatever")

    def test_refusal_and_emptiness_are_different_answers(self):
        # "You may not" and "you have none" have to be distinguishable
        # or a caller cannot tell a permission problem from a new user.
        empty = _verifier({"pub-carol": "sec-carol"})
        got = list_records("pub-carol", "n1",
                           _signer("sec-carol")(challenge("pub-carol", "n1")),
                           list_keys=self.store.list_keys, verify_bytes=empty)
        self.assertEqual(got, [])

    def test_a_listing_is_stable_between_calls(self):
        sig = _signer(KEYS[ALICE])(challenge(ALICE, "n1"))
        self.assertEqual(self._list(ALICE, "n1", sig), self._list(ALICE, "n1", sig))

    def test_only_records_are_listed(self):
        # A stray object under the prefix is not a record id.
        self.store.objects[f"{owner_prefix(ALICE)}/notes.txt"] = b"hello"
        sig = _signer(KEYS[ALICE])(challenge(ALICE, "n1"))
        self.assertEqual(self._list(ALICE, "n1", sig), sorted(self.ids))


class TheChallenge(unittest.TestCase):
    def test_it_names_the_key_being_claimed(self):
        self.assertIn(ALICE.encode(), challenge(ALICE, "n1"))

    def test_a_different_nonce_is_different_bytes(self):
        self.assertNotEqual(challenge(ALICE, "n1"), challenge(ALICE, "n2"))

    def test_a_different_key_is_different_bytes(self):
        self.assertNotEqual(challenge(ALICE, "n1"), challenge(BOB, "n1"))

    def test_it_is_the_same_bytes_every_time(self):
        self.assertEqual(challenge(ALICE, "n1"), challenge(ALICE, "n1"))


if __name__ == "__main__":
    unittest.main()
