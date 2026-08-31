"""Sending mail, and reading the answer correctly.

Two things are pinned and neither is about the network.

A send must never raise: every call site is a side effect of something
the caller has already succeeded at, and here that is a purchase. A mail
outage that became a failed transaction would be a lie about somebody's
own money.

And a probe's STATUS is not the answer. Cloudflare replies 404 for both
"no such route" and "not authorised", and 200 for a send to an inbox we
already control on a platform that can reach nobody else.
"""

from __future__ import annotations

import os
import re
import unittest
from pathlib import Path

from api._mail import (
    DEFAULT_MAIL_FROM,
    DEFAULT_NOTIFY_URL,
    HELLO,
    MAIL_ZONE,
    configured,
    mail_from,
    notify_token,
    notify_url,
    send,
    sending_domain,
    verdict_for,
)


class Addresses(unittest.TestCase):
    def test_the_sending_domain_is_a_subdomain_of_the_mail_zone(self) -> None:
        # A transactional sender wants its own subdomain: it carries the
        # SPF and DKIM records and keeps a bounce rate off the
        # reputation of the domain the site is served on.
        #
        # This briefly asserted the apex instead, because the zone
        # carried a DKIM key there and that looked like onboarding. It
        # was another provider's key and the send was refused the same
        # way — so the address came back here, and what has to change is
        # the domain's onboarding, not the address.
        self.assertNotEqual(sending_domain(DEFAULT_MAIL_FROM), MAIL_ZONE)
        self.assertTrue(sending_domain(DEFAULT_MAIL_FROM).endswith(MAIL_ZONE))

    def test_the_worker_sends_from_the_same_address_this_reports(self) -> None:
        # The Worker holds the binding and its own MAIL_FROM var, so
        # THAT is what goes on the wire. If the two disagree,
        # mail_check.py describes a send that did not happen — and the
        # reason a probe exists is to be believed.
        toml = (Path(__file__).resolve().parent.parent
                / "workers" / "mcp" / "wrangler.toml").read_text(encoding="utf-8")
        match = re.search(r'^MAIL_FROM\s*=\s*"([^"]+)"', toml, re.M)
        self.assertIsNotNone(match, "the Worker no longer sets MAIL_FROM")
        self.assertEqual(match.group(1), DEFAULT_MAIL_FROM)

    def test_mail_is_on_a_zone_this_account_actually_holds(self) -> None:
        # ontold.com is NOT one — workers/mcp/wrangler.toml records that
        # the token covers workais.app, ontold.site and onloved.com. A
        # sending subdomain on a zone that is not here can never be
        # onboarded, and every send is refused with the credential
        # present and the DNS looking correct.
        self.assertNotEqual(MAIL_ZONE, "ontold.com")

    def test_replies_reach_a_person(self) -> None:
        # People reply to no-reply addresses. With no reply path they get
        # a bounce from a mailbox nobody reads, and we never learn they
        # wrote.
        self.assertTrue(HELLO.startswith("hello@"))
        self.assertNotIn("no-reply", HELLO)

    def test_the_sender_is_overridable_without_a_deploy(self) -> None:
        # The symptom of a wrong sending domain is nothing at all until
        # the first real send is refused.
        os.environ["MAIL_FROM"] = "someone@elsewhere.test"
        try:
            self.assertEqual(mail_from(), "someone@elsewhere.test")
        finally:
            os.environ.pop("MAIL_FROM", None)


class Sending(unittest.TestCase):
    SECRETS = ("MCP_TOKEN", "ROOT_SECRET", "SIGNING_SECRET")

    def test_no_cloudflare_token_is_needed(self) -> None:
        # The point of going through the Worker. A credential that can
        # mail anyone does not belong in this deployment, and the
        # send_email binding means it does not have to be.
        for name in ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"):
            os.environ.pop(name, None)
        os.environ["ROOT_SECRET"] = "a-root-secret"
        try:
            self.assertTrue(configured())
        finally:
            os.environ.pop("ROOT_SECRET", None)

    def test_absent_credentials_are_a_valid_state(self) -> None:
        # The right one for a preview deploy: the flow works end to end
        # and nobody is emailed by a test.
        for name in self.SECRETS:
            os.environ.pop(name, None)
        self.assertFalse(configured())
        self.assertFalse(send("someone@example.com", "s", "t"))

    def test_the_bearer_is_one_that_already_exists(self) -> None:
        # Nothing new to configure for mail to work, and nothing extra to
        # rotate. Same order the Worker resolves it in.
        for name in self.SECRETS:
            os.environ.pop(name, None)
        os.environ["SIGNING_SECRET"] = "sig"
        try:
            self.assertEqual(notify_token(), "sig")
            os.environ["MCP_TOKEN"] = "mcp"
            self.assertEqual(notify_token(), "mcp")
        finally:
            for name in self.SECRETS:
                os.environ.pop(name, None)

    def test_the_worker_is_overridable_for_a_preview(self) -> None:
        self.assertEqual(notify_url(), DEFAULT_NOTIFY_URL)
        os.environ["NOTIFY_URL"] = "https://preview.example/notify"
        try:
            self.assertEqual(notify_url(), "https://preview.example/notify")
        finally:
            os.environ.pop("NOTIFY_URL", None)

    def test_a_send_never_raises(self) -> None:
        # A mail outage must not become a failed purchase. An unreachable
        # Worker is the shape most likely to throw somewhere careless.
        os.environ["ROOT_SECRET"] = "a-root-secret"
        os.environ["NOTIFY_URL"] = "http://127.0.0.1:9/notify"
        try:
            self.assertFalse(send("someone@example.com", "s", "t"))
        finally:
            os.environ.pop("ROOT_SECRET", None)
            os.environ.pop("NOTIFY_URL", None)


class Verdicts(unittest.TestCase):
    DOMAIN = "mail.ontold.com"

    def test_a_2xx_says_why_it_means_onboarded(self) -> None:
        v = verdict_for(200, "", self.DOMAIN)
        self.assertTrue(v.startswith("onboarded"))
        # The reasoning has to be in the message: the probe address is not
        # a verified destination, which is the only thing that makes a 200
        # mean more than "we mailed ourselves".
        self.assertIn("non-verified", v)

    def test_a_bearer_mismatch_is_not_reported_as_a_domain_problem(self) -> None:
        # Different fixes — one value copied to two places versus a
        # dashboard onboarding — and conflating them is what cost several
        # diagnoses.
        v = verdict_for(401, "unauthorized", self.DOMAIN)
        self.assertTrue(v.startswith("NOT READY"))
        self.assertIn("bearer", v)
        self.assertNotIn("onboarded", v)

    def test_a_403_is_read_as_never_having_reached_the_worker(self) -> None:
        # /notify returns 202, 401, 400, 404, 405, 502 and 503, and never
        # a 403. One means something in front of it answered — a WAF
        # rule, Bot Fight Mode, Access — so the send was not refused;
        # it was not attempted, and calling that "not onboarded" sends
        # somebody to the wrong dashboard.
        v = verdict_for(403, "", self.DOMAIN)
        self.assertIn("BEFORE it reached the Worker", v)
        self.assertNotIn("not onboarded", v)

    def test_a_worker_that_cannot_send_says_which_half_is_missing(self) -> None:
        v = verdict_for(503, "no send_email binding on this deployment", self.DOMAIN)
        self.assertIn("reachable but cannot send", v)
        self.assertIn("send_email binding", v)

    def test_the_refusal_the_first_real_send_returned(self) -> None:
        # Verbatim from Cloudflare, through the send_email binding, on
        # the first send that got all the way there. It is the answer
        # this probe exists to get and it must not read as anything
        # else — particularly not as a credential problem, which would
        # send somebody to rotate a token that is working.
        v = verdict_for(502, "refused could not find domain config of sending domain", self.DOMAIN)
        self.assertIn("not onboarded", v)
        self.assertIn("Email Sending", v)
        self.assertNotIn("token", v)

    def test_only_verified_destinations_reads_as_not_onboarded(self) -> None:
        # The answer this whole probe exists to get. Cloudflare accepts
        # verified destination addresses long before a sending domain is
        # onboarded, so this wording is the signature of a platform that
        # can mail us and nobody else.
        v = verdict_for(502, "refused destination address not verified", self.DOMAIN)
        self.assertTrue(v.startswith("NOT READY"))
        self.assertIn("not onboarded", v)
        self.assertIn(self.DOMAIN, v)

    def test_a_refusal_with_no_reason_says_so_rather_than_guessing(self) -> None:
        v = verdict_for(500, "", self.DOMAIN)
        self.assertIn("no reason given", v)


if __name__ == "__main__":
    unittest.main()
