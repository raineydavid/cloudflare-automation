"""api/_inference/r2_sink.py — owner-id key-scoping tests.

Founder (2026-07-10): "why dont we just use wrangler and create buckets
per individual /organisation" → single bucket + owner-prefixed keys
instead (no per-org bucket sprawl, no org concept exists anywhere in
the storage layer yet). Pins: _sanitize_owner_id strips anything that
isn't [a-zA-Z0-9_-], truncates, and empty/None input never produces a
truthy segment; output_key/upload_bytes fold the sanitized owner into
the key path when present and are byte-for-byte unchanged when absent
(no regression for existing unscoped callers).

Run: python3 -m unittest api._inference.test_r2_sink
"""

from __future__ import annotations

import unittest

from .r2_sink import _r2_endpoint, _sanitize_owner_id, _tenant_bucket, output_key, upload_bytes


class EndpointTests(unittest.TestCase):
    """The S3 host must honour R2_JURISDICTION — an EU bucket errors on
    the plain host, and .env.example defaults the jurisdiction to eu."""

    def test_no_account_returns_none(self):
        import os
        from unittest import mock
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(_r2_endpoint())

    def test_standard_bucket_plain_host(self):
        import os
        from unittest import mock
        with mock.patch.dict(os.environ, {"R2_ACCOUNT_ID": "acct123"}, clear=True):
            self.assertEqual(_r2_endpoint(), "https://acct123.r2.cloudflarestorage.com")

    def test_eu_jurisdiction_host(self):
        import os
        from unittest import mock
        env = {"R2_ACCOUNT_ID": "acct123", "R2_JURISDICTION": "eu"}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(_r2_endpoint(), "https://acct123.eu.r2.cloudflarestorage.com")

    def test_blank_jurisdiction_falls_back_to_plain(self):
        import os
        from unittest import mock
        env = {"R2_ACCOUNT_ID": "acct123", "R2_JURISDICTION": "  "}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(_r2_endpoint(), "https://acct123.r2.cloudflarestorage.com")


class SanitizeOwnerIdTests(unittest.TestCase):
    def test_none_and_empty_return_none(self) -> None:
        self.assertIsNone(_sanitize_owner_id(None))
        self.assertIsNone(_sanitize_owner_id(""))

    def test_valid_id_passes_through_unchanged(self) -> None:
        self.assertEqual(_sanitize_owner_id("user-abc_123"), "user-abc_123")

    def test_strips_path_separators_and_traversal(self) -> None:
        # No '/', '.', or other separators can ride through into a key —
        # this is what stops a hostile X-Ontold-Owner-Id header from
        # writing outside its own prefix.
        self.assertEqual(_sanitize_owner_id("../../etc/passwd"), "etcpasswd")
        self.assertEqual(_sanitize_owner_id("a/b\\c"), "abc")
        self.assertEqual(_sanitize_owner_id("a.b..c"), "abc")

    def test_strips_to_empty_returns_none(self) -> None:
        # An id that's ENTIRELY disallowed characters must fall back to
        # None (the unscoped layout), not an empty-but-truthy segment.
        self.assertIsNone(_sanitize_owner_id("../.."))
        self.assertIsNone(_sanitize_owner_id("////"))

    def test_truncates_to_64_chars(self) -> None:
        long_id = "a" * 200
        result = _sanitize_owner_id(long_id)
        self.assertEqual(len(result), 64)
        self.assertEqual(result, "a" * 64)


class OutputKeyTests(unittest.TestCase):
    def test_no_owner_id_omits_owner_segment(self) -> None:
        key = output_key("job123", "mp4")
        self.assertTrue(key.startswith("inference/"))
        self.assertNotIn("None", key)
        # Layout: inference/<yyyy-mm>/<jobId>/output.<ext> — no extra segment.
        parts = key.split("/")
        self.assertEqual(parts[0], "inference")
        self.assertEqual(parts[2], "job123")
        self.assertEqual(parts[3], "output.mp4")

    def test_owner_id_adds_a_segment_right_after_inference(self) -> None:
        key = output_key("job123", "mp4", owner_id="anon-abc123")
        parts = key.split("/")
        self.assertEqual(parts[0], "inference")
        self.assertEqual(parts[1], "anon-abc123")
        self.assertEqual(parts[3], "job123")
        self.assertEqual(parts[4], "output.mp4")

    def test_hostile_owner_id_cannot_inject_path_segments(self) -> None:
        key = output_key("job123", "mp4", owner_id="../../secrets")
        self.assertNotIn("..", key)
        # sanitizes to "secrets" — one clean segment, not a traversal.
        self.assertIn("secrets/", key)

    def test_owner_id_that_sanitizes_empty_falls_back_to_unscoped(self) -> None:
        scoped = output_key("job123", "mp4", owner_id="////")
        unscoped = output_key("job123", "mp4")
        self.assertEqual(scoped, unscoped)

    def test_extension_leading_dot_is_stripped(self) -> None:
        key = output_key("job123", ".png")
        self.assertTrue(key.endswith("output.png"))


class TenantBucketTests(unittest.TestCase):
    """Paid-tier dedicated-bucket override (founder, 2026-07-11: shared
    bucket free, separate buckets "an upgradable pathway (ie paid)").
    Pins: mapping hit → tenant bucket; miss/absent/invalid env → None
    (shared-bucket fallback); hostile owner ids can't dodge the map."""

    def test_no_env_returns_none(self) -> None:
        import os
        from unittest import mock

        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(_tenant_bucket("user-abc"))

    def test_mapping_hit_returns_dedicated_bucket(self) -> None:
        import os
        from unittest import mock

        env = {"R2_TENANT_BUCKETS": '{"user-abc": "ontold-t-abc"}'}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(_tenant_bucket("user-abc"), "ontold-t-abc")
            self.assertIsNone(_tenant_bucket("user-other"))

    def test_owner_is_sanitized_before_lookup(self) -> None:
        # A traversal-y owner id must be looked up by its SANITIZED
        # form — same identity the storage key uses — so an attacker
        # can't reach someone's dedicated bucket by decorating their id.
        import os
        from unittest import mock

        env = {"R2_TENANT_BUCKETS": '{"userabc": "ontold-t-abc"}'}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertEqual(_tenant_bucket("user.abc"), "ontold-t-abc")

    def test_invalid_json_and_shapes_fall_back_to_none(self) -> None:
        import os
        from unittest import mock

        for raw in ("{not json", '"a string"', '["list"]', '{"user-abc": 42}', '{"user-abc": ""}'):
            with mock.patch.dict(os.environ, {"R2_TENANT_BUCKETS": raw}, clear=True):
                self.assertIsNone(_tenant_bucket("user-abc"), raw)

    def test_none_owner_returns_none(self) -> None:
        import os
        from unittest import mock

        env = {"R2_TENANT_BUCKETS": '{"user-abc": "b"}'}
        with mock.patch.dict(os.environ, env, clear=True):
            self.assertIsNone(_tenant_bucket(None))
            self.assertIsNone(_tenant_bucket(""))


class UploadBytesKeyTests(unittest.TestCase):
    """upload_bytes composes its own key inline (not via output_key) —
    covered separately so a future refactor that unifies them doesn't
    silently drop this coverage."""

    def _configured_env(self):
        import os
        from unittest import mock

        return mock.patch.dict(
            os.environ,
            {
                "R2_ACCESS_KEY_ID": "ak",
                "R2_SECRET_ACCESS_KEY": "sk",
                "R2_BUCKET": "test-bucket",
                "R2_ACCOUNT_ID": "acct123",
            },
            clear=True,
        )

    def test_key_includes_sanitized_owner_segment(self) -> None:
        from unittest import mock

        with self._configured_env():
            with mock.patch("api._inference.r2_sink.sign_put_request") as sign:
                sign.return_value = ("https://x/test-bucket/k", {})
                with mock.patch("urllib.request.urlopen") as urlopen:
                    urlopen.return_value.__enter__.return_value.status = 200
                    result = upload_bytes(
                        job_id="job1",
                        body=b"data",
                        extension="jpg",
                        content_type="image/jpeg",
                        prefix="uploads",
                        owner_id="viewer-42",
                    )
        self.assertIn("uploads/viewer-42/", result["output_r2_key"])

    def test_tenant_mapping_routes_to_dedicated_bucket(self) -> None:
        import os
        from unittest import mock

        with self._configured_env():
            with mock.patch.dict(os.environ, {"R2_TENANT_BUCKETS": '{"viewer-42": "ontold-t-42"}'}, clear=False):
                with mock.patch("api._inference.r2_sink.sign_put_request") as sign:
                    sign.return_value = ("https://x/ontold-t-42/k", {})
                    with mock.patch("urllib.request.urlopen") as urlopen:
                        urlopen.return_value.__enter__.return_value.status = 200
                        result = upload_bytes(
                            job_id="job1",
                            body=b"data",
                            extension="jpg",
                            content_type="image/jpeg",
                            prefix="uploads",
                            owner_id="viewer-42",
                        )
        self.assertEqual(result["bucket"], "ontold-t-42")
        # The signed PUT itself must target the tenant bucket too, not
        # just the response metadata.
        self.assertEqual(sign.call_args.kwargs["bucket"], "ontold-t-42")

    def test_no_owner_id_key_matches_prior_unscoped_layout(self) -> None:
        from unittest import mock

        with self._configured_env():
            with mock.patch("api._inference.r2_sink.sign_put_request") as sign:
                sign.return_value = ("https://x/test-bucket/k", {})
                with mock.patch("urllib.request.urlopen") as urlopen:
                    urlopen.return_value.__enter__.return_value.status = 200
                    result = upload_bytes(
                        job_id="job1",
                        body=b"data",
                        extension="jpg",
                        content_type="image/jpeg",
                        prefix="uploads",
                    )
        key = result["output_r2_key"]
        self.assertTrue(key.startswith("uploads/"))
        # No owner segment: uploads/<yyyy-mm>/job1/upload.jpg — the second
        # path segment is the date stamp, not an owner id.
        ym_segment = key.split("/")[1]
        self.assertRegex(ym_segment, r"^\d{4}-\d{2}$")


if __name__ == "__main__":
    unittest.main()
