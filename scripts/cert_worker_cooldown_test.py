"""Offline cooldown tests using in-memory reports only; no secrets or network."""
import json
import sys
import unittest
from datetime import datetime, timezone
from unittest.mock import MagicMock, patch

from cert_worker_cooldown import previous_retry_deadline
import cert_worker_runtime as runtime


def report(delay=None, exists=True):
    path = MagicMock()
    path.exists.return_value = exists
    headers = {} if delay is None else {"rEtRy-AfTeR": str(delay)}
    path.read_text.return_value = json.dumps({
        "checked_at": "2026-10-05T08:00:00+00:00",
        "records": [{"response_details": {"headers": headers}}],
    })
    return path


class RuntimeReportLocationTests(unittest.TestCase):
    def deadline(self, state, legacy):
        state_dir, legacy_dir, source = MagicMock(), MagicMock(), MagicMock()
        state_dir.__truediv__.return_value = state
        legacy_dir.__truediv__.return_value = legacy
        source.resolve.return_value.parents = {1: legacy_dir}
        # The runtime must remain usable when the optional verifier is absent.
        with patch.object(runtime, "STATE_DIR", state_dir), \
                patch.object(runtime, "Path", return_value=source), \
                patch.dict(sys.modules, {"verify_psa_api": None}):
            return runtime.saved_psa_retry_deadline()

    def test_state_report_works_without_legacy_report_or_verifier(self):
        state, legacy = report(120), report(exists=False)
        self.assertEqual(self.deadline(state, legacy), datetime(2026, 10, 5, 8, 2, tzinfo=timezone.utc))
        state.read_text.assert_called_once_with(encoding="utf-8-sig")
        legacy.read_text.assert_not_called()
        state.write_text.assert_not_called()

    def test_legacy_report_keeps_existing_installations_protected(self):
        state, legacy = report(exists=False), report(180)
        self.assertEqual(self.deadline(state, legacy), datetime(2026, 10, 5, 8, 3, tzinfo=timezone.utc))
        state.read_text.assert_not_called()
        legacy.read_text.assert_called_once_with(encoding="utf-8-sig")
        legacy.write_text.assert_not_called()

    def test_two_missing_reports_do_not_invent_a_wait(self):
        state, legacy = report(exists=False), report(exists=False)
        self.assertIsNone(self.deadline(state, legacy))
        state.read_text.assert_not_called()
        legacy.read_text.assert_not_called()

    def test_later_deadline_is_preserved_in_either_location(self):
        for state_delay, legacy_delay in ((120, 180), (180, 120), (None, 180), (180, None)):
            with self.subTest(state_delay=state_delay, legacy_delay=legacy_delay):
                self.assertEqual(self.deadline(report(state_delay), report(legacy_delay)),
                                 datetime(2026, 10, 5, 8, 3, tzinfo=timezone.utc))

    def test_invalid_state_report_fails_closed_without_legacy_fallback(self):
        for content in ("{broken", "[]", json.dumps({"records": None}),
                        report("invalid-date").read_text.return_value):
            with self.subTest(content=content):
                state, legacy = report(), report(180)
                state.read_text.return_value = content
                with self.assertRaises(ValueError):
                    self.deadline(state, legacy)
                legacy.read_text.assert_not_called()
                state.write_text.assert_not_called()

    def test_invalid_legacy_report_cannot_be_hidden_by_valid_state_report(self):
        state, legacy = report(120), report()
        legacy.read_text.return_value = "{broken"
        with self.assertRaises(ValueError):
            self.deadline(state, legacy)
        legacy.write_text.assert_not_called()

    def test_unreadable_report_in_either_location_is_not_ignored(self):
        for unreadable_location in ("state", "legacy"):
            with self.subTest(location=unreadable_location):
                state, legacy = report(120), report(180)
                (state if unreadable_location == "state" else legacy).read_text.side_effect = OSError("fixture-only")
                with self.assertRaises(OSError):
                    self.deadline(state, legacy)
                state.write_text.assert_not_called()
                legacy.write_text.assert_not_called()


class CooldownParserTests(unittest.TestCase):
    def test_multiple_records_preserve_longest_delta_or_http_date(self):
        path = report()
        path.read_text.return_value = json.dumps({
            "checked_at": "2026-10-05T08:00:00Z",
            "records": [
                {"response_details": {"headers": {"Retry-After": "120"}}},
                {"response_details": {"headers": {"retry-after": "Mon, 05 Oct 2026 08:03:00 GMT"}}},
                {"response_details": {"headers": {"RETRY-AFTER": "90", "DATE": "Mon, 05 Oct 2026 08:02:00 GMT"}}},
            ],
        })
        self.assertEqual(previous_retry_deadline(path), datetime(2026, 10, 5, 8, 3, 30, tzinfo=timezone.utc))
        path.write_text.assert_not_called()


if __name__ == "__main__":
    unittest.main()
