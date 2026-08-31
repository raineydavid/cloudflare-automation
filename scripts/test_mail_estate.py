"""Every way a domain can look configured and deliver nothing.

The table this produces will be read as the answer to "is mail working",
so a green cell has to mean it. Each test below is a state that has
actually occurred in this account and read as fine at the time.
"""

from __future__ import annotations

import io
import contextlib
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.mail_estate import delegation_verdict, dmarc_verdict, in_verdict, out_verdict, report, sending_domains, zones  # noqa: E402

LIVE = [{"email": "a@x.test", "verified": "2026-01-01T00:00:00Z"}]
PENDING = [{"email": "a@x.test", "verified": None}]


def ruled(to: str, *targets: str, enabled: bool = True) -> list[dict]:
    return [{
        "matchers": [{"type": "literal", "field": "to", "value": to}],
        "actions": [{"type": "forward", "value": list(targets)}],
        "enabled": enabled,
    }]


class Out(unittest.TestCase):
    def test_the_subdomain_is_what_gets_onboarded(self):
        ok, why = out_verdict("a.test", {"mail.a.test"}, "", "mail")
        self.assertTrue(ok)
        self.assertIn("mail.a.test", why)

    def test_the_zone_being_present_is_not_the_subdomain_being_present(self):
        # The failure that cost this programme weeks: `mail.` in the
        # code, the apex onboarded, every send refused with the
        # credential present and the DNS looking right.
        ok, why = out_verdict("a.test", {"other.test"}, "", "mail")
        self.assertFalse(ok)
        self.assertIn("NOT onboarded", why)

    def test_an_apex_onboarding_does_count(self):
        self.assertTrue(out_verdict("a.test", {"a.test"}, "", "mail")[0])

    def test_a_command_that_failed_is_not_a_domain_that_cannot_send(self):
        # An empty list and an unreadable list look identical and mean
        # opposite things. Reporting NO here would send somebody to
        # re-onboard a domain that already works.
        ok, why = out_verdict("a.test", set(), "could not list the sending domains (boom)", "mail")
        self.assertFalse(ok)
        self.assertIn("unknown", why)
        self.assertNotIn("NOT onboarded", why)


class SendingList(unittest.TestCase):
    """Read from wrangler, because the REST resource answers 404 here."""

    LISTING = """
    Email sending domains:
      mail.a.test        active
      mail.b.test        pending
    """

    def test_the_domains_are_picked_out_of_the_listing(self):
        got, note = sending_domains(self.LISTING, True)
        self.assertEqual(note, "")
        self.assertIn("mail.a.test", got)
        self.assertIn("mail.b.test", got)

    def test_a_failed_command_reports_unknown_rather_than_none(self):
        # The distinction the whole column rests on. `ok=False` with
        # plausible-looking text must NOT be read as a domain list.
        got, note = sending_domains("Error: not authorised", False)
        self.assertEqual(got, set())
        self.assertIn("could not list", note)

    def test_the_failure_text_is_carried_so_it_can_be_diagnosed(self):
        _, note = sending_domains("✘ [ERROR] A request to Cloudflare failed", False)
        self.assertIn("Cloudflare", note)

    def test_no_output_at_all_says_so(self):
        _, note = sending_domains("", False)
        self.assertIn("no output", note)


class In(unittest.TestCase):
    def test_routing_off_is_not_ready_however_good_the_rule(self):
        ok, why = in_verdict("a.test", False, ruled("hello@a.test", "a@x.test"), LIVE, "hello")
        self.assertFalse(ok)
        self.assertIn("OFF", why)

    def test_a_domain_with_its_own_provider_receives_and_is_not_broken(self):
        # blackin.education. Cloudflare refuses to enable routing there
        # — `2008 Non-Cloudflare MX records exist` — and calling it NO
        # would be false: mail to it arrives, just not through us. A
        # report that marks working domains broken gets ignored, and is
        # then no use for the ones that really are.
        ok, why = in_verdict("a.test", False, [], LIVE, "hello", ["mx.provider.test"])
        self.assertTrue(ok)
        self.assertIn("mx.provider.test", why)
        self.assertIn("should stay off", why)

    def test_an_unreadable_MX_is_not_an_empty_one(self):
        # The guard bug, in the reporting half. None means the read
        # failed; saying "delivers nothing" about a zone we could not
        # look at is the same lie in a different place.
        ok, why = in_verdict("a.test", False, [], LIVE, "hello", None)
        self.assertFalse(ok)
        self.assertIn("cannot be established", why)

    def test_no_MX_and_routing_off_really_does_deliver_nothing(self):
        ok, why = in_verdict("a.test", False, [], LIVE, "hello", [])
        self.assertFalse(ok)
        self.assertIn("delivers nothing", why)

    def test_routing_on_with_no_rule_bounces(self):
        # nationalfilmfestivals.com's exact state: enabled, no rule,
        # because the step that creates one was skipped.
        ok, why = in_verdict("a.test", True, [], LIVE, "hello")
        self.assertFalse(ok)
        self.assertIn("bounces", why)

    def test_an_unverified_destination_is_the_silent_failure(self):
        # Cloudflare accepts the rule and drops the mail. Nothing
        # anywhere reports an error; the sender just never hears back.
        ok, why = in_verdict("a.test", True, ruled("hello@a.test", "a@x.test"), PENDING, "hello")
        self.assertFalse(ok)
        self.assertIn("dropped", why)

    def test_a_disabled_rule_is_not_a_rule(self):
        rules = ruled("hello@a.test", "a@x.test", enabled=False)
        self.assertFalse(in_verdict("a.test", True, rules, LIVE, "hello")[0])

    def test_a_rule_forwarding_nowhere_is_not_a_rule_either(self):
        self.assertFalse(in_verdict("a.test", True, ruled("hello@a.test"), LIVE, "hello")[0])

    def test_all_three_together_is_the_only_yes(self):
        ok, why = in_verdict("a.test", True, ruled("hello@a.test", "a@x.test"), LIVE, "hello")
        self.assertTrue(ok)
        self.assertIn("hello@a.test", why)

    def test_the_destination_is_never_printed(self):
        # This output goes to a CI log and a step summary.
        for addresses in (LIVE, PENDING):
            _, why = in_verdict("a.test", True, ruled("hello@a.test", "a@x.test"), addresses, "hello")
            self.assertNotIn("a@x.test", why)
            self.assertIn("a*@x*.test", why)


class ZoneStatus(unittest.TestCase):
    """A pending zone serves no DNS, so nothing else about it is true."""

    def test_a_pending_zone_says_the_real_reason(self):
        # screeningstudio.com. It carries Cloudflare's MX records and
        # refused to enable routing with `2009 Active zone required`.
        # Two provisioning runs could not fix it, because the fix is at
        # the registrar. Reporting "MX points at Cloudflare but routing
        # is off" described the symptom and pointed at the wrong
        # dashboard.
        ok, why = in_verdict("a.test", False, [], LIVE, "hello",
                             ["route1.mx.cloudflare.net"], "pending")
        self.assertFalse(ok)
        self.assertIn("PENDING", why)
        self.assertIn("registrar", why)

    def test_it_outranks_every_other_reason(self):
        # Even a zone that looks perfectly configured. Records that no
        # resolver will be sent to are not configuration.
        rules = ruled("hello@a.test", "a@x.test")
        self.assertFalse(in_verdict("a.test", True, rules, LIVE, "hello", [], "pending")[0])

    def test_a_pending_zone_cannot_send_however_onboarded_it_looks(self):
        # Proved by a real send, not reasoned about: wrangler lists
        # mail.screeningstudio.com as onboarded, this column said yes,
        # and the send was refused 400 10202 for BOTH probes including
        # one to a verified destination. Cloudflare serves no DNS for a
        # pending zone, so the DKIM record it wrote is published
        # nowhere, and a signature nothing can look up is not one.
        ok, why = out_verdict("a.test", {"mail.a.test"}, "", "mail", "pending")
        self.assertFalse(ok)
        self.assertIn("PENDING", why)

    def test_an_active_zone_is_judged_on_its_mail_settings(self):
        rules = ruled("hello@a.test", "a@x.test")
        self.assertTrue(in_verdict("a.test", True, rules, LIVE, "hello", [], "active")[0])


class Report(unittest.TestCase):
    def rows(self, **kw):
        base = {"zone": "a.test", "out": True, "out_why": "o", "in": True, "in_why": "i"}
        return [{**base, **kw}]

    def test_green_only_when_both_halves_hold(self):
        self.out = io.StringIO()
        with contextlib.redirect_stdout(self.out):
            self.assertEqual(report(self.rows()), 0)
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(report(self.rows(out=False)), 1)
            self.assertEqual(report(self.rows(**{"in": False})), 1)

    def test_no_zones_at_all_is_a_failure_not_a_clean_sheet(self):
        # An empty table reading "all 0 domains send and receive" is the
        # summary-that-describes-nothing bug, in its purest form.
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(report([]), 1)
        self.assertIn("NO ZONES", out.getvalue())

    def test_the_broken_ones_are_named(self):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            report(self.rows(zone="broken.test", out=False))
        self.assertIn("broken.test", out.getvalue())


class Delegation(unittest.TestCase):
    """The failure that took a day to find and shows in no dashboard."""

    CF = ["camilo.ns.cloudflare.com", "delilah.ns.cloudflare.com"]

    WRONG = ["rick.ns.cloudflare.com.", "becky.ns.cloudflare.com."]

    def test_the_wrong_cloudflare_pair_on_a_dead_zone_is_caught(self):
        # screeningstudio.com exactly. The registry delegated to
        # rick/becky while the zone was assigned camilo/delilah, and the
        # zone was MOVED rather than active. Both pairs are Cloudflare's,
        # so the registrar UI looks right and the Cloudflare zone page
        # looks right -- and the domain resolved nowhere. Site and mail
        # dark for one wrong pair of names.
        ok, why = delegation_verdict(self.CF, self.WRONG, "moved")
        self.assertFalse(ok)
        self.assertIn("WRONG NAMESERVERS", why)
        self.assertIn("rick.ns.cloudflare.com", why)
        self.assertIn("camilo.ns.cloudflare.com", why)

    def test_the_same_mismatch_on_an_ACTIVE_zone_does_not_claim_an_outage(self):
        # MEASURED, and it is why `status` exists. screening.studio held
        # a mismatched pair while resolving perfectly and serving its
        # site through Cloudflare's edge. The first version of this
        # verdict called that "resolves NOWHERE -- site and mail alike",
        # which was simply false about a working domain.
        #
        # Still a finding: the delegation and the assignment disagree,
        # and that is the state the domain goes dark from the next time
        # the zone is touched. But a report that calls a live domain
        # dead is a report that gets ignored, and this file has made
        # that mistake twice already.
        ok, why = delegation_verdict(self.CF, self.WRONG, "active")
        self.assertFalse(ok)
        self.assertNotIn("NOWHERE", why)
        self.assertIn("nothing is down right now", why)
        self.assertIn("rick.ns.cloudflare.com", why)

    def test_an_unknown_status_keeps_the_louder_wording(self):
        # No status means no evidence the zone is serving, and the
        # quieter message asserts that it is.
        _, why = delegation_verdict(self.CF, self.WRONG)
        self.assertIn("WRONG NAMESERVERS", why)

    def test_a_matching_delegation_passes(self):
        self.assertTrue(delegation_verdict(self.CF, list(self.CF))[0])

    def test_order_and_trailing_dots_and_case_do_not_matter(self):
        # A registry answer is fully qualified and Cloudflare's is not.
        # Comparing them literally would flag every healthy zone, and a
        # check that cries wolf everywhere gets deleted.
        ok, _ = delegation_verdict(
            self.CF, ["DELILAH.ns.Cloudflare.com.", "camilo.ns.cloudflare.com."])
        self.assertTrue(ok)

    def test_no_delegation_at_all_is_a_lapsed_registration(self):
        # Different problem, opposite action: renewing helps and
        # changing nameservers does nothing.
        ok, why = delegation_verdict(self.CF, [])
        self.assertFalse(ok)
        self.assertIn("lapsed", why)
        self.assertNotIn("WRONG NAMESERVERS", why)

    def test_could_not_ask_is_never_reported_as_lapsed(self):
        # The first version of this check reported all EIGHTEEN live
        # domains as expired registrations, because `dig +short` returns
        # nothing for a referral and empty was read as "no delegation".
        # A false alarm that tells somebody to renew eighteen working
        # domains is worse than no check at all.
        ok, why = delegation_verdict(self.CF, None)
        self.assertTrue(ok)
        self.assertIn("could not ask", why)
        self.assertNotIn("lapsed", why)

    def test_nothing_to_compare_against_is_not_a_failure(self):
        # Unreadable is not wrong, for the eighth time today.
        self.assertTrue(delegation_verdict([], ["ns1.example.com"])[0])


class Dmarc(unittest.TestCase):
    """The apex, not a subdomain — which is how ontold.com's was missed."""

    APEX = 'TXT _dmarc.a.test -> "v=DMARC1; p=reject; sp=reject"'
    SUB = 'TXT _dmarc.mail.a.test -> "v=DMARC1; p=reject;"'

    def test_a_policy_on_the_apex_is_the_one_that_counts(self):
        ok, why = dmarc_verdict("a.test", [self.APEX])
        self.assertTrue(ok)
        self.assertIn("p=reject", why)

    def test_a_policy_on_the_SUBDOMAIN_does_not_cover_the_apex(self):
        # ontold.com exactly: DMARC on mail.ontold.com, none on
        # ontold.com. Everything sends and delivers, and the domain
        # customers see gives receivers no instruction about forgery.
        ok, why = dmarc_verdict("a.test", [self.SUB])
        self.assertFalse(ok)
        self.assertIn("no DMARC", why)

    def test_a_txt_that_is_not_dmarc_does_not_count(self):
        spf = 'TXT _dmarc.a.test -> "v=spf1 -all"'
        self.assertFalse(dmarc_verdict("a.test", [spf])[0])

    def test_it_is_found_among_other_records(self):
        ok, _ = dmarc_verdict("a.test", ["A a.test -> 1.2.3.4", self.SUB, self.APEX])
        self.assertTrue(ok)


class ModuleShape(unittest.TestCase):
    def test_nothing_is_defined_after_the_main_guard(self):
        # Two probes were appended to the end of the file, below
        # `if __name__ == "__main__": raise SystemExit(main(...))`. The
        # module parses, every test passes, and the only symptom is a
        # NameError on a runner when main() reaches a function that
        # does not exist yet. Nothing static catches it; this does.
        src = (Path(__file__).resolve().parents[0] / "mail_estate.py").read_text()
        self.assertTrue(
            src.rstrip().endswith("raise SystemExit(main(sys.argv[1:]))"),
            "something is defined after the __main__ guard, so it does not exist when main() runs",
        )


class Zones(unittest.TestCase):
    def test_a_zone_without_an_id_is_not_a_zone(self):
        import scripts.mail_estate as m
        real, m._call = m._call, lambda *a, **k: {
            "success": True,
            "result": [{"name": "b.test", "id": "2", "status": "active"},
                       {"name": "no-id.test"},
                       {"name": "a.test", "id": "1", "status": "pending"}],
        }
        try:
            got = zones("t", "acc")
            self.assertEqual([z["name"] for z in got], ["a.test", "b.test"])
            # Carried through, because it decides the verdict.
            self.assertEqual([z["status"] for z in got], ["pending", "active"])
        finally:
            m._call = real


if __name__ == "__main__":
    unittest.main()
