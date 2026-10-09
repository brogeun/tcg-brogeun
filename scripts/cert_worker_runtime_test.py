"""Offline runtime regressions: no Chrome, network, credentials, or real jobs."""
import unittest
from unittest.mock import patch

from cert_worker_core import classify_psa
from cert_worker_runtime import ChromeReader
from cert_worker_test import PSA, URL

# Labels and order observed in PSA's public certificate page.
PUBLIC_PSA = """PSA POPULATION
20
PSA POP HIGHER
0
Sales History
Shop
Item Information
Cert Number
23483296
Item Grade
GEM MT 10
Label Type
W/ FUGITIVE INK TECHNOLOGY
Reverse Cert/Barcode
YES
Year
2003
Brand/Title
TOPPS CHROME
Subject
LEBRON JAMES
Card Number
111
Category
BASKETBALL CARDS
Variety/Pedigree
BLACK REFRACTOR
Sales of Similar Items
Cert Number 24311536
"""
NO_POP = PSA.replace("PSA Population 20\nPSA Pop Higher 0\n", "")


class FakeRequest:
    def __init__(self, navigation=True):
        self.navigation = navigation

    def is_navigation_request(self):
        return self.navigation


class FakeResponse:
    def __init__(self, page, state):
        self.status = state.get("status", 200)
        self.headers = state.get("headers", {})
        self.request = FakeRequest(state.get("navigation", True))
        self.frame = page.main_frame if state.get("main_frame", True) else object()


class FakeLocator:
    def __init__(self, page, selector):
        self.page = page
        self.selector = selector

    def count(self):
        return int(self.page.state.get("has_main", True))

    def inner_text(self, timeout):
        return self.page.state.get(self.selector, self.page.state.get("text", "Loading..."))


class FakePage:
    def __init__(self, states):
        self.states = states
        self.index = 0
        self.elapsed = 0
        self.waits = 0
        self.main_frame = object()
        self.listeners = []
        self.title_reads = 0
        self.goto_calls = 0

    @property
    def state(self):
        return self.states[self.index]

    @property
    def url(self):
        return self.state.get("url", URL)

    def on(self, event, listener):
        assert event == "response"
        self.listeners.append(listener)

    def remove_listener(self, event, listener):
        assert event == "response"
        self.listeners.remove(listener)

    def emit_response(self, state):
        response = FakeResponse(self, state)
        for listener in self.listeners:
            listener(response)
        return response

    def goto(self, url, **kwargs):
        self.goto_calls += 1
        response = self.emit_response(self.state)
        if self.state.get("goto_error"):
            raise RuntimeError(self.state["goto_error"])
        return response

    def title(self):
        self.title_reads += 1
        if self.state.get("title_error"):
            raise RuntimeError(self.state["title_error"])
        return self.state.get("title", "PSA Certificate")

    def locator(self, selector):
        return FakeLocator(self, selector)

    def wait_for_timeout(self, delay):
        self.elapsed += delay / 1000
        self.waits += 1
        if self.index + 1 < len(self.states):
            self.index += 1
            if "status" in self.state:
                self.emit_response(self.state)
            if "resource_status" in self.state:
                self.emit_response({"status": self.state["resource_status"], "navigation": False})
            if "subframe_status" in self.state:
                self.emit_response({"status": self.state["subframe_status"], "main_frame": False})


class ReaderTests(unittest.TestCase):
    def read(self, states):
        page = FakePage(states)
        reader = ChromeReader()
        reader.open = lambda: None
        reader.page = page
        with patch("cert_worker_runtime.time.monotonic", side_effect=lambda: page.elapsed):
            answer = reader.read({"cert_number": "23483296"})
        self.assertEqual(page.listeners, [])
        self.assertEqual(page.goto_calls, 1)
        return answer, page

    def test_transient_loading_then_success(self):
        answer, page = self.read([{"text": "Just a moment..."}, {"text": PSA}])
        self.assertEqual(answer["outcome"], "success")
        self.assertEqual(page.waits, 1)

    def test_automatic_verification_loading_can_finish(self):
        for text in ("Performing security verification", "Verifying you are human. This may take a few seconds.", "잠시만 기다리십시오… 보안 확인 수행 중"):
            with self.subTest(text=text):
                answer, page = self.read([{"status": 403, "text": text}, {"status": 200, "text": PSA}])
                self.assertEqual(answer["outcome"], "success")
                self.assertEqual(page.waits, 1)

    def test_initial_403_then_main_document_200(self):
        answer, page = self.read([
            {"status": 403, "text": "Checking your browser", "headers": {"retry-after": "3600"}},
            {"status": 200, "text": PSA, "url": URL + "/psa"},
        ])
        self.assertEqual(answer["outcome"], "success")
        self.assertNotIn("retry_after_seconds", answer)
        self.assertEqual(page.waits, 1)

    def test_loading_has_bounded_wait(self):
        answer, page = self.read([{"status": 403, "text": "Just a moment..."}])
        self.assertEqual(answer["outcome"], "blocked")
        self.assertEqual(page.elapsed, 30)

    def test_human_challenge_stays_blocked(self):
        for text in ("Verify you are human", "CAPTCHA", "Access denied", "Security verification"):
            with self.subTest(text=text):
                answer, page = self.read([{"text": text, "title": "Just a moment..."}])
                self.assertEqual(answer["outcome"], "blocked")
                self.assertEqual(page.waits, 0)

    def test_rate_limit_and_retry_after_are_respected(self):
        answer, page = self.read([{"status": 429, "text": "Just a moment...", "headers": {"retry-after": "7200"}}])
        self.assertEqual(answer["retry_after_seconds"], 7200)
        self.assertEqual(page.waits, 0)

    def test_new_main_document_retry_after_is_used(self):
        answer, page = self.read([
            {"status": 403, "text": "Just a moment...", "headers": {"retry-after": "1800"}},
            {"status": 429, "headers": {"retry-after": "7200"}},
        ])
        self.assertEqual(answer["retry_after_seconds"], 7200)
        self.assertEqual(page.waits, 1)

    def test_foreign_host_rejected_before_reading_dom(self):
        answer, page = self.read([{"url": "https://unrelated.example/", "text": "Just a moment..."}])
        self.assertEqual(answer["error_code"], "unexpected_redirect")
        self.assertEqual(page.title_reads, 0)
        self.assertEqual(page.waits, 0)

    def test_resources_and_subframe_errors_do_not_poison_document(self):
        answer, page = self.read([
            {"text": "Loading..."},
            {"text": PSA, "resource_status": 403, "subframe_status": 429},
        ])
        self.assertEqual(answer["outcome"], "success")
        self.assertEqual(page.waits, 1)

    def test_navigation_replaces_execution_context(self):
        answer, page = self.read([
            {"title_error": "Execution context was destroyed, most likely because of a navigation"},
            {"text": PSA, "status": 200, "url": URL + "/psa"},
        ])
        self.assertEqual(answer["outcome"], "success")
        self.assertEqual(page.waits, 1)

    def test_navigation_error_does_not_wait_forever(self):
        answer, page = self.read([{"title_error": "Execution context was destroyed"}])
        self.assertEqual(answer["error_code"], "browser_navigation_error")
        self.assertEqual(page.elapsed, 30)

    def test_navigation_interrupting_goto_can_finish(self):
        answer, page = self.read([
            {"text": "Loading...", "goto_error": "Navigation interrupted by another navigation"},
            {"text": PSA, "status": 200},
        ])
        self.assertEqual(answer["outcome"], "success")
        self.assertEqual(page.waits, 1)

    def test_unrelated_browser_errors_are_not_swallowed(self):
        page = FakePage([{"title_error": "Target page, context or browser has been closed"}])
        reader = ChromeReader()
        reader.open = lambda: None
        reader.page = page
        with self.assertRaisesRegex(RuntimeError, "has been closed"):
            reader.read({"cert_number": "23483296"})
        self.assertEqual(page.listeners, [])

    def test_delayed_pop_is_collected(self):
        answer, page = self.read([{"text": NO_POP}, {"text": PSA}])
        self.assertEqual(answer["record"]["pop_total"], 20)
        self.assertEqual(answer["record"]["pop_higher"], 0)
        self.assertEqual(page.waits, 1)

    def test_missing_pop_remains_unknown_after_deadline(self):
        answer, page = self.read([{"text": NO_POP}])
        self.assertEqual(answer["outcome"], "success")
        self.assertIsNone(answer["record"]["pop_total"])
        self.assertIsNone(answer["record"]["pop_higher"])
        self.assertEqual(page.elapsed, 30)

    def test_real_uppercase_pop_labels(self):
        answer = classify_psa(PUBLIC_PSA, "23483296", URL + "/psa")
        self.assertEqual(answer["outcome"], "success")
        self.assertEqual(answer["record"]["subject"], "LEBRON JAMES")
        self.assertEqual(answer["record"]["pop_total"], 20)
        self.assertEqual(answer["record"]["pop_higher"], 0)

    def test_source_maintenance_is_not_retried(self):
        answer, page = self.read([{"status": 503, "text": "Down for maintenance"}])
        self.assertEqual(answer["outcome"], "temporary_error")
        self.assertEqual(page.waits, 0)


if __name__ == "__main__":
    unittest.main()
