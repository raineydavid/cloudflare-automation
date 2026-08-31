"""vercel_env_sync — the consent rule, the scope search, and redaction.

This writes environment variables to the platform serving the site, so
the property that matters most is that it does NOT write unless someone
plainly said to. The file-as-dispatch path makes that a parsing
question: a JSON field decides whether a run is a dry run, and "yes",
null and a missing key must all mean no.

Hermetic — every Vercel call is stubbed. Run:
    python3 -m unittest scripts.test_vercel_env_sync
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from scripts import vercel_env_sync as sync


def _quiet():
    """Swallow the script's own stdout.

    It prints a per-variable plan on every run, and eight runs of that
    interleaved with unittest's output made a CI failure genuinely hard
    to find — the traceback was threaded through sixty lines of "would
    CREATE". A test log is for reading when something breaks.
    """
    return contextlib.redirect_stdout(io.StringIO())


def _request(body: dict) -> str:
    """Write a request file and return its path."""
    fh = tempfile.NamedTemporaryFile('w', suffix='.json', delete=False)
    json.dump(body, fh)
    fh.close()
    return fh.name


class ConsentTests(unittest.TestCase):
    """Only the literal string 'true' may write.

    The knob lives in the workflow now — APPLY at the top of
    .github/workflows/sync-vercel-env.yml — so the consent rule is a
    shell comparison rather than a JSON parse, and this follows it
    there. Deleting these when the mechanism moved would have quietly
    dropped the property that matters most: this writes environment
    variables to the platform serving the site.
    """

    WORKFLOW = (Path(__file__).resolve().parent.parent
                / ".github" / "workflows" / "sync-vercel-env.yml").read_text()

    def test_apply_is_one_of_exactly_two_words(self):
        """'false' or 'true'. Nothing else.

        This used to demand 'false' outright — which was wrong, and
        wrong in a way that made the tool unusable: the workflow file
        IS the control surface, so arming it is the only way to run a
        real sync from a branch. A check that forbids the single
        supported action is not a safety net, it is a bug with a
        reassuring name.

        What is worth pinning is that the value is never something
        ambiguous. 'yes', 'True', '1' and an empty string would every
        one of them be silently treated as no by the shell comparison
        below — safe, but silently, which is how someone concludes the
        workflow is broken when it is doing exactly what it was told.
        """
        import re  # noqa: PLC0415 — local to the only user
        m = re.search(r"^\s*APPLY:\s*'([^']*)'", self.WORKFLOW, re.M)
        self.assertIsNotNone(m, "APPLY must be declared in the workflow, quoted")
        self.assertIn(m.group(1), ("false", "true"),
                      "APPLY takes 'false' or 'true' — anything else reads as no, quietly")

    def test_apply_is_compared_against_the_literal_true(self):
        # Not `-n "$WANT_APPLY"`, not a truthiness test. 'yes', 'True'
        # and an empty value must all stay dry runs.
        self.assertIn('if [ "$WANT_APPLY" = "true" ]; then', self.WORKFLOW)

    def test_the_script_is_only_given_apply_inside_that_branch(self):
        # An --apply that sits outside the guard is armed on every run.
        armed = [ln for ln in self.WORKFLOW.splitlines() if "--apply" in ln]
        self.assertEqual(len(armed), 1, f"exactly one guarded --apply, found: {armed}")
        guard = self.WORKFLOW.index('if [ "$WANT_APPLY" = "true" ]; then')
        self.assertGreater(self.WORKFLOW.index("--apply"), guard)

    def test_the_knobs_live_in_the_workflow_and_nowhere_else(self):
        # Founder: "it needs to be in github yml not anywhere else."
        # A companion config file is a second place to look and a second
        # thing to forget.
        self.assertFalse((Path(__file__).resolve().parent.parent / "ops").exists(),
                         "the ops/ request file is gone; the yml is the control surface")
        self.assertNotIn("--request-file", self.WORKFLOW)


class TargetTests(unittest.TestCase):
    def test_a_comma_list_becomes_one_write_per_environment(self):
        # The whole reason this script exists: Vercel scopes vars per
        # environment, and a production-only value is invisible to a
        # preview. One run has to cover both.
        posts: list[dict] = []

        def fake_call(url: str, token: str, method: str = "GET", body: dict | None = None):
            if method == "POST" and body:
                posts.append(body)
            return 200, {"envs": []}, ""

        with mock.patch.object(sync, "_call", side_effect=fake_call), \
             mock.patch.dict(os.environ, {"VERCEL_TOKEN": "t", "R2_BUCKET": "b"}, clear=False), \
             mock.patch("sys.argv", ["x", "--target", "preview,production", "--apply"]), _quiet():
            sync.main()
        targets = sorted(t for p in posts for t in p["target"])
        self.assertEqual(targets, ["preview", "production"])

    def test_an_unknown_target_is_refused_before_any_call(self):
        with mock.patch.dict(os.environ, {"VERCEL_TOKEN": "t"}, clear=False), \
             mock.patch("sys.argv", ["x", "--target", "staging", "--apply"]), \
             mock.patch.object(sync, "_call") as called, _quiet():
            self.assertEqual(sync.main(), 1)
            called.assert_not_called()


class SafetyTests(unittest.TestCase):
    def test_an_unset_variable_is_skipped_not_blanked(self):
        # An empty string reads as "configured" to every is_configured()
        # check and fails later, further from the cause.
        posts: list[dict] = []

        def fake_call(url: str, token: str, method: str = "GET", body: dict | None = None):
            if method == "POST" and body:
                posts.append(body)
            return 200, {"envs": []}, ""

        with mock.patch.object(sync, "_call", side_effect=fake_call), \
             mock.patch.dict(os.environ, {"VERCEL_TOKEN": "t", "R2_BUCKET": "b",
                                          "R2_SECRET_ACCESS_KEY": ""}, clear=False), \
             mock.patch("sys.argv", ["x", "--target", "preview", "--apply"]), _quiet():
            sync.main()
        self.assertEqual([p["key"] for p in posts], ["R2_BUCKET"])

    def test_a_value_never_survives_into_an_error_message(self):
        with mock.patch.dict(os.environ, {"R2_SECRET_ACCESS_KEY": "s3cr3t-material"}, clear=False):
            out = sync._redact("Invalid value s3cr3t-material for key")
        self.assertNotIn("s3cr3t-material", out)
        self.assertIn("<R2_SECRET_ACCESS_KEY>", out)

    def test_redaction_ignores_trivially_short_values(self):
        # Redacting a 1-2 char value would blank unrelated text and make
        # the message useless — a "safety" feature that destroys the
        # diagnostic it was protecting.
        with mock.patch.dict(os.environ, {"R2_BUCKET": "ab"}, clear=False):
            self.assertEqual(sync._redact("a bad request"), "a bad request")



class WorkflowsAgreeTests(unittest.TestCase):
    """The uploader and the reader must name the SAME bucket.

    seed-r2.yml puts the assets in R2; sync-vercel-env.yml tells Vercel
    where to find them. If they resolve the bucket differently the
    upload succeeds, the read 404s, and neither side looks
    misconfigured — the exact failure this sync exists to end.

    R2_BUCKET is the one that bites: it exists only as a 'preview'
    ENVIRONMENT secret, invisible to any job that does not declare that
    environment, so both workflows fall through to the literal name.
    That literal is therefore load-bearing, not a placeholder.
    """

    ROOT = Path(__file__).resolve().parent.parent

    def _env_of(self, workflow: str) -> dict:
        """NAME -> expression for every `NAME: ${{ ... }}` in a workflow.

        Stdlib only, deliberately. The first version used PyYAML, which
        is installed on this machine and NOT in CI — so it passed here
        and errored there, which is the whole reason a local run is not
        a proof. scripts/test_stdlib_only.py now enforces the rule.

        This does not understand YAML; it collects assignments whose
        value is a ${{ }} expression, wherever they appear. That is
        enough because the names it compares appear only in env blocks,
        and it is stated rather than assumed: an empty map fails loudly
        instead of comparing two empty dicts and passing.
        """
        import re  # noqa: PLC0415 — local to the only user
        text = (self.ROOT / ".github" / "workflows" / workflow).read_text()
        found = {}
        for m in re.finditer(r"^\s*([A-Z][A-Z0-9_]*):\s*(\$\{\{.*\}\})\s*$", text, re.M):
            found.setdefault(m.group(1), m.group(2))
        self.assertTrue(found, f"{workflow}: parsed no env assignments — the check would be vacuous")
        return found

    def test_both_workflows_resolve_the_bucket_identically(self):
        seeder = self._env_of("seed-r2.yml")
        syncer = self._env_of("sync-vercel-env.yml")
        norm = lambda s: " ".join(s.split())  # noqa: E731 — whitespace is not meaning
        self.assertEqual(
            norm(syncer["R2_BUCKET"]), norm(seeder["R2_BUCKET"]),
            "the bucket written to and the bucket read from must be the same one",
        )

    def test_the_credential_fallbacks_match_too(self):
        # A repo carrying only the CLOUDFLARE_* names would seed fine and
        # sync nothing — same class of silent split.
        seeder = self._env_of("seed-r2.yml")
        syncer = self._env_of("sync-vercel-env.yml")
        for ours, theirs in (("R2_ACCOUNT_ID", "R2_ACCOUNT_ID"),
                             ("R2_ACCESS_KEY_ID", "AWS_ACCESS_KEY_ID"),
                             ("R2_SECRET_ACCESS_KEY", "AWS_SECRET_ACCESS_KEY")):
            with self.subTest(var=ours):
                self.assertEqual(" ".join(syncer[ours].split()),
                                 " ".join(seeder[theirs].split()))

    def test_every_declared_name_is_actually_passed_by_the_workflow(self):
        # A name in NAMES that the workflow never puts in the env is a
        # variable this can never copy, and it would report "not set
        # here" forever without anyone knowing why.
        syncer = self._env_of("sync-vercel-env.yml")
        for name in sync.NAMES:
            self.assertIn(name, syncer, f"{name} is declared but never passed")

if __name__ == "__main__":
    unittest.main()
