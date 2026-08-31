"""Which secrets does a Worker hold? Names only — there is no value path.

    npx wrangler secret list > out.txt
    python3 scripts/worker_secret_names.py out.txt

Prints the names, space separated, one line. Exits 3 and says
UNPARSEABLE on stderr when it does not recognise the output at all.

## Why that distinction is the whole point

`provision-notify-bearer.yml` mints a bearer only when the Worker has
none, because a Worker's secret cannot be read back: making three
consumers agree on an existing value is impossible, so the only
alternative is minting a new one, which silently revokes every current
holder.

That decision rests entirely on this answer. An empty list is a real
answer. Failing to recognise the output is NOT, and if the two collapse
into "no names found" then a cosmetic change to wrangler's output
becomes a revoked credential. So a shape we cannot read is an error,
never an empty list.

Wrangler prints JSON today. Its output is not a contract and has changed
between majors, hence the fallbacks — and hence the refusal underneath
them.

(A separate file rather than a heredoc in the workflow: Python inside a
`run:` block scalar sits at column 0 and breaks the YAML, which has
bitten this repo before.)
"""

from __future__ import annotations

import json
import re
import sys


def names(raw: str) -> list[str] | None:
    """The secret names in wrangler's output, or None if unrecognised."""
    try:
        rows = json.loads(raw[raw.index("["):raw.rindex("]") + 1])
    except Exception:
        pass
    else:
        return sorted(n for r in rows if isinstance(r, dict) and (n := r.get("name")))

    # A table, or JSON we could not bracket-match. Take the first shape
    # that yields anything; an empty result here means "not this shape",
    # not "no secrets" — the JSON branch above owns that answer.
    for pattern in (r'"name"\s*:\s*"([^"]+)"', r"^\s*([A-Z][A-Z0-9_]{2,})\s*$"):
        found = re.findall(pattern, raw, re.M)
        if found:
            return sorted(set(found))
    return None


def main(argv: list[str]) -> int:
    """Print the names. 3 when the output was not recognised at all."""
    raw = open(argv[0]).read() if argv else sys.stdin.read()
    found = names(raw)
    if found is None:
        print("UNPARSEABLE", file=sys.stderr)
        return 3
    print(" ".join(found))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
