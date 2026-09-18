"""Public-derivative lane — the guards that keep the split honest.

The public bucket is world-readable, so everything that lands there
must be (a) watermarked and (b) actually headed at a *-public bucket.
These tests pin both refusals firing BEFORE any network call, plus the
immutable content-addressed key shape that makes public versioning
safe under edge/unfurler caching.
"""

import os
import unittest
from unittest import mock

from api._inference.r2_sink import (
    _public_bucket,
    public_derivative_key,
    upload_public_derivative,
)


class PublicBucketTests(unittest.TestCase):
    def test_default_and_override(self):
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(_public_bucket(), "ontold-public")
        with mock.patch.dict(os.environ, {"R2_PUBLIC_BUCKET": "ontold-public-eu"}):
            self.assertEqual(_public_bucket(), "ontold-public-eu")


class PublicKeyTests(unittest.TestCase):
    def test_key_is_content_addressed_and_sanitized(self):
        key = public_derivative_key("Item/..\\42", "a" * 64, "Card", "JPG")
        self.assertTrue(key.startswith("public/"))
        self.assertIn("/aaaaaaaa/", key)          # digest8 segment
        self.assertTrue(key.endswith("card.JPG"))
        self.assertNotIn("..", key)               # traversal stripped

    def test_new_bytes_mean_new_key(self):
        a = public_derivative_key("sc-x", "1" * 64, "card", "jpg")
        b = public_derivative_key("sc-x", "2" * 64, "card", "jpg")
        self.assertNotEqual(a, b)                 # version = new key, never overwrite


class UploadGuardTests(unittest.TestCase):
    def test_refuses_unwatermarked(self):
        with self.assertRaises(ValueError):
            upload_public_derivative(
                content_id="sc-x", body=b"px", content_type="image/jpeg",
            )  # watermarked defaults False → refuse

    def test_refuses_non_public_bucket(self):
        with mock.patch.dict(os.environ, {"R2_PUBLIC_BUCKET": "ontold-projects-prod"}):
            with self.assertRaises(ValueError):
                upload_public_derivative(
                    content_id="sc-x", body=b"px", content_type="image/jpeg",
                    watermarked=True,
                )


if __name__ == "__main__":
    unittest.main()
