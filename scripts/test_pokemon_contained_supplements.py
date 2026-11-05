import copy,json,pathlib,tempfile,unittest
from pokemon_contained_supplements import load_review,apply_to_set,catalogue_card,run,validate_assets
ROOT=pathlib.Path(__file__).resolve().parents[1]
EXPECTED={"DP2":131,"DP3":127,"DP4-Bd":78,"DP4-Bm":78,"DP5":73,"DP5-TW":73,"DP6":100,"L1-Bhg":79,"L1-Bss":79,"L2":89,"L3":89,"Pt1":104,"Pt2":98,"Pt3":108,"Pt4":98,"VS-MANAPHY":23}
class ReviewedContentsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):cls.review=load_review(ROOT)
    def test_every_audited_product_is_published_and_has_unique_source_identities(self):
        self.assertEqual(len(self.review["entries"]),126)
        for code,count in EXPECTED.items():
            doc=json.loads((ROOT/"data/cards-by-set"/(code+".json")).read_text(encoding="utf-8"))
            self.assertEqual(doc["cardCount"],count,code);self.assertEqual(len(doc["cards"]),count)
            identities=[c.get("sourceId") or c.get("url") or c.get("sourceUrl") for c in doc["cards"]]
            self.assertEqual(len(identities),len(set(identities)),code)
    def test_basic_and_special_energy_are_distinct_and_recollection_is_idempotent(self):
        special={"name":"Darkness Energy","sourceId":"special-darkness","image":"special-energy-original.jpg"}
        raw={"code":"DP2","brand":"pokemon","cards":[special],"cardCount":1}
        first=apply_to_set(raw,"DP2",self.review)
        self.assertEqual(first["cards"][0],special)
        basics=[c for c in first["cards"] if c.get("basicEnergy")]
        self.assertEqual({c["energyType"] for c in basics},{"grass","fire","water","lightning","psychic","fighting","darkness","metal"})
        self.assertEqual(len(first["cards"]),9)
        self.assertEqual(first,apply_to_set(first,"DP2",self.review))
        self.assertEqual(first,apply_to_set(raw,"DP2",self.review))
        self.assertEqual(raw["cards"],[special],"A collected source was mutated in place")
        for c in basics:
            self.assertTrue(c["unprintedNumber"]);self.assertIsNone(c["printedNumber"]);self.assertFalse(c.get("id"))
            self.assertEqual(c["rarity"],"");self.assertEqual(c["rarityDisclosureStatus"],"verified-unprinted-rarity")
    def test_wrong_swellow_is_replaced_with_the_actual_swalot_image_without_its_prices(self):
        entry=next(e for e in self.review["entries"] if e["action"]=="replace")
        wrong={**entry["selector"],"id":"999999","minPrice":12345,"currency":"USD","productId":"999999"}
        raw={"code":"DP5-TW","brand":"pokemon","cards":[wrong],"cardCount":1}
        out=apply_to_set(raw,"DP5-TW",self.review)
        correct=next(c for c in out["cards"] if c["name"]=="Swalot")
        self.assertNotEqual(correct["image"],wrong["image"]);self.assertEqual(correct["sourceId"],"pokemon-card-17082")
        self.assertFalse(any(c["name"]=="Swellow" for c in out["cards"]))
        self.assertFalse(any(k in correct for k in ("id","productId","minPrice","currency")))
        self.assertEqual(out,apply_to_set(out,"DP5-TW",self.review))
        changed=copy.deepcopy(raw);changed["cards"][0]["image"]="different-unreviewed-card.jpg"
        with self.assertRaises(ValueError):apply_to_set(changed,"DP5-TW",self.review)
    def test_manaphy_contains_30_physical_cards_not_30_distinct_numbered_cards(self):
        doc=json.loads((ROOT/"data/cards-by-set/VS-MANAPHY.json").read_text(encoding="utf-8"))
        basics=[c for c in doc["cards"] if c.get("quantityInDeck")]
        self.assertEqual({c["energyType"]:c["quantityInDeck"] for c in basics},{"grass":2,"fire":2,"water":5,"psychic":2})
        self.assertEqual(19+sum(c["quantityInDeck"] for c in basics),30)
        self.assertEqual(len(doc["cards"]),23)
    def test_original_images_and_cover_formats_are_preserved(self):
        validate_assets(ROOT,self.review)
        from PIL import Image
        for asset in [*self.review["assets"],*self.review["covers"]]:
            with Image.open(ROOT/asset["localImage"].lstrip("/")) as im:
                self.assertEqual(im.size,(asset["width"],asset["height"]));self.assertEqual(im.format,asset["format"]);im.verify()
        covers={c["code"]:c for c in self.review["covers"]}
        self.assertEqual(covers["LL"]["kind"],"box");self.assertEqual(covers["LL"]["width"],1000)
        self.assertEqual(covers["WCP"]["width"],1080)
    def test_search_contains_the_same_reviewed_cards_and_exact_market_ids_only(self):
        cat=json.loads((ROOT/"data/japanese-catalog.json").read_text(encoding="utf-8"))
        for entry in self.review["entries"]:
            rows=[c for c in cat["cards"] if c["setCode"]==entry["setCode"] and c.get("sourceId")==entry["card"]["sourceId"]]
            self.assertEqual(len(rows),1)
            c=rows[0];self.assertEqual(c["nameKo"],entry["card"]["nameKo"]);self.assertEqual(c["image"],entry["card"]["image"])
            if entry["card"]["name"]=="Alph Lithograph":
                self.assertEqual(c["number"],"071/070");self.assertEqual(c["productId"],"556831");self.assertEqual(c["edition"],"1ED")
            else:self.assertIsNone(c["productId"]);self.assertEqual(c["productIds"],[])
    def test_reapply_is_read_only_when_already_materialized(self):
        self.assertEqual(run(ROOT,validate_only=True)["status"],"validated")
        self.assertEqual(run(ROOT)["changes"],[])
    def test_existing_artwork_guard_allows_only_exact_reviewed_new_cards(self):
        from materialize_vintage_pokemon_release import patch_documents
        with tempfile.TemporaryDirectory() as temporary:
            root=pathlib.Path(temporary);(root/"data/cards-by-set").mkdir(parents=True)
            (root/"data/pokemon-contained-supplements.json").write_text(json.dumps(self.review),encoding="utf-8")
            address="https://www.tcgcollector.com/cards/100/example"
            image="https://static.tcgcollector.com/content/images/original.jpg"
            original={"name":"Example","url":address,"image":image}
            source=apply_to_set({"code":"DP2","brand":"pokemon","cards":[original],"cardCount":1},"DP2",self.review)
            (root/"data/cards-by-set/DP2.json").write_text(json.dumps(source),encoding="utf-8")
            catalogue={"cards":[{"id":"JP:DP2:100","setCode":"DP2",**original}]+[catalogue_card(c,"DP2") for c in source["cards"][1:]]}
            (root/"data/japanese-catalog.json").write_text(json.dumps(catalogue),encoding="utf-8")
            review={"schemaVersion":1,"images":[{"setCode":"DP2","sourceUrl":address,"sourceId":"100","sourceName":"Example","originalImage":image,"localImage":"/images/pokemon-vintage/DP2/tcg-100.webp","imageSourceUrl":"https://static.tcgcollector.com/content/images/current.webp"}],"errors":[]}
            documents=patch_documents(root,review)
            self.assertEqual(len(documents["data/cards-by-set/DP2.json"]["cards"]),9)
            source["cards"][-1]["image"]="unreviewed-replacement.jpg"
            (root/"data/cards-by-set/DP2.json").write_text(json.dumps(source),encoding="utf-8")
            with self.assertRaises(ValueError):patch_documents(root,review)
if __name__=="__main__":unittest.main()
