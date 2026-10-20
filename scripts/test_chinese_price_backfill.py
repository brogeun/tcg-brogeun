"""Offline Chinese CNY importer tests; temporary catalogs and synthetic prices only."""
import copy
import json
import tempfile
import subprocess
import sys
import unittest
from datetime import datetime, timezone
from pathlib import Path

import backfill_chinese_prices as backfill


NOW = datetime(2026, 10, 10, 12, 0, tzinfo=timezone.utc)
STAMP = "2026-10-10T09:00:00+00:00"
SOURCE_ID = "11111111-1111-4111-8111-111111111111"
FOIL_ID = "22222222-2222-4222-8222-222222222222"
SOURCE_URL = "https://h5.jihuanshe.com/cards/12345"


def card(code, source_id=SOURCE_ID, variant="non-holo"):
    return {
        "id": f"{code}:001:{variant}", "sourceId": source_id,
        "sourceSetCode": "151c", "setCode": code, "language": "zh-CN",
        "number": "001", "name": "妙蛙种子", "nameKo": "이상해씨",
        "variant": variant, "variantLabel": variant, "rarity": "C",
        "image": "https://cdn.pokemon-tcg.cn/cards/11111111111111111111111111111111.png",
        "sourceUrl": "https://pikaqian.com/cards/" + source_id,
    }


def record(source_id=SOURCE_ID, grade="raw", **changes):
    result = {
        "sourceId": source_id, "sourceSetCode": "151c", "number": "001",
        "name": "妙蛙种子", "variant": "non-holo", "providerCardId": "12345",
        "sourceUrl": SOURCE_URL, "grade": grade, "priceKind": "reference",
        "priceMinor": 1234, "status": "available",
        "history": [{"date": "2026-10-08", "priceMinor": 1100, "sourceUrl": SOURCE_URL}],
    }
    result["gradingCompany"] = "PSA" if grade == "psa10" else "ungraded"
    if grade == "raw":
        result.update(condition="A", conditionLabel="A")
    result.update(changes)
    return result


def snapshot(records=None, **changes):
    result = {
        "schemaVersion": 1, "source": "jihuanshe", "language": "zh-CN",
        "market": "CN", "currency": "CNY", "observedAt": STAMP,
        "records": [record()] if records is None else records,
    }
    result.update(changes)
    return result


class ChinesePriceBackfillTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.write_catalog()
        self.inventory = backfill.build_inventory(self.root)

    def tearDown(self):
        self.temporary.cleanup()

    def write_json(self, relative, value):
        file = self.root / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")

    def write_set(self, code, cards):
        self.write_json("data/chinese-sets/" + code + ".json", {
            "schemaVersion": 1, "language": "zh-CN", "code": code,
            "sourceSetCode": "151c", "complete": True,
            "expectedCardCount": len(cards), "cardCount": len(cards),
            "printedCardCount": len({row["number"] for row in cards}), "cards": cards,
        })

    def write_catalog(self):
        codes = ["CN-151-LV", "CN-151-WANG"]
        self.write_json("data/chinese-catalog.json", {
            "schemaVersion": 1, "language": "zh-CN",
            "sets": [{"code": code, "name": code, "originalName": "宝可梦151", "cardCount": 2,
                      "sourceUrl": "https://www.pokemon.cn/tcg/17460.html",
                      "variants": ([
                          {"name": "5장 팩", "cardsPerPack": 5, "msrpUnit": "팩", "msrpCny": 10},
                          {"name": "20장 팩", "cardsPerPack": 20, "msrpUnit": "팩", "msrpCny": 50},
                      ] + ([
                          {"name": "20장 팩 박스", "cardsPerPack": 20, "packsPerBox": 6,
                           "msrpUnit": "박스", "msrpCny": 300},
                          {"name": "25장 팩 박스", "cardsPerPack": 25,
                           "msrpUnit": "박스", "msrpCny": 450},
                          {"name": "코인 세트", "cardsPerPack": 5, "packsPerBox": 3,
                           "msrpUnit": "세트", "msrpCny": 39,
                           "contents": "5장 팩 3개 · 홀로 카드 1장 · 코인 1개"},
                          {"name": "프로모 묶음", "cardsPerPack": 99, "packsPerBox": 2,
                           "msrpUnit": "세트", "msrpCny": 88, "contents": "팩과 프로모 카드"},
                      ] if code == "CN-151-WANG" else []))} for code in codes],
        })
        for code in codes:
            self.write_set(code, [card(code), card(code, FOIL_ID, "masterball")])

    def validate(self, payload=None):
        return backfill.validate_snapshot(payload or snapshot(), self.inventory, now=NOW)

    def merge(self, previous=None, payload=None):
        return backfill.merge_records(previous, payload or snapshot(), self.inventory, now=NOW)

    def quote(self, data, source_id=SOURCE_ID, grade="raw"):
        return data["records"][source_id]["quotes"][grade]

    def test_inventory_collects_once_per_variant_and_keeps_product_references(self):
        self.assertEqual(set(self.inventory), {SOURCE_ID, FOIL_ID})
        basic = self.inventory[SOURCE_ID]
        self.assertEqual((basic["language"], basic["sourceSetCode"], basic["number"], basic["variant"]),
                         ("zh-CN", "151c", "001", "non-holo"))
        self.assertEqual({(row["setCode"], row["cardId"]) for row in basic["refs"]},
                         {("CN-151-LV", "CN-151-LV:001:non-holo"),
                          ("CN-151-WANG", "CN-151-WANG:001:non-holo")})
        self.assertEqual(self.inventory[FOIL_ID]["variant"], "masterball")

    def test_inventory_rejects_conflicting_uuid_facts(self):
        conflicting = card("CN-151-WANG", variant="masterball")
        self.write_set("CN-151-WANG", [conflicting, card("CN-151-WANG", FOIL_ID, "masterball")])
        with self.assertRaises(ValueError):
            backfill.build_inventory(self.root)

    def test_valid_snapshot_preserves_cny_and_reference_semantics(self):
        payload = snapshot()
        before = copy.deepcopy(payload)
        rows = self.validate(payload)
        self.assertIsInstance(rows, list)
        self.assertEqual(rows[0]["priceMinor"], 1234)
        data, report = self.merge(payload=payload)
        self.assertEqual({key: data[key] for key in ("schemaVersion", "source", "language", "market", "currency")},
                         {"schemaVersion": 1, "source": "jihuanshe", "language": "zh-CN", "market": "CN", "currency": "CNY"})
        quote = self.quote(data)
        self.assertEqual((quote["priceMinor"], quote["status"], quote["priceKind"]),
                         (1234, "available", "reference"))
        self.assertEqual((quote["providerCardId"], quote["sourceUrl"]), ("12345", SOURCE_URL))
        self.assertIsInstance(report, dict)
        self.assertNotIn("normalizedAmount", quote)
        self.assertNotIn("psa10", data["records"][SOURCE_ID]["quotes"])
        self.assertEqual(payload, before)

    def test_rejects_foreign_source_currency_market_and_language(self):
        for field, value in (("schemaVersion", 2), ("source", "pikaqian"), ("currency", "USD"),
                             ("currency", "JPY"), ("market", "JP"), ("language", "en"),
                             ("language", "zh-TW")):
            with self.subTest(field=field, value=value):
                with self.assertRaises(ValueError):
                    self.validate(snapshot(**{field: value}))

    def test_rejects_card_identity_mismatch_including_foil(self):
        cases = (("sourceId", "33333333-3333-4333-8333-333333333333"),
                 ("sourceSetCode", "csv1c"), ("number", "002"), ("name", "皮卡丘"),
                 ("name", "이상해씨"), ("variant", "masterball"))
        for field, value in cases:
            with self.subTest(field=field):
                with self.assertRaises(ValueError):
                    self.validate(snapshot([record(**{field: value})]))

    def test_grade_quotes_and_distinct_foil_never_merge(self):
        rows = [record(grade="raw"), record(grade="psa10", priceMinor=50000),
                record(FOIL_ID, variant="masterball", priceMinor=6500, providerCardId="67890",
                       sourceUrl="https://h5.jihuanshe.com/cards/67890", history=[])]
        data, _ = self.merge(payload=snapshot(rows))
        self.assertEqual(set(data["records"]), {SOURCE_ID, FOIL_ID})
        self.assertEqual(set(data["records"][SOURCE_ID]["quotes"]), {"raw", "psa10"})
        self.assertEqual(self.quote(data, grade="psa10")["priceMinor"], 50000)
        self.assertEqual(self.quote(data, FOIL_ID)["priceMinor"], 6500)
        self.assertEqual(data["records"][FOIL_ID]["variant"], "masterball")

    def test_unsupported_grade_and_sale_claim_rejected(self):
        for changes in ({"grade": "PSA 10"}, {"grade": "bgs10"}, {"grade": "psa9"},
                        {"grade": "psa8"}, {"grade": "box"}, {"priceKind": "sold"},
                        {"priceKind": "unknown"}, {"status": "source_error"}):
            with self.subTest(changes=changes):
                with self.assertRaises(ValueError):
                    self.validate(snapshot([record(**changes)]))
        self.validate(snapshot([record(priceKind="asking")]))

    def test_prices_require_positive_integer_minor_units_or_explicit_no_price(self):
        for amount in (0, -1, 12.34, True, "1234", float("nan"), float("inf")):
            with self.subTest(amount=amount):
                with self.assertRaises(ValueError):
                    self.validate(snapshot([record(priceMinor=amount)]))
        for changes in ({"priceMinor": None, "status": "available"},
                        {"priceMinor": 1234, "status": "no_price"}):
            with self.subTest(changes=changes):
                with self.assertRaises(ValueError):
                    self.validate(snapshot([record(**changes)]))
        data, _ = self.merge(payload=snapshot([record(priceMinor=None, status="no_price", history=[])]))
        self.assertIsNone(self.quote(data)["priceMinor"])
        self.assertEqual(self.quote(data)["status"], "no_price")

    def test_source_urls_and_provider_ids_are_safe(self):
        invalid_urls = ("http://h5.jihuanshe.com/cards/12345", "https://evil.example/cards/12345",
                        "https://jihuanshe.com.evil.example/cards/12345",
                        "https://evil-jihuanshe.com/cards/12345",
                        "https://user:secret@h5.jihuanshe.com/cards/12345",
                        "https://h5.jihuanshe.com:444/cards/12345", "javascript:alert(1)")
        for value in invalid_urls:
            with self.subTest(url=value):
                with self.assertRaises(ValueError):
                    self.validate(snapshot([record(sourceUrl=value)]))
        for value in ("", "1.2", "abc", "-12345", True):
            with self.subTest(providerCardId=value):
                with self.assertRaises(ValueError):
                    self.validate(snapshot([record(providerCardId=value)]))

    def test_observation_requires_timezone_and_cannot_be_in_future(self):
        for value in ("2026-10-10T09:00:00", "2026-10-10", "garbage", "2026-10-11T09:00:00Z"):
            with self.subTest(observedAt=value):
                with self.assertRaises(ValueError):
                    self.validate(snapshot(observedAt=value))
        self.validate(snapshot(observedAt="2026-10-10T18:00:00+09:00"))

    def test_history_dates_prices_and_urls_are_validated(self):
        invalid = [{"date": "2026-02-30", "priceMinor": 1},
                   {"date": "2026-10-11", "priceMinor": 1},
                   {"date": "2026-10-09T00:00:00", "priceMinor": 1},
                   {"date": "2026-10-09", "priceMinor": 0},
                   {"date": "2026-10-09", "priceMinor": True},
                   {"date": "2026-10-09", "priceMinor": 1.5},
                   {"date": "2026-10-09", "priceMinor": 1, "sourceUrl": "https://evil.example/12345"}]
        for point in invalid:
            with self.subTest(point=point):
                with self.assertRaises(ValueError):
                    self.validate(snapshot([record(history=[point])]))
        self.validate(snapshot([record(history=[{"date": "2026-10-09", "priceMinor": 1200}])]))

    def test_conflicting_duplicate_card_grade_is_rejected_atomically(self):
        previous, _ = self.merge()
        saved = copy.deepcopy(previous)
        bad = snapshot([record(priceMinor=2000), record(priceMinor=3000)],
                       observedAt="2026-10-10T10:00:00Z")
        with self.assertRaises(ValueError):
            self.merge(previous, bad)
        self.assertEqual(previous, saved)

    def test_exact_replay_is_idempotent_and_does_not_mutate_previous(self):
        first, _ = self.merge()
        saved = copy.deepcopy(first)
        replay, _ = self.merge(first)
        self.assertEqual(replay, first)
        self.assertEqual(first, saved)
        with self.assertRaises(ValueError):
            self.merge(payload=snapshot([record(), record()]))

    def test_older_snapshot_cannot_replace_newer_quote(self):
        first, _ = self.merge()
        older = snapshot([record(priceMinor=1, history=[])], observedAt="2026-10-09T09:00:00Z")
        result, _ = self.merge(first, older)
        self.assertEqual(self.quote(result)["priceMinor"], 1234)
        self.assertEqual(self.quote(result)["observedAt"], self.quote(first)["observedAt"])

    def test_new_capture_preserves_history_and_prior_grade_quotes(self):
        first, _ = self.merge(payload=snapshot([record(), record(grade="psa10", priceMinor=50000)]))
        newer = snapshot([record(priceMinor=1500, history=[
            {"date": "2026-10-08", "priceMinor": 1100, "sourceUrl": SOURCE_URL},
            {"date": "2026-10-09", "priceMinor": 1400, "sourceUrl": SOURCE_URL},
        ])], observedAt="2026-10-10T10:00:00Z")
        result, _ = self.merge(first, newer)
        self.assertEqual(self.quote(result)["priceMinor"], 1500)
        history = self.quote(result)["history"]
        self.assertEqual({(row["date"], row["priceMinor"]) for row in history},
                         {("2026-10-08", 1100), ("2026-10-09", 1400)})
        self.assertEqual(len(history), 2)
        self.assertEqual(self.quote(result, grade="psa10"), self.quote(first, grade="psa10"))
        self.assertEqual(self.quote(first)["priceMinor"], 1234)

    def test_explicit_no_price_can_update_without_turning_into_zero(self):
        first, _ = self.merge()
        newer = snapshot([record(priceMinor=None, status="no_price", history=[])],
                         observedAt="2026-10-10T10:00:00Z")
        result, _ = self.merge(first, newer)
        self.assertIsNone(self.quote(result)["priceMinor"])
        self.assertEqual(self.quote(result)["status"], "no_price")
        self.assertEqual(self.quote(first)["priceMinor"], 1234)

    def test_invalid_capture_preserves_all_last_known_prices(self):
        first, _ = self.merge()
        before = copy.deepcopy(first)
        invalid = snapshot([record(priceMinor=9999), record(FOIL_ID, variant="masterball", priceMinor=-1)])
        with self.assertRaises(ValueError):
            self.merge(first, invalid)
        self.assertEqual(first, before)

    def test_previous_market_data_cannot_be_imported_as_jihuanshe_cny(self):
        first, _ = self.merge()
        for field, value in (("currency", "USD"), ("source", "pikaqian"),
                             ("market", "US"), ("language", "en")):
            wrong = copy.deepcopy(first)
            wrong[field] = value
            with self.subTest(field=field):
                with self.assertRaises(ValueError):
                    self.merge(wrong)


    def test_provider_integer_ids_normalize_to_strings(self):
        rows = self.validate(snapshot([record(providerCardId=12345)]))
        self.assertEqual(rows[0]["providerCardId"], "12345")

    def test_inventory_rejects_foreign_card_row_and_incomplete_declared_count(self):
        foreign = card("CN-151-LV")
        foreign["language"] = "en"
        self.write_set("CN-151-LV", [foreign, card("CN-151-LV", FOIL_ID, "masterball")])
        with self.assertRaises(ValueError):
            backfill.build_inventory(self.root)
        self.write_catalog()
        path = self.root / "data/chinese-sets/CN-151-LV.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        data["expectedCardCount"] = 3
        self.write_json("data/chinese-sets/CN-151-LV.json", data)
        with self.assertRaises(ValueError):
            backfill.build_inventory(self.root)

    def test_row_cannot_change_snapshot_market_or_observation(self):
        for changes in ({"language": "en"}, {"language": "zh-TW"}, {"currency": "USD"},
                        {"market": "JP"}, {"observedAt": "2026-10-10T09:00:00"},
                        {"observedAt": "2026-10-10T10:00:00Z"},
                        {"gradingCompany": "BGS"}):
            with self.subTest(changes=changes):
                with self.assertRaises(ValueError):
                    self.validate(snapshot([record(**changes)]))

    def test_source_links_do_not_store_credentials_or_supplied_price_queries(self):
        for suffix in ("?token=test-fixture", "?api_key=test-fixture", "?password=test-fixture",
                       "?price=1234", "?amount=1234"):
            with self.subTest(suffix=suffix):
                with self.assertRaises(ValueError):
                    self.validate(snapshot([record(sourceUrl=SOURCE_URL + suffix)]))
        with self.assertRaises(ValueError):
            self.validate(snapshot([record(sourceUrl="https://h5.jihuanshe.com/")]))

    def test_history_dates_are_canonical_and_conflicts_rejected(self):
        with self.assertRaises(ValueError):
            self.validate(snapshot([record(history=[{"date": "2026-10-8", "priceMinor": 1000}])]))
        with self.assertRaises(ValueError):
            self.validate(snapshot([record(history=[{"date": "2026-10-08", "priceMinor": 1000},
                                                      {"date": "2026-10-08", "priceMinor": 2000}])]))

    def test_same_observation_in_another_timezone_cannot_change_price(self):
        first, _ = self.merge()
        before = copy.deepcopy(first)
        equivalent_time = snapshot([record(priceMinor=9999)],
                                   observedAt="2026-10-10T18:00:00+09:00")
        with self.assertRaises(ValueError):
            self.merge(first, equivalent_time)
        self.assertEqual(first, before)

    def test_prepare_targets_has_blank_prices_and_truthful_zero_collection(self):
        import csv
        output = self.root / "staging"
        report = backfill.prepare_targets(self.root, output)
        self.assertEqual((report["inventoryCards"], report["catalogEntries"], report["collectedCards"]),
                         (2, 4, 0))
        self.assertEqual((report["status"], report["currency"], report["market"]),
                         ("awaiting_source_data", "CNY", "CN"))
        with (output / "targets.csv").open(encoding="utf-8-sig", newline="") as stream:
            rows = list(csv.DictReader(stream))
        self.assertEqual({row["sourceId"] for row in rows}, {SOURCE_ID, FOIL_ID})
        self.assertEqual(len(rows), 4)
        self.assertEqual({(row["sourceId"], row["grade"]) for row in rows},
                         {(uuid, grade) for uuid in (SOURCE_ID, FOIL_ID) for grade in ("raw", "psa10")})
        self.assertTrue(all(row["gradingCompany"] == "PSA" and not row["condition"]
                            if row["grade"] == "psa10" else
                            row["gradingCompany"] == "ungraded" and row["condition"] == "A"
                            for row in rows))
        self.assertTrue(all(not row["conditionLabel"] for row in rows))
        self.assertEqual(report["cardQuoteTargets"], 4)
        self.assertEqual(report["categories"], ["box", "psa10", "A"])
        self.assertEqual((report["boxQuoteTargets"], report["boxProducts"],
                          report["verifiedBoxTargets"], report["collectedBoxes"]), (5, 2, 1, 0))
        with (output / "box-targets.csv").open(encoding="utf-8-sig", newline="") as stream:
            boxes = list(csv.DictReader(stream))
        self.assertEqual(len(boxes), 5)
        self.assertTrue(all(not row["priceMinor"] and not row["providerProductId"] and
                            not row["sourceUrl"] and not row["status"] for row in boxes))
        self.assertTrue(all(row["quantity"] == "1" and row["unit"] == "box" and
                            row["grade"] == "box" and row["condition"] == "sealed" for row in boxes))
        self.assertTrue(all(not row["packsPerBox"] for row in boxes
                            if row["configurationStatus"] == "needs_verification"))
        self.assertTrue(all(not row["priceMinor"] and not row["providerCardId"] for row in rows))
        self.assertFalse((output / "prices.json").exists())
        self.assertFalse((self.root / "data/chinese-prices-jihuanshe.json").exists())

    def test_provider_card_id_cannot_point_to_two_foil_uuids(self):
        wrong_foil = record(FOIL_ID, variant="masterball", priceMinor=6500, history=[])
        with self.assertRaises(ValueError):
            self.validate(snapshot([record(), wrong_foil]))
        first, _ = self.merge()
        before = copy.deepcopy(first)
        with self.assertRaises(ValueError):
            self.merge(first, snapshot([wrong_foil], observedAt="2026-10-10T10:00:00Z"))
        self.assertEqual(first, before)

    def test_reference_and_asking_history_cannot_replace_each_other(self):
        for old_kind, new_kind in (("reference", "asking"), ("asking", "reference")):
            with self.subTest(old_kind=old_kind, new_kind=new_kind):
                first, _ = self.merge(payload=snapshot([record(priceKind=old_kind)]))
                before = copy.deepcopy(first)
                newer = snapshot([record(priceKind=new_kind, priceMinor=1500)],
                                 observedAt="2026-10-10T10:00:00Z")
                with self.assertRaises(ValueError):
                    self.merge(first, newer)
                self.assertEqual(first, before)

    def test_cli_stages_valid_prices_and_failed_import_preserves_output(self):
        source = self.root / "capture.json"
        cli_payload = snapshot([record(history=[{"date": "2020-01-08", "priceMinor": 1100}])],
                               observedAt="2020-01-10T09:00:00Z")
        source.write_text(json.dumps(cli_payload, ensure_ascii=False), encoding="utf-8")
        output = self.root / "staging"
        args = [sys.executable, "-B", str(Path(backfill.__file__).resolve()),
                "--root", str(self.root), "--input", str(source), "--output", str(output)]
        successful = subprocess.run(args, capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(successful.returncode, 0, successful.stderr)
        report = json.loads(successful.stdout)
        self.assertEqual((report["source"], report["currency"], report["applied"]),
                         ("jihuanshe", "CNY", False))
        price_path = output / "prices.json"
        saved = price_path.read_bytes()
        self.assertEqual(self.quote(json.loads(saved))["priceMinor"], 1234)
        self.assertFalse((self.root / "data/chinese-prices-jihuanshe.json").exists())
        cli_payload["records"][0]["priceMinor"] = -1
        source.write_text(json.dumps(cli_payload), encoding="utf-8")
        rejected = subprocess.run(args, capture_output=True, text=True, encoding="utf-8")
        self.assertNotEqual(rejected.returncode, 0)
        self.assertEqual(price_path.read_bytes(), saved)
        self.assertFalse((self.root / "data/chinese-prices-jihuanshe.json").exists())

    def test_release_and_row_observation_bound_history(self):
        changed_inventory = copy.deepcopy(self.inventory)
        changed_inventory[SOURCE_ID]["release"] = "2026-10-09"
        with self.assertRaises(ValueError):
            backfill.validate_snapshot(snapshot(), changed_inventory, now=NOW)
        changed_inventory[SOURCE_ID]["release"] = "2026-10-11"
        with self.assertRaises(ValueError):
            backfill.validate_snapshot(snapshot([record(history=[])]), changed_inventory, now=NOW)
        with self.assertRaises(ValueError):
            self.validate(snapshot([record(observedAt="2026-10-09T09:00:00Z",
                                           history=[{"date": "2026-10-10", "priceMinor": 1000}])]))

    def test_equivalent_timestamp_and_same_price_are_idempotent(self):
        first, _ = self.merge()
        equivalent = snapshot(observedAt="2026-10-10T18:00:00+09:00")
        second, report = self.merge(first, equivalent)
        self.assertEqual(second, first)
        self.assertEqual(self.quote(second)["observedAt"], self.quote(first)["observedAt"])
        self.assertEqual(report["unchanged"], 1)

    def test_existing_provider_card_id_cannot_be_replaced(self):
        first, _ = self.merge()
        before = copy.deepcopy(first)
        newer = snapshot([record(providerCardId="67890",
                                 sourceUrl="https://h5.jihuanshe.com/cards/67890", priceMinor=1500)],
                         observedAt="2026-10-10T10:00:00Z")
        with self.assertRaises(ValueError):
            self.merge(first, newer)
        self.assertEqual(first, before)

    def test_a_condition_requires_explicit_source_label_for_price_or_history(self):
        for label in ("A", "A급", "A级", "A級", "NM", "Near Mint"):
            with self.subTest(label=label):
                normalized = self.validate(snapshot([record(conditionLabel=label)]))
                self.assertEqual(normalized[0]["conditionLabel"], label)
        for label in (None, "", "如图", "微瑕", "全新", "A+", "NM/LP"):
            for changes in ({"conditionLabel": label},
                            {"conditionLabel": label, "status": "no_price", "priceMinor": None}):
                with self.subTest(changes=changes):
                    with self.assertRaises(ValueError):
                        self.validate(snapshot([record(**changes)]))
        for condition in (None, "", "B", "NM"):
            with self.subTest(condition=condition):
                with self.assertRaises(ValueError):
                    self.validate(snapshot([record(condition=condition)]))
        no_quote = record(priceMinor=None, status="no_price", history=[], conditionLabel="")
        self.validate(snapshot([no_quote]))

    def test_only_ungraded_a_or_confirmed_psa10_can_be_imported(self):
        for company in (None, "", "BGS", "CGC", "ungraded"):
            with self.subTest(company=company):
                with self.assertRaises(ValueError):
                    self.validate(snapshot([record(grade="psa10", gradingCompany=company)]))
        missing_company = record(grade="psa10")
        missing_company.pop("gradingCompany")
        with self.assertRaises(ValueError):
            self.validate(snapshot([missing_company]))
        with self.assertRaises(ValueError):
            self.validate(snapshot([record(gradingCompany="PSA")]))
        for grade, company in (("raw", "ungraded"), ("psa10", "PSA")):
            with self.subTest(grade=grade):
                data, _ = self.merge(payload=snapshot([record(grade=grade)]))
                self.assertEqual(set(data["records"][SOURCE_ID]["quotes"]), {grade})
                self.assertEqual(self.quote(data, grade=grade)["gradingCompany"], company)
                self.assertEqual(self.validate(snapshot([record(grade=grade)]))[0]["gradingCompany"], company)

    def test_previous_grade_evidence_is_revalidated_without_mutation(self):
        first, _ = self.merge(payload=snapshot([record(), record(grade="psa10")]))
        cases = (("raw", "conditionLabel", "如图"), ("raw", "conditionLabel", None),
                 ("raw", "condition", "B"), ("raw", "gradingCompany", "PSA"),
                 ("psa10", "gradingCompany", None), ("psa10", "gradingCompany", "BGS"))
        for grade, field, value in cases:
            wrong = copy.deepcopy(first)
            self.quote(wrong, grade=grade)[field] = value
            saved = copy.deepcopy(wrong)
            with self.subTest(grade=grade, field=field, value=value):
                with self.assertRaises(ValueError):
                    self.merge(wrong, snapshot(records=[]))
                self.assertEqual(wrong, saved)
        wrong = copy.deepcopy(first)
        wrong["records"][SOURCE_ID]["quotes"]["psa9"] = copy.deepcopy(self.quote(wrong, grade="psa10"))
        with self.assertRaises(ValueError):
            self.merge(wrong, snapshot(records=[]))

    def test_no_price_update_preserves_evidence_for_retained_a_history(self):
        first, _ = self.merge(payload=snapshot([record(conditionLabel="Near Mint")]))
        no_quote = record(priceMinor=None, status="no_price", history=[], conditionLabel="")
        newer = snapshot([no_quote], observedAt="2026-10-10T10:00:00Z")
        result, _ = self.merge(first, newer)
        self.assertIsNone(self.quote(result)["priceMinor"])
        self.assertEqual(self.quote(result)["history"], self.quote(first)["history"])
        self.assertEqual(self.quote(result)["conditionLabel"], "Near Mint")
        replay, _ = self.merge(result, newer)
        self.assertEqual(replay, result)

    def test_box_targets_merge_pack_formats_and_never_infer_pack_price(self):
        boxes = backfill.build_box_targets(self.root)
        self.assertEqual(len(boxes), 5)
        verified = boxes["BOX:CN-151-WANG:20"]
        self.assertEqual((verified["cardsPerPack"], verified["packsPerBox"],
                          verified["configurationStatus"], verified["quantity"], verified["unit"]),
                         (20, 6, "verified", 1, "box"))
        for key in ("BOX:CN-151-LV:5", "BOX:CN-151-LV:20", "BOX:CN-151-WANG:5", "BOX:CN-151-WANG:25"):
            with self.subTest(key=key):
                self.assertIsNone(boxes[key]["packsPerBox"])
                self.assertEqual(boxes[key]["configurationStatus"], "needs_verification")
        self.assertNotIn("BOX:CN-151-WANG:99", boxes)
        self.assertTrue(all(not set(target).intersection({"msrpCny", "priceMinor", "price", "status"})
                            for target in boxes.values()))
        self.assertTrue(all(target["grade"] == "box" and target["condition"] == "sealed"
                            for target in boxes.values()))

    def test_conflicting_confirmed_box_contents_are_rejected(self):
        path = self.root / "data/chinese-catalog.json"
        data = json.loads(path.read_text(encoding="utf-8"))
        data["sets"][1]["variants"].append({"name": "20장 팩 박스", "cardsPerPack": 20,
                                            "packsPerBox": 8, "msrpUnit": "박스"})
        self.write_json("data/chinese-catalog.json", data)
        with self.assertRaises(ValueError):
            backfill.build_box_targets(self.root)

    def test_real_catalog_card_inventory_and_box_configuration_audit(self):
        actual_root = Path(backfill.__file__).resolve().parents[1]
        inventory = backfill.build_inventory(actual_root)
        self.assertEqual(len(inventory), 13613)
        self.assertEqual(sum(len(card["refs"]) for card in inventory.values()), 15002)
        catalog = backfill.read_json(actual_root / "data/chinese-catalog.json")
        self.assertEqual(len(catalog["sets"]), 48)
        variants = [v for product in catalog["sets"] for v in product["variants"]]
        self.assertEqual(len(variants), 101)
        self.assertEqual(sum(v.get("msrpUnit") == "세트" for v in variants), 6)
        named_boxes = [v for v in variants if v.get("msrpUnit") == "박스" or "박스" in v.get("name", "")]
        self.assertEqual(len(named_boxes), 15)
        boxes = backfill.build_box_targets(actual_root)
        self.assertEqual(len(boxes), 80)
        self.assertEqual(len({target["setCode"] for target in boxes.values()}), 48)
        self.assertEqual(sum(target["configurationStatus"] == "verified" for target in boxes.values()), 13)
        self.assertEqual(sum(target["configurationStatus"] == "needs_verification" for target in boxes.values()), 67)
        for code in ("CN-CSM1-5", "CN-CSM2-5"):
            self.assertIsNone(boxes[f"BOX:{code}:6"]["packsPerBox"])
        self.assertEqual(boxes["BOX:CN-151-JU:5"]["configurationStatus"], "needs_verification")
        self.assertIsNone(boxes["BOX:CN-151-JU:5"]["packsPerBox"])
        self.assertEqual(boxes["BOX:CN-151-LV:20"]["configurationStatus"], "needs_verification")

if __name__ == "__main__":
    unittest.main()
