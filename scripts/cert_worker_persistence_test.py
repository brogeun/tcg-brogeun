"""Offline restart/cooldown regressions: all state, clocks and sessions are fake."""
import json
import os
import sys
import unittest
from contextlib import ExitStack, contextmanager
from datetime import datetime, timedelta, timezone
from types import ModuleType, SimpleNamespace
from unittest.mock import MagicMock, Mock, patch

import cert_worker_runtime as runtime
from cert_worker_cooldown import previous_retry_deadline


NOW = datetime(2026, 10, 9, 12, tzinfo=timezone.utc)
FAKE_ENV = {"SITE": "https://worker.example", "PSA_WORKER_KEY": "fixture-worker-key",
            "PSA_API_TOKEN": "fixture-psa-token", "PSA_LOOKUP_MODE": "api"}
RATE_LIMIT = {"outcome": "blocked", "error_code": "psa_api_rate_limited",
              "retry_after_seconds": 3600}
SUCCESS = {"outcome": "success", "record": {"subject": "fixture-card"}}


@contextmanager
def fake_writer(existing=None):
    state, destination, stream = MagicMock(), MagicMock(), MagicMock()
    state.__truediv__.return_value = destination
    stream.__enter__.return_value = stream
    stream.name = "fixture-only/.psa-cooldown-owned.tmp"
    stream.fileno.return_value = 71
    events = []
    disk = {"destination": "existing-report", "temporary": None}
    stream.write.side_effect = lambda text: disk.update(temporary=text)
    stream.flush.side_effect = lambda: events.append("flush")
    stream.__exit__.side_effect = lambda *args: events.append("closed")

    def replace(source, target):
        events.append("replace")
        disk["destination"] = disk["temporary"]
        disk["temporary"] = None

    with ExitStack() as stack:
        stack.enter_context(patch.dict(os.environ, FAKE_ENV, clear=True))
        stack.enter_context(patch.object(runtime, "STATE_DIR", state))
        stack.enter_context(patch.object(runtime, "Path", MagicMock()))
        stack.enter_context(patch.object(runtime, "saved_psa_retry_deadline", return_value=existing))
        clock = stack.enter_context(patch.object(runtime, "datetime"))
        clock.now.return_value = NOW
        factory = stack.enter_context(patch.object(runtime.tempfile, "NamedTemporaryFile", return_value=stream))
        fsync = stack.enter_context(patch.object(runtime.os, "fsync", side_effect=lambda _: events.append("fsync")))
        replace_mock = stack.enter_context(patch.object(runtime.os, "replace", side_effect=replace))
        unlink = stack.enter_context(patch.object(runtime.os, "unlink", side_effect=lambda _: disk.update(temporary=None)))
        yield SimpleNamespace(state=state, destination=destination, stream=stream, factory=factory,
                              fsync=fsync, replace=replace_mock, unlink=unlink, events=events, disk=disk)


@contextmanager
def fake_loop(queue_times, *, provider="psa", mode="api", saved=None, outcomes=None,
              persist_error=None, persisted_delay=None, acknowledgement="accepted"):
    elapsed = [0.0]
    times = iter(queue_times)
    events, acknowledged = [], []
    api, source, psa_source, lock, chrome = [MagicMock() for _ in range(5)]
    fake_requests = ModuleType("requests")
    fake_requests.RequestException = type("FixtureRequestError", (Exception,), {})
    fake_requests.Session = Mock(side_effect=[api, source, psa_source] if mode == "api" else [api, source])
    fake_playwright = ModuleType("playwright")
    fake_sync = ModuleType("playwright.sync_api")
    fake_sync.Error = type("FixtureBrowserError", (Exception,), {})
    fake_playwright.sync_api = fake_sync
    outcome_iter = iter(outcomes or [SUCCESS])

    def queue(*args, **kwargs):
        try:
            elapsed[0] = next(times)
        except StopIteration:
            raise KeyboardInterrupt
        response = MagicMock()
        response.status_code = 200
        response.json.return_value = {"ok": True, "jobs": [{"id": "fixture-job", "provider": provider,
            "cert_number": "12345678", "lease_token": "fixture-lease"}]}
        return response

    def lookup(*args):
        events.append("lookup")
        return dict(next(outcome_iter))

    def persist(seconds):
        events.append("persist")
        if persist_error is not None:
            raise persist_error
        return seconds if persisted_delay is None else persisted_delay

    def ack(session, site, headers, job, outcome):
        events.append("ack")
        acknowledged.append(dict(outcome))
        return acknowledgement

    api.post.side_effect = queue
    api.get.side_effect = source.get.side_effect = psa_source.get.side_effect = AssertionError("real transport forbidden")
    chrome.read.side_effect = lookup
    clock = SimpleNamespace(time=lambda: NOW.timestamp() + elapsed[0],
                            monotonic=lambda: 1000 + elapsed[0], sleep=Mock())
    with ExitStack() as stack:
        stack.enter_context(patch.dict(os.environ, {**FAKE_ENV, "PSA_LOOKUP_MODE": mode}, clear=True))
        stack.enter_context(patch.dict(sys.modules, {"requests": fake_requests, "playwright": fake_playwright,
                                                    "playwright.sync_api": fake_sync}, clear=True))
        stack.enter_context(patch.object(runtime, "STATE_DIR", MagicMock()))
        stack.enter_context(patch.object(runtime, "Path", MagicMock()))
        stack.enter_context(patch.object(runtime, "LOG", MagicMock()))
        stack.enter_context(patch.object(runtime, "configure_logging", Mock()))
        stack.enter_context(patch.object(runtime, "acquire_lock", return_value=lock))
        stack.enter_context(patch.object(runtime, "saved_psa_retry_deadline", return_value=saved))
        stack.enter_context(patch.object(runtime, "time", clock))
        stack.enter_context(patch.object(runtime, "ChromeReader", return_value=chrome))
        stack.enter_context(patch.object(runtime, "validate_job", return_value=True))
        reader = stack.enter_context(patch.object(runtime, "read_psa_api", side_effect=lookup))
        bgs_reader = stack.enter_context(patch.object(runtime, "read_bgs", side_effect=lookup))
        persistence = stack.enter_context(patch.object(runtime, "persist_psa_api_retry", side_effect=persist))
        acknowledgement_mock = stack.enter_context(patch.object(runtime, "post_result", side_effect=ack))
        yield SimpleNamespace(api=api, source=source, psa_source=psa_source, lock=lock, chrome=chrome,
                              clock=clock, reader=reader, bgs_reader=bgs_reader, persistence=persistence,
                              ack=acknowledgement_mock, acknowledged=acknowledged, events=events)


class PersistenceTests(unittest.TestCase):
    def test_atomic_minimal_report_restores_deadline_without_sensitive_data(self):
        with fake_writer() as fake:
            self.assertEqual(runtime.persist_psa_api_retry(3600), 3600)
            text = fake.stream.write.call_args.args[0]
            self.assertEqual(json.loads(text), {"checked_at": NOW.isoformat(), "records": [{
                "response_details": {"status": 429, "headers": {"Retry-After": "3600"}}}]})
            for sensitive in (FAKE_ENV["PSA_WORKER_KEY"], FAKE_ENV["PSA_API_TOKEN"], "12345678", "fixture-lease", "fixture-card"):
                self.assertNotIn(sensitive, text)
            report = MagicMock()
            report.exists.return_value = True
            report.read_text.return_value = text
            self.assertEqual(previous_retry_deadline(report), NOW + timedelta(hours=1))
            self.assertEqual(fake.events, ["flush", "fsync", "closed", "replace"])
            fake.fsync.assert_called_once_with(71)
            fake.replace.assert_called_once_with(fake.stream.name, fake.destination)
            fake.unlink.assert_not_called()
            self.assertIs(fake.factory.call_args.kwargs["dir"], fake.state)
            self.assertFalse(fake.factory.call_args.kwargs["delete"])

    def test_longer_saved_deadline_survives_new_shorter_response(self):
        existing = NOW + timedelta(seconds=7200, microseconds=1)
        with fake_writer(existing=existing) as fake:
            self.assertEqual(runtime.persist_psa_api_retry(1800), 7201)
            report = MagicMock()
            report.exists.return_value = True
            report.read_text.return_value = fake.stream.write.call_args.args[0]
            self.assertGreaterEqual(previous_retry_deadline(report), existing)

    def test_expired_report_does_not_extend_minimum_new_cooldown(self):
        with fake_writer(existing=NOW - timedelta(days=1)) as fake:
            self.assertEqual(runtime.persist_psa_api_retry(1), 1800)
            self.assertEqual(json.loads(fake.disk["destination"])["records"][0]["response_details"]["headers"],
                             {"Retry-After": "1800"})

    def test_replace_failure_preserves_destination_and_cleans_only_owned_temp(self):
        with fake_writer() as fake:
            fake.replace.side_effect = OSError("fixture replace failure")
            with self.assertRaisesRegex(OSError, "replace failure"):
                runtime.persist_psa_api_retry(3600)
            self.assertEqual(fake.disk["destination"], "existing-report")
            fake.unlink.assert_called_once_with(fake.stream.name)
            self.assertEqual(fake.events, ["flush", "fsync", "closed"])

    def test_write_or_sync_failure_never_replaces_existing_report(self):
        for failure in ("write", "fsync"):
            with self.subTest(failure=failure), fake_writer() as fake:
                target = fake.stream.write if failure == "write" else fake.fsync
                target.side_effect = OSError("fixture save failure")
                with self.assertRaisesRegex(OSError, "save failure"):
                    runtime.persist_psa_api_retry(3600)
                fake.replace.assert_not_called()
                fake.unlink.assert_called_once_with(fake.stream.name)
                self.assertEqual(fake.disk["destination"], "existing-report")

    def test_temp_creation_failure_does_not_delete_any_path(self):
        with fake_writer() as fake:
            fake.factory.side_effect = OSError("fixture create failure")
            with self.assertRaisesRegex(OSError, "create failure"):
                runtime.persist_psa_api_retry(3600)
            fake.replace.assert_not_called()
            fake.unlink.assert_not_called()
            self.assertEqual(fake.disk["destination"], "existing-report")

    def test_cleanup_failure_preserves_original_replace_error(self):
        with fake_writer() as fake:
            fake.replace.side_effect = OSError("fixture replace failure")
            fake.unlink.side_effect = OSError("fixture cleanup failure")
            with self.assertRaisesRegex(OSError, "replace failure"):
                runtime.persist_psa_api_retry(3600)
            fake.unlink.assert_called_once_with(fake.stream.name)


class RuntimePersistenceTests(unittest.TestCase):
    def assert_saved_cooldown_expires(self, seconds, times, expected_delays):
        with fake_loop(times, saved=NOW + timedelta(seconds=seconds)) as fake:
            self.assertEqual(runtime.run(), 0)
            self.assertEqual([item.get("retry_after_seconds") for item in fake.acknowledged[:-1]], expected_delays)
            self.assertTrue(all(item["error_code"] == "provider_cooldown" for item in fake.acknowledged[:-1]))
            self.assertEqual(fake.acknowledged[-1]["outcome"], "success")
            fake.reader.assert_called_once()
            fake.persistence.assert_not_called()

    def test_1799_second_cooldown_keeps_original_deadline_across_jobs(self):
        self.assert_saved_cooldown_expires(1799, [0, 1798, 1799], [1800, 2])

    def test_one_second_cooldown_keeps_original_deadline_across_jobs(self):
        self.assert_saved_cooldown_expires(1, [0, 0.5, 1], [2, 1])

    def test_actual_429_persists_once_and_honors_longer_saved_delay(self):
        with fake_loop([0, 3600, 7200], outcomes=[RATE_LIMIT, SUCCESS], persisted_delay=7200) as fake:
            self.assertEqual(runtime.run(), 0)
            fake.persistence.assert_called_once_with(3600)
            self.assertEqual(fake.reader.call_count, 2)
            self.assertEqual(fake.acknowledged[0]["retry_after_seconds"], 7200)
            self.assertEqual(fake.acknowledged[1]["error_code"], "provider_cooldown")
            self.assertEqual(fake.acknowledged[1]["retry_after_seconds"], 3601)
            self.assertEqual(fake.acknowledged[2]["outcome"], "success")

    def test_non_rate_limit_psa_outcomes_do_not_write_cooldown(self):
        cases = [(SUCCESS, 0), ({"outcome": "not_found"}, 0),
                 ({"outcome": "temporary_error", "error_code": "psa_api_unavailable", "retry_after_seconds": 900}, 0),
                 ({"outcome": "blocked", "error_code": "unexpected_redirect", "retry_after_seconds": 1800}, 0),
                 ({"outcome": "blocked", "error_code": "psa_api_authentication_required", "retry_after_seconds": 1800}, 2)]
        for outcome, expected_code in cases:
            with self.subTest(outcome=outcome), fake_loop([0], outcomes=[outcome]) as fake:
                self.assertEqual(runtime.run(), expected_code)
                fake.persistence.assert_not_called()

    def test_bgs_and_browser_results_never_persist_psa_api_cooldown(self):
        for provider, mode in (("bgs", "api"), ("psa", "browser")):
            with self.subTest(provider=provider, mode=mode), \
                    fake_loop([0], provider=provider, mode=mode, outcomes=[RATE_LIMIT]) as fake:
                self.assertEqual(runtime.run(), 0)
                fake.persistence.assert_not_called()
                fake.reader.assert_not_called()

    def test_save_failure_reports_then_stops_before_another_lookup_for_any_ack(self):
        for acknowledgement in ("accepted", "failed", "expired", "fatal"):
            with self.subTest(ack=acknowledgement), \
                    fake_loop([0, 7200], outcomes=[RATE_LIMIT, SUCCESS],
                              persist_error=OSError("fixture persistence failure"), acknowledgement=acknowledgement) as fake:
                self.assertEqual(runtime.run(), 2)
                self.assertEqual(fake.events, ["lookup", "persist", "ack"])
                fake.reader.assert_called_once()
                fake.api.post.assert_called_once()
                fake.ack.assert_called_once()
                fake.clock.sleep.assert_not_called()
                fake.lock.close.assert_called_once()
                for session in (fake.api, fake.source, fake.psa_source):
                    session.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
