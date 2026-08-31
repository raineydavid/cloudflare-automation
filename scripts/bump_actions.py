"""Keep the workflows on current actions and runtimes.

    python3 scripts/bump_actions.py [--apply] [--offline]

Repins every `uses:` line to the action's latest release and lifts the
node/python floors. Never touches a SHA pin — that was deliberate.
`--offline` skips the network and only fixes internal disagreement,
which is what arch/actionsAreCurrent.test.ts asserts on every CI run.

Exits non-zero if a lookup FAILED while online: a subscription that has
quietly stopped checking reports exactly the same "nothing to do" as one
finding everything current.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKFLOWS = ROOT / ".github" / "workflows"

#: `uses: owner/repo@ref`, with an optional trailing comment.
USES = re.compile(r"^(?P<lead>\s*-?\s*uses:\s*)(?P<action>[\w.-]+/[\w.-]+)@(?P<ref>[\w.\-]+)(?P<tail>.*)$")

#: A ref we will rewrite. Anything else — a SHA, a branch, a `v1.2.3`
#: patch pin — is left exactly as it is.
MAJOR = re.compile(r"^v(\d+)$")

#: Runtime pins we keep current alongside the actions. The founder asked
#: for "the latest node" in the same breath as the action versions, and a
#: workflow on a dead Node line is the same class of problem.
RUNTIMES = {
    "python-version": "3.12",
}

#: Node's version lives in .nvmrc and the workflows read it with
#: `node-version-file` — the setup-node README's own recommendation, and
#: it deletes the drift class: ten workflows cannot disagree about a
#: number that only exists once.
NVMRC = ROOT / ".nvmrc"
NODE_FLOOR = "24"


def used_versions(text: str) -> dict[str, set[str]]:
    """Every action in a workflow, mapped to the refs it is pinned at."""
    found: dict[str, set[str]] = {}
    for line in text.splitlines():
        m = USES.match(line)
        if m:
            found.setdefault(m.group("action"), set()).add(m.group("ref"))
    return found


def repo_majors() -> dict[str, set[int]]:
    """Every action across every workflow, mapped to the majors in use.

    More than one entry for an action IS the internal drift this exists
    to find — an action pinned two ways is a workflow somebody copied
    from an older one.
    """
    majors: dict[str, set[int]] = {}
    for f in sorted(WORKFLOWS.glob("*.yml")) + sorted(WORKFLOWS.glob("*.yaml")):
        for action, refs in used_versions(f.read_text(encoding="utf-8")).items():
            for ref in refs:
                m = MAJOR.match(ref)
                if m:
                    majors.setdefault(action, set()).add(int(m.group(1)))
    return majors


def latest_major(action: str) -> int | None:
    """The newest major tag published for an action, or None.

    Reads releases rather than tags: a release is what the publisher
    considers shipped, and the tag list is full of release candidates
    and moved pointers. Unauthenticated is fine — this is a handful of
    calls, well inside the anonymous rate limit — but GITHUB_TOKEN is
    used when present so a scheduled run never trips it.
    """
    req = urllib.request.Request(
        f"https://api.github.com/repos/{action}/releases/latest",
        headers={"Accept": "application/vnd.github+json", "User-Agent": "ontold-bump-actions"},
    )
    token = os.environ.get("GITHUB_TOKEN", "")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            tag = json.load(r).get("tag_name", "")
    except (urllib.error.URLError, OSError, ValueError) as exc:
        print(f"   ? {action}: could not read latest release ({type(exc).__name__})", file=sys.stderr)
        return None
    m = re.match(r"^v?(\d+)", tag or "")
    return int(m.group(1)) if m else None


def rewrite(text: str, targets: dict[str, int]) -> tuple[str, list[str]]:
    """Repin every `uses:` line to its target major. Returns the new text
    and one line per change, for the log and the commit message."""
    changes: list[str] = []
    out: list[str] = []
    for line in text.splitlines():
        m = USES.match(line)
        if not m:
            out.append(line)
            continue
        action, ref = m.group("action"), m.group("ref")
        want = targets.get(action)
        cur = MAJOR.match(ref)
        # A SHA pin, a branch, or an action with no target: untouched.
        if want is None or cur is None or int(cur.group(1)) == want:
            out.append(line)
            continue
        out.append(f"{m.group('lead')}{action}@v{want}{m.group('tail')}")
        changes.append(f"{action} v{cur.group(1)} -> v{want}")
    return "\n".join(out) + ("\n" if text.endswith("\n") else ""), changes


def rewrite_runtimes(text: str) -> tuple[str, list[str]]:
    """Bring `node-version` / `python-version` up to the pinned floor.

    Only ever forward. A workflow deliberately held back on an older
    runtime would be moved by this, which is why the floors live in
    RUNTIMES as a decision rather than being read from the network:
    somebody has to choose them.
    """
    changes: list[str] = []
    out: list[str] = []
    for line in text.splitlines():
        hit = None
        for key, want in RUNTIMES.items():
            m = re.match(rf"^(\s*{key}:\s*)(['\"]?)([\d.]+)(\2)(\s*.*)$", line)
            if m and _older(m.group(3), want):
                hit = f"{m.group(1)}'{want}'{m.group(5)}"
                changes.append(f"{key} {m.group(3)} -> {want}")
                break
        out.append(hit if hit else line)
    return "\n".join(out) + ("\n" if text.endswith("\n") else ""), changes


def _older(have: str, want: str) -> bool:
    """Version compare on dotted numbers, shortest-wins on a tie."""
    a = [int(x) for x in have.split(".") if x.isdigit()]
    b = [int(x) for x in want.split(".") if x.isdigit()]
    return a < b


def bump_nvmrc(apply: bool) -> list[str]:
    """Lift .nvmrc to the Node floor. One file, ten workflows."""
    if not NVMRC.exists():
        return []
    have = NVMRC.read_text(encoding="utf-8").strip()
    if not _older(have, NODE_FLOOR):
        return []
    if apply:
        NVMRC.write_text(NODE_FLOOR + "\n", encoding="utf-8")
    return [f".nvmrc {have} -> {NODE_FLOOR}"]


def main() -> int:
    """Repin the workflows, or report what would change."""
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write; omit for a dry run")
    ap.add_argument("--offline", action="store_true",
                    help="skip the release lookups; only fix internal disagreement")
    ap.add_argument("--report-actions", action="store_true",
                    help="report action drift without rewriting it — Dependabot "
                         "opens those PRs; this still owns the runtime floors")
    args = ap.parse_args()

    majors = repo_majors()
    targets: dict[str, int] = {}
    unchecked: list[str] = []

    for action, seen in sorted(majors.items()):
        highest = max(seen)
        latest = None if args.offline else latest_major(action)
        if latest is None and not args.offline:
            unchecked.append(action)
        want = max(highest, latest) if latest is not None else highest
        if len(seen) > 1:
            print(f"   ! {action} pinned {sorted(seen)} across the repo")
        if latest is not None and latest > highest:
            print(f"   ^ {action} v{highest} -> v{latest} (latest release)")
        targets[action] = want

    changed: list[str] = []
    for c in bump_nvmrc(args.apply):
        print(f"   {'.nvmrc':34} {c}")
        changed.append(".nvmrc")

    files = sorted(WORKFLOWS.glob("*.yml")) + sorted(WORKFLOWS.glob("*.yaml"))
    for f in files:
        text = f.read_text(encoding="utf-8")
        new, acts = rewrite(text, {} if args.report_actions else targets)
        if args.report_actions:
            _, acts = rewrite(text, targets)          # report, do not write
        new, runs = rewrite_runtimes(new)
        for c in acts + runs:
            print(f"   {f.name:34} {c}{'  (Dependabot opens this)' if args.report_actions and c in acts else ''}")
        if new == text:
            continue
        changed.append(f.name)
        if args.apply:
            f.write_text(new, encoding="utf-8")

    verb = "updated" if args.apply else "would update"
    print(f"\n{verb}={len(changed)} of {len(files)} workflow(s)"
          + (f" unchecked={len(unchecked)}" if unchecked else ""))

    # setup-node sat at v4 while v7 was current, and the offline run
    # said "nothing to do" — the same output it gives when everything IS
    # current. A subscription that has stopped checking has to be loud
    # about it or it is not a subscription.
    if unchecked:
        print(f"\nCOULD NOT CHECK: {', '.join(unchecked)}", file=sys.stderr)
        print("These may be behind. Fix the lookup rather than trusting the run.",
              file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
