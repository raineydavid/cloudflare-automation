#!/usr/bin/env python3
"""Print the bearer tokens derived from the root secret.

Founder (2026-07-27): *"why do we have so many secret keys - its getting
ridiculous"* … *"can keep them but maybe make it a copy of one?"*

`api/_secrets.py` does the deriving. This prints the results, because a
derived token still has to be pasted somewhere by a human — into a
Claude connector config, a CI secret, a curl command — and the server
must never log a live credential to do it.

Run it where the root already is (your machine, `vercel env pull`), not
in CI:

    ROOT_SECRET='…' python3 scripts/derive_tokens.py

Nothing is written to disk and nothing leaves the process. Deriving the
same root twice gives the same tokens, so this is safe to re-run
whenever you need one again — losing a derived token is not an
incident, it is a re-run.

Run: python3 scripts/derive_tokens.py
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from api._secrets import DERIVABLE, derive, root_secret  # noqa: E402


def main() -> int:
    """Print each derivable token, or explain why it cannot be derived."""
    root = root_secret()
    if not root:
        print(
            "No root secret. Set ROOT_SECRET (preferred) or "
            "SIGNING_SECRET, then re-run.\n\n"
            "Generate one with:  python3 -c \"import secrets; print(secrets.token_hex(32))\"",
            file=sys.stderr,
        )
        return 1

    print("Derived from your root secret. Paste these where each is needed;")
    print("they are stable, so re-run this any time rather than storing them.\n")

    for env_name, purpose in sorted(DERIVABLE.items()):
        explicit = os.environ.get(env_name)
        if explicit:
            # An explicit value wins at runtime, so printing the derived
            # one here would hand someone a token the server rejects.
            print(f"{env_name:28} set explicitly — derivation not used")
            continue
        print(f"{env_name:28} {derive(purpose)}")

    print(
        "\nThese are NOT set as environment variables — the server derives them\n"
        "from the root on demand. Set one explicitly only to rotate it alone."
    )
    print(
        "\nNot derivable, because someone else issues and validates them:\n"
        "  PAYMENTS_KEY / STRIPE_SECRET_KEY, inference provider keys,\n"
        "  Cloudflare tokens. Those still have to be pasted from their consoles."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
