import argparse
import copy
import importlib.util
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "collect_yuyutei_market.py"
SPEC = importlib.util.spec_from_file_location("collect_yuyutei_market", MODULE_PATH)
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)


def product(pid="10155", name="Monkey D. Luffy (parallel)", price="3,980", stock="1 点",
            number="OP17-118", rarity="P-SEC", source_set="op17", extra_class=""):
    # Reduced original listing structure, including actual same-number artwork collision.
    return f'''<div class="card-product position-relative {extra_class}">
      <a href="https://yuyu-tei.jp/sell/opc/card/{source_set}/{pid}">
       <div class="product-img"><img src="https://card.yuyu-tei.jp/opc/100_140/{source_set}/{pid}.jpg"
        alt="{number} {rarity} {name}"></div></a>
      <span class="d-block border">{number}</span>
      <a href="https://yuyu-tei.jp/sell/opc/card/{source_set}/{pid}"><h4>{name}</h4></a>
      <strong>{price} 円</strong><label class="cart_sell_zaiko">在庫 : {stock}</label>
      <input class="cart_ver" value="{source_set}"><input class="cart_cid" value="{pid}">
      <input class="cart_kizu" value="0"></div>'''


def listing(*products):
    return '<div class="cards-list"><h3><span>P-SEC</span> Card List</h3>' + ''.join(products) + '</div>'


NOW = "2026-10-29T12:00:00Z"


class OriginalListingTests(unittest.TestCase):
    def rows(self, markup):
        return collector.parse_listing(markup, "onepiece", "op17", NOW)[0]

    def test_discovery_preserves_original_dotted_codes_and_deduplicates_mobile(self):
        html = '''<input name="vers[]" value="dcext1.0" id="a"><label for="a">D.C. Extra</label>
        <input name="vers[]" value="dcext1.0" id="b"><label for="b">D.C. Extra</label>
        <input name="vers[]" value="promo-st60" id="c"><label for="c">Promo</label>
        <a href="https://yuyu-tei.jp/sell/ws/s/dcext1.0">Current</a>
        <a href="https://yuyu-tei.jp/sell/ws/s/sale">Sale is not a set</a>'''
        sets, highlights = collector.discover_sets(html, "weiss_schwarz")
        self.assertEqual([row["sourceSetCode"] for row in sets], ["dcext1.0", "promo-st60"])
        self.assertEqual(highlights, ["dcext1.0"])
        self.assertEqual(sets[0]["name"], "D.C. Extra")

    def test_same_number_and_rarity_parallel_artworks_remain_separate(self):
        rows = self.rows(listing(product(), product("10156", "Monkey D. Luffy (海賊団スーパーパラレル)", "398,000", "×", extra_class="sold-out")))
        self.assertEqual(len(rows), 2)
        self.assertEqual({row["cardNumber"] for row in rows}, {"OP17-118"})
        self.assertEqual({row["rarity"] for row in rows}, {"P-SEC"})
        self.assertEqual(len({row["variant"] for row in rows}), 2)
        self.assertEqual(len({row["id"] for row in rows}), 2)
        self.assertEqual(sorted(row["price"] for row in rows), [3980, 398000])

    def test_recommendations_and_other_set_blocks_are_excluded(self):
        markup = product("99999") + listing(product(), product("12345", source_set="op16"))
        rows, diagnostics = collector.parse_listing(markup, "onepiece", "op17", NOW)
        self.assertEqual([row["sourceProductId"] for row in rows], ["10155"])
        self.assertEqual(diagnostics["differentSetBlock"], 1)

    def test_original_quantity_and_sold_out_semantics(self):
        rows = self.rows(listing(product("1", stock="6 点"), product("2", stock="○"),
                                 product("3", stock="×", extra_class="sold-out"), product("4", stock="不明")))
        by_id = {row["sourceProductId"]: row for row in rows}
        self.assertEqual((by_id["1"]["stock"], by_id["1"]["purchasable"]), (6, True))
        self.assertEqual((by_id["2"]["stock"], by_id["2"]["stockState"]), (None, "in_stock_quantity_unknown"))
        self.assertEqual((by_id["3"]["stock"], by_id["3"]["purchasable"]), (0, False))
        self.assertIsNone(by_id["4"]["purchasable"])

    def test_missing_price_never_becomes_zero(self):
        row = self.rows(listing(product(price="価格未定")))[0]
        self.assertIsNone(row["price"])
        self.assertIsNone(row["purchasable"])

    def test_damaged_condition_is_not_a_raw_undamaged_quote(self):
        html = listing(product().replace('class="cart_kizu" value="0"', 'class="cart_kizu" value="1"'))
        self.assertEqual(self.rows(html), [])


class HistoricalIdentityTests(unittest.TestCase):
    def row(self):
        return collector.parse_listing(listing(product()), "onepiece", "op17", NOW)[0][0]

    def test_history_is_keyed_to_exact_original_product(self):
        old = self.row()
        old["history"] = [{"date": "2026-10-28", "price": 320, "sourceAsOf": "2026-10-28T12:00:00Z"}]
        different = copy.deepcopy(old)
        different.update({"id": "yuyutei:opc:op17:10156", "sourceProductId": "10156", "price": 39800, "history": []})
        merged = collector.merge_records([old], [different])
        selected = next(row for row in merged if row["sourceProductId"] == "10156")
        self.assertEqual([point["price"] for point in selected["history"]], [39800])

    def test_psa_currency_variant_and_language_history_never_mix(self):
        for field, value in [("grade", "PSA 10"), ("currency", "USD"), ("variant", "different artwork"),
                             ("language", "en"), ("priceKind", "completed_sale")]:
            with self.subTest(field=field):
                old = self.row(); old[field] = value
                old["history"] = [{"date": "2026-10-28", "price": 320}]
                merged = collector.merge_records([old], [self.row()])[0]
                self.assertEqual([point["date"] for point in merged["history"]], ["2026-10-29"])

    def test_daily_rerun_replaces_only_same_day_point(self):
        first = collector.merge_records([], [self.row()])[0]
        second = self.row(); second["price"] = 4100
        merged = collector.merge_records([first], [second])[0]
        self.assertEqual(len(merged["history"]), 1)
        self.assertEqual(merged["history"][0]["price"], 4100)

    def test_successful_shrinking_snapshot_keeps_history_but_removes_buyability(self):
        one = self.row()
        two = copy.deepcopy(one); two.update({"id": "yuyutei:opc:op17:10156", "sourceProductId": "10156", "price": 398000})
        two["history"] = [{"date": "2026-10-28", "price": 398000}]
        result = collector.merge_records([one, two], [self.row()], complete_snapshot=True)
        missing = next(row for row in result if row["sourceProductId"] == "10156")
        self.assertTrue(missing["notObservedInLatestSnapshot"])
        self.assertIsNone(missing["purchasable"])
        self.assertEqual(missing["price"], 398000)
        self.assertEqual(missing["history"], two["history"])

    def test_older_original_seed_cannot_overwrite_newer_quote(self):
        current = self.row()
        older = self.row(); older.update({"sourceAsOf": "2026-10-28T12:00:00Z", "price": 100})
        self.assertEqual(collector.merge_records([current], [older])[0]["price"], current["price"])


class LastGoodAndRotationTests(unittest.TestCase):
    def test_newest_and_least_recently_attempted_sets_rotate(self):
        discovered = [{"sourceSetCode": str(i), "name": str(i)} for i in range(5)]
        previous = {"sets": [{"sourceSetCode": "1", "lastAttemptAt": NOW}]}
        chosen = collector.choose_sets(discovered, ["0"], previous, 3)
        self.assertEqual([row["sourceSetCode"] for row in chosen], ["0", "2", "3"])

    def test_empty_source_page_keeps_last_good_price_and_original_timestamp(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            old_row = collector.parse_listing(listing(product()), "onepiece", "op17", "2026-10-28T12:00:00Z")[0][0]
            detail_path = output / "yuyutei-market" / "onepiece" / "op17.json"
            collector.atomic_json(detail_path, {"lastSuccessAt": "2026-10-28T12:00:00Z", "sourceAsOf": "2026-10-28T12:00:00Z", "records": [old_row]})
            args = argparse.Namespace(output_dir=output, max_sets_per_game=0, workers=1, timeout=5,
                                      history_days=90, resume_hours=0, limiter=None, requests_per_second=1)
            discovery = '<input name="vers[]" value="op17" id="x"><label for="x">OP17</label>'
            with patch.object(collector, "fetch_html", side_effect=[discovery, '<div>Source unavailable</div>']):
                summary = collector.collect_game("onepiece", args)
            self.assertEqual(summary["status"], "partial")
            self.assertEqual(summary["coverage"]["failedSets"], 1)
            shard = json.loads((output / "yuyutei-market" / "onepiece.json").read_text(encoding="utf-8"))
            decoded = dict(zip(shard["columns"], shard["rows"][0]))
            self.assertEqual(decoded["price"], 3980)
            self.assertEqual(decoded["sourceAsOf"], "2026-10-28T12:00:00Z")
            self.assertEqual(json.loads(detail_path.read_text(encoding="utf-8"))["records"][0], old_row)

    def test_http429_opens_global_circuit_and_respects_retry_after(self):
        limiter = collector.RateLimiter(2, max_requests=250)
        error = urllib.error.HTTPError("https://yuyu-tei.jp/top/opc", 429, "Too Many Requests", {"Retry-After": "3600"}, None)
        with patch.object(collector.urllib.request, "urlopen", side_effect=error) as request:
            with self.assertRaises(collector.SourceDeferred):
                collector.fetch_html("https://yuyu-tei.jp/top/opc", 5, limiter=limiter)
            with self.assertRaises(collector.SourceDeferred):
                collector.fetch_html("https://yuyu-tei.jp/top/ws", 5, limiter=limiter)
        self.assertEqual(request.call_count, 1)
        self.assertEqual(limiter.cooldown["retryAfterSeconds"], 3600)
        self.assertEqual(limiter.cooldown["retryAfterPolicy"], "original_retry_after_header")

    def test_request_budget_stops_before_another_source_request(self):
        limiter = collector.RateLimiter(2, max_requests=1)
        limiter.wait()
        with self.assertRaises(collector.SourceDeferred):
            limiter.wait()
        self.assertEqual(limiter.request_count, 1)

    def test_http403_is_source_access_denial_not_a_parser_or_dependency_failure(self):
        limiter = collector.RateLimiter(2, max_requests=250)
        error = urllib.error.HTTPError("https://yuyu-tei.jp/top/ua", 403, "Forbidden", {}, None)
        with patch.object(collector.urllib.request, "urlopen", side_effect=error) as request:
            for url in ["https://yuyu-tei.jp/top/ua", "https://yuyu-tei.jp/top/digi"]:
                with self.assertRaises(collector.SourceDeferred):
                    collector.fetch_html(url, 5, limiter=limiter)
        self.assertEqual(request.call_count, 1)
        self.assertEqual(limiter.cooldown["httpStatus"], 403)
        self.assertEqual(limiter.cooldown["blockReason"], "access_denied")
        self.assertEqual(limiter.cooldown["retryAfterSeconds"], 86400)

    def test_valid_retained_data_is_never_reported_as_a_successful_refresh(self):
        with tempfile.TemporaryDirectory() as directory:
            args = argparse.Namespace(output_dir=Path(directory), max_sets_per_game=45,
                                      history_days=90, resume_hours=20, requests_per_second=.5,
                                      max_requests=250, limiter=collector.RateLimiter(.5),
                                      _run_fresh_records={"union_arena": 0})
            args.limiter.record_rate_limit("https://yuyu-tei.jp/top/ua", http_status=403)
            summary = {"game": "union_arena", "recordCount": 3, "sourceAsOf": NOW, "status": "partial"}
            manifest = collector.publish_manifest(args, summary)
            self.assertEqual(manifest["lastRun"]["outcome"], "blocked")
            self.assertEqual(manifest["lastRun"]["recordsFetched"], 0)
            self.assertEqual(manifest["lastRun"]["httpStatus"], 403)

    def test_persisted_cooldown_prevents_source_requests_after_restart(self):
        limiter = collector.RateLimiter(2)
        limiter.record_rate_limit("https://yuyu-tei.jp/top/opc", fallback_seconds=900)
        restarted = collector.RateLimiter(2, cooldown=limiter.cooldown)
        with patch.object(collector.urllib.request, "urlopen") as request:
            with self.assertRaises(collector.SourceDeferred):
                collector.fetch_html("https://yuyu-tei.jp/top/ws", 5, limiter=restarted)
        request.assert_not_called()

    def test_product_seed_is_not_treated_as_complete_set_snapshot(self):
        self.assertFalse(collector.recently_collected({"lastSuccessAt": collector.utc_now(),
                                                      "records": [{"id": "one"}], "collectionScope": "product_observations"}, 20))


if __name__ == "__main__":
    unittest.main()
