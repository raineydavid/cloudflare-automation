"""S3 SigV4 signer — stdlib only, no boto/botocore.

Why hand-roll SigV4:
  - Vercel Python functions share a 500MB Lambda limit across the
    requirements.txt, which is currently runwayml-only. Adding boto3
    would bloat every function (~50MB).
  - botocore alone is smaller but still ~30MB and pulls dateutil.
  - SigV4 itself is well-specified and the PUT-Object subset we need
    is ~120 lines of hashlib + hmac. Worth the maintenance cost to
    keep the bundle minimal.

Scope: signs PUT requests to an S3-compatible endpoint (Cloudflare R2
in our case). GET / DELETE / multipart can be added when needed —
keep this file narrow until then.

Reference: https://docs.aws.amazon.com/general/latest/gr/sigv4_signing.html
"""

from __future__ import annotations

import datetime as _dt
import hashlib
import hmac
from urllib.parse import quote


# R2's "auto" region — accepted by all R2 endpoints regardless of
# where the bucket actually lives. Don't change this without testing
# against the specific bucket's jurisdiction.
DEFAULT_REGION = "auto"
SERVICE = "s3"
ALGORITHM = "AWS4-HMAC-SHA256"


def _sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _hmac_sha256(key: bytes, msg: str) -> bytes:
    return hmac.new(key, msg.encode("utf-8"), hashlib.sha256).digest()


def _signing_key(secret: str, date_stamp: str, region: str, service: str) -> bytes:
    """Derive the per-request signing key. Re-derived per call rather
    than cached because we don't expect high enough QPS from a Vercel
    function to make caching worthwhile."""
    k_date    = _hmac_sha256(("AWS4" + secret).encode("utf-8"), date_stamp)
    k_region  = _hmac_sha256(k_date,    region)
    k_service = _hmac_sha256(k_region,  service)
    k_signing = _hmac_sha256(k_service, "aws4_request")
    return k_signing


def _canonical_uri(path: str) -> str:
    """Percent-encode the path per the AWS spec: each path segment
    gets URL-encoded, but '/' itself is NOT encoded. Leading slash
    is required."""
    if not path.startswith("/"):
        path = "/" + path
    # quote() with safe='/' preserves separators; everything else
    # gets encoded. The AWS spec actually requires DOUBLE-encoding
    # for sigv4 except for S3, which uses single encoding. R2
    # follows the S3 convention here.
    return quote(path, safe="/~")


def sign_put_request(
    *,
    access_key_id: str,
    secret_access_key: str,
    endpoint: str,           # e.g. https://<accountId>.r2.cloudflarestorage.com
    bucket: str,
    key: str,                # bucket-relative, no leading slash
    body: bytes,
    content_type: str,
    region: str = DEFAULT_REGION,
    extra_headers: dict[str, str] | None = None,
) -> tuple[str, dict[str, str]]:
    """Build the signed PUT URL + headers for the given object.

    Returns:
        (url, headers) — pass to urllib.request.Request(url, data=body,
        method='PUT', headers=headers). Caller is responsible for the
        actual HTTP call so this function stays pure + testable.
    """
    # ---------------------------------------------------------------
    # 1. Build the canonical request
    # ---------------------------------------------------------------
    host = endpoint.replace("https://", "").replace("http://", "")
    # Path-style addressing — required for R2 with custom endpoints.
    canonical_path = _canonical_uri(f"/{bucket}/{key}")
    url = f"{endpoint.rstrip('/')}/{bucket}/{quote(key, safe='/~')}"

    now = _dt.datetime.now(_dt.UTC)
    amz_date    = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp  = now.strftime("%Y%m%d")
    body_hash   = _sha256_hex(body)

    # Required signed headers in alphabetical order. Lower-cased
    # names; trimmed values.
    headers_to_sign: dict[str, str] = {
        "host":                 host,
        "content-type":         content_type,
        "x-amz-content-sha256": body_hash,
        "x-amz-date":           amz_date,
    }
    if extra_headers:
        for k, v in extra_headers.items():
            headers_to_sign[k.lower()] = str(v).strip()

    sorted_header_names = sorted(headers_to_sign.keys())
    canonical_headers = "".join(
        f"{name}:{headers_to_sign[name]}\n" for name in sorted_header_names
    )
    signed_headers = ";".join(sorted_header_names)

    canonical_request = "\n".join([
        "PUT",
        canonical_path,
        "",                  # no query string for PUT object
        canonical_headers,
        signed_headers,
        body_hash,
    ])

    # ---------------------------------------------------------------
    # 2. Build the string-to-sign + signature
    # ---------------------------------------------------------------
    credential_scope = f"{date_stamp}/{region}/{SERVICE}/aws4_request"
    string_to_sign = "\n".join([
        ALGORITHM,
        amz_date,
        credential_scope,
        _sha256_hex(canonical_request.encode("utf-8")),
    ])

    signing_key = _signing_key(secret_access_key, date_stamp, region, SERVICE)
    signature = hmac.new(
        signing_key,
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    # ---------------------------------------------------------------
    # 3. Compose the Authorization header
    # ---------------------------------------------------------------
    authorization = (
        f"{ALGORITHM} "
        f"Credential={access_key_id}/{credential_scope}, "
        f"SignedHeaders={signed_headers}, "
        f"Signature={signature}"
    )

    # The headers dict we return uses canonical-case names so urllib
    # passes them through cleanly. Authorization is added last so it
    # doesn't appear in the signed-headers list (it can't sign itself).
    out_headers = {
        "Host":                 host,
        "Content-Type":         content_type,
        "Content-Length":       str(len(body)),
        "X-Amz-Content-Sha256": body_hash,
        "X-Amz-Date":           amz_date,
        "Authorization":        authorization,
    }
    if extra_headers:
        for k, v in extra_headers.items():
            # Don't overwrite the signed canonical headers — extras
            # were already mixed into the signature above.
            if k.lower() not in {"host", "content-type", "x-amz-content-sha256", "x-amz-date"}:
                out_headers[k] = str(v)

    return url, out_headers


# ---------------------------------------------------------------------
# Pre-signed GET URLs (query-string SigV4)
# ---------------------------------------------------------------------
#
# Different signing flavour from PUT above: instead of putting the
# auth in the Authorization header, the auth lives entirely in the
# query string. Browsers can follow a 302 to one of these without
# needing custom request headers — which is exactly what we want for
# the /api/watch indirection endpoint (302 → pre-signed R2 URL → the
# user-agent fetches the video directly).
#
# Canonical-request differences vs the header-signed PUT:
#   - method = "GET" (or HEAD)
#   - canonical query string includes every X-Amz-* param EXCEPT
#     X-Amz-Signature itself, sorted lexicographically
#   - SignedHeaders = "host" only — that's all that gets signed
#   - HashedPayload literal = "UNSIGNED-PAYLOAD" (S3 convention for
#     pre-signed URLs; the body isn't part of the URL so it can't be
#     hashed in advance).
#
# TTL is bounded: AWS / R2 SigV4 caps presigned-URL lifetime at 7
# days (604800 seconds). Beyond that, R2 will reject the URL.


PRESIGN_MAX_TTL_SECONDS = 604800  # 7 days — AWS / R2 hard cap


def sign_get_url(
    *,
    access_key_id: str,
    secret_access_key: str,
    endpoint: str,
    bucket: str,
    key: str,
    expires_in: int,
    region: str = DEFAULT_REGION,
    extra_query: dict[str, str] | None = None,
) -> str:
    """Build a pre-signed GET URL for the given object.

    Args:
        expires_in: seconds the URL is valid for. Clamped to
            [1, PRESIGN_MAX_TTL_SECONDS]. Pick the smallest value
            that comfortably exceeds your playback session — for
            streaming, 5min is usually enough; the browser caches
            the URL across seek operations.
        extra_query: extra query params to include in the signed URL.
            Most commonly used for response-content-disposition
            overrides. Keys MUST be x-amz-* or response-* per S3 spec.

    Returns:
        A complete URL including the signature. Hand straight to a
        302 Location header or an <video src> attribute.
    """
    if expires_in < 1:
        expires_in = 1
    if expires_in > PRESIGN_MAX_TTL_SECONDS:
        expires_in = PRESIGN_MAX_TTL_SECONDS

    host = endpoint.replace("https://", "").replace("http://", "")
    canonical_path = _canonical_uri(f"/{bucket}/{key}")

    now = _dt.datetime.now(_dt.UTC)
    amz_date   = now.strftime("%Y%m%dT%H%M%SZ")
    date_stamp = now.strftime("%Y%m%d")
    credential_scope = f"{date_stamp}/{region}/{SERVICE}/aws4_request"

    # The query params that BECOME the auth. Order doesn't matter at
    # this point — we sort alphabetically when building the canonical
    # query string below.
    qs: dict[str, str] = {
        "X-Amz-Algorithm":     ALGORITHM,
        "X-Amz-Credential":    f"{access_key_id}/{credential_scope}",
        "X-Amz-Date":          amz_date,
        "X-Amz-Expires":       str(expires_in),
        "X-Amz-SignedHeaders": "host",
    }
    if extra_query:
        for k, v in extra_query.items():
            qs[k] = str(v)

    # Canonical query string: sorted by key, each pair URL-encoded
    # individually with quote(safe=''). Pairs joined by '&'.
    canonical_qs = "&".join(
        f"{quote(k, safe='~')}={quote(qs[k], safe='~')}"
        for k in sorted(qs.keys())
    )

    canonical_headers = f"host:{host}\n"
    signed_headers = "host"

    canonical_request = "\n".join([
        "GET",
        canonical_path,
        canonical_qs,
        canonical_headers,
        signed_headers,
        "UNSIGNED-PAYLOAD",
    ])

    string_to_sign = "\n".join([
        ALGORITHM,
        amz_date,
        credential_scope,
        _sha256_hex(canonical_request.encode("utf-8")),
    ])
    signing_key = _signing_key(secret_access_key, date_stamp, region, SERVICE)
    signature = hmac.new(
        signing_key,
        string_to_sign.encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()

    # Final URL = endpoint + path + signed qs + &X-Amz-Signature=...
    return (
        f"{endpoint.rstrip('/')}/{bucket}/{quote(key, safe='/~')}"
        f"?{canonical_qs}&X-Amz-Signature={signature}"
    )
