"""Offline verification tests. No network, real credentials, or report writes."""
import io
import json
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch
import verify_psa_api as verifier

NOW = datetime(2026, 10, 5, 8, 10, tzinfo=timezone.utc)


class FrozenDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW


def report_path(retry="80761", date="Mon, 05 Oct 2026 08:04:00 GMT", checked="2026-10-05T08:04:00.537943+00:00"):
    path = MagicMock()
    path.exists.return_value = True
    path.read_text.return_value = json.dumps({"checked_at": checked, "passed": False,
        "records": [{"outcome": "blocked", "response_details": {"status": 429,
        "headers": {"Date": date, "Retry-After": retry}}}]})
    return path


class VerificationCooldownTests(unittest.TestCase):
    def setUp(self):
        self.state_report = MagicMock()
        self.state_report.exists.return_value = False
        patcher = patch.object(verifier, "STATE_REPORT_PATH", self.state_report)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_delta_uses_later_recorded_anchor_without_shortening_wait(self):
        deadline = verifier.previous_retry_deadline(report_path())
        self.assertEqual(deadline, datetime(2026, 10, 6, 6, 30, 1, 537943, tzinfo=timezone.utc))

    def test_delta_can_use_either_date_or_checked_at(self):
        expected = datetime(2026, 10, 6, 6, 30, 1, tzinfo=timezone.utc)
        self.assertEqual(verifier.previous_retry_deadline(report_path(checked=None)), expected)
        self.assertEqual(verifier.previous_retry_deadline(report_path(date=None, checked="2026-10-05T08:04:00+00:00")), expected)

    def test_http_date_retry_after_is_supported(self):
        expected = datetime(2026, 10, 6, 6, 30, 1, tzinfo=timezone.utc)
        self.assertEqual(verifier.previous_retry_deadline(report_path(retry="Tue, 06 Oct 2026 06:30:01 GMT", date=None, checked=None)), expected)

    def test_active_wait_stops_before_token_read_or_session_and_preserves_report(self):
        path = report_path()
        environment = MagicMock()
        output = io.StringIO()
        with patch.object(verifier, "REPORT_PATH", path), patch.object(verifier, "datetime", FrozenDateTime), \
                patch.object(verifier.os, "environ", environment), patch.object(verifier, "VerificationSession") as session, \
                patch.object(verifier, "read_psa_api") as reader, redirect_stdout(output):
            self.assertEqual(verifier.main(), 3)
        environment.get.assert_not_called()
        session.assert_not_called()
        reader.assert_not_called()
        path.write_text.assert_not_called()
        self.assertEqual(len(output.getvalue().splitlines()), 1)
        self.assertIn("No network request was made", output.getvalue())

    def test_expired_wait_allows_normal_flow_with_fake_session_only(self):
        path = report_path(retry="1")
        session = MagicMock()
        session.__enter__.return_value = session
        session.last_response_details = {"status": 503, "headers": {}}
        answer = {"outcome": "temporary_error", "error_code": "offline_fixture"}
        with patch.object(verifier, "REPORT_PATH", path), patch.object(verifier, "datetime", FrozenDateTime), \
                patch.dict(verifier.os.environ, {"PSA_API_TOKEN": "offline-fixture-only"}, clear=True), \
                patch.object(verifier, "VerificationSession", return_value=session) as factory, \
                patch.object(verifier, "read_psa_api", return_value=answer) as reader, redirect_stdout(io.StringIO()):
            self.assertEqual(verifier.main(), 1)
        factory.assert_called_once()
        reader.assert_called_once()
        path.write_text.assert_called_once()

    def test_missing_report_or_prior_failure_without_delay_does_not_invent_wait(self):
        missing = MagicMock()
        missing.exists.return_value = False
        self.assertIsNone(verifier.previous_retry_deadline(missing))
        missing.read_text.assert_not_called()
        for data in ({"passed": False}, {"records": [{"outcome": "temporary_error"}]},
                     {"records": [{"response_details": {"status": 429, "headers": {}}}]}):
            with self.subTest(data=data):
                path = MagicMock()
                path.exists.return_value = True
                path.read_text.return_value = json.dumps(data)
                self.assertIsNone(verifier.previous_retry_deadline(path))

    def test_broken_json_or_invalid_explicit_delay_fails_closed_and_preserves_report(self):
        for content in ("{broken", "[]", json.dumps({"records": None}),
                        report_path(retry="invalid").read_text.return_value,
                        report_path(date=None, checked=None).read_text.return_value):
            with self.subTest(content_kind="invalid report"):
                path = MagicMock()
                path.exists.return_value = True
                path.read_text.return_value = content
                environment = MagicMock()
                with patch.object(verifier, "REPORT_PATH", path), patch.object(verifier.os, "environ", environment), \
                        patch.object(verifier, "VerificationSession") as session, redirect_stdout(io.StringIO()):
                    self.assertEqual(verifier.main(), 4)
                environment.get.assert_not_called()
                session.assert_not_called()
                path.write_text.assert_not_called()


    def test_worker_state_wait_blocks_verification_before_credentials_or_network(self):
        state = report_path()
        legacy = report_path(retry="1")
        environment = MagicMock()
        output = io.StringIO()
        with patch.object(verifier, "STATE_REPORT_PATH", state), \
                patch.object(verifier, "REPORT_PATH", legacy), \
                patch.object(verifier, "datetime", FrozenDateTime), \
                patch.object(verifier.os, "environ", environment), \
                patch.object(verifier, "VerificationSession") as session, redirect_stdout(output):
            self.assertEqual(verifier.main(), 3)
        environment.get.assert_not_called()
        session.assert_not_called()
        state.write_text.assert_not_called()
        legacy.write_text.assert_not_called()
        self.assertIn("2026-10-06T06:30:01.537943+00:00", output.getvalue())

    def test_later_deadline_from_either_report_blocks_verification(self):
        for state_delay, legacy_delay in (("80761", "90000"), ("90000", "80761")):
            with self.subTest(state_delay=state_delay, legacy_delay=legacy_delay):
                state = report_path(retry=state_delay)
                legacy = report_path(retry=legacy_delay)
                environment = MagicMock()
                output = io.StringIO()
                with patch.object(verifier, "STATE_REPORT_PATH", state), \
                        patch.object(verifier, "REPORT_PATH", legacy), \
                        patch.object(verifier, "datetime", FrozenDateTime), \
                        patch.object(verifier.os, "environ", environment), \
                        patch.object(verifier, "VerificationSession") as session, redirect_stdout(output):
                    self.assertEqual(verifier.main(), 3)
                self.assertIn("2026-10-06T09:04:00.537943+00:00", output.getvalue())
                environment.get.assert_not_called()
                session.assert_not_called()
                state.write_text.assert_not_called()
                legacy.write_text.assert_not_called()

    def test_invalid_or_unreadable_worker_state_stops_before_credentials_or_network(self):
        for failure in ("malformed", "unreadable"):
            with self.subTest(failure=failure):
                state, legacy = report_path(), report_path(retry="1")
                if failure == "malformed":
                    state.read_text.return_value = "{broken"
                else:
                    state.read_text.side_effect = OSError("fixture-only")
                environment = MagicMock()
                with patch.object(verifier, "STATE_REPORT_PATH", state), \
                        patch.object(verifier, "REPORT_PATH", legacy), \
                        patch.object(verifier.os, "environ", environment), \
                        patch.object(verifier, "VerificationSession") as session, redirect_stdout(io.StringIO()):
                    self.assertEqual(verifier.main(), 4)
                environment.get.assert_not_called()
                session.assert_not_called()
                state.write_text.assert_not_called()
                legacy.write_text.assert_not_called()


class VerificationDiagnosticTests(unittest.TestCase):
    def details(self, payload=None, status=429, content_type="application/json", raw=None, headers=None):
        response = verifier.requests.Response()
        response.status_code = status
        response.headers.update({"Content-Type": content_type, "Retry-After": "120"})
        response.headers.update(headers or {})
        response._content = raw if raw is not None else json.dumps(payload).encode()
        with patch.object(verifier.requests.Session, "get", return_value=response) as request:
            with verifier.VerificationSession("current-fixture-token") as session:
                self.assertIs(session.get("https://example.invalid"), response)
                result = session.last_response_details
        request.assert_called_once()
        return result

    def test_nested_case_insensitive_error_and_retry_metadata_are_retained(self):
        details = self.details({"STATUSCODE": 429, "Description": "Daily quota exhausted",
                                "error": {"CODE": "quota_exceeded", "errors": [
                                    {"MESSAGE": "Retry after reset"}]}})
        self.assertTrue(details["json_parse_ok"])
        self.assertEqual(details["json_root_type"], "dict")
        self.assertEqual(details["headers"]["Retry-After"], "120")
        self.assertEqual(details["diagnostic_fields"], {
            "statuscode": "429", "description": "Daily quota exhausted",
            "error.code": "quota_exceeded"})
        # Lists of errors at the normal root depth are inspected, but traversal is bounded.
        self.assertEqual(self.details({"errors": [{"MESSAGE": "Retry after reset"}]})[
            "diagnostic_fields"]["errors.0.message"], "Retry after reset")

    def test_reflected_credentials_cookies_and_unlisted_fields_are_not_recorded(self):
        details = self.details({
            "Message": "Quota for current-fixture-token is exhausted",
            "description": "Bearer unrelated-fixture-value",
            "reason": "eyJfixture.payload.signature",
            "detail": "Cookie: session=fixture-cookie-value",
            "error": {"title": "Authorization: fixture-header-value", "password": "fixture-password"},
            "access_token": "fixture-access-value"}, headers={
                "Set-Cookie": "fixture-response-cookie", "Authorization": "fixture-response-auth"})
        recorded = json.dumps(details)
        for value in ("current-fixture-token", "unrelated-fixture-value", "eyJfixture.payload.signature",
                      "fixture-cookie-value", "fixture-header-value", "fixture-password", "fixture-access-value",
                      "fixture-response-cookie", "fixture-response-auth"):
            self.assertNotIn(value, recorded)
        self.assertIn("Quota for [redacted] is exhausted", recorded)

    def test_authentication_descriptions_survive_but_credential_assignments_do_not(self):
        for message in ("Access token expired", "Invalid access token", "API key quota exceeded",
                        "Authorization failed", "Cookie is required"):
            with self.subTest(message=message):
                self.assertEqual(self.details({"message": message})[
                    "diagnostic_fields"]["message"], message)
        for message in ('access_token=fixture-assigned-secret', '"token": "fixture-assigned-secret"',
                        "API key: fixture-assigned-secret", "Cookie: session=fixture-assigned-secret",
                        "Authorization: Basic fixture-assigned-secret"):
            with self.subTest(kind="credential assignment"):
                self.assertNotIn("fixture-assigned-secret", json.dumps(self.details({"message": message})))

    def test_safe_request_identifiers_are_available_for_support(self):
        identifiers = {"CF-Ray": "0123456789abcdef-ICN",
                       "X-Request-ID": "fixture-request-id", "apim-request-id": "fixture-apim-id"}
        details = self.details({"message": "Rate limit exceeded"}, headers=identifiers)
        for name, value in identifiers.items():
            self.assertEqual(details["headers"][name], value)

    def test_malformed_json_and_unstructured_bodies_do_not_record_raw_content(self):
        details = self.details(raw=b'{"broken":"private-body-fixture"')
        self.assertFalse(details["json_parse_ok"])
        self.assertNotIn("private-body-fixture", json.dumps(details))
        for content_type, raw in (("text/plain", b"private-body-fixture"),
                                  ("application/json", b'"private-body-fixture"')):
            with self.subTest(content_type=content_type):
                details = self.details(content_type=content_type, raw=raw)
                self.assertEqual(details["body_bytes"], len(raw))
                self.assertNotIn("private-body-fixture", json.dumps(details))

    def test_success_status_records_population_presence_without_card_body(self):
        details = self.details({"IsValidRequest": True, "ServerMessage": "Request successful",
                                "PSACert": {"Subject": "private-card-fixture", "TotalPopulation": None}}, status=200)
        self.assertEqual(details["population_fields"], {
            "TotalPopulation": {"present": True, "is_null": True},
            "PopulationHigher": {"present": False, "is_null": True}})
        self.assertEqual(details["diagnostic_fields"]["servermessage"], "Request successful")
        self.assertNotIn("private-card-fixture", json.dumps(details))

    def test_network_failure_clears_previous_response_details(self):
        with verifier.VerificationSession("current-fixture-token") as session:
            session.last_response_details = {"status": 200, "headers": {}}
            with patch.object(verifier.requests.Session, "get", side_effect=verifier.requests.ConnectionError):
                with self.assertRaises(verifier.requests.ConnectionError):
                    session.get("https://example.invalid")
            self.assertIsNone(session.last_response_details)


if __name__ == "__main__":
    unittest.main()
