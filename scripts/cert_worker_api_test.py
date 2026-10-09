"""Offline PSA API contract tests: fake sessions, no network or real secrets."""
import copy
import io
import json
import os
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from unittest.mock import MagicMock, patch

from cert_worker_api import classify_psa_api, read_psa_api
import cert_worker_runtime as runtime

CERT = "0023483296"
URL = "https://api.psacard.com/publicapi/cert/GetByCertNumber/" + CERT
TOKEN = "fixture-psa-token-not-a-real-secret"
WORKER_KEY = "fixture-hub-worker-key-not-a-real-secret"
PAYLOAD = {
    "IsValidRequest": True, "ServerMessage": "Request successful",
    "PSACert": {
        "CertNumber": CERT, "GradeDescription": "GEM MT 10", "CardGrade": "10",
        "Subject": "LEBRON JAMES", "Brand": "TOPPS CHROME", "CardNumber": "111",
        "Year": "2003", "Variety": "BLACK REFRACTOR", "LabelType": "W/ FUGITIVE INK TECHNOLOGY",
        "TotalPopulation": 20, "PopulationHigher": 0,
    },
}
JOB = {"id": "fixture-job", "lease_token": "fixture-lease", "provider": "psa",
       "cert_number": CERT, "lookup_url": "https://www.psacard.com/cert/" + CERT}
API_ENV = {"PSA_LOOKUP_MODE": "api", "PSA_API_TOKEN": TOKEN,
           "PSA_WORKER_KEY": WORKER_KEY, "SITE": "https://tcghub.kr"}


def payload_with(**fields):
    value = copy.deepcopy(PAYLOAD)
    value["PSACert"].update(fields)
    return value


def fake_session(status=200, content_type="application/json", retry_after="", url=URL):
    response = MagicMock()
    response.url = url
    response.status_code = status
    response.headers = {"Content-Type": content_type, "Retry-After": retry_after}
    response.json.return_value = copy.deepcopy(PAYLOAD)
    session = MagicMock()
    session.get.return_value = response
    return session, response


class PsaApiClassifierTests(unittest.TestCase):
    def classify(self, payload=PAYLOAD, **kwargs):
        return classify_psa_api(payload, CERT, URL, **kwargs)

    def assert_rejected(self, value, outcome="parse_error"):
        self.assertEqual(value["outcome"], outcome)
        self.assertNotIn("record", value)

    def test_valid_card_and_population_record(self):
        value = self.classify()
        self.assertEqual(value["outcome"], "success")
        self.assertEqual(value["record"], {
            "cert_number": CERT, "grade_text": "GEM MT 10", "subject": "LEBRON JAMES",
            "brand": "TOPPS CHROME", "year": "2003", "card_number": "111",
            "variety": "BLACK REFRACTOR", "label": "W/ FUGITIVE INK TECHNOLOGY",
            "pop_total": 20, "pop_higher": 0, "source_url": URL,
        })

    def test_both_zero_populations_are_valid(self):
        value = self.classify(payload_with(TotalPopulation=0, PopulationHigher=0))
        self.assertEqual(value["outcome"], "success")
        self.assertEqual(value["record"]["pop_total"], 0)
        self.assertEqual(value["record"]["pop_higher"], 0)

    def test_mint_nine_grade_is_preserved(self):
        value = self.classify(payload_with(GradeDescription="MINT 9", CardGrade="9"))
        self.assertEqual(value["outcome"], "success")
        self.assertEqual(value["record"]["grade_text"], "MINT 9")

    def test_leading_zeroes_must_not_be_guessed_or_lost(self):
        for cert in (23483296, "23483296", "0023483297", "", None):
            with self.subTest(cert=cert):
                self.assert_rejected(self.classify(payload_with(CertNumber=cert)))

    def test_invalid_requested_identity_is_rejected(self):
        for cert in (23483296, None, "123", "../../etc/passwd", "1" * 13):
            with self.subTest(cert=cert):
                self.assert_rejected(classify_psa_api(PAYLOAD, cert, URL))

    def test_missing_identity_is_rejected(self):
        payload = copy.deepcopy(PAYLOAD)
        del payload["PSACert"]["CertNumber"]
        self.assert_rejected(self.classify(payload))

    def test_grade_description_and_card_grade_must_agree(self):
        for description, grade in (("MINT 9", "10"), ("GEM MT 10", "9"), ("GEM MT 10", "AUTHENTIC")):
            with self.subTest(description=description, grade=grade):
                self.assert_rejected(self.classify(payload_with(GradeDescription=description, CardGrade=grade)))

    def test_unsupported_authentication_and_qualified_grades_are_rejected(self):
        for grade in ("AUTHENTIC", "AUTHENTIC 10", "AUTH 10", "ALTERED 10", "TRIMMED 10",
                      "MINT 9 (OC)", "MINT 9 (ST)", "MINT 9 (PD)", "MINT 9 (OF)",
                      "MINT 9 (MK)", "MINT 9 (MC)", "MINT 9 OC", "MINT 9 qualifier"):
            with self.subTest(grade=grade):
                self.assert_rejected(self.classify(payload_with(
                    GradeDescription=grade, CardGrade="9" if "9" in grade else "10")))

    def test_ambiguous_grade_is_not_truncated(self):
        self.assert_rejected(self.classify(payload_with(GradeDescription="Card 10 Autograph 9", CardGrade="10")))

    def test_missing_grade_is_rejected(self):
        self.assert_rejected(self.classify(payload_with(GradeDescription="", CardGrade="")))

    def test_required_card_metadata_cannot_be_empty_or_nontext(self):
        for field in ("Subject", "Brand", "CardNumber"):
            for invalid in (None, "", "  ", 111, [], {}):
                with self.subTest(field=field, invalid=invalid):
                    self.assert_rejected(self.classify(payload_with(**{field: invalid})))

    def test_missing_population_is_unknown_and_never_success(self):
        for field in ("TotalPopulation", "PopulationHigher"):
            with self.subTest(field=field):
                payload = copy.deepcopy(PAYLOAD)
                del payload["PSACert"][field]
                value = self.classify(payload)
                self.assert_rejected(value, "temporary_error")
                self.assertEqual(value["error_code"], "psa_api_population_unavailable")

    def test_population_requires_nonnegative_whole_numbers(self):
        for field in ("TotalPopulation", "PopulationHigher"):
            for invalid in (None, "", -1, 1.5, "-1", "1.5", True, False, [], {}):
                with self.subTest(field=field, invalid=invalid):
                    value = self.classify(payload_with(**{field: invalid}))
                    self.assert_rejected(value, "temporary_error")
                    self.assertEqual(value["error_code"], "psa_api_population_unavailable")

    def test_exact_official_url_is_required(self):
        for url in (URL.replace("https:", "http:"), URL + "?anything=1", URL + "/",
                    URL.replace(CERT, "0023483297"),
                    URL.replace("api.psacard.com", "api.psacard.com.evil.invalid"),
                    "https://www.psacard.com/cert/" + CERT,
                    "https://evil.invalid/", "https://api.psacard.com@evil.invalid/"):
            with self.subTest(url=url):
                self.assert_rejected(classify_psa_api(PAYLOAD, CERT, url), "blocked")

    def test_authentication_and_forbidden_are_blocked(self):
        for status in (401, 403):
            with self.subTest(status=status):
                self.assert_rejected(self.classify(status=status), "blocked")

    def test_rate_limit_honors_delta_retry_after(self):
        value = self.classify(status=429, retry_after="7200")
        self.assert_rejected(value, "blocked")
        self.assertGreaterEqual(value["retry_after_seconds"], 7200)

    def test_rate_limit_honors_http_date_retry_after(self):
        deadline = datetime.now(timezone.utc) + timedelta(hours=2)
        value = self.classify(status=429, retry_after=format_datetime(deadline, usegmt=True))
        self.assert_rejected(value, "blocked")
        self.assertGreaterEqual(value["retry_after_seconds"], 7195)

    def test_rate_limit_without_valid_retry_after_still_backs_off(self):
        for retry in ("", "not a date", "-10"):
            with self.subTest(retry=retry):
                value = self.classify(status=429, retry_after=retry)
                self.assert_rejected(value, "blocked")
                self.assertGreater(value["retry_after_seconds"], 0)

    def test_redirect_is_blocked_even_with_valid_json(self):
        for status in (301, 302, 307, 308):
            with self.subTest(status=status):
                self.assert_rejected(self.classify(status=status), "blocked")

    def test_server_errors_are_temporary_not_absent_records(self):
        for status in (500, 502, 503, 504):
            with self.subTest(status=status):
                self.assert_rejected(self.classify(status=status), "temporary_error")

    def test_html_response_is_temporary(self):
        self.assert_rejected(self.classify("<html>maintenance</html>", content_type="text/html"), "temporary_error")

    def test_explicit_no_data_found_is_required(self):
        value = self.classify({"IsValidRequest": True, "ServerMessage": "No data found", "PSACert": None})
        self.assertEqual(value["outcome"], "not_found")
        self.assertNotIn("record", value)

    def test_absence_is_not_inferred_from_status_or_ambiguous_payload(self):
        candidates = (None, [], {}, {"PSACert": None}, {"ServerMessage": "No data found"},
                      {"IsValidRequest": False, "ServerMessage": "No data found"},
                      {"IsValidRequest": "true", "ServerMessage": "No data found"},
                      {"IsValidRequest": True, "ServerMessage": "Request failed"},
                      {"IsValidRequest": True, "ServerMessage": "No data found", "PSACert": {}})
        for payload in candidates:
            with self.subTest(payload=payload):
                value = self.classify(payload)
                self.assertNotIn(value["outcome"], ("success", "not_found"))
                self.assertNotIn("record", value)
        value = self.classify({"IsValidRequest": True, "ServerMessage": "No data found"}, status=404)
        self.assertNotEqual(value["outcome"], "not_found")


class PsaApiReaderTests(unittest.TestCase):
    def test_missing_token_returns_blocked_without_any_network(self):
        for token in (None, "", "  "):
            with self.subTest(token=token):
                session = MagicMock()
                value = read_psa_api(session, JOB, token)
                self.assertEqual(value["outcome"], "blocked")
                self.assertEqual(value["error_code"], "psa_api_token_missing")
                self.assertEqual(session.mock_calls, [])

    def test_fixed_endpoint_bearer_header_timeout_and_no_redirects(self):
        session, response = fake_session()
        job = {**JOB, "lookup_url": "https://evil.invalid/", "worker_key": WORKER_KEY}
        value = read_psa_api(session, job, TOKEN)
        self.assertEqual(value["outcome"], "success")
        session.get.assert_called_once_with(
            URL, headers={"Authorization": "Bearer " + TOKEN, "Accept": "application/json"},
            allow_redirects=False, timeout=(5, 25))
        response.json.assert_called_once_with()
        session.headers.update.assert_not_called()
        session.post.assert_not_called()
        self.assertNotIn(WORKER_KEY, str(session.get.call_args))
        self.assertNotIn(JOB["lease_token"], str(session.get.call_args))

    def test_invalid_cert_never_reaches_the_network(self):
        for cert in (None, 23483296, "../../secret", "123", "1" * 13):
            with self.subTest(cert=cert):
                session = MagicMock()
                value = read_psa_api(session, {**JOB, "cert_number": cert}, TOKEN)
                self.assertEqual(value["outcome"], "parse_error")
                self.assertEqual(session.mock_calls, [])

    def test_response_url_is_validated(self):
        session, _ = fake_session(url="https://evil.invalid/")
        self.assertEqual(read_psa_api(session, JOB, TOKEN)["outcome"], "blocked")
        self.assertEqual(session.get.call_count, 1)

    def test_redirect_never_follows_location(self):
        session, response = fake_session(status=302)
        response.headers["Location"] = "https://evil.invalid/"
        self.assertEqual(read_psa_api(session, JOB, TOKEN)["outcome"], "blocked")
        self.assertEqual(session.get.call_count, 1)
        self.assertIs(session.get.call_args.kwargs["allow_redirects"], False)

    def test_http_status_and_retry_header_are_passed_to_classifier(self):
        session, _ = fake_session(status=429, retry_after="7200")
        value = read_psa_api(session, JOB, TOKEN)
        self.assertEqual(value["outcome"], "blocked")
        self.assertGreaterEqual(value["retry_after_seconds"], 7200)
        self.assertEqual(session.get.call_count, 1)

    def test_non_json_does_not_attempt_json_parsing(self):
        session, response = fake_session(content_type="text/html")
        self.assertEqual(read_psa_api(session, JOB, TOKEN)["outcome"], "temporary_error")
        response.json.assert_not_called()

    def test_broken_json_never_becomes_success_or_not_found(self):
        session, response = fake_session()
        response.json.side_effect = ValueError("fixture invalid JSON")
        value = read_psa_api(session, JOB, TOKEN)
        self.assertNotIn(value["outcome"], ("success", "not_found"))
        self.assertNotIn("record", value)


class RuntimeModeTests(unittest.TestCase):
    def test_api_check_works_without_playwright_and_never_prints_tokens(self):
        output = io.StringIO()
        def available(name):
            return object() if name == "requests" else None
        with patch.dict(os.environ, API_ENV, clear=True), redirect_stdout(output), \
                patch.object(runtime.importlib.util, "find_spec", side_effect=available):
            status = runtime.check()
        self.assertEqual(status, 0)
        data = json.loads(output.getvalue())
        self.assertFalse(data["playwright_installed"])
        self.assertFalse(data["human_challenge_dependency"])
        self.assertTrue(data["psa_api_token_configured"])
        self.assertNotIn(TOKEN, output.getvalue())
        self.assertNotIn(WORKER_KEY, output.getvalue())

    def test_api_run_without_token_exits_before_lock_logging_or_network(self):
        env = {**API_ENV, "PSA_API_TOKEN": ""}
        with patch.dict(os.environ, env, clear=True), redirect_stdout(io.StringIO()), \
                patch.object(runtime, "configure_logging") as logging, \
                patch.object(runtime, "acquire_lock") as lock, \
                patch("requests.Session") as session, \
                patch.object(runtime, "ChromeReader") as chrome:
            self.assertEqual(runtime.run(), 2)
        logging.assert_not_called()
        lock.assert_not_called()
        session.assert_not_called()
        chrome.assert_not_called()

    def test_api_run_uses_separate_psa_session_and_never_creates_browser(self):
        hub, bgs, psa = MagicMock(), MagicMock(), MagicMock()
        response = MagicMock(status_code=200)
        response.json.return_value = {"ok": True, "jobs": [JOB]}
        hub.post.return_value = response
        outcome = {"outcome": "success", "record": {"cert_number": CERT}}
        lock = MagicMock()
        with patch.dict(os.environ, API_ENV, clear=True), \
                patch.object(runtime, "configure_logging"), \
                patch.object(runtime, "acquire_lock", return_value=lock), \
                patch("requests.Session", side_effect=[hub, bgs, psa]), \
                patch.object(runtime, "ChromeReader") as chrome, \
                patch.object(runtime, "read_psa_api", return_value=outcome) as reader, \
                patch.object(runtime, "saved_psa_retry_deadline", return_value=None), \
                patch.object(runtime, "post_result", return_value="accepted") as post_result, \
                patch.object(runtime.time, "sleep", side_effect=KeyboardInterrupt):
            self.assertEqual(runtime.run(), 0)
        chrome.assert_not_called()
        reader.assert_called_once_with(psa, JOB, TOKEN)
        post_result.assert_called_once_with(hub, "https://tcghub.kr",
                                           {"x-psa-worker-key": WORKER_KEY}, JOB, outcome)
        self.assertNotIn(TOKEN, str(hub.post.call_args))
        psa.headers.update.assert_not_called()
        psa.close.assert_called_once_with()
        lock.close.assert_called_once_with()


class StartupCooldownTests(unittest.TestCase):
    NOW = 1791187440.0

    def run_job(self, job, deadline):
        hub, bgs, psa = MagicMock(), MagicMock(), MagicMock()
        response = MagicMock(status_code=200)
        response.json.return_value = {"ok": True, "jobs": [job]}
        hub.post.return_value = response
        outcome = {"outcome": "success", "record": {"cert_number": job["cert_number"]}}
        with patch.dict(os.environ, API_ENV, clear=True), \
                patch.object(runtime, "configure_logging"), \
                patch.object(runtime, "acquire_lock", return_value=MagicMock()), \
                patch("requests.Session", side_effect=[hub, bgs, psa]), \
                patch.object(runtime, "saved_psa_retry_deadline", return_value=deadline), \
                patch.object(runtime.time, "time", return_value=self.NOW), \
                patch.object(runtime.time, "monotonic", return_value=100.0), \
                patch.object(runtime, "ChromeReader") as chrome, \
                patch.object(runtime, "read_psa_api", return_value=outcome) as psa_reader, \
                patch.object(runtime, "read_bgs", return_value=outcome) as bgs_reader, \
                patch.object(runtime, "post_result", return_value="accepted") as post, \
                patch.object(runtime.time, "sleep", side_effect=KeyboardInterrupt):
            self.assertEqual(runtime.run(), 0)
        chrome.assert_not_called()
        return psa_reader, bgs_reader, post

    def test_saved_psa_wait_defers_first_job_without_external_lookup(self):
        deadline = datetime.fromtimestamp(self.NOW + 80761, timezone.utc)
        psa, bgs, post = self.run_job(JOB, deadline)
        psa.assert_not_called()
        bgs.assert_not_called()
        post.assert_called_once()
        outcome = post.call_args.args[-1]
        self.assertEqual(outcome["outcome"], "blocked")
        self.assertEqual(outcome["error_code"], "provider_cooldown")
        self.assertGreaterEqual(outcome["retry_after_seconds"], 80761)

    def test_saved_psa_wait_does_not_defer_bgs(self):
        job = {**JOB, "provider": "bgs", "cert_number": "0016097088",
               "lookup_url": "https://www.beckett.com/api/grading/lookup?category=BGS&serialNumber=0016097088"}
        deadline = datetime.fromtimestamp(self.NOW + 80761, timezone.utc)
        psa, bgs, post = self.run_job(job, deadline)
        psa.assert_not_called()
        bgs.assert_called_once()
        self.assertEqual(post.call_args.args[-1]["outcome"], "success")

    def test_expired_saved_wait_allows_api_lookup(self):
        deadline = datetime.fromtimestamp(self.NOW - 1, timezone.utc)
        psa, bgs, post = self.run_job(JOB, deadline)
        psa.assert_called_once()
        bgs.assert_not_called()
        self.assertEqual(post.call_args.args[-1]["outcome"], "success")

    def test_invalid_saved_wait_stops_before_jobs_or_sessions(self):
        output = io.StringIO()
        with patch.dict(os.environ, API_ENV, clear=True), redirect_stdout(output), \
                patch.object(runtime, "saved_psa_retry_deadline", side_effect=ValueError("fixture invalid report")), \
                patch.object(runtime, "configure_logging") as logging, \
                patch.object(runtime, "acquire_lock") as lock, \
                patch("requests.Session") as session, \
                patch.object(runtime, "ChromeReader") as chrome:
            self.assertEqual(runtime.run(), 2)
        logging.assert_not_called()
        lock.assert_not_called()
        session.assert_not_called()
        chrome.assert_not_called()
        self.assertNotIn(TOKEN, output.getvalue())
        self.assertNotIn(WORKER_KEY, output.getvalue())


if __name__ == "__main__":
    unittest.main()