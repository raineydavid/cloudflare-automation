"""Attribution, without putting a colleague's address in a CI log."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.audit_zone import actor_of, describe, touching  # noqa: E402


class Actor(unittest.TestCase):
    def test_a_person_is_masked(self):
        got = actor_of({"actor": {"type": "user", "email": "someone@example.com"}})
        self.assertEqual(got, "s*@e*.com")

    def test_an_automation_is_named_as_one(self):
        # A token doing this and a person doing it call for different
        # follow-ups, so the distinction has to survive into the line.
        got = actor_of({"actor": {"type": "api_key", "email": "bot@example.com"}})
        self.assertIn("api_key", got)

    def test_no_actor_says_so_rather_than_printing_nothing(self):
        self.assertIn("no actor", actor_of({}))

    def test_no_address_survives_in_a_described_line(self):
        line = describe({
            "when": "2026-08-25T10:00:00Z",
            "actor": {"type": "user", "email": "someone@example.com"},
            "action": {"type": "zone.delete"},
            "resource": {"type": "zone"},
        })
        self.assertNotIn("someone@example.com", line)
        self.assertIn("zone.delete", line)


class Touching(unittest.TestCase):
    ENTRIES = [
        {"when": "2026-08-01T00:00:00Z", "resource": {"id": "other.test"}},
        {"when": "2026-08-25T00:00:00Z", "resource": {"id": "a.test"}},
        {"when": "2026-08-26T00:00:00Z", "newValue": "moved a.test somewhere"},
    ]

    def test_the_domain_is_found_wherever_it_appears(self):
        # A zone delete names it in `resource`; a nameserver change
        # names it in a value. Matching one field would miss the other.
        self.assertEqual(len(touching(self.ENTRIES, "a.test")), 2)

    def test_newest_first(self):
        self.assertEqual(touching(self.ENTRIES, "a.test")[0]["when"],
                         "2026-08-26T00:00:00Z")

    def test_an_unrelated_domain_is_not_matched(self):
        self.assertEqual(touching(self.ENTRIES, "nothing.test"), [])


if __name__ == "__main__":
    unittest.main()
