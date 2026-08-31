"""Copy declared storage variables from the environment into Vercel.

    python3 scripts/vercel_env_sync.py --target preview,production [--apply]

Reads values from the process environment (the workflow puts GitHub
secrets there) and upserts them onto a Vercel project. Dry-run unless
--apply is passed.

Why this exists: R2 is populated by seed-r2.yml using GitHub's secrets,
and /api/watch on Vercel could not read the same bucket. Same bucket,
different environment's variables. Vercel also scopes vars per
environment, so a Production-only value is invisible to a preview — the
failure that looks exactly like a wrong credential.

It syncs a DECLARED list, never "whatever is set" — that is how an
unrelated secret ends up on a deployment nobody meant to give it. And
it never prints a value: the log carries names, actions and HTTP
statuses only, and any value that turns up inside an API error message
is redacted before the message is shown.

The workflow owns the knobs: .github/workflows/sync-vercel-env.yml
carries APPLY and TARGET at the top and passes them as flags, so there
is one file to edit and one place to look.

Setup is ONE secret. VERCEL_TOKEN is required; the project defaults to
this repo's Vercel project name and the team is discovered from the
token when the project is not reachable personally, so
VERCEL_PROJECT_ID / VERCEL_ORG_ID are optional overrides rather than
things you have to go and look up.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

API = "https://api.vercel.com"

#: The Vercel API accepts a project NAME wherever it accepts an id, so
#: this is a working default and not merely a label.
DEFAULT_PROJECT = "ontold"

#: The variables this may copy. R2_JURISDICTION earns its place: the
#: endpoint host is <account>.<jurisdiction>.r2.cloudflarestorage.com,
#: so GitHub and Vercel disagreeing about it yields two valid credential
#: sets pointing at different hosts — uploads succeed, reads fail, and
#: neither side looks misconfigured.
NAMES = [
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET",
    "R2_JURISDICTION",
    "R2_PUBLIC_BASE",
    # The bearer /notify expects. Same shape of problem as the R2 pair:
    # the value is minted on one platform and consumed on another, and
    # the two disagreeing looks like a broken Worker rather than a
    # missing copy. api/_mail.py reads it from Vercel; the Worker holds
    # its own copy as a wrangler secret. Both are written by the same
    # run of provision-notify-bearer.yml so they cannot drift.
    #
    # MCP_TOKEN stays alongside it: a deployment configured before mail
    # got a name of its own still presents that one, and /notify still
    # accepts it.
    "NOTIFY_TOKEN",
    "MCP_TOKEN",
]

ALL_TARGETS = ["production", "preview", "development"]


def _redact(text: str) -> str:
    """Blank any declared secret that appears in an API message.

    Vercel echoes parts of a rejected request back. The names are
    already in this log by design; the values must never be, and an
    error path is exactly where that guarantee gets forgotten.
    """
    for name in NAMES:
        v = os.environ.get(name, "")
        if v and len(v) > 3:
            text = text.replace(v, f"<{name}>")
    return text


def _call(url: str, token: str, method: str = "GET",
          body: dict | None = None) -> tuple[int, dict, str]:
    """One Vercel API call → (status, parsed body, human-readable note).

    The note carries Vercel's own error code/message. Without it a 403
    is indistinguishable from a 404 from a typo, and whoever runs this
    is left guessing at the one step that needs to work.
    """
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode() or "{}"
            return resp.status, (json.loads(raw) if raw.strip().startswith("{") else {}), ""
    except urllib.error.HTTPError as exc:
        note = ""
        try:
            err = json.loads(exc.read().decode() or "{}").get("error", {})
            note = _redact(f"{err.get('code', '')}: {err.get('message', '')}".strip(": "))
        except Exception:  # noqa: BLE001 — a missing error body is not a crash
            pass
        return exc.code, {}, note
    except Exception as exc:  # noqa: BLE001 — a sync reports, it does not traceback
        return 0, {}, type(exc).__name__


def _resolve_scope(token: str, project: str, team: str) -> tuple[str, str]:
    """Find the query suffix that can actually see `project`.

    A token issued under a team cannot read the project without
    teamId, and Vercel answers 403/404 for that — which reads as "wrong
    project name" to everyone who has ever hit it. Rather than make
    someone paste an org id they have to go digging for, try personal
    scope first, then each team the token can see.

    Returns (suffix, description). Empty description = personal scope.
    """
    if team:
        return f"?teamId={team}", f"teamId={team} (from VERCEL_ORG_ID)"
    status, _, _ = _call(f"{API}/v9/projects/{project}", token)
    if status == 200:
        return "", "personal scope"
    status, teams, _ = _call(f"{API}/v2/teams", token)
    for t in (teams.get("teams", []) if status == 200 else []):
        tid = t.get("id", "")
        if not tid:
            continue
        code, _, _ = _call(f"{API}/v9/projects/{project}?teamId={tid}", token)
        if code == 200:
            return f"?teamId={tid}", f"team {t.get('slug') or tid}"
    return "", "personal scope (project not reachable — reporting the real error below)"


def main() -> int:
    """Upsert the declared variables onto the project. 0 on success."""
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--target", default="preview",
        help="comma-separated: preview,production,development — or 'all'. "
             "Vercel scopes vars per environment, so a preview deployment "
             "cannot see a production-only value.",
    )
    ap.add_argument("--apply", action="store_true", help="write; omit for a dry run")
    args = ap.parse_args()

    targets = ALL_TARGETS if args.target.strip() == "all" else [
        t.strip() for t in args.target.split(",") if t.strip()
    ]
    bad = [t for t in targets if t not in ALL_TARGETS]
    if bad or not targets:
        print(f"unknown target(s): {bad or '(none given)'}", file=sys.stderr)
        return 1

    token = os.environ.get("VERCEL_TOKEN", "")
    if not token:
        print("VERCEL_TOKEN must be set (a Vercel account token)", file=sys.stderr)
        return 1
    project = os.environ.get("VERCEL_PROJECT_ID") or DEFAULT_PROJECT
    suffix, scope = _resolve_scope(token, project, os.environ.get("VERCEL_ORG_ID", ""))

    status, listing, note = _call(f"{API}/v9/projects/{project}/env{suffix}", token)
    if status != 200:
        print(f"could not read {project} via {scope} — HTTP {status} {note}", file=sys.stderr)
        print("Check the token has access to this project, or set "
              "VERCEL_PROJECT_ID / VERCEL_ORG_ID explicitly.", file=sys.stderr)
        return 1
    rows = listing.get("envs", [])

    print(f"── project={project} scope={scope} targets={','.join(targets)} apply={args.apply}")
    failures = missing = 0
    for name in NAMES:
        value = os.environ.get(name, "")
        if not value:
            # Never write an empty string: it reads as "configured" to
            # every is_configured() check and fails later, further away
            # from the cause.
            print(f"   skip   {name}  (not set here)")
            missing += 1
            continue
        for target in targets:
            ids = [r["id"] for r in rows
                   if r.get("key") == name and target in (r.get("target") or [])]
            if not args.apply:
                print(f"   would {'REPLACE' if ids else 'CREATE '} {name}  [{target}]")
                continue
            # One row per (key, target) — a create over the top is a 409,
            # not an update, so the old row goes first.
            for env_id in ids:
                _call(f"{API}/v9/projects/{project}/env/{env_id}{suffix}", token, method="DELETE")
            code, _, why = _call(
                f"{API}/v10/projects/{project}/env{suffix}", token, method="POST",
                body={"key": name, "value": value, "type": "encrypted", "target": [target]},
            )
            print(f"   set    {name}  [{target}] -> HTTP {code} {why}".rstrip())
            if code not in (200, 201):
                failures += 1

    if missing:
        print(f"\n{missing} declared variable(s) were not set here — nothing was written for them.")
    if args.apply:
        print("\nRedeploy for these to take effect — Vercel reads env at build/boot.")
        print("Then /api/health: seed_readable should report ok.")
    else:
        print("\nDry run — nothing written. Re-run with the Apply box ticked.")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
