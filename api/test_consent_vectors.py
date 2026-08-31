"""The consent gate has two implementations. This is half of why that
is survivable.

`api/_consent.py` decides whether an agent may contact a vulnerable
person. `workers/mcp/src/consent.mjs` decides the same thing at the
edge, because a Dynamic Worker's capabilities are composed there and
the edge cannot call Python.

Two implementations of a safety decision drift, and the drift is
invisible: both sides keep passing their own tests while disagreeing
about whether somebody's phone rings. So neither side owns the answers.
`shared/consentVectors.json` holds them, and BOTH suites read it — this
file, and `workers/mcp/consent.test.mjs`.

What this half proves is that the fixture still describes the real
Python. If someone changes a refusal here and does not regenerate, this
fails. If someone edits the fixture to make the JavaScript pass, this
fails. The JavaScript suite proves the other half.

Regenerate with the snippet in shared/README.md, and expect both suites
to move together. If only one moves, one of them is wrong.
"""

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from api._consent import may_contact  # noqa: E402

VECTORS = Path(__file__).resolve().parent.parent / "shared" / "consentVectors.json"


class TheFixtureStillDescribesThisImplementation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cases = json.loads(VECTORS.read_text())["cases"]

    def test_every_vector_matches(self):
        for case in self.cases:
            with self.subTest(case["name"]):
                allowed, why = may_contact(case["consent"], **case["args"])
                self.assertEqual(
                    {"allowed": allowed, "why": why}, case["expect"],
                    f"{case['name']}: regenerate shared/consentVectors.json, "
                    "and expect workers/mcp/consent.test.mjs to move too",
                )

    def test_the_refusal_order_is_covered(self):
        # A fixture that only tested the happy path would pass forever
        # while the ORDER of refusals rotted — and the order is the
        # design: the recipient's own stop is checked before the
        # guardian's signature, deliberately.
        names = {c["name"] for c in self.cases}
        for required in ("stop beats everything else", "revoked beats expiry"):
            self.assertIn(required, names)

    def test_it_is_not_all_refusals(self):
        # The inverse trap: a gate that refused everything would satisfy
        # every refusal vector. At least one case must be permitted.
        allowed = [c for c in self.cases if c["expect"]["allowed"]]
        self.assertGreaterEqual(len(allowed), 3, "the fixture must cover permitted cases too")

    def test_there_are_enough_of_them_to_mean_something(self):
        self.assertGreaterEqual(len(self.cases), 12)


if __name__ == "__main__":
    unittest.main()
