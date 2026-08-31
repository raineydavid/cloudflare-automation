#!/usr/bin/env bash
# provision-r2 — create Ontold's R2 bucket(s) via wrangler, non-interactively.
#
# Blocked on ONE credential only: a Cloudflare API token with R2 edit
# permission. The agent environment has no Cloudflare creds and wrangler
# can't do headless browser login, so this can't self-auth. Provide the
# token and this becomes a single command.
#
# Usage:
#   export CLOUDFLARE_API_TOKEN=<token with "R2 Storage: Edit">
#   export CLOUDFLARE_ACCOUNT_ID=<account id>
#   bash scripts/provision-r2.sh            # creates the shared bucket
#   bash scripts/provision-r2.sh t-acme     # + a paid-tenant bucket
#
# What it does NOT do (dashboard/DNS-only, can't be scripted safely):
#   - enable the bucket's public r2.dev URL or attach media.ontold.com
#   - mint the runtime R2 API access key/secret (R2 → Manage API Tokens)
# Those two are the last manual steps; everything else is here.

set -euo pipefail

BUCKET="${R2_BUCKET:-ontold-projects-prod}"
JUR="${R2_JURISDICTION:-}"          # 'eu' for EU data residency, else empty

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "✗ CLOUDFLARE_API_TOKEN is not set — cannot authenticate to Cloudflare." >&2
  echo "  Create one at: Cloudflare dashboard → My Profile → API Tokens →" >&2
  echo "  Create Token → 'R2 Storage: Edit' (scoped to your account), then:" >&2
  echo "    export CLOUDFLARE_API_TOKEN=<token>" >&2
  echo "    export CLOUDFLARE_ACCOUNT_ID=<account id>" >&2
  exit 1
fi

acct_flag=()
[[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]] && acct_flag=(--account-id "${CLOUDFLARE_ACCOUNT_ID}")
jur_flag=()
[[ -n "${JUR}" ]] && jur_flag=(--jurisdiction "${JUR}")

create() {
  local name="$1"
  echo "→ creating R2 bucket: ${name} ${JUR:+(jurisdiction ${JUR})}"
  # Idempotent-ish: a 'already exists' error is fine to ignore.
  npx --yes wrangler r2 bucket create "${name}" "${acct_flag[@]}" "${jur_flag[@]}" \
    || echo "  (bucket may already exist — continuing)"
}

# Shared bucket (free tier — everyone, owner-prefixed keys).
create "${BUCKET}"

# Optional extra args → paid-tenant dedicated buckets (R2_TENANT_BUCKETS).
for tenant in "$@"; do
  create "ontold-${tenant}"
done

echo
echo "✓ bucket(s) created. Remaining manual steps (dashboard):"
echo "  1. R2 → ${BUCKET} → Settings → enable public access (r2.dev) or"
echo "     attach a custom domain (e.g. media.ontold.com)."
echo "  2. R2 → Manage R2 API Tokens → create Object Read & Write token;"
echo "     put the Access Key ID / Secret + R2_ACCOUNT_ID, R2_BUCKET,"
echo "     R2_PUBLIC_BASE into Vercel + GitHub Actions env (see .env.example)."
echo "  Then the storage lane goes live (health probe → configured/writable/readable)."
