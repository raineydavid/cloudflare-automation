"""Where a reply to us goes, and when we must refuse to decide.

Two things are pinned. An UNVERIFIED destination is not a destination —
a rule pointing at one accepts the rule and drops the mail, which looks
identical to working. And forwarding a domain's mail somewhere nobody
named is a guess this must never make.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.email_routing import choose_destination, is_cloudflare_mx, mask, masked, may_enable, rule_for, verdict, verified  # noqa: E402

ONE = [{"email": "a@x.test", "verified": "2026-01-01T00:00:00Z"}]
TWO = ONE + [{"email": "b@x.test", "verified": "2026-01-02T00:00:00Z"}]


class Verified(unittest.TestCase):
    def test_unverified_is_not_a_destination(self):
        # Cloudflare will not forward until the owner clicks its link.
        # Counting one would build a rule that silently loses mail.
        rows = [{"email": "nobody@x.test", "verified": None},
                {"email": "later@x.test"}]
        self.assertEqual(verified(rows), [])

    def test_verified_is_a_timestamp_not_a_boolean(self):
        self.assertEqual(verified(ONE), ["a@x.test"])


class ChooseDestination(unittest.TestCase):
    def test_the_only_verified_one_is_the_answer(self):
        dest, why = choose_destination(ONE)
        self.assertEqual(dest, "a@x.test")
        self.assertIn("only verified", why)

    def test_it_refuses_to_pick_between_two(self):
        # The wrong choice is invisible until somebody reports a reply
        # that went nowhere, so this stops rather than guessing.
        dest, why = choose_destination(TWO)
        self.assertEqual(dest, "")
        self.assertIn("MAIL_DESTINATION", why)
        # Distinguishable, and neither address is readable — this
        # reason is printed into a CI log.
        self.assertIn("a*@x*.test", why)
        self.assertIn("b*@x*.test", why)

    def test_an_explicit_choice_wins(self):
        self.assertEqual(choose_destination(TWO, "b@x.test")[0], "b@x.test")

    def test_an_explicit_choice_that_is_not_verified_is_refused(self):
        # Naming an address does not verify it, and the failure would
        # otherwise be a rule that exists and delivers nothing.
        dest, why = choose_destination(ONE, "typo@x.test")
        self.assertEqual(dest, "")
        self.assertIn("not a verified destination", why)

    def test_unverified_addresses_are_named_so_somebody_can_click(self):
        rows = [{"email": "waiting@x.test", "verified": None}]
        dest, why = choose_destination(rows)
        self.assertEqual(dest, "")
        self.assertIn("w*@x*.test", why)
        self.assertNotIn("waiting", why)
        self.assertIn("confirmation", why)

    def test_nothing_at_all_says_so_plainly(self):
        self.assertEqual(choose_destination([]), ("", "no destination addresses at all on this account"))


class RuleFor(unittest.TestCase):
    RULES = [{
        "name": "anything",
        "matchers": [{"type": "literal", "field": "to", "value": "hello@x.test"}],
        "actions": [{"type": "forward", "value": ["a@x.test"]}],
    }]

    def test_matched_on_the_matcher_not_the_name(self):
        # A name is a label somebody typed; the `to` matcher is what
        # actually decides delivery, and two rules can share a name.
        self.assertIsNotNone(rule_for(self.RULES, "hello@x.test"))
        self.assertIsNone(rule_for(self.RULES, "anything"))

    def test_case_does_not_make_a_second_rule(self):
        self.assertIsNotNone(rule_for(self.RULES, "HELLO@X.test"))

    def test_a_catch_all_is_not_a_rule_for_this_address(self):
        # A catch-all has no `to` matcher. Treating it as coverage would
        # skip creating the rule we came for.
        catch_all = [{"matchers": [{"type": "all"}], "actions": []}]
        self.assertIsNone(rule_for(catch_all, "hello@x.test"))


class Mask(unittest.TestCase):
    """A destination address is somebody's inbox, not log material."""

    def test_the_domain_is_masked_too(self):
        # The first version kept the domain, reasoning that it carried
        # the useful half. For a personal domain the domain IS the name,
        # so that identified somebody completely while looking careful.
        self.assertEqual(mask("rainey@raineydavid.com"), "r*@r*.com")

    def test_nothing_of_the_name_survives_but_an_initial(self):
        got = mask("rainey@raineydavid.com")
        self.assertNotIn("rainey", got)
        self.assertNotIn("raineydavid", got)

    def test_a_subdomain_is_hidden_as_well(self):
        # A subdomain names things — a company, a product, a tenant.
        self.assertEqual(mask("bob@mail.example.co.uk"), "b*@m*.e*.c*.uk")

    def test_the_tld_survives_so_it_still_reads_as_an_address(self):
        self.assertTrue(mask("x@y.io").endswith(".io"))

    def test_junk_does_not_pass_through_as_itself(self):
        # A malformed value printed raw is the leak this prevents.
        self.assertEqual(mask("notanaddress"), "(not an address)")
        self.assertEqual(mask("a@nodot"), "(not an address)")
        self.assertEqual(mask(""), "(not an address)")

    def test_an_empty_list_says_none_rather_than_nothing(self):
        self.assertEqual(masked([]), "NONE")


class MayEnable(unittest.TestCase):
    """Enabling rewrites the zone's MX. Whether that is safe is a fact."""

    def test_an_empty_zone_has_nothing_to_take_away(self):
        allowed, why = may_enable([])
        self.assertTrue(allowed)
        self.assertIn("no MX", why)

    def test_an_incumbent_provider_is_never_displaced(self):
        # The dangerous case, and the only one. Turning routing on here
        # would take delivery for the WHOLE domain from whoever has it.
        allowed, why = may_enable(["aspmx.l.google.com (pri 1)"])
        self.assertFalse(allowed)
        self.assertIn("aspmx.l.google.com", why)

    def test_even_one_record_is_enough_to_refuse(self):
        self.assertFalse(may_enable(["mx.zoho.eu (pri 10)"])[0])

    def test_an_UNREADABLE_zone_is_refused_rather_than_read_as_empty(self):
        # The bug this is here for, found in production. Run
        # estate-wide against a token without DNS read, every zone came
        # back empty, and this printed "MX: NONE — nothing receives for
        # this domain" about blackin.education — which Cloudflare then
        # refused with `2008 Non-Cloudflare MX records exist`.
        #
        # So the guard was not guarding; Cloudflare's own check was
        # doing the work, and the report was telling a reader the
        # opposite of the truth. A safety check that cannot see must
        # refuse, not wave through.
        allowed, why = may_enable(None)
        self.assertFalse(allowed)
        self.assertIn("cannot read", why)

    def test_unreadable_and_empty_do_not_give_the_same_answer(self):
        self.assertNotEqual(may_enable(None)[0], may_enable([])[0])

    def test_cloudflares_own_MX_is_not_an_incumbent(self):
        # screeningstudio.com and studentaccount.com carry
        # route1..3.mx.cloudflare.net with the routing SERVICE off: the
        # records point at something not running, so the domain
        # receives nothing while looking configured. Refusing there
        # protected nobody and blocked both from ever getting a reply
        # path.
        allowed, why = may_enable(["route1.mx.cloudflare.net (pri 8)",
                                   "route2.mx.cloudflare.net (pri 57)"])
        self.assertTrue(allowed)
        self.assertIn("Cloudflare's own", why)

    def test_one_third_party_MX_among_cloudflares_still_refuses(self):
        # The dangerous mixture. Enabling would still displace the real
        # provider, so the presence of Cloudflare records must not
        # excuse it.
        allowed, why = may_enable(["route1.mx.cloudflare.net (pri 8)",
                                   "aspmx.l.google.com (pri 1)"])
        self.assertFalse(allowed)
        self.assertIn("aspmx.l.google.com", why)
        self.assertNotIn("route1", why)


class CloudflareMx(unittest.TestCase):
    """Read off a live zone, never recalled — see the selector we invented."""

    def test_the_routing_hosts_are_recognised(self):
        for host in ("route1.mx.cloudflare.net", "route2.mx.cloudflare.net (pri 57)"):
            self.assertTrue(is_cloudflare_mx(host), host)

    def test_a_lookalike_is_not_matched(self):
        # Suffix, anchored. `mx.cloudflare.net.evil.test` must not pass.
        self.assertFalse(is_cloudflare_mx("mx.cloudflare.net.evil.test"))
        self.assertFalse(is_cloudflare_mx("notcloudflare.net"))
        self.assertFalse(is_cloudflare_mx("aspmx.l.google.com"))


class Verdict(unittest.TestCase):
    """Routing off means no reply path, however the rule got there."""

    def test_a_freshly_created_rule_on_a_dead_zone_is_not_ready(self):
        self.assertEqual(verdict(False, "a.test", "hello@a.test forwards to x@y.test"), 1)

    def test_an_EXISTING_rule_on_a_dead_zone_is_not_ready_either(self):
        # The branch that reported success. "already has a rule" is true
        # and useless while the zone delivers nothing.
        self.assertEqual(verdict(False, "a.test", "hello@a.test already has a rule"), 1)

    def test_enabling_is_named_as_a_decision_with_a_blast_radius(self):
        import io, contextlib
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            verdict(False, "a.test", "anything")
        said = out.getvalue()
        self.assertIn("MX RECORDS", said)
        self.assertIn("whole domain", said)

    def test_an_enabled_zone_is_ready(self):
        self.assertEqual(verdict(True, "a.test", "hello@a.test forwards to x@y.test"), 0)


if __name__ == "__main__":
    unittest.main()
