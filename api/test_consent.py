"""Consent, for someone who cannot give it themselves.

Every test here is a way this could hurt a real person: a call at three
in the morning, a fourth call to someone who cannot remember the third,
a permission that outlived the situation it was given for, or a
frightened person who cannot make it stop.

The refusal ORDER is pinned hardest. Getting the checks right and the
order wrong is how a system ends up verifying a guardian's signature
before it will stop ringing someone who is asking it to.
"""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from api._consent import (  # noqa: E402
    CHANNELS,
    DEFAULT_WAKING_HOURS,
    NEEDS,
    PURPOSES,
    ConsentError,
    brief_for,
    may_contact,
    needs_of,
    record,
    revocation,
)

GUARDIAN = "pub-daughter"
NOW = "2026-08-06T10:00:00Z"
LATER = "2026-12-01T10:00:00Z"


def a_record(**over):
    kw = dict(
        guardian=GUARDIAN, recipient_ref="ref-7f3a",
        channels=["voice"], purposes=["companionship", "reading"],
        expires_at="2026-11-01T00:00:00Z", needs=["audio-only", "reintroduce"],
        relationship="daughter",
    )
    kw.update(over)
    return record(**kw)


def signed(**over):
    body = a_record(**over)
    return {"record": body, "digest": "d", "signature": "sig", "public_key": GUARDIAN}


#: "not supplied", so a test CAN pass None as the record under test —
#: `s=None` defaulting to a valid record is how a check for junk input
#: quietly became a check for good input.
_UNSET = object()


def ask(s=_UNSET, **over):
    kw = dict(channel="voice", purpose="reading", now_iso=NOW, local_hour=10)
    kw.update(over)
    return may_contact(signed() if s is _UNSET else s, **kw)


class TheRecipientComesFirst(unittest.TestCase):
    """The guardian consented. The person on the phone did not."""

    def test_stop_is_honoured(self):
        ok, why = ask(recipient_said_stop=True)
        self.assertFalse(ok)
        self.assertIn("recipient", why)

    def test_stop_needs_no_signature_key_or_verification(self):
        # The cruellest possible failure would be asking a distressed
        # person to authenticate before the calls stop. So this is
        # checked BEFORE the record is even looked at.
        for junk in ({}, None, {"record": {"kind": "nonsense"}}):
            ok, why = may_contact(junk, channel="voice", purpose="reading",
                                  now_iso=NOW, local_hour=10, recipient_said_stop=True)
            self.assertFalse(ok)
            self.assertIn("recipient", why)

    def test_stop_beats_a_perfectly_valid_consent(self):
        ok, _ = ask()
        self.assertTrue(ok)
        self.assertFalse(ask(recipient_said_stop=True)[0])

    def test_nothing_re_enables_itself(self):
        # A guardian has to consent again, deliberately. There is no
        # path here that clears a stop.
        self.assertFalse(ask(recipient_said_stop=True)[0])
        self.assertFalse(ask(recipient_said_stop=True, contacts_today=0)[0])


class WhatWasActuallyAgreedTo(unittest.TestCase):
    def test_a_permitted_contact_is_permitted(self):
        self.assertEqual(ask(), (True, "permitted"))

    def test_a_channel_nobody_agreed_to_is_refused(self):
        ok, why = ask(channel="sms")
        self.assertFalse(ok)
        self.assertIn("text message", why)

    def test_a_purpose_nobody_agreed_to_is_refused(self):
        ok, why = ask(purpose="checkin")
        self.assertFalse(ok)
        self.assertIn("checkin", why)

    def test_a_withdrawn_consent_is_refused(self):
        ok, why = ask(revoked=True)
        self.assertFalse(ok)
        self.assertIn("withdrawn", why)

    def test_an_expired_consent_is_refused(self):
        ok, why = ask(now_iso=LATER)
        self.assertFalse(ok)
        self.assertIn("expired", why)

    def test_an_unsigned_record_is_refused(self):
        # Failing open here would be indefensible.
        s = signed()
        s["signature"] = None
        self.assertFalse(ask(s)[0])

    def test_something_that_is_not_a_consent_record_is_refused(self):
        for junk in ({}, None, {"record": {}}, {"record": {"kind": "revocation"}}):
            self.assertFalse(ask(junk)[0])


class NotInTheMiddleOfTheNight(unittest.TestCase):
    def test_three_in_the_morning_is_refused(self):
        ok, why = ask(local_hour=3)
        self.assertFalse(ok)
        self.assertIn("waking hours", why)

    def test_the_window_is_half_open_at_both_ends(self):
        start, end = DEFAULT_WAKING_HOURS
        self.assertTrue(ask(local_hour=start)[0])
        self.assertFalse(ask(local_hour=end)[0])
        self.assertTrue(ask(local_hour=end - 1)[0])

    def test_a_record_may_be_more_careful_than_the_default(self):
        s = signed(waking_hours=(10, 17))
        self.assertFalse(ask(s, local_hour=9)[0])
        self.assertTrue(ask(s, local_hour=10)[0])

    def test_a_record_may_not_be_less_careful(self):
        # This is the setting an operator would widen for engagement and
        # a person would feel at four in the morning.
        with self.assertRaises(ConsentError):
            a_record(waking_hours=(6, 23))
        with self.assertRaises(ConsentError):
            a_record(waking_hours=(0, 24))

    def test_a_nonsense_window_is_refused_at_creation(self):
        for bad in ((20, 9), (9, 9), (-1, 10), (9, 25)):
            with self.assertRaises(ConsentError, msg=str(bad)):
                a_record(waking_hours=bad)


class NotAgainAndAgain(unittest.TestCase):
    """Someone who cannot remember the last call experiences the fourth
    one as the first, which is worse."""

    def test_the_ceiling_holds(self):
        ok, why = ask(contacts_today=2)
        self.assertFalse(ok)
        self.assertIn("limit 2", why)

    def test_under_the_ceiling_is_fine(self):
        self.assertTrue(ask(contacts_today=1)[0])

    def test_the_ceiling_is_bounded_at_creation(self):
        for bad in (0, -1, 7, 99):
            with self.assertRaises(ConsentError, msg=str(bad)):
                a_record(max_contacts_per_day=bad)


class ConsentHasToExpire(unittest.TestCase):
    def test_a_record_with_no_expiry_is_refused(self):
        # Consent that never expires is consent nobody revisits — and
        # the person it covers cannot revisit it themselves.
        with self.assertRaises(ConsentError):
            a_record(expires_at="")

    def test_a_record_needs_a_guardian_and_a_recipient(self):
        with self.assertRaises(ConsentError):
            a_record(guardian="")
        with self.assertRaises(ConsentError):
            a_record(recipient_ref="")

    def test_an_empty_grant_is_not_a_grant(self):
        with self.assertRaises(ConsentError):
            a_record(channels=[])
        with self.assertRaises(ConsentError):
            a_record(purposes=[])

    def test_an_invented_channel_purpose_or_need_is_refused(self):
        with self.assertRaises(ConsentError):
            a_record(channels=["telegram"])
        with self.assertRaises(ConsentError):
            a_record(purposes=["marketing"])
        with self.assertRaises(ConsentError):
            a_record(needs=["whatever"])


class NoIdentityInTheRecord(unittest.TestCase):
    """These records are checkable by third parties and stored under a
    key-derived prefix. They have no business carrying the identity of a
    vulnerable person to whoever fetches one."""

    def test_the_record_carries_only_what_it_was_given(self):
        body = a_record()
        self.assertEqual(body["recipient_ref"], "ref-7f3a")
        blob = str(body)
        for pii in ("+44", "@", "Street", "Road"):
            self.assertNotIn(pii, blob)

    def test_the_id_is_derived_from_the_record(self):
        # The same consent twice is the same id; a changed one is not.
        self.assertEqual(a_record()["id"], a_record()["id"])
        self.assertNotEqual(a_record()["id"], a_record(channels=["email"])["id"])


class AccessNeeds(unittest.TestCase):
    def test_needs_are_not_a_gate(self):
        # They do not decide WHETHER to call — they decide what the call
        # has to be like. A caller that only asked may_contact would
        # never see them, which is why they are separate.
        self.assertEqual(needs_of(signed()), ["audio-only", "reintroduce"])
        self.assertTrue(ask()[0])

    def test_the_brief_is_words_a_model_will_read(self):
        # A rule the model never reads is a rule the output ignores —
        # learned on book covers and again on the 217 template blanks.
        text = brief_for(signed())
        self.assertIn("without sight", text)
        self.assertIn("say who is calling", text)
        self.assertTrue(text.endswith("."))

    def test_no_needs_means_no_instruction_rather_than_an_empty_one(self):
        self.assertEqual(brief_for(signed(needs=[])), "")
        self.assertEqual(brief_for({}), "")

    def test_every_need_has_wording(self):
        # A need with no sentence would silently vanish from the brief.
        text = brief_for(signed(needs=sorted(NEEDS)))
        for phrase in NEEDS.values():
            self.assertIn(phrase, text)


class Revocation(unittest.TestCase):
    def test_a_revocation_names_what_it_withdraws(self):
        r = revocation(consent_id="consent-abc", by=GUARDIAN, at=NOW)
        self.assertEqual(r["consent"], "consent-abc")
        self.assertTrue(r["id"].startswith("rev-"))

    def test_an_incomplete_revocation_is_refused(self):
        for kw in ({"consent_id": ""}, {"by": ""}, {"at": ""}):
            base = dict(consent_id="consent-abc", by=GUARDIAN, at=NOW)
            base.update(kw)
            with self.assertRaises(ConsentError):
                revocation(**base)


class TheOrderOfRefusals(unittest.TestCase):
    """Getting the checks right and the order wrong is how a system ends
    up verifying a signature before it will stop ringing someone."""

    def test_the_recipient_outranks_everything(self):
        # Expired, wrong channel, middle of the night, over the limit —
        # and the reason returned is still the person asking to stop.
        ok, why = may_contact(signed(), channel="sms", purpose="marketing",
                              now_iso=LATER, local_hour=3, contacts_today=99,
                              recipient_said_stop=True, revoked=True)
        self.assertFalse(ok)
        self.assertIn("recipient", why)

    def test_revocation_outranks_the_rest(self):
        ok, why = may_contact(signed(), channel="sms", purpose="marketing",
                              now_iso=LATER, local_hour=3, revoked=True)
        self.assertFalse(ok)
        self.assertIn("withdrawn", why)

    def test_expiry_outranks_the_details(self):
        ok, why = ask(now_iso=LATER, channel="sms", local_hour=3)
        self.assertFalse(ok)
        self.assertIn("expired", why)

    def test_every_refusal_explains_itself(self):
        # "Denied" tells an operator nothing at three in the morning.
        cases = [
            dict(recipient_said_stop=True), dict(revoked=True), dict(now_iso=LATER),
            dict(channel="sms"), dict(purpose="checkin"), dict(local_hour=3),
            dict(contacts_today=5),
        ]
        for c in cases:
            ok, why = ask(**c)
            self.assertFalse(ok, str(c))
            self.assertGreater(len(why), 12, str(c))

    def test_the_vocabulary_is_closed(self):
        # A new way to reach someone is a decision, not a config value.
        self.assertEqual(set(CHANNELS), {"voice", "whatsapp", "sms", "email"})
        self.assertIn("companionship", PURPOSES)
        self.assertIn("reading", PURPOSES)


if __name__ == "__main__":
    unittest.main()
