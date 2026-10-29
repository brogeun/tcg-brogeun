"""Offline publication guards using small source-faithful fixtures."""
from contextlib import redirect_stdout
from copy import deepcopy
from datetime import datetime, timezone
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from validate_reference_markets import InvalidData, Validator, main


NOW = datetime(2026, 10, 29, 12, tzinfo=timezone.utc)
ASOF = "2026-10-29T10:00:00Z"


class ReferenceValidationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def write(self, reference, data):
        file = self.root / reference.lstrip("/")
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        return file

    def read(self, reference):
        return json.loads((self.root / reference.lstrip("/")).read_text(encoding="utf-8"))

    def validate(self, **kwargs):
        validator = Validator(self.root, now=NOW, **kwargs)
        report = validator.run()
        return validator, report

    @staticmethod
    def quote(printing, market=1.25):
        return {"subTypeName": printing, "marketPrice": market, "lowPrice": 1.0, "midPrice": 2.0,
                "highPrice": 3.0, "directLowPrice": None, "currency": "USD", "priceKind": "market_estimate",
                "listingPriceKind": "asking_price", "conditionScope": "ungraded provider aggregate", "isLastCompletedSale": False}

    def us(self, asof=ASOF):
        prints = {"Normal": self.quote("Normal"), "Reverse Holofoil": self.quote("Reverse Holofoil", None)}
        card = {"productId": "123", "sourceUrl": "https://www.tcgplayer.com/product/123/example", "name": "Example",
                "sourcePrinting": "unspecified", "printings": prints}
        shard = {"schemaVersion": 1, "source": "TCGCSV", "currency": "USD", "language": "en", "setCode": "EN-X",
                 "sourceAsOf": asof, "cards": {"101": card}, "sealed": [], "coverage": {"matchedCards": 1, "matchedWithoutPrice": 0}}
        entry = {"code": "EN-X", "file": "/data/us-market/EN-X.json", "cardCount": 1, "matchedCount": 1,
                 "pricedCount": 1, "printingCount": 2, "sealedCount": 0, "status": "mapped", "sourceAsOf": asof}
        manifest = {"schemaVersion": 1, "source": "TCGCSV", "currency": "USD", "language": "en", "sourceAsOf": asof,
                    "sets": [entry], "coverage": {"catalogSets": 1, "matchedCards": 1, "pricedCards": 1, "printingQuotes": 2, "sealedProducts": 0, "staleSets": 0}}
        self.write("/data/us-market.json", manifest)
        self.write(entry["file"], shard)
        return manifest, shard

    def yuyu(self):
        record = {"id": "yuyutei:ws:dcext1.0:10001", "game": "weiss_schwarz", "source": "yuyutei", "language": "ja", "grade": "raw",
                  "sourceSetCode": "dcext1.0", "sourceProductId": "10001", "cardNumber": "NIK/S117-001", "name": "Card",
                  "sourceUrl": "https://yuyu-tei.jp/sell/ws/card/dcext1.0/10001", "currency": "JPY", "priceKind": "asking",
                  "price": 1200, "stock": None, "stockState": "in_stock_quantity_unknown", "purchasable": True, "sourceAsOf": ASOF, "history": []}
        columns = ["sourceSetCode", "sourceProductId", "cardNumber", "price", "stock", "stockState", "sourceAsOf", "purchasable"]
        entry = {"sourceSetCode": "dcext1.0", "name": "A source set with dots", "shard": "/data/yuyutei-market/weiss_schwarz/dcext1.0.json", "status": "ok", "recordCount": 1}
        metadata = {"schemaVersion": 1, "source": "yuyutei", "currency": "JPY", "priceKind": "asking", "game": "weiss_schwarz", "sourceGame": "ws", "language": "ja", "sourceAsOf": ASOF}
        index = {**metadata, "columns": columns, "rows": [[record[field] for field in columns]], "sets": [entry]}
        detail = {**metadata, "sourceSetCode": "dcext1.0", "records": [record]}
        game = {"game": "weiss_schwarz", "sourceGame": "ws", "shard": "/data/yuyutei-market/weiss_schwarz.json", "status": "ok", "recordCount": 1,
                "coverage": {"discoveredSets": 1, "collectedSets": 1, "failedSets": 0, "pendingSets": 0}}
        manifest = {"schemaVersion": 1, "source": "yuyutei", "currency": "JPY", "priceKind": "asking", "sourceAsOf": ASOF, "status": "ok", "games": [game]}
        self.write("/data/yuyutei-market.json", manifest)
        self.write(game["shard"], index)
        self.write(entry["shard"], detail)
        return manifest, index, detail

    def mercari(self):
        reference = {"id": "mercari:m123", "itemId": "m123", "sourceUrl": "https://jp.mercari.com/item/m123", "title": "Known listing",
                     "price": {"amount": 19000, "currency": "JPY"}, "observedAt": ASOF, "saleStatus": "unknown", "soldAt": None,
                     "verification": "unverified", "valuationEligible": False, "priceBasis": "displayed_listing_price", "fetchStatus": "ok", "stale": False}
        data = {"schemaVersion": 1, "source": "mercari", "updatedAt": ASOF, "references": [reference], "verifiedQuotes": [],
                "coverage": {"trackedCount": 1, "verifiedQuoteCount": 0, "discovery": "manual_urls"}}
        self.write("/data/mercari-references.json", data)
        return data

    def snkr(self):
        product = {"id": "123", "brand": "union_arena", "kind": "card", "name": "Source card", "url": "https://snkrdunk.com/apparels/123",
                   "currency": "USD", "minPrice": 100, "priceCheckedAt": ASOF,
                   "catalogAsk": {"amount": 14500, "currency": "JPY", "kind": "lowest_listing_ask", "condition": "unspecified"},
                   "grades": {"raw": {"currency": "JPY", "price_kind": "lowest_listing_ask", "availability": "no-listing"},
                              "psa10": {"currency": "JPY", "price_kind": "lowest_listing_ask", "availability": "listed", "lowest_ask": 18000, "active_count": 1}},
                   "gradeCheckedAt": ASOF, "gradeStatus": "checked"}
        game = {"id": "union_arena", "cardUrl": "/data/price-union_arena-card.json", "boxUrl": "/data/price-union_arena-box.json",
                "cardCount": 1, "boxCount": 0, "listingComplete": True}
        manifest = {"schemaVersion": 1, "source": "SNKRDUNK", "fetchedAt": ASOF, "games": [game]}
        common = {"schemaVersion": 1, "source": "SNKRDUNK", "currency": "USD", "brand": "union_arena", "fetchedAt": ASOF, "collection": {"complete": True}}
        snapshot = {**common, "kind": "card", "count": 1, "products": [product]}
        self.write("/data/snkrdunk-games.json", manifest)
        self.write(game["cardUrl"], snapshot)
        self.write(game["boxUrl"], {**common, "kind": "box", "count": 0, "products": []})
        return manifest, snapshot

    def test_absent_sources_are_explicitly_unavailable_without_fabricated_values(self):
        validator, report = self.validate()
        self.assertFalse(validator.invalid)
        self.assertEqual(report["status"], "unavailable")
        self.assertTrue(all(row["asOf"] is None for row in report["sources"].values()))

    def test_corrupt_json_and_nonfinite_json_constants_reject_publication(self):
        for content in ('{"bad":', '{"schemaVersion":1,"source":"TCGCSV","price":NaN}'):
            with self.subTest(content=content):
                self.write("/data/us-market.json", {}).write_text(content, encoding="utf8")
                validator, report = self.validate()
                self.assertTrue(validator.invalid)
                self.assertIn("invalid JSON", report["sources"]["us"]["errors"][0])

    def test_paths_reject_traversal_drive_paths_encoded_components_and_backslashes(self):
        validator = Validator(self.root)
        for value in ("/data/../secret.json", "/data/us/../../secret.json", "C:/data/x.json", "/data/%2e%2e/x.json", "/data/..\\x.json"):
            with self.subTest(value=value), self.assertRaises(InvalidData):
                validator.safe_path(value)
        self.assertEqual(validator.safe_path("/data/yuyutei-market/ws/dcext1.0.json").name, "dcext1.0.json")

    def test_us_multiple_printings_and_ask_only_quote_keep_their_semantics(self):
        self.us()
        validator, report = self.validate()
        self.assertFalse(validator.invalid)
        self.assertEqual(report["sources"]["us"]["status"], "healthy")
        self.assertEqual(report["sources"]["us"]["coverage"]["printingQuotes"], 2)

    def test_us_unpriced_exact_match_is_explicitly_allowed(self):
        manifest, shard = self.us()
        shard["cards"] = {}
        shard["coverage"] = {"matchedCards": 1, "matchedWithoutPrice": 1}
        manifest["sets"][0].update(pricedCount=0, printingCount=0)
        manifest["coverage"].update(pricedCards=0, printingQuotes=0)
        self.write("/data/us-market.json", manifest)
        self.write("/data/us-market/EN-X.json", shard)
        self.assertFalse(self.validate()[0].invalid)

    def test_us_psa_inference_or_completed_sale_promotion_rejects_publication(self):
        for mutation in ("grade", "sale", "printing"):
            with self.subTest(mutation=mutation):
                _, shard = self.us()
                card = shard["cards"]["101"]
                if mutation == "grade":
                    card["psa10"] = 100
                elif mutation == "sale":
                    card["printings"]["Normal"]["isLastCompletedSale"] = True
                else:
                    card["sourcePrinting"] = "Holofoil"
                self.write("/data/us-market/EN-X.json", shard)
                self.assertTrue(self.validate()[0].invalid)

    def test_us_zero_negative_or_infinite_prices_are_not_missing_price_markers(self):
        for value in (0, -1, float("inf"), True):
            with self.subTest(value=value):
                _, shard = self.us()
                shard["cards"]["101"]["printings"]["Normal"]["marketPrice"] = value
                self.write("/data/us-market/EN-X.json", shard)
                self.assertTrue(self.validate()[0].invalid)

    def test_stale_last_good_keeps_original_observation_and_failed_refresh_is_not_freshened(self):
        old = "2026-10-20T10:00:00Z"
        self.us(asof=old)
        original = self.read("/data/us-market/EN-X.json")
        validator, report = self.validate(outcomes={"us": {"outcome": "failure"}})
        self.assertFalse(validator.invalid)
        self.assertTrue(report["sources"]["us"]["stale"])
        self.assertEqual(report["sources"]["us"]["asOf"], old)
        self.assertEqual(report["sources"]["us"]["oldestQuoteAt"], old)
        self.assertEqual(original, self.read("/data/us-market/EN-X.json"))

    def test_yuyutei_dotted_set_and_pending_discovery_are_valid_partial_coverage(self):
        manifest, index, _ = self.yuyu()
        index["sets"].append({"sourceSetCode": "pending1", "name": "Discovered only"})
        manifest["games"][0]["coverage"].update(discoveredSets=2, pendingSets=1)
        self.write("/data/yuyutei-market.json", manifest)
        self.write("/data/yuyutei-market/weiss_schwarz.json", index)
        validator, report = self.validate()
        self.assertFalse(validator.invalid)
        self.assertEqual(report["sources"]["yuyutei"]["status"], "partial")

    def test_same_card_number_different_exact_shop_products_remain_distinct(self):
        manifest, index, detail = self.yuyu()
        other = deepcopy(detail["records"][0])
        other.update(id="yuyutei:ws:dcext1.0:10002", sourceProductId="10002", sourceUrl="https://yuyu-tei.jp/sell/ws/card/dcext1.0/10002", price=120000)
        detail["records"].append(other)
        index["rows"].append([other[field] for field in index["columns"]])
        index["sets"][0]["recordCount"] = manifest["games"][0]["recordCount"] = 2
        self.write("/data/yuyutei-market.json", manifest)
        self.write("/data/yuyutei-market/weiss_schwarz.json", index)
        self.write(index["sets"][0]["shard"], detail)
        validator, report = self.validate()
        self.assertFalse(validator.invalid)
        self.assertEqual(report["sources"]["yuyutei"]["coverage"]["records"], 2)

    def test_current_verified_partial_shop_products_are_not_mislabeled_as_aged(self):
        manifest, index, _ = self.yuyu()
        index["sets"][0].update(status="partial", collectionScope="product_observations")
        manifest["games"][0]["coverage"].update(collectedSets=0, pendingSets=1, partialProductSets=1)
        manifest["cooldown"] = {"httpStatus": 429, "observedAt": ASOF, "nextEligibleAt": "2026-10-29T10:15:00Z", "retryAfterSeconds": 900}
        self.write("/data/yuyutei-market.json", manifest)
        self.write("/data/yuyutei-market/weiss_schwarz.json", index)
        validator, report = self.validate()
        self.assertFalse(validator.invalid)
        result = report["sources"]["yuyutei"]
        self.assertEqual(result["status"], "partial")
        self.assertFalse(result["stale"])
        self.assertEqual(result["cooldown"]["httpStatus"], 429)
        self.assertEqual(result["coverage"]["partialProductSets"], 1)

    def test_yuyutei_index_detail_mismatch_or_unknown_stock_promotion_is_rejected(self):
        _, index, detail = self.yuyu()
        detail["records"][0]["price"] = 1
        self.write(index["sets"][0]["shard"], detail)
        self.assertTrue(self.validate()[0].invalid)
        self.yuyu()
        index = self.read("/data/yuyutei-market/weiss_schwarz.json")
        index["rows"][0][index["columns"].index("stockState")] = "unknown"
        self.write("/data/yuyutei-market/weiss_schwarz.json", index)
        self.assertTrue(self.validate()[0].invalid)

    def test_mercari_unknown_unverified_reference_is_valid_but_not_a_valuation_feed(self):
        self.mercari()
        validator, report = self.validate()
        self.assertFalse(validator.invalid)
        self.assertEqual(report["sources"]["mercari"]["status"], "partial")

    def test_mercari_unknown_candidate_cannot_be_promoted_or_given_inferred_sold_date(self):
        for field, value in (("valuationEligible", True), ("soldAt", ASOF)):
            with self.subTest(field=field):
                data = self.mercari()
                data["references"][0][field] = value
                self.write("/data/mercari-references.json", data)
                self.assertTrue(self.validate()[0].invalid)

    def test_snkr_native_only_ask_and_missing_graded_listing_are_valid(self):
        manifest, snapshot = self.snkr()
        snapshot["products"][0]["minPrice"] = None
        self.write(manifest["games"][0]["cardUrl"], snapshot)
        validator, report = self.validate()
        self.assertFalse(validator.invalid)
        self.assertEqual(report["sources"]["snkrdunk"]["status"], "healthy")

    def test_snkr_no_listing_cannot_carry_an_invented_ask_or_wrong_grade_currency(self):
        for field, value in (("lowest_ask", 1), ("currency", "USD")):
            with self.subTest(field=field):
                manifest, snapshot = self.snkr()
                snapshot["products"][0]["grades"]["raw"][field] = value
                self.write(manifest["games"][0]["cardUrl"], snapshot)
                self.assertTrue(self.validate()[0].invalid)

    def test_large_snkr_snapshot_includes_every_chunk_and_checks_full_manifest_count(self):
        manifest, snapshot = self.snkr()
        second = deepcopy(snapshot["products"][0])
        second.update(id="124", url="https://snkrdunk.com/apparels/124")
        shard_path = "/data/snkrdunk-games/union_arena-card-0001.json"
        snapshot.update(totalCount=2, shards=[shard_path])
        manifest["games"][0]["cardCount"] = 2
        self.write("/data/snkrdunk-games.json", manifest)
        self.write(manifest["games"][0]["cardUrl"], snapshot)
        self.write(shard_path, {"schemaVersion": 1, "source": "SNKRDUNK", "brand": "union_arena", "kind": "card", "count": 1, "products": [second]})
        validator, report = self.validate()
        self.assertFalse(validator.invalid)
        self.assertEqual(report["sources"]["snkrdunk"]["coverage"]["products"], 2)
        (self.root / shard_path.lstrip("/")).unlink()
        self.assertTrue(self.validate()[0].invalid)

    def test_snkr_chunk_traversal_or_duplicate_identity_is_rejected(self):
        manifest, snapshot = self.snkr()
        snapshot.update(totalCount=2, shards=["/data/snkrdunk-games/../../outside.json"])
        self.write(manifest["games"][0]["cardUrl"], snapshot)
        self.assertTrue(self.validate()[0].invalid)
        shard_path = "/data/snkrdunk-games/union_arena-card-0001.json"
        snapshot["shards"] = [shard_path]
        self.write(manifest["games"][0]["cardUrl"], snapshot)
        self.write(shard_path, {"schemaVersion": 1, "source": "SNKRDUNK", "brand": "union_arena", "kind": "card", "count": 1, "products": snapshot["products"]})
        self.assertTrue(self.validate()[0].invalid)

    def test_manifest_with_missing_published_shard_is_invalid(self):
        self.us()
        (self.root / "data/us-market/EN-X.json").unlink()
        self.assertTrue(self.validate()[0].invalid)

    def test_cli_writes_atomic_compact_health_with_stable_exit_codes(self):
        self.us()
        with patch.dict("os.environ", {"REFERENCE_SOURCE_OUTCOMES": '{"us":"failure"}'}), redirect_stdout(io.StringIO()):
            self.assertEqual(main(["--root", str(self.root), "--output", "data/reference-market-health.json"]), 0)
        report = self.read("/data/reference-market-health.json")
        self.assertEqual(report["schemaVersion"], 1)
        self.assertEqual(report["sources"]["us"]["refreshOutcome"], "failure")
        self.assertFalse((self.root / "data/reference-market-health.json.tmp").exists())
        self.write("/data/us-market/EN-X.json", {"broken": True})
        with redirect_stdout(io.StringIO()):
            self.assertEqual(main(["--root", str(self.root), "--output", "data/reference-market-health.json"]), 1)


if __name__ == "__main__":
    unittest.main()
