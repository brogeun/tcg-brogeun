"""Offline checks: bounded public collection and exact-byte failure preservation."""
import copy
import io
import json
import os
import tempfile
import unittest
import urllib.error
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import refresh_search_prices as target

NOW = datetime(2026, 10, 20, 3, tzinfo=timezone.utc)


def fx():
    return {"updated": NOW.isoformat(), "asOf": "2026-10-19", "source": "fixture",
            "basis": "previous-business-day-close", "rates": {"USD": 1400, "JPY": 9}}


def row(cid, amount=14000, display="₩14,000"):
    return {"id": cid, "name": "Source " + str(cid), "minPrice": amount,
            "minPriceFormat": display, "listingCount": "99+", "productNumber": "P-" + str(cid)}


def old_catalogue(pokemon=2):
    return {"fetchedAt": "2026-09-01T00:00:00Z", "customMetadata": {"keep": True},
            "details": [{"id": str(cid), "brand": "pokemon" if cid < 10 else "onepiece",
                         "kind": "card", "name": "Preserve " + str(cid), "minPrice": 100,
                         "currency": "USD", "listingCount": 1, "userField": "keep"}
                        for cid in [*range(1, pokemon + 1), 10]]}


def complete_pages(brand, order, page, per_page):
    if brand == "pokemon":
        return {"tradingCards": [row(1), row(2)] if page == 1 else []}
    return {"tradingCards": [row(10)] if page == 1 else []}


class FakeClient:
    def __init__(self, fetch=complete_pages):
        self.get = fetch

    def remaining(self):
        return 100


class FixtureTests(unittest.TestCase):
    def basis(self):
        return target.fx_basis(fx(), NOW)

    def test_full_two_brand_fetch_preserves_metadata_and_checks_each_product(self):
        documents = target.build_documents(old_catalogue(), self.basis(), complete_pages,
                                           per_page=2, now=lambda: NOW)
        combined = documents["all-cards.json"]
        self.assertEqual(combined["customMetadata"], {"keep": True})
        self.assertEqual(len(combined["searchPriceRefresh"]["streams"]), 4)
        self.assertEqual(len(combined["details"]), 3)
        self.assertEqual(combined["details"][0]["name"], "Preserve 1")
        self.assertEqual(combined["details"][0]["userField"], "keep")
        self.assertEqual(combined["details"][0]["minPrice"], 10)
        self.assertEqual(combined["details"][0]["priceSource"]["originalCurrency"], "KRW")
        self.assertEqual(documents["cards-prices.json"]["prices"]["1"],
                         [10, "USD", "99+", NOW.isoformat(), "available"])

    def test_overlap_between_pages_and_streams_deduplicates_with_progress(self):
        def pages(brand, order, page, per_page):
            return {"tradingCards": {1: [row(1), row(2)], 2: [row(2), row(3)], 3: []}[page]}
        result, report = target.collect_stream(pages, "pokemon", "popular", self.basis(), per_page=2)
        self.assertEqual(set(result), {"1", "2", "3"})
        self.assertEqual(report["pages"], 3)

    def test_short_intermediate_pages_do_not_hide_later_products_or_claim_completion(self):
        calls = []
        def pages(brand, order, page, per_page):
            calls.append(page)
            return {'tradingCards': {1: [row(1)], 2: [row(2), row(3)], 3: [row(4)], 4: []}[page]}
        result, summary = target.collect_stream(pages, 'pokemon', 'popular', self.basis(), per_page=2)
        self.assertEqual(set(result), {'1', '2', '3', '4'})
        self.assertEqual(calls, [1, 2, 3, 4])
        self.assertEqual(summary['terminal'], 'empty-page')
        self.assertEqual(summary['pages'], 4)

    def test_repeated_page_and_reordered_same_ids_fail(self):
        for reorder in (False, True):
            def pages(brand, order, page, per_page):
                return {"tradingCards": [row(2), row(1)] if reorder and page > 1 else [row(1), row(2)]}
            with self.assertRaisesRegex(target.RefreshError, "Repeated"):
                target.collect_stream(pages, "pokemon", "popular", self.basis(), per_page=2)

    def test_transient_repeat_retries_same_page_without_committing_rejected_provenance(self):
        calls = []
        def pages(brand, order, page, per_page):
            calls.append(page)
            if page == 1 or page == 2 and calls.count(2) == 1:
                return {"tradingCards": [row(1), row(2)]}
            return {"tradingCards": [row(3), row(4)] if page == 2 else []}
        result, summary = target.collect_stream(pages, 'pokemon', 'popular', self.basis(), per_page=2)
        self.assertEqual(calls, [1, 2, 2, 3])
        self.assertEqual(set(result), {'1', '2', '3', '4'})
        self.assertEqual(summary['repeatedPageRetries'], 1)
        self.assertIn('page=1&', result['1']['priceSource']['url'])
        self.assertIn('page=2&', result['3']['priceSource']['url'])

    def test_persistent_repeat_has_context_and_never_skips_to_next_page(self):
        calls = []
        def pages(brand, order, page, per_page):
            calls.append(page)
            return {'tradingCards': [row(1), row(2)]}
        with self.assertRaisesRegex(target.RefreshError, r'brand=pokemon order=popular page=2.*firstId=1 lastId=2'):
            target.collect_stream(pages, 'pokemon', 'popular', self.basis(), per_page=2)
        self.assertEqual(calls, [1, 2, 2, 2])

    def test_bad_price_error_identifies_brand_order_page_and_row(self):
        with self.assertRaisesRegex(target.RefreshError, r'brand=onepiece order=new page=1 rowId=123'):
            target.collect_stream(lambda *args: {'tradingCards': [row(123, 10, 'EUR 10')]},
                                  'onepiece', 'new', self.basis())

    def test_missing_products_are_unavailable_with_original_metadata_retained(self):
        catalog = old_catalogue(pokemon=5)
        def pages(brand, order, page, per_page):
            return {"tradingCards": ([row(1), row(2), row(3), row(4)] if brand == "pokemon" else [row(10)]) if page == 1 else []}
        documents = target.build_documents(catalog, self.basis(), pages, now=lambda: NOW)
        missing = next(item for item in documents["all-cards.json"]["details"] if item["id"] == "5")
        self.assertEqual(missing["name"], "Preserve 5")
        self.assertIsNone(missing["minPrice"])
        self.assertIsNone(missing["listingCount"])
        self.assertEqual(missing["priceStatus"], "not-listed")
        self.assertEqual(missing["priceCheckedAt"], NOW.isoformat())

    def test_drastic_shrink_fails(self):
        with self.assertRaisesRegex(target.RefreshError, "80%"):
            target.build_documents(old_catalogue(pokemon=5), self.basis(), complete_pages, per_page=2)

    def test_page_limit_and_initial_empty_are_incomplete(self):
        with self.assertRaisesRegex(target.RefreshError, "page limit"):
            target.collect_stream(complete_pages, "pokemon", "popular", self.basis(), per_page=2, max_pages=1)
        with self.assertRaisesRegex(target.RefreshError, "Empty brand"):
            target.collect_stream(lambda *args: {"tradingCards": []}, "pokemon", "popular", self.basis())

    def test_missing_price_does_not_claim_no_listings_when_listings_exist(self):
        def pages(brand, order, page, per_page):
            return {"tradingCards": [row(1, None, "")] if page == 1 else []}
        values, _ = target.collect_stream(pages, "pokemon", "popular", self.basis())
        self.assertEqual(values["1"]["priceStatus"], "price-unavailable")
        self.assertEqual(values["1"]["listingCount"], "99+")

    def test_currency_prefixed_no_price_markers_require_an_absent_price(self):
        for display, currency in [("₩ -", "KRW"), ("¥ -", "JPY"), ("US $ -", "USD"), ("$ --", "USD")]:
            for absent in (None, 0):
                self.assertEqual(target.listing_price(row(1, absent, display), self.basis()), (None, currency))
            with self.assertRaisesRegex(target.RefreshError, "no-price display"):
                target.listing_price(row(1, 10, display), self.basis())

    def test_saved_public_listing_samples_parse_without_external_requests(self):
        samples = Path(__file__).resolve().parents[2] / "samples"
        paths = [samples / (brand + "-" + order + "-100.json")
                 for brand in target.BRANDS for order in target.ORDERS]
        if not all(path.is_file() for path in paths):
            self.skipTest("Audit-only saved public samples are not packaged with the script")
        total = 0
        for path in paths:
            payload = json.loads(path.read_bytes())
            self.assertEqual(len(payload["tradingCards"]), 100)
            for item in payload["tradingCards"]:
                value, currency = target.listing_price(item, self.basis())
                self.assertIn(currency, ("KRW", "JPY", "USD", None))
                self.assertTrue(value is None or value > 0)
                total += 1
            brand, order, _ = path.stem.split("-")
            rows, terminal = target.collect_stream(
                lambda _brand, _order, page, _size: payload if page == 1 else {"tradingCards": []},
                brand, order, self.basis(), now=lambda: NOW)
            self.assertEqual(len(rows), 100)
            self.assertEqual(terminal["terminal"], "empty-page")
        self.assertEqual(total, 400)

    def test_price_currency_conversion_is_explicit_and_finite(self):
        for amount, display, expected, currency in [(10, "$10", 10, "USD"), (10, "US $10", 10, "USD"),
                                                     (1000, "¥1,000", 6.43, "JPY"), (14000, "₩14,000", 10, "KRW")]:
            self.assertEqual(target.listing_price(row(1, amount, display), self.basis()), (expected, currency))
        self.assertEqual(target.listing_price(row(1, None, ""), self.basis()), (None, None))
        for invalid in [row(1, 10, "CA$10"), row(1, 10, ""), row(1, 10, "$20"),
                        row(1, float("inf"), "$10"), row(1, True, "$1"), row(1, 10, "€10")]:
            with self.assertRaises(target.RefreshError):
                target.listing_price(invalid, self.basis())

    def test_fx_collection_freshness_and_actual_business_close(self):
        for changes in [{"updated": (NOW - timedelta(hours=73)).isoformat()}, {"asOf": "2026-10-12"},
                        {"updated": (NOW + timedelta(hours=1)).isoformat()}, {"rates": {"USD": 0, "JPY": 9}}]:
            document = fx()
            document.update(changes)
            with self.assertRaises(target.RefreshError):
                target.fx_basis(document, NOW)

    def test_bad_schema_ids_counts_and_cross_brand_conflicts_fail(self):
        for invalid in [{}, {"tradingCards": "bad"}, {"tradingCards": [row("bad")]},
                        {"tradingCards": [row(1), row(1)]},
                        {"tradingCards": [{**row(1), "listingCount": "many"}]}]:
            with self.assertRaises(target.RefreshError):
                target.collect_stream(lambda *args: invalid, "pokemon", "popular", self.basis())
        with self.assertRaisesRegex(target.RefreshError, "conflicts"):
            target.build_documents(old_catalogue(), self.basis(),
                                   lambda brand, order, page, size: {"tradingCards": [row(1), row(2)] if page == 1 else []})


class PromotionTests(unittest.TestCase):
    def fixture(self, directory):
        directory = Path(directory)
        originals = {name: ("original bytes: " + name).encode() for name in
                     ("all-cards.json", "cards-meta.json", "cards-prices.json")}
        for name, raw in originals.items():
            (directory / name).write_bytes(raw)
        return directory, originals, {name: {"fresh": name} for name in originals}

    def test_every_promotion_failure_restores_exact_original_bytes(self):
        for fail_at in (1, 2, 3):
            with self.subTest(fail_at=fail_at), tempfile.TemporaryDirectory() as folder:
                directory, originals, documents = self.fixture(folder)
                calls = 0
                def replace(source, destination):
                    nonlocal calls
                    calls += 1
                    if calls == fail_at:
                        raise OSError("injected write failure")
                    os.replace(source, destination)
                with self.assertRaisesRegex(target.RefreshError, "exact original"):
                    target.promote_documents(directory, documents, originals, replace=replace)
                for name, raw in originals.items():
                    self.assertEqual((directory / name).read_bytes(), raw)

    def test_concurrent_user_change_is_retained(self):
        with tempfile.TemporaryDirectory() as folder:
            directory, originals, documents = self.fixture(folder)
            (directory / "cards-meta.json").write_bytes(b"user edit")
            with self.assertRaisesRegex(target.RefreshError, "changed"):
                target.promote_documents(directory, documents, originals)
            self.assertEqual((directory / "cards-meta.json").read_bytes(), b"user edit")
            self.assertEqual((directory / "all-cards.json").read_bytes(), originals["all-cards.json"])

    def test_success_promotes_all_three_valid_documents(self):
        with tempfile.TemporaryDirectory() as folder:
            directory, originals, documents = self.fixture(folder)
            target.promote_documents(directory, documents, originals)
            for name, document in documents.items():
                self.assertEqual(json.loads((directory / name).read_bytes()), document)

    def test_fetch_failure_after_first_brand_leaves_all_original_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            directory, _, _ = self.fixture(folder)
            (directory / "all-cards.json").write_text(json.dumps(old_catalogue()), encoding="utf-8")
            (directory / "fx-rates.json").write_text(json.dumps(fx()), encoding="utf-8")
            originals = {name: (directory / name).read_bytes() for name in
                         ("all-cards.json", "cards-meta.json", "cards-prices.json")}
            def fetch(brand, order, page, per_page):
                if brand == "onepiece":
                    raise target.RefreshError("HTTP 429")
                return complete_pages(brand, order, page, per_page)
            with self.assertRaisesRegex(target.RefreshError, "429"):
                target.refresh(directory, FakeClient(fetch), now=lambda: NOW, per_page=2)
            for name, raw in originals.items():
                self.assertEqual((directory / name).read_bytes(), raw)

    def test_unrecovered_repeated_page_preserves_all_three_original_snapshots(self):
        with tempfile.TemporaryDirectory() as folder:
            directory, _, _ = self.fixture(folder)
            (directory / 'all-cards.json').write_text(json.dumps(old_catalogue()), encoding='utf-8')
            (directory / 'fx-rates.json').write_text(json.dumps(fx()), encoding='utf-8')
            originals = {name: (directory / name).read_bytes() for name in
                         ('all-cards.json', 'cards-meta.json', 'cards-prices.json')}
            calls = []
            def repeated(brand, order, page, per_page):
                calls.append(page)
                return {'tradingCards': [row(1), row(2)]}
            with self.assertRaisesRegex(target.RefreshError, 'Repeated listing page'):
                target.refresh(directory, FakeClient(repeated), now=lambda: NOW, per_page=2)
            self.assertEqual(calls, [1, 2, 2, 2])
            for name, raw in originals.items():
                self.assertEqual((directory / name).read_bytes(), raw)


class ClientTests(unittest.TestCase):
    class Response(io.BytesIO):
        def getcode(self):
            return 200

        def geturl(self):
            return "https://snkrdunk.com/en/v1/trading-cards"

    def test_all_attempts_are_throttled_and_send_no_cookie_or_authorization(self):
        tick, starts, requests = [0.0], [], []
        def sleep(seconds):
            tick[0] += seconds
        def opener(request, timeout):
            starts.append(tick[0])
            requests.append(request)
            if len(starts) == 1:
                raise urllib.error.HTTPError(request.full_url, 503, "busy", {}, None)
            return self.Response(b'{"tradingCards":[]}')
        client = target.PublicClient(opener=opener, clock=lambda: tick[0], sleep=sleep)
        client.get("pokemon", "popular", 1, 100)
        client.get("pokemon", "popular", 2, 100)
        self.assertEqual(starts, [0, 1, 2])
        self.assertTrue(all("cookie" not in {key.lower() for key in request.headers}
                            and "authorization" not in {key.lower() for key in request.headers} for request in requests))
        headers = [{key.lower(): value for key, value in request.headers.items()} for request in requests]
        self.assertNotIn("cache-control", headers[0])
        self.assertEqual(headers[1]["cache-control"], "no-cache")
        self.assertEqual(headers[1]["pragma"], "no-cache")
        self.assertNotIn("cache-control", headers[2])

    def test_same_page_validation_retries_revalidate_without_changing_url(self):
        requests, ticks = [], [0.0]
        def opener(request, timeout):
            requests.append(request)
            return self.Response(b'{"tradingCards":[]}')
        client = target.PublicClient(opener=opener, clock=lambda: ticks[0],
                                     sleep=lambda seconds: ticks.__setitem__(0, ticks[0] + seconds))
        for _ in range(3):
            client.get("pokemon", "popular", 2, 100)
        self.assertEqual(len({request.full_url for request in requests}), 1)
        headers = [{key.lower(): value for key, value in request.headers.items()} for request in requests]
        self.assertNotIn("cache-control", headers[0])
        self.assertNotIn("pragma", headers[0])
        for retried in headers[1:]:
            self.assertEqual(retried["cache-control"], "no-cache")
            self.assertEqual(retried["pragma"], "no-cache")
        self.assertEqual(ticks[0], 2.0)
        with self.assertRaisesRegex(target.RefreshError, "request budget exhausted"):
            client.get("pokemon", "popular", 2, 100)
        self.assertEqual(len(requests), 3)

    def test_403_and_429_stop_on_first_attempt(self):
        for code in (403, 429):
            count = []
            def opener(request, timeout):
                count.append(1)
                raise urllib.error.HTTPError(request.full_url, code, "stop", {}, None)
            client = target.PublicClient(opener=opener, sleep=lambda _: None)
            with self.assertRaisesRegex(target.RefreshError, str(code)):
                client.get("pokemon", "popular", 1, 100)
            self.assertEqual(len(count), 1)

    def test_retry_and_runtime_limits(self):
        calls, tick = [], [0.0]
        def opener(request, timeout):
            calls.append(1)
            raise urllib.error.URLError("offline")
        client = target.PublicClient(opener=opener, clock=lambda: tick[0], sleep=lambda sec: tick.__setitem__(0, tick[0] + sec))
        with self.assertRaises(target.RefreshError):
            client.get("pokemon", "popular", 1, 100)
        self.assertEqual(len(calls), 3)
        tick[0] = 0
        client = target.PublicClient(opener=opener, clock=lambda: tick[0], sleep=lambda sec: tick.__setitem__(0, tick[0] + sec), max_seconds=1)
        with self.assertRaisesRegex(target.RefreshError, "runtime"):
            client.get("pokemon", "popular", 1, 100)

    def test_transport_and_repeated_page_retries_share_three_actual_request_budget(self):
        from urllib.parse import parse_qs, urlsplit
        requests, ticks = [], [0.0]
        counts = {}
        def opener(request, timeout):
            page = int(parse_qs(urlsplit(request.full_url).query)['page'][0])
            counts[page] = counts.get(page, 0) + 1
            requests.append((page, ticks[0]))
            if page == 2 and counts[page] == 1:
                raise urllib.error.HTTPError(request.full_url, 503, 'transient', {}, None)
            return self.Response(json.dumps({'tradingCards': [row(1), row(2)]}).encode())
        client = target.PublicClient(opener=opener, clock=lambda: ticks[0],
                                     sleep=lambda seconds: ticks.__setitem__(0, ticks[0] + seconds))
        with self.assertRaisesRegex(target.RefreshError, 'request budget exhausted'):
            target.collect_stream(client.get, 'pokemon', 'popular', {'rates': {'USD': 1400, 'JPY': 9}}, per_page=2)
        self.assertEqual(counts, {1: 1, 2: 3})
        self.assertEqual([stamp for _, stamp in requests], [0, 1, 2, 3])


if __name__ == "__main__":
    unittest.main()
