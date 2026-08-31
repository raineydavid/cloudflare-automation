"""Taking a domain's mail from its provider — the one destructive act here.

Everything else in this repo refuses to do this. These pin the refusals,
because the failure mode is somebody's mail stopping.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.inbound_switch import classify, describe  # noqa: E402

MG = [{"content": "mxa.mailgun.org", "priority": 10, "name": "a.test", "type": "MX", "ttl": 1},
      {"content": "mxb.mailgun.org", "priority": 10, "name": "a.test", "type": "MX", "ttl": 1}]
CF = [{"content": "route1.mx.cloudflare.net", "priority": 8, "name": "a.test", "type": "MX", "ttl": 1}]
GOOGLE = [{"content": "aspmx.l.google.com", "priority": 1, "name": "a.test", "type": "MX", "ttl": 1}]


class Classify(unittest.TestCase):
    def test_the_named_provider_is_separated(self):
        theirs, cf, other = classify(MG, "mailgun.org")
        self.assertEqual(len(theirs), 2)
        self.assertEqual((cf, other), ([], []))

    def test_cloudflares_own_is_not_the_provider(self):
        theirs, cf, other = classify(MG + CF, "mailgun.org")
        self.assertEqual(len(theirs), 2)
        self.assertEqual(len(cf), 1)
        self.assertEqual(other, [])

    def test_an_unnamed_provider_lands_in_other(self):
        # The refusal case. A zone with mail somewhere this was not told
        # about is a zone whose arrangement is not understood, and
        # deleting there stops mail somebody depends on.
        _, _, other = classify(MG + GOOGLE, "mailgun.org")
        self.assertEqual(len(other), 1)

    def test_a_trailing_dot_does_not_hide_a_match(self):
        dotted = [{"content": "mxa.mailgun.org.", "priority": 10, "name": "a.test", "type": "MX"}]
        self.assertEqual(len(classify(dotted, "mailgun.org")[0]), 1)

    def test_matching_is_case_insensitive(self):
        upper = [{"content": "MXA.MAILGUN.ORG", "priority": 10, "name": "a.test", "type": "MX"}]
        self.assertEqual(len(classify(upper, "mailgun.org")[0]), 1)

    def test_a_lookalike_domain_is_not_matched(self):
        # `notmailgun.org` ENDS WITH `mailgun.org`. A bare suffix test
        # would delete a lookalike domain's MX, in the one script here
        # permitted to delete anything. Matched on a label boundary.
        evil = [{"content": "mx.notmailgun.org", "priority": 10, "name": "a.test", "type": "MX"}]
        theirs, _, other = classify(evil, "mailgun.org")
        self.assertEqual(theirs, [])
        self.assertEqual(len(other), 1)

    def test_the_provider_apex_itself_still_matches(self):
        apex = [{"content": "mailgun.org", "priority": 10, "name": "a.test", "type": "MX"}]
        self.assertEqual(len(classify(apex, "mailgun.org")[0]), 1)


class Describe(unittest.TestCase):
    def test_a_line_carries_everything_needed_to_recreate_it(self):
        # A destructive change that cannot be undone from its own output
        # is a change nobody should run.
        line = describe(MG[0])
        for part in ("MX", "a.test", "mxa.mailgun.org", "priority 10"):
            self.assertIn(part, line)


if __name__ == "__main__":
    unittest.main()
