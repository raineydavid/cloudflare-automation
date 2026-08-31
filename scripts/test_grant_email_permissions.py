"""Editing a live credential without losing what it already does.

`PUT /tokens/{id}` replaces the whole policy list, so the merge is the
dangerous part: dropping one policy removes a capability silently, and
the deploy that needed it fails days later for a reason nobody connects
back to this. Every test here is about that.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.grant_email_permissions import (  # noqa: E402
    already_granted,
    merged,
    regressions,
    resolve_groups,
    split_by_scope,
)

ZONE = "z1"
ACCOUNT = "a1"
ZONE_KEY = f"com.cloudflare.api.account.zone.{ZONE}"
ACCOUNT_KEY = f"com.cloudflare.api.account.{ACCOUNT}"

# What the live token looks like: capabilities the mint's own list does
# NOT contain, which is exactly what a careless fix would lose.
EXISTING = [
    {"id": "p1", "effect": "allow",
     "resources": {"com.cloudflare.api.account.acct": "*"},
     "permission_groups": [{"id": "r2", "name": "Workers R2 Storage Write"}]},
    {"id": "p2", "effect": "allow",
     "resources": {ZONE_KEY: "*"},
     "permission_groups": [{"id": "routes", "name": "Workers Routes Write"}]},
]
# Scopes verbatim from Cloudflare's catalogue: Email Sending is
# zone-scoped, Email Routing Addresses is account-scoped. Assuming both
# were zone-scoped is what made the first apply do nothing.
ZONED = {"id": "es", "name": "Email Sending Write", "scopes": ["com.cloudflare.api.account.zone"]}
ACCOUNTED = {"id": "era", "name": "Email Routing Addresses Write",
             "scopes": ["com.cloudflare.api.account"]}
GROUPS = [ZONED]


class Merge(unittest.TestCase):
    def test_every_existing_policy_survives_verbatim(self):
        out = merged(EXISTING, GROUPS, ZONE, ACCOUNT)
        self.assertEqual(out[:2], EXISTING)

    def test_it_appends_rather_than_editing_the_zone_policy(self):
        # Adding groups to the existing zone policy would work and is
        # not worth the risk: an in-place edit can lose a group through
        # any mistake, an append cannot.
        out = merged(EXISTING, GROUPS, ZONE, ACCOUNT)
        self.assertEqual(len(out), 3)
        # id and name only — `scopes` is how we DECIDE the resource, not
        # something the policy body carries.
        self.assertEqual(out[2]["permission_groups"],
                         [{"id": "es", "name": "Email Sending Write"}])
        self.assertEqual(out[2]["resources"], {ZONE_KEY: "*"})

    def test_the_new_policy_is_scoped_to_one_zone(self):
        # Not the account, and not every zone the token can see. The
        # grant should be no wider than the workflows that need it.
        out = merged(EXISTING, GROUPS, ZONE, ACCOUNT)
        self.assertEqual(list(out[2]["resources"]), [ZONE_KEY])

    def test_running_twice_changes_nothing(self):
        once = merged(EXISTING, GROUPS, ZONE, ACCOUNT)
        self.assertEqual(merged(once, GROUPS, ZONE, ACCOUNT), once)

    def test_a_token_with_no_policies_still_gets_one(self):
        self.assertEqual(len(merged([], GROUPS, ZONE, ACCOUNT)), 1)


class AlreadyGranted(unittest.TestCase):
    def test_the_same_groups_on_another_zone_do_not_count(self):
        # A grant on a different zone reads as present to a sloppy
        # check and does nothing for the zone we need.
        other = [{"effect": "allow",
                  "resources": {"com.cloudflare.api.account.zone.other": "*"},
                  "permission_groups": GROUPS}]
        self.assertFalse(already_granted(other, GROUPS, ZONE, ACCOUNT))

    def test_a_deny_policy_does_not_count_as_a_grant(self):
        deny = [{"effect": "deny", "resources": {ZONE_KEY: "*"},
                 "permission_groups": GROUPS}]
        self.assertFalse(already_granted(deny, GROUPS, ZONE, ACCOUNT))

    def test_a_partial_grant_is_not_a_grant(self):
        # Half the groups present means the other half is still missing,
        # and skipping would leave one workflow broken for a reason that
        # now looks unrelated.
        partial = [{"effect": "allow", "resources": {ZONE_KEY: "*"},
                    "permission_groups": [{"id": "es"}]}]
        self.assertFalse(already_granted(partial, [ZONED, ACCOUNTED], ZONE, ACCOUNT))
        self.assertTrue(already_granted(partial, [ZONED], ZONE, ACCOUNT))


class SplitByScope(unittest.TestCase):
    """The bug that made a successful PUT change nothing."""

    def test_a_group_goes_under_the_resource_its_scope_names(self):
        account, zone = split_by_scope([ZONED, ACCOUNTED])
        self.assertEqual([g["id"] for g in zone], ["es"])
        self.assertEqual([g["id"] for g in account], ["era"])

    def test_both_scopes_get_their_own_policy(self):
        out = merged([], [ZONED, ACCOUNTED], ZONE, ACCOUNT)
        by_resource = {list(p["resources"])[0]: p for p in out}
        self.assertEqual(set(by_resource), {ZONE_KEY, ACCOUNT_KEY})
        self.assertEqual([g["id"] for g in by_resource[ZONE_KEY]["permission_groups"]], ["es"])
        self.assertEqual([g["id"] for g in by_resource[ACCOUNT_KEY]["permission_groups"]], ["era"])

    def test_only_the_missing_half_is_added(self):
        # The zone half already granted; adding a second zone policy
        # would be noise, and skipping the account half would repeat the
        # original failure.
        have_zone = [{"effect": "allow", "resources": {ZONE_KEY: "*"},
                      "permission_groups": [{"id": "es"}]}]
        out = merged(have_zone, [ZONED, ACCOUNTED], ZONE, ACCOUNT)
        self.assertEqual(len(out), 2)
        self.assertEqual(list(out[1]["resources"]), [ACCOUNT_KEY])

    def test_an_unscoped_group_is_treated_as_account(self):
        # A catalogue entry with no scopes must land somewhere rather
        # than vanish; account is the safe reading because a zone group
        # in an account policy is rejected loudly.
        account, zone = split_by_scope([{"id": "x", "name": "Odd"}])
        self.assertEqual([g["id"] for g in account], ["x"])
        self.assertEqual(zone, [])


class Resolve(unittest.TestCase):
    CATALOGUE = [
        {"id": "1", "name": "Email Sending Read",
         "scopes": ["com.cloudflare.api.account.zone"]},
        {"id": "2", "name": "Email Sending Edit",
         "scopes": ["com.cloudflare.api.account.zone"]},
    ]

    def test_either_spelling_resolves(self):
        found, missing = resolve_groups(
            self.CATALOGUE, [["Email Sending Write", "Email Sending Edit"]])
        self.assertEqual([g["id"] for g in found], ["2"])
        self.assertEqual(missing, [])

    def test_the_scope_is_carried_through(self):
        # Dropping it is what put every group under the wrong resource.
        found, _ = resolve_groups(self.CATALOGUE, [["Email Sending Read"]])
        self.assertEqual(found[0]["scopes"], ["com.cloudflare.api.account.zone"])

    def test_a_name_this_account_lacks_is_reported_not_dropped(self):
        found, missing = resolve_groups(self.CATALOGUE, [["Nonexistent Group"]])
        self.assertEqual(found, [])
        self.assertEqual(missing, ["Nonexistent Group"])


class Regressions(unittest.TestCase):
    def test_a_lost_capability_is_named(self):
        before = {"R2": True, "Workers Routes": True, "Email Sending": False}
        after = {"R2": True, "Workers Routes": False, "Email Sending": True}
        self.assertEqual(regressions(before, after), ["Workers Routes"])

    def test_gaining_one_is_not_a_regression(self):
        self.assertEqual(regressions({"Email Sending": False}, {"Email Sending": True}), [])

    def test_something_broken_before_and_after_is_not_ours(self):
        # It failed for its own reasons and blaming this edit would send
        # somebody to undo a change that did no harm.
        self.assertEqual(regressions({"D1": False}, {"D1": False}), [])


if __name__ == "__main__":
    unittest.main()
