import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("build_tcg_card_info", Path(__file__).resolve().parents[1] / "scripts/build_tcg_card_info.py")
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


def card(identity="1", game="weiss_schwarz", name='"AK Missile" Private TD [NIK/S117-T01](Trial Deck "Goddess of Victory : NIKKE")', **extra):
    return {"id": identity, "name": name, "brand": game, "kind": "card", "language": "unknown",
            "code": "WS-TCG-NIK/S117-T01", "image": "https://example.test/card.webp",
            "url": f"https://snkrdunk.com/apparels/{identity}", "minPrice": 12.34, "currency": "USD",
            "releasedAt": "2026-10-01T00:00:00Z", **extra}


def source_files(root, products=None, boxes=None):
    (root / "data").mkdir(exist_ok=True)
    for game in builder.GAMES:
        for kind in ("card", "box"):
            rows = (products or {}).get(game, []) if kind == "card" else (boxes or {}).get(game, [])
            builder.atomic_write(root / "data" / f"price-{game}-{kind}.json",
                                 {"source": "SNKRDUNK", "brand": game, "kind": kind, "products": rows,
                                  "totalCount": len(rows), "collection": {"complete": True}, "fetchedAt": "2026-10-29T00:00:00Z"})


class PrintedIdentityTests(unittest.TestCase):
    def test_weiss_name_bracket_preserves_different_full_number_despite_shared_code(self):
        one = card()
        two = card("2", name='Private RRR [NIK/S117-T01R](Trial Deck "Goddess of Victory : NIKKE")')
        self.assertEqual(builder.full_number(one, "weiss_schwarz"), "NIK/S117-T01")
        self.assertEqual(builder.full_number(two, "weiss_schwarz"), "NIK/S117-T01R")

    def test_weiss_printing_qualifier_is_not_discarded(self):
        value = card(name='Mickey OR [Dds/S104-100OR E5](Booster Pack Disney100)')
        self.assertEqual(builder.full_number(value, "weiss_schwarz"), "Dds/S104-100OR E5")
        self.assertEqual(builder.printed_set("weiss_schwarz", builder.full_number(value, "weiss_schwarz")), "Dds/S104")

    def test_union_action_point_full_number_preserved(self):
        value = card(game="union_arena", name='Action Point [UAPR-JJK-1-AP01](Premium Card Set)', code="UATCG-UAPR-JJK-1-AP01")
        self.assertEqual(builder.full_number(value, "union_arena"), "UAPR-JJK-1-AP01")
        self.assertEqual(builder.printed_set("union_arena", "UA18BT/NIK-1-019"), "UA18BT")
        for number in ("PC02BT/NIK-2-036", "EX15BT/BLC-4-AP02", "EX16BT/MMM-2-012"):
            value = card(game="union_arena", name=f"Registered card [{number}]", code="")
            self.assertEqual(builder.full_number(value, "union_arena"), number)
            self.assertEqual(builder.printed_set("union_arena", number), number.split("/")[0])

    def test_explicit_foreign_excluded_but_english_translation_unknown_retained(self):
        self.assertEqual(builder.language(card(), "weiss_schwarz", "NIK/S117-T01"), "unknown")
        self.assertIsNone(builder.language(card(language="en"), "weiss_schwarz", "NIK/S117-T01"))
        self.assertIsNone(builder.language(card(name="Private English Version"), "weiss_schwarz", "NIK/S117-T01"))
        self.assertIsNone(builder.language(card(), "yugioh", "LOB-EN001"))

    def test_card_name_quote_is_not_the_pack_title(self):
        context = builder.pack_context(card())
        self.assertEqual(builder.quoted_title(context), "Goddess of Victory : NIKKE")
        self.assertNotIn("AK Missile", context)


class CatalogBuildTests(unittest.TestCase):
    def test_exact_box_title_kind_and_edition_match_never_uses_loose_pack(self):
        context = 'Booster Pack "Goddess of Victory : NIKKE"'
        common = {"name": 'Weiss Schwarz Booster Pack "Goddess of Victory : NIKKE" Pack', "language": "unknown", "image": "pack.jpg"}
        box = common | {"id": "box", "kind": "box", "name": 'Weiss Schwarz Booster Pack "Goddess of Victory : NIKKE" Box', "image": "box.jpg"}
        self.assertEqual(builder.box_cover([common, box], "weiss_schwarz", context, "unknown")["id"], "box")
        self.assertIsNone(builder.box_cover([common], "weiss_schwarz", context, "unknown"))
        second = box | {"id": "second", "name": box["name"] + " Second Edition"}
        self.assertIsNone(builder.box_cover([second], "weiss_schwarz", context, "unknown"))

    def test_nikke_alias_keeps_underlying_game_exact_product_and_quote(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            ws = card("10", grades={"PSA10": {"minPrice": 100}}, listingCount=2)
            ua = card("20", "union_arena", 'Modernia SR★★ [UA18BT/NIK-1-019](Booster Pack "NIKKE")',
                      code="UATCG-UA18BT-NIK-1-019", minPrice=35, variant="parallel")
            source_files(root, {"weiss_schwarz": [ws], "union_arena": [ua]})
            manifest = builder.build(root)
            nikke = next(game for game in manifest["games"] if game["id"] == "nikke")
            self.assertEqual(nikke["cardCount"], 2)
            self.assertEqual({entry["sourceGame"] for entry in nikke["sets"]}, {"weiss_schwarz", "union_arena"})
            for entry in nikke["sets"]:
                row = builder.read_json(root / entry["file"].lstrip("/"))["cards"][0]
                self.assertEqual(row["game"], entry["sourceGame"])
                self.assertEqual(row["snkrProduct"]["id"], row["id"])
                self.assertEqual(row["snkrProduct"]["fullCardNumber"], row["fullCardNumber"])
                self.assertEqual(row["snkrProduct"]["setCode"], entry["code"])
                self.assertEqual(row["snkrdunkId"], row["id"])
                self.assertEqual(row["catalogSource"], "SNKRDUNK")
                self.assertEqual(row["snkrProduct"]["currency"], "USD")
                self.assertNotIn("image", row["snkrProduct"])
                self.assertNotIn("code", row["snkrProduct"])
                self.assertNotIn("releasedAt", row["snkrProduct"])
                self.assertEqual(row["variant"], "parallel" if row["id"] == "20" else "")
                if row["id"] == "10":
                    self.assertEqual(row["snkrProduct"]["grades"], ws["grades"])
            self.assertEqual(builder.validate(root)[0], [])

    def test_same_number_variants_stay_separate_and_sets_sort_newest_first(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            products = [card("1"), card("2", name='Private SP [NIK/S117-T01](Trial Deck "Goddess of Victory : NIKKE")'),
                        card("3", name='Future R [ABC/S999-001](Booster Pack "Future")', releasedAt="2026-11-01T00:00:00Z")]
            source_files(root, {"weiss_schwarz": products})
            game = next(game for game in builder.build(root)["games"] if game["id"] == "weiss_schwarz")
            self.assertEqual(game["sets"][0]["code"], "ABC/S999")
            two = next(entry for entry in game["sets"] if entry["code"] == "NIK/S117")
            self.assertEqual(two["cardCount"], 2)
            self.assertEqual(two["coverType"], "card")
            self.assertFalse(two["officialComplete"])
            rows = builder.read_json(root / two["file"].lstrip("/"))["cards"]
            self.assertEqual({row["id"] for row in rows}, {"1", "2"})

    def test_missing_source_shard_does_not_replace_last_good_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_files(root)
            target = root / "data/tcg-card-info.json"
            target.write_text('{"lastGood":true}', encoding="utf-8")
            source = root / "data/price-weiss_schwarz-card.json"
            data = builder.read_json(source)
            data["shards"] = ["/data/snkrdunk-games/weiss_schwarz-card-0001.json"]
            builder.atomic_write(source, data)
            with self.assertRaises(FileNotFoundError):
                builder.build(root)
            self.assertEqual(target.read_text(encoding="utf-8"), '{"lastGood":true}')

    def test_unidentified_number_is_explicit_and_keeps_same_product_quote(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source_files(root, {"union_arena": [card("90", "union_arena", "Unidentified registered card", code="")]})
            manifest = builder.build(root)
            game = next(game for game in manifest["games"] if game["id"] == "union_arena")
            row = builder.read_json(root / game["sets"][0]["file"].lstrip("/"))["cards"][0]
            self.assertEqual(row["fullCardNumber"], "")
            self.assertEqual(row["snkrProduct"]["minPrice"], 12.34)
            self.assertEqual(manifest["coverage"]["union_arena"]["unknownNumberProducts"], 1)
            self.assertEqual(builder.validate(root)[0], [])

    def test_large_set_parts_keep_one_set_identity_and_all_source_ids(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            products = [card(str(index), description="unused", variant="x" * 600,
                             name='Private ' + "z" * 600 + ' SR [NIK/S117-T01](Trial Deck "Goddess of Victory : NIKKE")')
                        for index in range(20)]
            source_files(root, {"weiss_schwarz": products})
            with patch.object(builder, "MAX_BYTES", 10000):
                manifest = builder.build(root)
            game = next(game for game in manifest["games"] if game["id"] == "weiss_schwarz")
            entry = game["sets"][0]
            main = builder.read_json(root / entry["file"].lstrip("/"))
            self.assertTrue(main["shards"])
            ids = set()
            for url in [entry["file"]] + main["shards"]:
                data = builder.read_json(root / url.lstrip("/"))
                self.assertEqual(data["set"]["id"], entry["id"])
                self.assertEqual(data["game"], "weiss_schwarz")
                ids.update(row["id"] for row in data["cards"])
            self.assertEqual(ids, {str(index) for index in range(20)})
            self.assertEqual(builder.validate(root)[0], [])


if __name__ == "__main__":
    unittest.main()


class BoxNavigationTests(unittest.TestCase):
    def test_dragon_ball_reprints_link_by_pack_title_not_old_printed_number(self):
        sets = [dict(id='a', sourceGame='dragon_ball_fusion_world', sourcePackTitle='FUSION WORLD "Booster Pack Heartbeat of Awakening"', code='FB01', cardCount=2),
                dict(id='b', sourceGame='dragon_ball_fusion_world', sourcePackTitle='FUSION WORLD "MANGA BOOSTER 01"', code='FB01', cardCount=3),
                dict(id='c', sourceGame='dragon_ball_fusion_world', sourcePackTitle='Promotional Card "Battle Pack 01"', code='FB01', cardCount=1)]
        boxes = [card('box', 'dragon_ball_fusion_world', 'DRAGON BALL SUPER CARD GAME FUSION WORLD "MANGA BOOSTER 01" Box', kind='box', productNumber='DBFW-SB01')]
        result = builder.navigation_boxes(sets, boxes, 'dragon_ball_fusion_world')
        self.assertEqual(result[0]['setIds'], ['b'])

    def test_nikke_never_merges_weiss_and_union_contents(self):
        sets = [dict(id=game, sourceGame=game, sourcePackTitle='Booster Pack "NIKKE"', code='NIK/S117', cardCount=2) for game in ('weiss_schwarz','union_arena')]
        boxes = [card('box', name='Weiss Schwarz Booster Pack "NIKKE" Box', kind='box')]
        result = builder.navigation_boxes(sets, boxes, 'weiss_schwarz')
        self.assertEqual(result[0]['setIds'], ['weiss_schwarz'])

    def test_loose_packs_cases_and_bonus_cards_are_not_box_navigation(self):
        names = ['Weiss Schwarz Booster Pack "NIKKE" Box', 'Weiss Schwarz Booster Pack "NIKKE" Pack', 'Weiss Schwarz Booster Pack "NIKKE" Case', 'Weiss Schwarz Booster Pack "NIKKE Bonus for Purchasing 3 BOX" Pack']
        boxes = [card(str(i),name=name,kind='box') for i,name in enumerate(names)]
        self.assertEqual(len(builder.navigation_boxes([], boxes, 'weiss_schwarz')), 1)

    def test_bleach_legacy_marketplace_deck_typo_uses_full_bt_code(self):
        sets = [dict(id='booster', sourceGame='union_arena', sourcePackTitle='UNIONARENA Starter Deck BLEACH Thousand-year blood war', code='UA08BT', cardCount=132),
                dict(id='deck', sourceGame='union_arena', sourcePackTitle='UNIONARENA Starter Deck BLEACH Thousand-year blood war', code='UA08ST', cardCount=22)]
        boxes = [card('box','union_arena','UNION ARENA Booster Pack "BLEACH Thousand-year blood war" Box',kind='box',productNumber='UATCG-UA08BT-BLC-1')]
        result = builder.navigation_boxes(sets, boxes, 'union_arena')
        self.assertEqual(result[0]['setIds'], ['booster'])
        self.assertEqual(result[0]['series'], '블리치')

    def test_same_title_standard_and_premium_boosters_keep_separate_boxes_and_contents(self):
        sets = [dict(id='standard', sourceGame='weiss_schwarz', sourcePackTitle='Booster Pack "hololive production"', code='HOL/W91', cardCount=350),
                dict(id='premium', sourceGame='weiss_schwarz', sourcePackTitle='Premium Booster "hololive production"', code='HOL/WE36', cardCount=159)]
        boxes = [card('standard-box', name='Weiss Schwarz Booster Pack Hololive Production Box', kind='box'),
                 card('premium-box', name='Weiss Schwarz Premium Booster Pack Hololive Production Box', kind='box')]
        result = {box['id']: box['setIds'] for box in builder.navigation_boxes(sets, boxes, 'weiss_schwarz')}
        self.assertEqual(result, {'BOX:standard-box':['standard'], 'BOX:premium-box':['premium']})
