"""R2-canonical output sink for inference outputs.

Every provider call goes through this sink so the canonical URL the
SPA ever sees is an R2 URL, never a provider URL. Reasons:
  - Provider URLs expire (Runware: 24h, Runway: variable).
  - We want one CDN to serve all outputs (consistent egress cost,
    consistent caching behaviour, single audit trail).
  - Switching providers later doesn't break existing URLs in the
    audit trail / user library.

Pattern is the same as the import.yml / onboard.yml workflows already
use for committing back to public/imports/<runId>/: aws-cli against the
R2 S3 endpoint, or boto3 when running inside a Vercel function. This
module abstracts the choice.

Stub today — concrete impl lands when the first gateway call needs to
upload (probably image-gen via Runware, as the first migration off the
existing third-party-direct call sites).
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
import urllib.error
import urllib.request

from .s3_sigv4 import sign_get_url, sign_put_request


def _account_id() -> str | None:
    """The Cloudflare account id, extracted rather than trusted: the id
    is exactly 32 hex chars, but the env slot holds whatever a human
    pasted — 2026-07-17 it was a 33-char value (id + one stray char)
    that made every endpoint invalid. Pull the first 32-hex token out
    of the raw value (works even for a pasted dashboard URL); if none
    exists, fall back to the stripped raw so the failure stays visible
    downstream instead of turning into a silent None."""
    raw = os.environ.get("R2_ACCOUNT_ID") or os.environ.get("CLOUDFLARE_ACCOUNT_ID")
    if not raw:
        return None
    m = re.search(r"[0-9a-fA-F]{32}", raw)
    return m.group(0).lower() if m else raw.strip()


def _r2_endpoint() -> str | None:
    account_id = _account_id()
    if not account_id:
        return None
    # Jurisdiction-restricted buckets (EU / FedRAMP) MUST use a
    # jurisdiction-specific S3 host — <account>.<jur>.r2... — and error
    # on the plain host. Standard buckets use <account>.r2... (blank
    # jurisdiction). R2_JURISDICTION mirrors the slot in .env.example,
    # which defaults to 'eu'; without honouring it here an EU bucket
    # would fail every signed request.
    jur = (os.environ.get("R2_JURISDICTION") or "").strip().lower()
    host = f"{account_id}.{jur}.r2.cloudflarestorage.com" if jur else f"{account_id}.r2.cloudflarestorage.com"
    return f"https://{host}"


def _r2_public_base() -> str | None:
    return (
        os.environ.get("R2_PUBLIC_BASE")
        or os.environ.get("CLOUDFLARE_R2_PUBLIC_URL")
    )


def _sanitize_owner_id(raw: str | None) -> str | None:
    """Owner id for the R2 key path — client-supplied (X-Ontold-Owner-Id,
    services/auth.ts's effectiveId()), so it must be sanitized before it
    becomes part of a storage key: only [a-zA-Z0-9_-], truncated, no
    path separators or traversal sequences possible. Anything that
    sanitizes to empty returns None (→ the unscoped key layout).

    This is groundwork, not a security boundary yet — there's no real
    per-user auth system (services/auth.ts is an explicit dev-stub,
    localStorage-only identity), so a client can send any owner id it
    likes. What this buys today: organized, collision-free keys per
    browser identity, ready for a real entitlement check on the read
    side (api/watch.py's _user_allowed(), currently a stub) once
    accounts exist — not an access-control guarantee now."""
    if not raw:
        return None
    cleaned = "".join(c for c in raw if c.isalnum() or c in "_-")[:64]
    return cleaned or None


def _tenant_bucket(owner_id: str | None) -> str | None:
    """Paid-tier dedicated-bucket override (founder, 2026-07-11: one
    shared bucket for everyone by default, separate buckets as "an
    upgradable pathway (ie paid) rather than just free").

    R2_TENANT_BUCKETS is a JSON object mapping sanitized owner ids to
    dedicated bucket names, e.g. {"user-abc123": "ontold-t-abc123"}.
    Upgrading a tenant is an env edit + redeploy — no code change. The
    dedicated bucket must live in the same Cloudflare account and be
    covered by the same API token as the shared one (one credential
    set, many buckets). Objects written before the upgrade stay in the
    shared bucket; only new writes land in the tenant's own.

    Absent env, invalid JSON, or no entry for this owner → None, and
    the caller falls back to the shared R2_BUCKET."""
    owner = _sanitize_owner_id(owner_id)
    if not owner:
        return None
    raw = os.environ.get("R2_TENANT_BUCKETS", "")
    if not raw:
        return None
    try:
        mapping = json.loads(raw)
    except ValueError:
        # Operator typo shouldn't take the whole storage lane down —
        # log and serve everyone from the shared bucket.
        print("[r2_sink] R2_TENANT_BUCKETS is not valid JSON; ignoring", flush=True)
        return None
    if not isinstance(mapping, dict):
        return None
    bucket = mapping.get(owner)
    return bucket if isinstance(bucket, str) and bucket else None


def output_key(job_id: str, extension: str, owner_id: str | None = None) -> str:
    """Canonical R2 object key for an inference job's output.

    Layout: inference/[<owner>/]<yyyy-mm>/<jobId>/output.<ext>
    Date prefix keeps cold-storage browsing tractable. Owner segment
    (see _sanitize_owner_id) groups a browser identity's own outputs
    together; omitted entirely when no owner_id is supplied, so
    existing keys/callers are unaffected.
    """
    ym = time.strftime("%Y-%m", time.gmtime())
    owner = _sanitize_owner_id(owner_id)
    owner_seg = f"{owner}/" if owner else ""
    return f"inference/{owner_seg}{ym}/{job_id}/output.{extension.lstrip('.')}"


def _r2_credentials() -> tuple[str | None, str | None, str | None]:
    """Read R2 credentials with the same fallback chain the workflows
    use (R2_* primary, CLOUDFLARE_* legacy, AWS_* for aws-cli compat).
    Returns (access_key_id, secret_access_key, bucket)."""
    access_key = (
        os.environ.get("R2_ACCESS_KEY_ID")
        or os.environ.get("CLOUDFLARE_R2_ACCESS_KEY_ID")
        or os.environ.get("AWS_ACCESS_KEY_ID")
    )
    secret = (
        os.environ.get("R2_SECRET_ACCESS_KEY")
        or os.environ.get("CLOUDFLARE_R2_SECRET_ACCESS_KEY")
        or os.environ.get("AWS_SECRET_ACCESS_KEY")
    )
    bucket = (
        os.environ.get("R2_BUCKET")
        or os.environ.get("CLOUDFLARE_R2_BUCKET")
    )
    return access_key, secret, bucket


class R2NotConfigured(RuntimeError):
    """Raised when one or more required R2 env vars are missing.
    Callers should let this propagate so the API endpoint can return a
    503 with a clear message instead of silently no-op'ing."""


def is_configured() -> bool:
    """Quick check used by API endpoints to decide whether R2 is wired
    up at all. Useful for /api/health-style introspection."""
    access_key, secret, bucket = _r2_credentials()
    return bool(access_key and secret and bucket and _r2_endpoint())


def _public_url(bucket: str, key: str) -> str:
    """Compose the public-read URL for an uploaded object.

    Two cases:
      1. R2_PUBLIC_BASE is set → use it directly (custom domain or
         public.r2.dev URL configured for the bucket). Most common.
      2. R2_PUBLIC_BASE is unset → fall back to a constructed
         pub-<account>.r2.dev URL. NOT guaranteed to work unless the
         bucket has public access enabled in the R2 dashboard.
    """
    base = _r2_public_base()
    if base:
        return f"{base.rstrip('/')}/{key.lstrip('/')}"
    # Fallback — bucket needs public-access enabled for this to work.
    return f"https://pub-{bucket}.r2.dev/{key.lstrip('/')}"


def _public_bucket() -> str:
    """The public-derivatives bucket. Env-overridable so an EU lane
    (ontold-public-eu, provisioned with jurisdiction=eu) or a rename is
    config, not code. MUST end in '-public' — upload_public_derivative
    enforces that as a structural guard."""
    return os.environ.get("R2_PUBLIC_BUCKET", "ontold-public")


def public_derivative_key(content_id: str, digest: str, kind: str, extension: str) -> str:
    """Immutable, content-addressed key for a PUBLIC derivative.

    Layout: public/<contentId>/<digest8>/<kind>.<ext>

    Versioning-by-immutability: public objects are edge-cached and
    unfurler-cached (Slack/X fetch once and keep it), so overwriting a
    key is a footgun. A new version of a share card = new bytes = new
    digest = NEW key; the app manifest just points at the latest. Remix
    branches are new content ids, so they land under their own prefix
    naturally. Old versions can be lifecycle-expired later — nothing
    references them once the pointer moves."""
    cid = _sanitize_owner_id(content_id) or "item"
    k = (kind or "card").strip().lower()
    return f"public/{cid}/{digest[:8]}/{k}.{extension.lstrip('.')}"


def upload_public_derivative(
    *,
    content_id: str,
    body: bytes,
    content_type: str,
    kind: str = "card",
    extension: str = "jpg",
    watermarked: bool = False,
) -> dict:
    """Upload a WATERMARKED derivative (share card / low-res thumb) to
    the public bucket. This is the ONLY code path that writes anything
    public, and it refuses two ways:

      1. watermarked must be explicitly True — the caller asserts the
         pixels carry the ontold mark (utils/watermark.ts applies it
         client-side; a server pipeline must do equivalent). Public
         means scrapeable; scrapeable means it markets us or it leaks.
      2. the target bucket must end in '-public' — so a misconfigured
         R2_PUBLIC_BUCKET can never silently route derivatives into the
         private projects bucket (or vice versa: this function can
         never be pointed at a bucket that watch.py treats as gated).

    Originals NEVER come through here — they go to output_key() in the
    private bucket and are served via short-TTL signed URLs (watch.py).
    """
    if not watermarked:
        raise ValueError("public derivatives must be watermarked (pass watermarked=True after applying the mark)")
    bucket = _public_bucket()
    if not bucket.endswith("-public"):
        raise ValueError(f"refusing public upload to non-public bucket '{bucket}'")
    access_key, secret, _ = _r2_credentials()
    endpoint = _r2_endpoint()
    if not (access_key and secret and endpoint):
        raise R2NotConfigured("R2 not configured for upload_public_derivative")

    digest = hashlib.sha256(body).hexdigest()
    key = public_derivative_key(content_id, digest, kind, extension)
    url, headers = sign_put_request(
        access_key_id=access_key,
        secret_access_key=secret,
        endpoint=endpoint,
        bucket=bucket,
        key=key,
        body=body,
        content_type=content_type,
    )
    put_req = urllib.request.Request(url, data=body, method="PUT", headers=headers)
    with urllib.request.urlopen(put_req, timeout=30) as resp:
        if resp.status not in (200, 201):
            raise RuntimeError(f"R2 public PUT returned {resp.status}")

    return {
        "public_r2_key": key,
        "public_url":    _public_url(bucket, key),
        "bucket":        bucket,
        "size_bytes":    len(body),
        "digest":        digest,
    }


def fetch_and_upload(
    *,
    job_id: str,
    source_url: str,
    extension: str,
    content_type: str,
    max_retries: int = 3,
    owner_id: str | None = None,
) -> dict:
    """Fetch from a provider URL and re-upload to R2.

    Returns a dict shaped for the SPA's expectations:
        {
            "output_r2_key":      "<bucket-relative key>",
            "output_url":         "<public R2 URL>",
            "bucket":             "<R2 bucket name>",
            "source_provider_url": "<original URL the provider gave us>",
            "size_bytes":         <int>,
        }

    Raises:
        R2NotConfigured if credentials/bucket env vars aren't set.
        urllib.error.URLError on persistent network failure (after retries).
        RuntimeError on R2 PUT failure (non-2xx response).
    """
    access_key, secret, bucket = _r2_credentials()
    endpoint = _r2_endpoint()
    if not (access_key and secret and bucket and endpoint):
        raise R2NotConfigured(
            "R2 not configured. Need R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, "
            "R2_BUCKET, R2_ACCOUNT_ID (or their CLOUDFLARE_* equivalents)."
        )
    # Paid tenants write to their own dedicated bucket (same account,
    # same credentials); everyone else shares R2_BUCKET.
    bucket = _tenant_bucket(owner_id) or bucket

    # ---- 1. Fetch the provider URL with retries --------------------
    body: bytes | None = None
    last_err: Exception | None = None
    for attempt in range(max_retries):
        try:
            req = urllib.request.Request(source_url, headers={
                # Some providers reject default Python UA.
                "User-Agent": "ontold-r2-sink/1.0",
            })
            with urllib.request.urlopen(req, timeout=30) as resp:
                if resp.status != 200:
                    raise RuntimeError(f"source fetch returned {resp.status}")
                body = resp.read()
            break
        except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError) as e:
            last_err = e
            # Exponential backoff — provider URLs (Runway / Runware) are
            # occasionally flaky in the first second after creation.
            time.sleep(0.5 * (2 ** attempt))
    if body is None:
        raise (last_err or RuntimeError("fetch failed with no error"))

    # ---- 2. Upload to R2 via signed PUT ----------------------------
    key = output_key(job_id, extension, owner_id=owner_id)
    url, headers = sign_put_request(
        access_key_id=access_key,
        secret_access_key=secret,
        endpoint=endpoint,
        bucket=bucket,
        key=key,
        body=body,
        content_type=content_type,
    )
    put_req = urllib.request.Request(url, data=body, method="PUT", headers=headers)
    try:
        with urllib.request.urlopen(put_req, timeout=60) as put_resp:
            if put_resp.status not in (200, 201):
                raise RuntimeError(f"R2 PUT returned {put_resp.status}")
    except urllib.error.HTTPError as e:
        # Surface the body so SigV4 / permission issues are diagnosable
        # from the function logs — these are the most common failure
        # mode during setup.
        detail = e.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"R2 PUT {e.code}: {detail}") from e

    return {
        "output_r2_key":       key,
        "output_url":          _public_url(bucket, key),
        "bucket":              bucket,
        "source_provider_url": source_url,
        "size_bytes":          len(body),
    }


def inline_archive(*, job_id: str, payload: dict) -> dict:
    """Archive a small structured result as JSON in R2 for audit.

    Used by text-gen / structured-output / embedding capabilities where
    the result is a dict that fits in the response body. The SPA still
    reads from InferenceResult.inlineResult; this writes the same
    payload to R2 so we have a permanent record independent of any
    database we choose later.
    """
    access_key, secret, bucket = _r2_credentials()
    endpoint = _r2_endpoint()
    if not (access_key and secret and bucket and endpoint):
        raise R2NotConfigured("R2 not configured for inline_archive")

    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    key = output_key(job_id, "json")
    url, headers = sign_put_request(
        access_key_id=access_key,
        secret_access_key=secret,
        endpoint=endpoint,
        bucket=bucket,
        key=key,
        body=body,
        content_type="application/json",
    )
    put_req = urllib.request.Request(url, data=body, method="PUT", headers=headers)
    with urllib.request.urlopen(put_req, timeout=15) as resp:
        if resp.status not in (200, 201):
            raise RuntimeError(f"R2 inline_archive PUT returned {resp.status}")

    return {
        "archive_r2_key": key,
        "archive_url":    _public_url(bucket, key),
        "bucket":         bucket,
        "size_bytes":     len(body),
    }


MARKING_HEADER = "x-amz-meta-ai-marking"


def _marking_header(provenance: dict | None) -> dict[str, str]:
    """The Article 50 assertion as signed object metadata, or nothing.

    Returns {} when there is no provenance record, which is the honest
    answer for bytes a person uploaded: marking those as machine-made
    would be a false claim, and the duty is about output we generated.

    Never raises. A marking that could break an upload would get removed
    the first time it did.
    """
    if not provenance:
        return {}
    try:
        from api._aiMarking import marking_bytes

        return {MARKING_HEADER: marking_bytes(provenance).decode("ascii", "ignore")}
    except Exception as e:  # noqa: BLE001
        print(f"[r2_sink] could not build AI marking: {e}", flush=True)
        return {}


def upload_bytes(
    *,
    job_id: str,
    body: bytes,
    extension: str,
    content_type: str,
    prefix: str = "uploads",
    owner_id: str | None = None,
    provenance: dict | None = None,
) -> dict:
    """Push raw bytes to R2 under <prefix>/<yyyy-mm>/<job_id>/upload.<ext>.

    Used by the /api/storage/upload endpoint for client-driven uploads
    (user dragged a file into the references panel, generation pipeline
    has bytes-in-hand, etc.). Different from fetch_and_upload because
    there's no source URL to fetch — the caller already holds the
    bytes.

    Returns the same dict shape as fetch_and_upload so client code
    treats the two interchangeably:
        {
            "output_r2_key":  "<bucket-relative key>",
            "output_url":     "<public R2 URL>",
            "bucket":         "<R2 bucket name>",
            "size_bytes":     <int>,
        }
    """
    access_key, secret, bucket = _r2_credentials()
    endpoint = _r2_endpoint()
    if not (access_key and secret and bucket and endpoint):
        raise R2NotConfigured(
            "R2 not configured. Need R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, "
            "R2_BUCKET, R2_ACCOUNT_ID (or their CLOUDFLARE_* equivalents)."
        )
    # Paid tenants write to their own dedicated bucket (same account,
    # same credentials); everyone else shares R2_BUCKET.
    bucket = _tenant_bucket(owner_id) or bucket

    if not isinstance(body, (bytes, bytearray)) or len(body) == 0:
        raise RuntimeError("upload_bytes called with empty body")

    # Compose the key. uploads/ prefix is separate from assets/ so
    # the seed-r2.yml sync (which only touches assets/*) never
    # competes with user-uploaded content. Owner segment (see
    # _sanitize_owner_id) is groundwork for future per-user scoping —
    # omitted entirely when no owner_id is supplied.
    ym = time.strftime("%Y-%m", time.gmtime())
    owner = _sanitize_owner_id(owner_id)
    owner_seg = f"{owner}/" if owner else ""
    key = f"{prefix.rstrip('/')}/{owner_seg}{ym}/{job_id}/upload.{extension.lstrip('.')}"

    # Article 50 marking, at the one seam every generated artefact
    # passes through, so it does not depend on which generator made it.
    # Signed with the request rather than added after, or it would not
    # survive SigV4. See #129.
    marking_header = _marking_header(provenance)

    url, headers = sign_put_request(
        access_key_id=access_key,
        secret_access_key=secret,
        endpoint=endpoint,
        bucket=bucket,
        key=key,
        body=bytes(body),
        content_type=content_type,
        extra_headers=marking_header,
    )
    put_req = urllib.request.Request(url, data=bytes(body), method="PUT", headers=headers)
    try:
        with urllib.request.urlopen(put_req, timeout=60) as put_resp:
            if put_resp.status not in (200, 201):
                raise RuntimeError(f"R2 PUT returned {put_resp.status}")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"R2 PUT {e.code}: {detail}") from e

    return {
        "output_r2_key": key,
        "output_url":    _public_url(bucket, key),
        "bucket":        bucket,
        "size_bytes":    len(body),
        # So a caller can see an artefact went out unmarked rather than
        # assume it did not. #129.
        "ai_marked":     bool(marking_header),
    }


def presigned_get_url(r2_key: str, expires_in: int = 3600) -> str:
    """Short-lived signed GET URL for an object already in R2.

    The ONE way a render pipeline hands an inference provider (i2v seed
    frame, style reference) a fetchable URL for a PRIVATE-bucket object.
    upload_bytes' own `output_url` is a _public_url — it needs
    R2_PUBLIC_BASE (a public-bucket domain the private projects bucket
    doesn't have), so seeding i2v from it fails wherever that env isn't
    set. Presigning against the same credentials is the exact mechanism
    api/watch.py serves media with, and works with zero public config.
    Shared here so every renderer (dramax, examples, …) seeds i2v the
    SAME way (founder, 2026-07-17: "they should all work the same way").
    """
    access_key, secret, bucket = _r2_credentials()
    endpoint = _r2_endpoint()
    if not (access_key and secret and bucket and endpoint):
        raise R2NotConfigured("R2 not configured for presigned_get_url")
    return sign_get_url(
        access_key_id=access_key,
        secret_access_key=secret,
        endpoint=endpoint,
        bucket=bucket,
        key=r2_key,
        expires_in=expires_in,
    )
