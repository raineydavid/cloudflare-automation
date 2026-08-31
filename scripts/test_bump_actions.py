"""bump_actions — the rewrite rules, without the network.

A bad rewrite lands in every workflow at once, and a workflow that
fails to parse fails silently until something tries to run it.

    python3 -m unittest scripts.test_bump_actions
"""

from __future__ import annotations

import unittest

from scripts.bump_actions import NODE_FLOOR, RUNTIMES, _older, rewrite, rewrite_runtimes, used_versions


class ParseTests(unittest.TestCase):
    def test_reads_action_and_ref(self):
        self.assertEqual(
            used_versions("      - uses: actions/checkout@v6\n"),
            {"actions/checkout": {"v6"}})

    def test_a_trailing_comment_does_not_confuse_it(self):
        self.assertEqual(
            used_versions("      - uses: actions/cache@v4  # pinned for the pip cache\n"),
            {"actions/cache": {"v4"}})

    def test_two_pins_for_one_action_are_both_reported(self):
        # This IS the drift the arch test fails on — the parse has to
        # surface it rather than last-one-wins.
        got = used_versions("  - uses: actions/checkout@v6\n  - uses: actions/checkout@v3\n")
        self.assertEqual(got, {"actions/checkout": {"v6", "v3"}})


class RewriteTests(unittest.TestCase):
    def test_it_repins_a_behind_major(self):
        out, changes = rewrite("      - uses: actions/checkout@v3\n", {"actions/checkout": 6})
        self.assertIn("actions/checkout@v6", out)
        self.assertEqual(changes, ["actions/checkout v3 -> v6"])

    def test_it_leaves_a_current_pin_alone(self):
        src = "      - uses: actions/checkout@v6\n"
        out, changes = rewrite(src, {"actions/checkout": 6})
        self.assertEqual(out, src)
        self.assertEqual(changes, [])

    def test_it_never_touches_a_sha_pin(self):
        # A commit pin is a supply-chain decision. Floating it back to a
        # tag would undo it silently, which is worse than being behind.
        src = "      - uses: actions/checkout@8f4b7f8 # pinned deliberately\n"
        out, changes = rewrite(src, {"actions/checkout": 6})
        self.assertEqual(out, src)
        self.assertEqual(changes, [])

    def test_it_never_downgrades(self):
        # A target below what is written means the target is stale, not
        # the file. rewrite only applies what it is told, so the caller
        # takes max() — this guards the caller's contract by showing the
        # rewrite is literal.
        out, _ = rewrite("  - uses: a/b@v6\n", {"a/b": 6})
        self.assertIn("a/b@v6", out)

    def test_indentation_and_the_rest_of_the_line_survive(self):
        src = "        - uses: actions/setup-node@v4   # comment\n"
        out, _ = rewrite(src, {"actions/setup-node": 6})
        self.assertEqual(out, "        - uses: actions/setup-node@v6   # comment\n")

    def test_a_file_with_no_trailing_newline_keeps_not_having_one(self):
        out, _ = rewrite("  - uses: a/b@v1", {"a/b": 2})
        self.assertFalse(out.endswith("\n"))


class RuntimeTests(unittest.TestCase):
    def test_it_lifts_an_old_python(self):
        # Reads the floor rather than restating it: two copies of a
        # version number is how the test and the fixer disagree.
        want = RUNTIMES["python-version"]
        out, changes = rewrite_runtimes("          python-version: '3.9'\n")
        self.assertIn(f"python-version: '{want}'", out)
        self.assertEqual(changes, [f"python-version 3.9 -> {want}"])

    def test_it_quotes_a_bare_version(self):
        # YAML reads an unquoted 3.10 as a float and drops the zero.
        out, _ = rewrite_runtimes("          python-version: 3.9\n")
        self.assertIn(f"""python-version: '{RUNTIMES["python-version"]}'""", out)

    def test_node_is_not_a_workflow_pin_any_more(self):
        # It lives in .nvmrc, read via node-version-file — the
        # setup-node README's own recommendation. Ten workflows cannot
        # disagree about a number that only exists once.
        self.assertNotIn("node-version", RUNTIMES)
        self.assertTrue(NODE_FLOOR)

    def test_it_leaves_a_newer_runtime_alone(self):
        src = "          python-version: '3.99'\n"
        out, changes = rewrite_runtimes(src)
        self.assertEqual(out, src)
        self.assertEqual(changes, [])


class CompareTests(unittest.TestCase):
    def test_dotted_compare(self):
        self.assertTrue(_older("3.9", "3.12"))     # not a string compare
        self.assertFalse(_older("3.14", "3.12"))
        self.assertFalse(_older("22", "22"))


if __name__ == "__main__":
    unittest.main()
