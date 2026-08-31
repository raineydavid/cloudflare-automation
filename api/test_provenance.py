"""Provenance has to survive people copying each other.

Every test here is about a claim somebody could make falsely: that they
made a thing, that a thing descends from theirs, or that a creator
granted something they did not.
"""

import hashlib
import json
import unittest

from api._provenance import (
    GRANTS,
    canonical,
    lineage,
    may_remake,
    prompt_fingerprint,
    record,
    sign,
    verify,
)


# A toy keypair: signature = sha256(key || msg). Enough to exercise the
# contract without a crypto dependency — the real one is Registrack's
# keypair.sign_bytes, passed in.
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


def _signed(creator=ALICE, **kw):
    body = record(artefact_id=kw.pop("artefact_id", "film-1"), creator=creator, **kw)
    return sign(body, _signer(KEYS[creator]), creator)


class CanonicalForm(unittest.TestCase):
    def test_matches_registracks_canonical_exactly(self):
        # Byte-identical or every signature ever made breaks. Registrack:
        # json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
        payload = {"b": 2, "a": 1}
        self.assertEqual(
            canonical(payload),
            json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str).encode(),
        )

    def test_key_order_does_not_change_the_bytes(self):
        self.assertEqual(canonical({"a": 1, "b": 2}), canonical({"b": 2, "a": 1}))


class PromptStaysPrivate(unittest.TestCase):
    def test_the_prompt_is_never_in_the_record(self):
        # A provenance record travels publicly; the brief is the
        # creator's IP and this repo keeps prompts server-side.
        brief = "A quiet windswept story about the last working lighthouse"
        s = _signed(prompt=brief)
        self.assertNotIn(brief, json.dumps(s))
        self.assertIn("prompt_sha256", s["record"])

    def test_the_holder_of_the_brief_can_still_prove_the_link(self):
        brief = "A quiet windswept story"
        s = _signed(prompt=brief)
        self.assertEqual(s["record"]["prompt_sha256"], prompt_fingerprint(brief))

    def test_reflowed_whitespace_is_the_same_brief(self):
        # A prompt retyped with a different line wrap is the same
        # prompt; a fingerprint that disagrees fails for no reason.
        self.assertEqual(prompt_fingerprint("a  b\n c"), prompt_fingerprint("a b c"))

    def test_a_different_brief_is_a_different_fingerprint(self):
        self.assertNotEqual(prompt_fingerprint("a"), prompt_fingerprint("b"))

    def test_no_prompt_means_no_field_rather_than_an_empty_one(self):
        self.assertNotIn("prompt_sha256", record(artefact_id="x", creator=ALICE))


class Authorship(unittest.TestCase):
    def test_a_genuine_record_verifies(self):
        self.assertEqual(verify(_signed(), V), (True, "verified"))

    def test_an_edited_record_fails(self):
        # The whole point: you cannot take someone's record and put
        # your artefact in it.
        s = _signed()
        s["record"]["artefact"] = "someone-elses-film"
        ok, why = verify(s, V)
        self.assertFalse(ok)
        self.assertIn("digest", why)

    def test_you_cannot_claim_authorship_with_your_own_key(self):
        # Bob signs a record that names Alice as creator. The signature
        # is valid — it just is not Alice's.
        body = record(artefact_id="film-1", creator=ALICE)
        s = sign(body, _signer(KEYS[BOB]), BOB)
        ok, why = verify(s, V)
        self.assertFalse(ok)
        self.assertIn("different key", why)

    def test_a_forged_signature_fails(self):
        s = _signed()
        s["signature"] = "00" * 32
        self.assertFalse(verify(s, V)[0])

    def test_a_malformed_signature_is_refused_not_raised(self):
        s = _signed()
        s["signature"] = "not-hex"
        ok, why = verify(s, V)
        self.assertFalse(ok)
        self.assertIn("malformed", why)

    def test_junk_is_refused(self):
        for junk in (None, {}, {"nope": 1}, "a string"):
            self.assertFalse(verify(junk, V)[0])

    def test_a_record_about_nothing_is_refused_at_creation(self):
        with self.assertRaises(ValueError):
            record(artefact_id="", creator=ALICE)
        with self.assertRaises(ValueError):
            record(artefact_id="x", creator="")


class Grants(unittest.TestCase):
    def test_open_and_credit_permit_a_remake(self):
        for g in ("open", "credit", "shape-only"):
            allowed, what = may_remake(_signed(grant=g))
            self.assertTrue(allowed, g)
            self.assertEqual(what, GRANTS[g])

    def test_reserved_refuses_but_still_explains(self):
        allowed, what = may_remake(_signed(grant="reserved"))
        self.assertFalse(allowed)
        self.assertTrue(what)

    def test_a_record_with_no_grant_is_not_permission(self):
        # Nobody decided. Guessing permissively is how a copy ships.
        allowed, why = may_remake({"record": {"artefact": "x"}})
        self.assertFalse(allowed)
        self.assertIn("ask", why)

    def test_an_unknown_grant_is_refused_at_creation(self):
        with self.assertRaises(ValueError):
            record(artefact_id="x", creator=ALICE, grant="whatever-i-like")


class Lineage(unittest.TestCase):
    def _chain(self):
        a = _signed(artefact_id="original", creator=ALICE, grant="credit")
        b = sign(record(artefact_id="remix", creator=BOB, parent=a["record"]["id"]),
                 _signer(KEYS[BOB]), BOB)
        c = sign(record(artefact_id="remix-of-remix", creator=ALICE,
                        parent=b["record"]["id"]), _signer(KEYS[ALICE]), ALICE)
        return a, b, c, {x["record"]["id"]: x for x in (a, b, c)}

    def test_a_derivative_walks_back_to_its_origin(self):
        a, b, c, index = self._chain()
        self.assertEqual(lineage(c["record"]["id"], index),
                         [c["record"]["id"], b["record"]["id"], a["record"]["id"]])

    def test_every_ancestor_still_verifies_under_its_own_key(self):
        # A chain is not proof. Each link is signed by whoever actually
        # made that link, and that is what makes the walk worth anything.
        _, _, _, index = self._chain()
        for r in index.values():
            self.assertEqual(verify(r, V), (True, "verified"))

    def test_a_cycle_terminates(self):
        # A forged record can name any parent, including one that names
        # it back. The walk must not hang.
        x = sign(record(artefact_id="x", creator=ALICE, parent="prv-y"), _signer("sec-alice"), ALICE)
        y = sign(record(artefact_id="y", creator=ALICE, parent=x["record"]["id"]),
                 _signer("sec-alice"), ALICE)
        index = {x["record"]["id"]: x, "prv-y": y}
        self.assertLessEqual(len(lineage(x["record"]["id"], index)), 3)

    def test_a_long_chain_is_capped(self):
        index, prev = {}, None
        for i in range(200):
            r = sign(record(artefact_id=f"a{i}", creator=ALICE, parent=prev),
                     _signer("sec-alice"), ALICE)
            index[r["record"]["id"]] = r
            prev = r["record"]["id"]
        self.assertEqual(len(lineage(prev, index, limit=64)), 64)

    def test_an_unknown_parent_ends_the_walk_rather_than_failing(self):
        orphan = sign(record(artefact_id="x", creator=ALICE, parent="prv-missing"),
                      _signer("sec-alice"), ALICE)
        got = lineage(orphan["record"]["id"], {orphan["record"]["id"]: orphan})
        self.assertEqual(got, [orphan["record"]["id"], "prv-missing"])


class TheSupplierStaysOurs(unittest.TestCase):
    """A public record must not publish who we buy inference from.

    The first version of this module put the models on the record.
    ci.yml already greps the built bundle for exactly that and fails
    the build — so a signed record naming them would have handed out
    what a check on every push exists to keep in.
    """

    def test_no_model_name_reaches_the_record(self):
        blob = json.dumps(_signed(prompt="x", seconds=8))
        for supplier in ("runware", "runway", "kling", "veo", "gpt-",
                         "claude", "gemini", "grok", "seedance", "flux"):
            self.assertNotIn(supplier, blob.lower(), supplier)

    def test_a_caller_cannot_smuggle_one_in(self):
        # record() takes keyword arguments only, so an extra field is a
        # TypeError rather than something that quietly rides along into
        # a signature nobody can edit afterwards.
        with self.assertRaises(TypeError):
            record(artefact_id="x", creator=ALICE, models=["runware:101@1"])

    def test_the_disclosure_names_US(self):
        # The fact worth publishing is that a machine made it, and who
        # to ask about it — not which engine turned the handle.
        self.assertEqual(_signed()["record"]["tool"], "ontold")

    def test_the_seconds_billed_ride_along(self):
        # The quote, the spend and the provenance are the same event.
        self.assertEqual(_signed(seconds=300)["record"]["seconds"], 300)


if __name__ == "__main__":
    unittest.main()
