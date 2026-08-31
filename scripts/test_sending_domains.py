"""Reading an onboarded sending domain out of the zone's DNS.

The question this answers is not "is there a DKIM record" but "WHICH
NAME was onboarded" — because the failure it exists to catch is a
sending address on a subdomain that was never the onboarded one, which
looks correct from every side until a real send is refused.
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from scripts.sending_domains import cloudflare_ready, sending_names  # noqa: E402


class TestSendingNames(unittest.TestCase):
    def test_the_selector_is_not_part_of_the_answer(self):
        # cf2024-1._domainkey.mail.ontold.site means mail.ontold.site is
        # what was onboarded. Reporting the whole record name would send
        # somebody to put a selector in MAIL_FROM.
        rows = [{"name": "cf2024-1._domainkey.mail.ontold.site"}]
        self.assertEqual(sending_names(rows), ["mail.ontold.site"])

    def test_finds_the_case_this_was_written_for(self):
        # nationalff carried `mail.` in code while `mx.` was onboarded.
        # If that shape recurs here, MAIL_FROM fixes it with no deploy —
        # but only if the report names `mx.` rather than shrugging.
        rows = [
            {"name": "cf2024-1._domainkey.mx.ontold.site"},
            {"name": "ontold.site"},
        ]
        self.assertEqual(sending_names(rows), ["mx.ontold.site"])

    def test_reports_every_onboarded_domain_not_just_the_first(self):
        rows = [
            {"name": "cf2024-1._domainkey.mx.a.test"},
            {"name": "s1._domainkey.mail.a.test"},
        ]
        self.assertEqual(sending_names(rows), ["mail.a.test", "mx.a.test"])

    def test_two_selectors_on_one_domain_are_one_answer(self):
        # Key rotation leaves two records. That is one onboarded domain,
        # and listing it twice would read as two places to choose from.
        rows = [
            {"name": "cf2024-1._domainkey.mail.a.test"},
            {"name": "cf2024-2._domainkey.mail.a.test"},
        ]
        self.assertEqual(sending_names(rows), ["mail.a.test"])

    def test_an_spf_or_dmarc_record_is_not_an_onboarded_domain(self):
        # Both can be written by hand, and neither means Cloudflare will
        # accept a send. Treating them as proof is how a probe reports
        # ready on a platform that can reach nobody.
        rows = [
            {"name": "a.test", "content": "v=spf1 include:_spf.mx.cloudflare.net ~all"},
            {"name": "_dmarc.a.test", "content": "v=DMARC1; p=none"},
        ]
        self.assertEqual(sending_names(rows), [])

    def test_no_records_at_all_is_no_answer_rather_than_a_crash(self):
        self.assertEqual(sending_names([]), [])


class TestCloudflareReady(unittest.TestCase):
    """Whose key is it — the distinction that cost two send attempts."""

    def test_somebody_elses_dkim_key_is_not_onboarding(self):
        # ontold.site carried a DKIM key, the report called it
        # onboarded, the sender moved to the apex on that basis, and the
        # send was refused exactly as before. The key was another
        # provider's. A DKIM record means SOME provider can sign for the
        # name; only a Cloudflare selector says Cloudflare can.
        rows = [{"name": "google._domainkey.a.test"},
                {"name": "s1._domainkey.a.test"}]
        self.assertEqual(sending_names(rows), ["a.test"])   # a key exists
        self.assertEqual(cloudflare_ready(rows), [])        # and it is not ours

    def test_a_cloudflare_selector_is_the_answer(self):
        rows = [{"name": "cf2024-1._domainkey.mail.a.test"}]
        self.assertEqual(cloudflare_ready(rows), ["mail.a.test"])

    def test_the_selector_a_live_onboarded_domain_actually_uses(self):
        # Verbatim from the Email Sending settings page for
        # mail.ontold.site, which was onboarded and working while this
        # script called it unonboarded. Matching only `cf2024-` was a
        # false negative on a live domain — worse than the false
        # positive it was written to prevent, because it sends somebody
        # to redo something already done.
        rows = [{"name": "cf-bounce._domainkey.mail.ontold.site"}]
        self.assertEqual(cloudflare_ready(rows), ["mail.ontold.site"])

    def test_a_foreign_key_alongside_ours_does_not_hide_it(self):
        # A domain can carry both. Ours being present is what matters.
        rows = [{"name": "google._domainkey.a.test"},
                {"name": "cf2024-1._domainkey.a.test"}]
        self.assertEqual(cloudflare_ready(rows), ["a.test"])

    def test_no_records_is_no_domains(self):
        self.assertEqual(cloudflare_ready([]), [])


if __name__ == "__main__":
    unittest.main()
