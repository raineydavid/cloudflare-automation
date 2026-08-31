"""The one thing this parser must never do is confuse two answers.

`[]` means the Worker holds nothing and it is safe to mint. An output
shape we do not recognise means we do not know — and treating that as
`[]` would mint a bearer over a live one and revoke every holder.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.worker_secret_names import names  # noqa: E402


class TestWorkerSecretNames(unittest.TestCase):
    def test_reads_wranglers_json(self):
        raw = """
        [
          { "name": "GH_PAT", "type": "secret_text" },
          { "name": "MCP_TOKEN", "type": "secret_text" }
        ]
        """
        self.assertEqual(names(raw), ["GH_PAT", "MCP_TOKEN"])

    def test_ignores_chatter_around_the_json(self):
        # wrangler prints version banners and update notices above its
        # output, and a parser that demanded the file BE json would take
        # one of those as "unrecognised".
        raw = '\n ⛅️ wrangler 4.0.0\n---\n[{"name":"MCP_TOKEN"}]\nDone.\n'
        self.assertEqual(names(raw), ["MCP_TOKEN"])

    def test_empty_list_is_an_answer_not_a_failure(self):
        self.assertEqual(names("[]"), [])

    def test_a_table_still_yields_names(self):
        raw = "Secret Name\n-----------\nGH_PAT\nROOT_SECRET\n"
        self.assertEqual(names(raw), ["GH_PAT", "ROOT_SECRET"])

    def test_unrecognised_output_is_none_and_never_empty(self):
        # The whole point. None is "we do not know"; [] is "there are
        # none", and the caller mints on the second.
        for raw in ("", "error: not logged in\n", "something went wrong"):
            with self.subTest(raw=raw):
                self.assertIsNone(names(raw))

    def test_lowercase_words_are_not_mistaken_for_secret_names(self):
        # A prose failure message must not parse as a list of secrets —
        # that would read as "a token is held" and block a mint forever.
        self.assertIsNone(names("no worker named ontold-mcp was found\n"))


if __name__ == "__main__":
    unittest.main()
