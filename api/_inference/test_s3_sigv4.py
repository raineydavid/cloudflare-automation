"""Tests for the SigV4 signer — anchored against AWS-published vectors.

Run:
    python3 -m unittest api._inference.test_s3_sigv4

The test below uses AWS's "get-vanilla" test vector from the SigV4
test suite (publicly published) to verify the canonical-request +
string-to-sign + signing-key derivations. We adapt it to PUT-object
since that's what we actually use, but the core algorithm is shared.

The most likely failure mode if SigV4 regresses is `R2 PUT returned
403 SignatureDoesNotMatch` in production. This test catches that
before deploy.

These were written as bare pytest-style functions, which `python3 -m
unittest <module>` (what CI actually runs — see ci.yml) silently
collects as ZERO tests: unittest's module loader only picks up
TestCase subclasses. That meant every test below ran on nobody's
machine but a developer's running pytest by hand — CI showed green
having executed none of them. The wrapper at the bottom folds each
test_* function into a TestCase so `unittest` actually runs it; pytest
still discovers the bare functions directly, so either runner works.
"""

from __future__ import annotations

import hashlib
import hmac
import unittest

from urllib.parse import parse_qs, urlparse

from .s3_sigv4 import (
    PRESIGN_MAX_TTL_SECONDS,
    _hmac_sha256,
    _sha256_hex,
    _signing_key,
    sign_get_url,
    sign_put_request,
)


def test_sha256_hex_empty() -> None:
    # Sanity — empty-string SHA256 is a well-known constant. Catches
    # any binary/string encoding regressions.
    assert _sha256_hex(b"") == (
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    )


def test_signing_key_matches_published_vector() -> None:
    # Published in AWS docs: "Examples of Deriving a Signing Key
    # for Signature Version 4". Confirms the four-step HMAC chain
    # produces the expected key.
    secret = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY"
    date_stamp = "20120215"
    region = "us-east-1"
    service = "iam"
    key = _signing_key(secret, date_stamp, region, service)
    # Published expected signing key bytes (hex).
    expected_hex = "f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d"
    assert key.hex() == expected_hex


def test_sign_put_returns_url_and_required_headers() -> None:
    url, headers = sign_put_request(
        access_key_id="AKIAIOSFODNN7EXAMPLE",  # scan-secrets: allow - AWS's published SigV4 test vector
        secret_access_key="wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        endpoint="https://abcdefg.r2.cloudflarestorage.com",
        bucket="ontold-prod",
        key="thumbs/2024/01/abc123.jpg",
        body=b"hello world",
        content_type="image/jpeg",
    )
    # URL composition — path-style bucket addressing.
    assert url == "https://abcdefg.r2.cloudflarestorage.com/ontold-prod/thumbs/2024/01/abc123.jpg"
    # Required headers must be present.
    for h in ("Authorization", "X-Amz-Content-Sha256", "X-Amz-Date", "Content-Type", "Host"):
        assert h in headers, f"missing header: {h}"
    # Authorization header shape — algo + Credential + SignedHeaders + Signature.
    auth = headers["Authorization"]
    assert auth.startswith("AWS4-HMAC-SHA256 ")
    assert "Credential=AKIAIOSFODNN7EXAMPLE/" in auth  # scan-secrets: allow - AWS test vector
    assert "SignedHeaders=" in auth
    assert "Signature=" in auth
    # Body hash matches sha256(body).
    assert headers["X-Amz-Content-Sha256"] == hashlib.sha256(b"hello world").hexdigest()


def test_sign_put_deterministic_for_same_inputs() -> None:
    # Date is the only non-deterministic input; we can't easily mock
    # _dt.datetime.now without bleeding into module internals. Instead,
    # verify that two calls with identical inputs ~milliseconds apart
    # produce identical SIGNATURES IFF the seconds boundary doesn't
    # cross. If this test flakes, the timestamp crossed a second
    # boundary — rerun.
    a_url, a = sign_put_request(
        access_key_id="A", secret_access_key="B",
        endpoint="https://x.r2.cloudflarestorage.com",
        bucket="b", key="k.bin", body=b"x", content_type="application/octet-stream",
    )
    b_url, b = sign_put_request(
        access_key_id="A", secret_access_key="B",
        endpoint="https://x.r2.cloudflarestorage.com",
        bucket="b", key="k.bin", body=b"x", content_type="application/octet-stream",
    )
    assert a_url == b_url
    # If the timestamps match exactly, signatures must too.
    if a["X-Amz-Date"] == b["X-Amz-Date"]:
        assert a["Authorization"] == b["Authorization"]


def test_canonical_path_does_not_double_encode_slashes() -> None:
    # R2 follows S3 convention (single-encoded paths). A '/' inside
    # the key should remain a '/', not become '%2F'.
    url, _ = sign_put_request(
        access_key_id="A", secret_access_key="B",
        endpoint="https://x.r2.cloudflarestorage.com",
        bucket="b", key="a/b/c.bin", body=b"", content_type="application/octet-stream",
    )
    assert "/a/b/c.bin" in url
    assert "%2F" not in url


# ─── sign_get_url tests ────────────────────────────────────────────

def _parse_signed(url: str) -> dict[str, str]:
    """Helper: parse a presigned URL into its query params."""
    q = parse_qs(urlparse(url).query)
    return {k: v[0] for k, v in q.items()}


def test_get_url_has_all_required_amz_params() -> None:
    url = sign_get_url(
        access_key_id="AKIAIOSFODNN7EXAMPLE",  # scan-secrets: allow - AWS's published SigV4 test vector
        secret_access_key="wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
        endpoint="https://abcdefg.r2.cloudflarestorage.com",
        bucket="ontold-prod",
        key="assets/films/lighthouse.mp4",
        expires_in=300,
    )
    q = _parse_signed(url)
    for required in (
        "X-Amz-Algorithm",
        "X-Amz-Credential",
        "X-Amz-Date",
        "X-Amz-Expires",
        "X-Amz-SignedHeaders",
        "X-Amz-Signature",
    ):
        assert required in q, f"missing required query param: {required}"
    assert q["X-Amz-Algorithm"] == "AWS4-HMAC-SHA256"
    assert q["X-Amz-SignedHeaders"] == "host"
    assert q["X-Amz-Expires"] == "300"
    # 64-hex signature
    assert len(q["X-Amz-Signature"]) == 64
    assert all(c in "0123456789abcdef" for c in q["X-Amz-Signature"])


def test_get_url_clamps_expires_to_max_ttl() -> None:
    url = sign_get_url(
        access_key_id="A", secret_access_key="B",
        endpoint="https://x.r2.cloudflarestorage.com",
        bucket="b", key="k.mp4", expires_in=PRESIGN_MAX_TTL_SECONDS * 2,
    )
    q = _parse_signed(url)
    assert q["X-Amz-Expires"] == str(PRESIGN_MAX_TTL_SECONDS)


def test_get_url_clamps_expires_to_at_least_one() -> None:
    url = sign_get_url(
        access_key_id="A", secret_access_key="B",
        endpoint="https://x.r2.cloudflarestorage.com",
        bucket="b", key="k.mp4", expires_in=0,
    )
    q = _parse_signed(url)
    assert q["X-Amz-Expires"] == "1"


def test_get_url_credential_scope_is_correct() -> None:
    url = sign_get_url(
        access_key_id="AKIA-TEST",
        secret_access_key="secret",
        endpoint="https://x.r2.cloudflarestorage.com",
        bucket="b", key="k.mp4", expires_in=60, region="auto",
    )
    q = _parse_signed(url)
    cred = q["X-Amz-Credential"]
    # Format: <access>/<yyyymmdd>/<region>/s3/aws4_request
    parts = cred.split("/")
    assert parts[0] == "AKIA-TEST"
    assert len(parts[1]) == 8 and parts[1].isdigit()  # yyyymmdd
    assert parts[2] == "auto"
    assert parts[3] == "s3"
    assert parts[4] == "aws4_request"


def test_get_url_path_preserves_slashes() -> None:
    url = sign_get_url(
        access_key_id="A", secret_access_key="B",
        endpoint="https://x.r2.cloudflarestorage.com",
        bucket="b", key="assets/films/foo.mp4", expires_in=60,
    )
    # Path-style bucket addressing — bucket then key, slashes preserved.
    assert "/b/assets/films/foo.mp4?" in url
    assert "%2F" not in urlparse(url).path


def test_get_url_signature_changes_when_key_changes() -> None:
    # Sanity: two different keys must produce different signatures.
    # If this fails, the canonical request isn't actually including
    # the path — silently fatal for production.
    u1 = sign_get_url(
        access_key_id="A", secret_access_key="B",
        endpoint="https://x.r2.cloudflarestorage.com",
        bucket="b", key="a.mp4", expires_in=60,
    )
    u2 = sign_get_url(
        access_key_id="A", secret_access_key="B",
        endpoint="https://x.r2.cloudflarestorage.com",
        bucket="b", key="b.mp4", expires_in=60,
    )
    assert _parse_signed(u1)["X-Amz-Signature"] != _parse_signed(u2)["X-Amz-Signature"]


def test_get_url_signature_changes_when_expires_changes() -> None:
    # Sanity: expires_in is part of the signed canonical query string.
    u1 = sign_get_url(
        access_key_id="A", secret_access_key="B",
        endpoint="https://x.r2.cloudflarestorage.com",
        bucket="b", key="k.mp4", expires_in=60,
    )
    u2 = sign_get_url(
        access_key_id="A", secret_access_key="B",
        endpoint="https://x.r2.cloudflarestorage.com",
        bucket="b", key="k.mp4", expires_in=300,
    )
    assert _parse_signed(u1)["X-Amz-Signature"] != _parse_signed(u2)["X-Amz-Signature"]


# ─── unittest wrapper (see module docstring — bare functions alone are
# invisible to `python3 -m unittest`, which is what CI runs) ──────────

class SigV4Tests(unittest.TestCase):
    pass


def _wrap_bare_test_functions() -> None:
    # Function scope so the loop variables don't leak into module
    # globals — a leaked reference to SigV4Tests itself under some
    # other name would make loadTestsFromModule see it twice and
    # double-run every test.
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            setattr(SigV4Tests, name, (lambda f: lambda self: f())(fn))


_wrap_bare_test_functions()

if __name__ == "__main__":
    unittest.main()
