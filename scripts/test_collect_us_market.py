"""Identity, price semantics, cache and failure-preservation tests; no network."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

from scripts import collect_us_market as us


def product(pid=10, title="Charizard ex - 223/197", number="223/197", rarity="Special Illustration Rare", group=100):
    return {"productId": pid, "name": title, "categoryId": 3, "groupId": group,
            "url": f"https://www.tcgplayer.com/product/{pid}/pokemon-test-card",
            "extendedData": [{"name": "Number", "value": number}, {"name": "Rarity", "value": rarity}]}


def catalog():
    return {"schemaVersion": 1, "code": "EN-TEST", "language": "en", "cards": [
        {"sourceId": "source-1", "name": "Charizard ex", "number": "223/197", "rarity": "Special Illustration Rare", "language": "en", "setCode": "EN-TEST", "psa10": {"source": "PriceCharting", "sourcePriceCents": 12345}}]}


GROUP = {"groupId": 100, "categoryId": 3, "name": "SV03: Test Set", "abbreviation": "TEST", "publishedOn": "2026-01-01T00:00:00", "modifiedOn": "2026-10-28T00:00:00"}
PRICE = {"productId": 10, "subTypeName": "Holofoil", "marketPrice": 88.55, "lowPrice": 65.0, "midPrice": 99.0, "highPrice": 1000.0}


class IdentityTests(unittest.TestCase):
    def build(self, cards=None, products=None, prices=None):
        return us.build_shard(cards or catalog(), GROUP, products if products is not None else [product()], prices if prices is not None else [PRICE], "2026-10-28T20:06:05+00:00", "2026-10-29T00:00:00+00:00")

    def test_exact_control_and_original_psa10_unchanged(self):
        original = catalog()
        before = copy.deepcopy(original)
        result = self.build(cards=original)
        self.assertEqual(original, before)
        self.assertEqual(result["cards"]["source-1"]["productId"], "10")
        quote = result["cards"]["source-1"]["printings"]["Holofoil"]
        self.assertEqual(quote["currency"], "USD")
        self.assertFalse(quote["isLastCompletedSale"])
        self.assertEqual(quote["conditionScope"], "ungraded provider aggregate")

    def test_number_denominator_and_suffix_are_significant(self):
        self.assertNotEqual(us.number("001/165"), us.number("001/197"))
        self.assertNotEqual(us.number("001a/165"), us.number("001/165"))
        self.assertEqual(us.number("001/165"), us.number("1/165"))
        self.assertEqual(self.build(products=[product(number="223/165")])["cards"], {})

    def test_wrong_set_product_rejects_whole_response(self):
        with self.assertRaises(ValueError):
            self.build(products=[product(group=101)])

    def test_wrong_source_set_rejects(self):
        source = catalog()
        source["cards"][0]["setCode"] = "EN-OTHER"
        with self.assertRaises(ValueError):
            self.build(cards=source)

    def test_wrong_rarity_rejected(self):
        self.assertEqual(self.build(products=[product(rarity="Ultra Rare")])["cards"], {})

    def test_reviewed_rarity_ontology_pairs_require_exact_identity(self):
        source = catalog()
        source["cards"][0].update(name="Leafeon V", number="013/159", rarity="Holo Rare V")
        target = product(title="Leafeon V", number="013/159", rarity="Ultra Rare")
        self.assertIn("source-1", self.build(cards=source, products=[target])["cards"])
        # Never select a rarity-compatible row when the number/name already has
        # multiple provider products, even if a second row has another rarity.
        self.assertEqual(self.build(cards=source, products=[target, {**target, "productId": 11, "url": "https://www.tcgplayer.com/product/11/other", "extendedData": [{"name": "Number", "value": "013/159"}, {"name": "Rarity", "value": "Secret Rare"}]}])["cards"], {})

    def test_secret_hyper_sir_ir_and_unspecified_not_broadly_collapsed(self):
        for source in ("Holo Rare V", "Rare Holo ex", "Holo Rare VMAX", "Rare Holo LV.X", "Holo Rare VSTAR"):
            self.assertTrue(us.compatible_rarity(source, "Ultra Rare"))
        self.assertTrue(us.compatible_rarity("Rare Secret", "Secret Rare"))
        self.assertTrue(us.compatible_rarity("Secret Rare", "Rare Secret"))
        for source in ("Secret Rare", "Hyper Rare", "Special Illustration Rare", "Illustration Rare", "Rare Secret", ""):
            self.assertFalse(us.compatible_rarity(source, "Ultra Rare"))
        self.assertFalse(us.compatible_rarity("Illustration Rare", "Special Illustration Rare"))
        self.assertFalse(us.compatible_rarity("Rare Secret", "Hyper Rare"))
        self.assertFalse(us.compatible_rarity("", "Common"))

    def test_real_edition_and_name_suffix_not_stripped(self):
        self.assertEqual(self.build(products=[product(title="Charizard ex (Pokemon Center)")])["cards"], {})
        self.assertNotEqual(us.name("Charizard"), us.name("Charizard ex"))
        self.assertNotEqual(us.set_name("Base Set"), us.set_name("Base Set (Shadowless)"))

    def test_duplicate_candidate_rejected(self):
        result = self.build(products=[product(), product(pid=11)])
        self.assertEqual(result["cards"], {})
        self.assertEqual(result["coverage"]["ambiguousCards"], 1)

    def test_printings_stay_separate_and_never_fallback(self):
        reverse = {**PRICE, "subTypeName": "Reverse Holofoil", "marketPrice": 5.0}
        quotes, _ = us.printing_quotes([PRICE, reverse], 10)
        self.assertEqual(quotes["Holofoil"]["marketPrice"], 88.55)
        self.assertEqual(quotes["Reverse Holofoil"]["marketPrice"], 5.0)
        self.assertNotIn("Normal", quotes)
        self.assertNotIn("PSA 10", quotes)

    def test_conflicting_currency_or_duplicate_printing_rejected(self):
        self.assertEqual(us.printing_quotes([{**PRICE, "currency": "JPY"}], 10)[0], {})
        self.assertEqual(us.printing_quotes([PRICE, PRICE], 10)[0], {})

    def test_zero_missing_and_nan_never_become_real_quotes(self):
        quote, _ = us.printing_quotes([{**PRICE, "marketPrice": 0, "lowPrice": float("nan"), "midPrice": None, "highPrice": -1}], 10)
        self.assertEqual(quote, {})
        quote, _ = us.printing_quotes([{**PRICE, "marketPrice": None, "lowPrice": 10.0}], 10)
        self.assertIsNone(quote["Holofoil"]["marketPrice"])
        self.assertEqual(quote["Holofoil"]["lowPrice"], 10.0)

    def test_reviewed_gender_spelling_accents_do_not_merge_different_cards(self):
        self.assertEqual(us.name("Nidoran ♀"), us.name("Nidoran F"))
        self.assertNotEqual(us.name("Nidoran F"), us.name("Nidoran M"))
        self.assertEqual(us.name("Impostor Professor Oak"), us.name("Imposter Professor Oak"))
        self.assertNotEqual(us.name("Impostor Professor Oak"), us.name("Professor Oak"))
        self.assertEqual(us.name("Pokémon Center"), us.name("Pokemon Center"))
        self.assertNotEqual(us.name("Pokémon Center"), us.name("Pokemon Center Lady"))

    def test_number_title_suffix_only_removed_when_full_number_proven(self):
        self.assertEqual(us.product_name(product(title="Charizard ex 223/197")), "Charizard ex")
        self.assertEqual(us.product_name(product(title="Charizard ex 223/165")), "Charizard ex 223/165")
        self.assertEqual(us.product_name(product(title="Charizard ex 223")), "Charizard ex 223")

    def test_sealed_id_is_not_a_set_or_single(self):
        sealed = {"productId": 20, "name": "Test Set Elite Trainer Box", "categoryId": 3, "groupId": 100, "url": "https://www.tcgplayer.com/product/20/pokemon-test-etb", "extendedData": []}
        result = self.build(products=[product(), sealed], prices=[PRICE, {**PRICE, "productId": 20, "subTypeName": "Normal"}])
        self.assertEqual(result["sealed"][0]["productId"], "20")
        self.assertNotEqual(result["sealed"][0]["productId"], result["setCode"])
        self.assertEqual(us.kind(product(title="Box of Disaster")), "card")

    def test_untrusted_product_url_does_not_attach_price(self):
        self.assertEqual(self.build(products=[{**product(), "url": "https://example.com/product/10"}])["cards"], {})
        self.assertEqual(self.build(products=[{**product(), "url": "https://www.tcgplayer.com/product/11/wrong-id"}])["cards"], {})


class SetMappingTests(unittest.TestCase):
    def setUp(self):
        self.entry = {"code": "EN-TEST", "name": "Test Set", "displayCode": "DIFFERENT_PROVIDER_CODE", "release": "2026.01.01"}

    def test_unique_name_release_matches_without_equating_abbreviations(self):
        self.assertEqual(us.map_sets([self.entry], [GROUP])["EN-TEST"]["status"], "mapped")

    def test_conflicting_date_and_duplicate_candidates_do_not_guess(self):
        self.assertEqual(us.map_sets([self.entry], [{**GROUP, "publishedOn": "2026-01-02"}])["EN-TEST"]["status"], "unmapped")
        self.assertEqual(us.map_sets([self.entry], [GROUP, {**GROUP, "groupId": 101}])["EN-TEST"]["status"], "ambiguous")

    def test_subset_and_edition_labels_remain_distinct(self):
        self.assertEqual(us.set_name("SWSH12: Silver Tempest Trainer Gallery"), us.set_name("Silver Tempest (Trainer Gallery)"))
        self.assertNotEqual(us.set_name("Silver Tempest"), us.set_name("Silver Tempest (Trainer Gallery)"))

    def test_duplicate_catalog_sets_cannot_share_one_group(self):
        duplicate = {**self.entry, "code": "EN-OTHER"}
        mappings = us.map_sets([self.entry, duplicate], [GROUP])
        self.assertTrue(all(value["status"] == "ambiguous" for value in mappings.values()))

    def test_reviewed_date_override_pins_both_dates_and_group(self):
        source = {"code": "EN-TCG1146", "name": "Triumphant", "release": "2010.11.02"}
        target = {**GROUP, "groupId": 1381, "name": "Triumphant", "publishedOn": "2010-11-03T00:00:00"}
        match = us.map_sets([source], [target])[source["code"]]
        self.assertEqual(match["status"], "mapped")
        self.assertEqual(match["override"]["minimumMatchedCards"], 90)
        self.assertEqual(us.map_sets([{**source, "release": "2010.11.01"}], [target])[source["code"]]["status"], "unmapped")
        self.assertEqual(us.map_sets([source], [{**target, "publishedOn": "2010-11-04T00:00:00"}])[source["code"]]["status"], "unmapped")
        self.assertEqual(us.map_sets([source], [{**target, "groupId": 999}])[source["code"]]["status"], "unmapped")
        self.assertNotIn("EN-TCG1175", us.REVIEWED_DATE_OVERRIDES)
        self.assertNotIn("EN-TCG11141", us.REVIEWED_DATE_OVERRIDES)


class FakeProvider:
    fail_prices = False
    fail_groups = False
    change_snapshot = False

    def __init__(self, *args):
        self.requests = 0
        self.provenance = []
        self.version_calls = 0

    def version(self):
        self.requests += 1
        self.version_calls += 1
        token = "changed" if self.change_snapshot and self.version_calls > 1 else "snapshot-1"
        return token, "2026-10-28T20:06:05+00:00"

    def json(self, key, url, revision):
        self.requests += 1
        if key == "groups":
            if self.fail_groups:
                raise OSError("provider unavailable")
            return {"results": [GROUP]}
        if key.startswith("products"):
            return {"results": [product()]}
        if self.fail_prices:
            raise OSError("provider prices unavailable")
        return {"results": [PRICE]}


class SynchronizationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.entry = {"code": "EN-TEST", "name": "Test Set", "release": "2026.01.01", "cardCount": 1}
        us.atomic_json(self.root / "data/english-catalog.json", {"schemaVersion": 1, "sets": [self.entry], "cardCount": 1})
        us.atomic_json(self.root / "data/english-sets/EN-TEST.json", catalog())
        FakeProvider.fail_prices = FakeProvider.fail_groups = FakeProvider.change_snapshot = False
        self.patch = mock.patch.object(us, "Provider", FakeProvider)
        self.patch.start()
        self.addCleanup(self.patch.stop)

    def test_initial_publish_and_no_existing_catalog_mutation(self):
        original = (self.root / "data/english-sets/EN-TEST.json").read_bytes()
        run = us.sync(self.root)
        manifest = us.read_json(self.root / "data/us-market.json")
        self.assertEqual(run["status"], "complete-for-mapped-sets")
        self.assertEqual(manifest["coverage"]["pricedCards"], 1)
        self.assertEqual((self.root / "data/english-sets/EN-TEST.json").read_bytes(), original)

    def test_unchanged_snapshot_skips_product_requests(self):
        us.sync(self.root)
        run = us.sync(self.root)
        self.assertEqual(run["status"], "unchanged")
        self.assertEqual(run["networkRequests"], 1)

    def test_price_failure_retains_previous_shard_exactly(self):
        us.sync(self.root)
        path = self.root / "data/us-market/EN-TEST.json"
        original = path.read_bytes()
        FakeProvider.fail_prices = True
        run = us.sync(self.root, force=True)
        self.assertEqual(path.read_bytes(), original)
        self.assertEqual(run["coverage"]["staleSets"], 1)
        self.assertEqual(us.read_json(self.root / "data/us-market.json")["sets"][0]["status"], "stale")

    def test_whole_provider_failure_retains_manifest(self):
        us.sync(self.root)
        path = self.root / "data/us-market.json"
        before = path.read_bytes()
        FakeProvider.fail_groups = True
        run = us.sync(self.root, force=True)
        self.assertEqual(run["status"], "failed-kept-previous")
        self.assertEqual(path.read_bytes(), before)

    def test_snapshot_change_does_not_publish_mixed_data(self):
        FakeProvider.change_snapshot = True
        with self.assertRaises(ValueError):
            us.sync(self.root)
        self.assertFalse((self.root / "data/us-market.json").exists())
        self.assertFalse((self.root / "data/us-market/EN-TEST.json").exists())

    def test_date_override_anchor_loss_preserves_last_good_shard(self):
        us.sync(self.root)
        path = self.root / "data/us-market/EN-TEST.json"
        before = path.read_bytes()
        with mock.patch.dict(GROUP, {"publishedOn": "2026-01-02T00:00:00"}), mock.patch.dict(us.REVIEWED_DATE_OVERRIDES, {"EN-TEST": (100, "2026-01-01", "2026-01-02", 2)}):
            run = us.sync(self.root, force=True)
        self.assertEqual(path.read_bytes(), before)
        self.assertEqual(run["coverage"]["staleSets"], 1)
        self.assertIn("anchor minimum", run["failures"][0]["reason"])


class CacheTests(unittest.TestCase):
    def test_offline_cache_checks_hash_and_never_fetches(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            raw = b'{"results":[]}'
            (cache / "groups.json").write_bytes(raw)
            us.atomic_json(cache / "groups.meta.json", {"url": "https://tcgcsv.com/test", "revision": "v1", "sha256": hashlib.sha256(raw).hexdigest()})
            provider = us.Provider(cache, offline=True)
            self.assertEqual(provider.json("groups", "https://tcgcsv.com/test", "v2"), {"results": []})
            self.assertEqual(provider.requests, 0)
            (cache / "groups.json").write_bytes(b'{}')
            with self.assertRaises(ValueError):
                provider.json("groups", "https://tcgcsv.com/test", "v2")


if __name__ == "__main__":
    unittest.main()
