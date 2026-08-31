"""Give the existing Cloudflare token the email permissions it lacks.

    CLOUDFLARE_API_TOKEN=... python3 scripts/grant_email_permissions.py ontold.site
    CLOUDFLARE_API_TOKEN=... python3 scripts/grant_email_permissions.py ontold.site --apply

Dry run unless `--apply`. Never prints a token value.

## Why edit rather than mint

Two provisioning workflows are blocked on one credential:
`provision-sending-domain` cannot onboard a sending domain and
`provision-email-routing` cannot even READ routing, both refused
`Authentication error [code: 10000]`. The token predates Cloudflare's
email permission groups.

Minting a replacement is the obvious move and it is wrong here.
`mint-deploy-token`'s permission list contains no R2 and no Workers
Routes, so a minted token would break deploy-mcp, deploy-site-host and
seed-r2 in order to fix mail. Editing a token preserves its VALUE, so
nothing stored anywhere has to change.

## Additive, never a rewrite

The dangerous operation is `PUT /tokens/{id}`, which replaces the whole
policy list. A merge that drops one policy silently removes a
capability, and the symptom is a deploy failing days later for a reason
nobody connects to this.

So this appends ONE new policy and passes every existing policy through
untouched. It never edits, reorders or removes an existing entry, and
it is a no-op when the groups are already granted.

## Prove it, before and after

A capability probe runs on both sides of the write and the two are
compared. Anything the token could do before and cannot do after is a
regression this caused, and it is reported as one rather than left to
surface in an unrelated workflow.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

API = "https://api.cloudflare.com/client/v4"
USER_AGENT = "ontold/1.0 (+https://ontold.com)"

#: What to add, by name, with the spellings Cloudflare uses.
#:
#: The API splits read and write where the dashboard's "Edit" bundles
#: them, and a write-only token cannot list what it is about to write
#: to — both provisioning scripts read before they act.
WANT = [
    ["Email Routing Rules Read"],
    ["Email Routing Rules Write", "Email Routing Rules Edit"],
    ["Email Routing Addresses Read"],
    ["Email Routing Addresses Write", "Email Routing Addresses Edit"],
    ["Email Sending Read"],
    ["Email Sending Write", "Email Sending Edit"],
]

#: Endpoints that must still work afterwards. The point of the list is
#: what it protects: R2 and Workers Routes are NOT in the mint's
#: permission set, so they are the capabilities a careless fix loses.
PROBES = [
    ("D1", "/accounts/{account}/d1/database"),
    ("Workers Scripts", "/accounts/{account}/workers/scripts"),
    ("R2", "/accounts/{account}/r2/buckets"),
    ("Zone read", "/zones/{zone}"),
    ("Workers Routes", "/zones/{zone}/workers/routes"),
    ("Email Routing", "/zones/{zone}/email/routing"),
    ("Email Sending", "/zones/{zone}/email/sending/subdomains"),
]


def _call(path: str, token: str, method: str = "GET", body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        f"{API}{path}", data=data,
        headers={
            "authorization": f"Bearer {token}",
            "content-type": "application/json",
            "user-agent": USER_AGENT,
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as res:
            return json.loads(res.read().decode())
    except urllib.error.HTTPError as err:
        try:
            return json.loads(err.read().decode())
        except Exception:
            return {"success": False, "errors": [{"message": f"HTTP {err.code}"}]}
    except Exception as err:  # pragma: no cover - network shapes vary
        return {"success": False, "errors": [{"message": str(err)}]}


def resolve_groups(catalogue: list[dict], want: list[list[str]]) -> tuple[list[dict], list[str]]:
    """(groups to grant, names this account does not offer).

    Aliases because Cloudflare's spelling differs between the catalogue
    and the token API, and a missing name must be REPORTED rather than
    quietly dropped — a partial grant fixes one workflow and leaves the
    other failing for a reason that now looks unrelated.
    """
    by_name = {g.get("name"): g for g in catalogue if g.get("name")}
    found, missing = [], []
    for aliases in want:
        hit = next((by_name[a] for a in aliases if a in by_name), None)
        if hit:
            # Keep `scopes`. It decides which POLICY the group belongs
            # in, and dropping it is what made the first attempt add a
            # policy that changed nothing.
            found.append({"id": hit["id"], "name": hit["name"],
                          "scopes": hit.get("scopes") or []})
        else:
            missing.append(" / ".join(aliases))
    return found, missing


def split_by_scope(groups: list[dict]) -> tuple[list[dict], list[dict]]:
    """(account-scoped, zone-scoped), read from each group's own `scopes`.

    THE thing the first attempt got wrong. Every group went into one
    zone-resource policy, the PUT was accepted, and the token could
    still reach neither email product — because Email Routing Addresses
    are account-scoped (destination addresses live on the account, which
    is why email_routing.py reads them from `/accounts/...`) and a
    group placed under the wrong resource does nothing.

    mint-deploy-token in this repo already did this, and says so: "the
    scope decides which policy it belongs in, and a zone-scoped group in
    an account policy is rejected by the API." The catalogue hands the
    scope over; there was never a reason to assume it.
    """
    account, zone = [], []
    for group in groups:
        scoped_to_zone = any(
            str(s).endswith(".zone") for s in (group.get("scopes") or [])
        )
        (zone if scoped_to_zone else account).append(
            {"id": group["id"], "name": group["name"]}
        )
    return account, zone


def _allows(policies: list[dict], group_ids: set[str], resource: str) -> bool:
    """Whether an existing allow-policy already covers these on `resource`."""
    if not group_ids:
        return True
    for policy in policies:
        if policy.get("effect") != "allow":
            continue
        if resource not in (policy.get("resources") or {}):
            continue
        have = {g.get("id") for g in (policy.get("permission_groups") or [])}
        if group_ids <= have:
            return True
    return False


def already_granted(policies: list[dict], groups: list[dict],
                    zone_id: str, account_id: str) -> bool:
    """Whether both halves are already allowed on their own resource."""
    account_groups, zone_groups = split_by_scope(groups)
    return (
        _allows(policies, {g["id"] for g in account_groups},
                f"com.cloudflare.api.account.{account_id}")
        and _allows(policies, {g["id"] for g in zone_groups},
                    f"com.cloudflare.api.account.zone.{zone_id}")
    )


def merged(policies: list[dict], groups: list[dict],
           zone_id: str, account_id: str) -> list[dict]:
    """Existing policies verbatim, plus a policy per scope that needs one.

    APPENDS. It must never edit, reorder or drop an existing entry: a
    PUT replaces the whole list, so a merge that loses a policy removes
    a capability silently and the deploy that needed it fails days later
    for a reason nobody connects to this.
    """
    out = list(policies)
    account_groups, zone_groups = split_by_scope(groups)
    for wanted, resource in (
        (account_groups, f"com.cloudflare.api.account.{account_id}"),
        (zone_groups, f"com.cloudflare.api.account.zone.{zone_id}"),
    ):
        if wanted and not _allows(out, {g["id"] for g in wanted}, resource):
            out.append({
                "effect": "allow",
                "resources": {resource: "*"},
                "permission_groups": wanted,
            })
    return out


def probe(token: str, account_id: str, zone_id: str) -> dict[str, bool]:
    """What this token can reach right now, by capability name."""
    out = {}
    for label, path in PROBES:
        got = _call(path.format(account=account_id, zone=zone_id), token)
        out[label] = bool(got.get("success"))
    return out


def regressions(before: dict[str, bool], after: dict[str, bool]) -> list[str]:
    """Capabilities lost. Anything here is damage this script did."""
    return sorted(k for k, ok in before.items() if ok and not after.get(k))


def identify(token: str, account_id: str) -> tuple[str, str, str]:
    """Which token family this is, its id, and why not.

    Returns the BASE PATH its own record lives under, because the two
    families are not interchangeable: an account-owned token is managed
    at `/accounts/{id}/tokens` and a user-owned one at `/user/tokens`,
    and asking the wrong one answers `1000 Invalid API Token` — which
    reads exactly like a bad credential and is not. This token had just
    listed a zone successfully when that happened.

    Tries the account family first: `CLOUDFLARE_API_TOKEN` here is an
    Account API Token, and wrangler says so on every run.
    """
    tried = []
    for base in (f"/accounts/{account_id}/tokens", "/user/tokens"):
        got = _call(f"{base}/verify", token)
        token_id = (got.get("result") or {}).get("id", "")
        if token_id:
            return base, token_id, ""
        tried.append(f"{base}/verify -> {json.dumps(got.get('errors') or [])[:120]}")
    return "", "", " ; ".join(tried)


def main(argv: list[str]) -> int:
    """Grant the email groups. 0 when the token ends up able to do the job."""
    zone_name = argv[0] if argv and not argv[0].startswith("-") else ""
    apply = "--apply" in argv
    token = (os.environ.get("CLOUDFLARE_API_TOKEN") or "").strip()
    if not zone_name or not token:
        print("usage: CLOUDFLARE_API_TOKEN=... grant_email_permissions.py <zone> [--apply]",
              file=sys.stderr)
        return 2

    zones = _call(f"/zones?name={zone_name}", token)
    rows = zones.get("result") or []
    if not zones.get("success") or not rows:
        print(f"cannot see the zone {zone_name} — {json.dumps(zones.get('errors') or [])[:200]}")
        return 1
    zone_id = rows[0]["id"]
    account_id = (rows[0].get("account") or {}).get("id", "")

    base, token_id, why = identify(token, account_id)
    if not token_id:
        print(f"cannot identify this token — {why}")
        return 1
    print(f"token:   {token_id} ({base.split('/')[1]}-owned)")

    current = _call(f"{base}/{token_id}", token)
    if not current.get("success"):
        print("cannot read this token's own policies — "
              f"{json.dumps(current.get('errors') or [])[:200]}")
        print("It needs Account API Tokens: Edit to change itself. Without that the "
              "permissions have to be added in the dashboard; editing preserves the "
              "value either way, so nothing stored changes.")
        return 1
    policies = (current.get("result") or {}).get("policies") or []
    print(f"policies: {len(policies)} existing")

    catalogue = _call(f"/accounts/{account_id}/tokens/permission_groups", token)
    groups, missing = resolve_groups(catalogue.get("result") or [], WANT)
    if missing:
        print(f"NOT OFFERED by this account: {', '.join(missing)}")
    if not groups:
        print("status:  NOT READY: none of the email permission groups exist here")
        return 1
    account_groups, zone_groups = split_by_scope(groups)
    if account_groups:
        print(f"granting (account): {', '.join(g['name'] for g in account_groups)}")
    if zone_groups:
        print(f"granting (zone {zone_name}): {', '.join(g['name'] for g in zone_groups)}")

    if already_granted(policies, groups, zone_id, account_id):
        print("status:  already granted — nothing to change")
        return 0

    before = probe(token, account_id, zone_id)
    print("before:  " + ", ".join(f"{k}={'yes' if v else 'NO'}" for k, v in before.items()))

    if not apply:
        added = len(merged(policies, groups, zone_id, account_id)) - len(policies)
        print(f"status:  dry run. Re-run with --apply to add {added} policy/policies, "
              f"leaving all {len(policies)} existing ones untouched.")
        return 0

    body = dict(current.get("result") or {})
    body["policies"] = merged(policies, groups, zone_id, account_id)
    wrote = _call(f"{base}/{token_id}", token, method="PUT", body=body)
    if not wrote.get("success"):
        print(f"status:  NOT READY: the edit was refused — "
              f"{json.dumps(wrote.get('errors') or [])[:300]}")
        return 1

    # Cloudflare caches token policy at the edge, so an immediate probe
    # can report the old answer. The first attempt compared before and
    # after inside the same second.
    after = probe(token, account_id, zone_id)
    for _ in range(6):
        if after.get("Email Routing") and after.get("Email Sending"):
            break
        time.sleep(10)
        after = probe(token, account_id, zone_id)
    print("after:   " + ", ".join(f"{k}={'yes' if v else 'NO'}" for k, v in after.items()))
    lost = regressions(before, after)
    if lost:
        # Loud, because this is damage rather than a failed attempt, and
        # it would otherwise surface as an unrelated deploy failing.
        print(f"status:  REGRESSION: this edit LOST {', '.join(lost)}. "
              "Restore those permission groups on the token before deploying anything.")
        return 1
    if not after.get("Email Sending") or not after.get("Email Routing"):
        # The policy persisted — the count goes up on every run — and
        # the access did not change. Twice, with the scopes split
        # correctly the second time and a propagation wait on both.
        #
        # The reading that fits: a token cannot grant ITSELF permissions
        # it does not already hold. That is what an API should refuse,
        # and refusing it by storing the policy while ignoring its
        # effect is exactly what this looks like from here.
        #
        # If that is right, no amount of fixing this script helps: the
        # grant has to come from a credential with more authority than
        # the token being edited.
        print("status:  NOT READY: the policy was stored and the access did not change. "
              "A token most likely cannot grant itself permissions it does not hold, in "
              "which case this approach cannot work at all and the groups have to be "
              "added from the dashboard (which preserves the value, so no secret here "
              "changes). Nothing was lost — every other capability still reads yes above.")
        return 1
    print("status:  granted — provision-sending-domain and provision-email-routing can run")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
