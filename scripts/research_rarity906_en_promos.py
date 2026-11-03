#!/usr/bin/env python3
"""Reproduce exact French McDonald's reference evidence; never rewrite raw cards.

The EN catalogue panel contains three French physical products.  The matching
source is the *French* TCGdex directory, not its unrelated 12-card English 2018
set.  The saved TCG Collector images were manually reviewed for printed French
names, full fractions and set identity.  None remains an external DB value,
not a claim that every physical rarity symbol has been inspected.
"""

from __future__ import annotations

import argparse
import ast
import gzip
import hashlib
import json
import re
import subprocess
from collections import Counter
from pathlib import Path
from urllib.parse import quote


ROOT = Path(__file__).resolve().parents[1]
REVIEW = "rarity906-en-promos-20261104"
COMMIT = "a8fe5736aef9bd6be2436e3be730109030f4c6e2"
PRODUCTS = {
    "EN-TCG1192": ("Collection McDonald's 2013", "2013bw", 12),
    "EN-TCG11140": ("Collection McDonald's 2018", "2018sm-fr", 40),
    "EN-TCG11480": ("Collection McDonald's 2019", "2019sm-fr", 40),
}
SCOPE = set(PRODUCTS) | {"EN-TCG11125"}
VICTORY = {
    "48994": ("No. 013", "2006-2007", "Spring", "Pikachu", "gold", "Takumi Akabane"),
    "48998": ("No. 017", "2007-2008", "Autumn", "Pikachu", "silver", "Takumi Akabane"),
    "48999": ("No. 018", "2007-2008", "Spring", "Pikachu", "gold", "Takumi Akabane"),
    "49003": ("No. 022", "2008-2009", "Autumn", "Pikachu", "silver", "Takumi Akabane"),
    "49004": ("No. 023", "2008-2009", "Spring", "Pikachu", "gold", "Takumi Akabane"),
    "49008": ("No. 027", "2009-2010", "Autumn", "Pikachu", "silver", "Takumi Akabane"),
    "49009": ("No. 028", "2009-2010", "Spring", "Pikachu", "gold", "Takumi Akabane"),
    "49013": ("No. 032", "2010-2011", "Autumn", "Typhlosion", "silver", "Tokiko Miyamoto"),
    "49014": ("No. 035", "2010-2011", "Spring", "Typhlosion", "gold", "Tokiko Miyamoto"),
}
SOURCE_DIR = ROOT / "data/collections/sources"
STRING = r'''(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')'''


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def git_bytes(repo: Path, revision: str, path: str) -> bytes:
    return subprocess.check_output(["git", "show", f"{revision}:{path}"], cwd=repo)


def ts_string(text: str, key: str) -> str:
    m = re.search(rf"\b{re.escape(key)}\s*:\s*({STRING})", text)
    assert m, (key, text[:200])
    return ast.literal_eval(m.group(1))


def public_url(path: str) -> str:
    return f"https://github.com/tcgdex/cards-database/blob/{COMMIT}/{quote(path, safe='/')}"


def save(suffix: str, value: dict) -> None:
    path = SOURCE_DIR / f"{REVIEW}-{suffix}.json"
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    print(path.relative_to(ROOT))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tcgdex", type=Path, default=Path("/tmp/tcgdex-rarity-en"))
    args = parser.parse_args()
    git_head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    names = {int(x["id"]): x["en"] for x in json.loads((ROOT / "data/pokemon-names-pokeapi.json").read_text())}
    rows, archives = [], []
    for path in sorted(SOURCE_DIR.glob("rarity-crossdb-20261101-en-*.json.gz")):
        archives.append({"path": str(path.relative_to(ROOT)), "sha256": sha(path.read_bytes())})
        rows.extend(x for x in json.loads(gzip.decompress(path.read_bytes()))["rows"]
                    if x["setCode"] in SCOPE and x.get("preferredReferenceStatus") == "not-resolved-by-references")
    assert Counter(x["setCode"] for x in rows) == {
        "EN-TCG1192": 12, "EN-TCG11140": 40, "EN-TCG11480": 40, "EN-TCG11125": 82,
    }
    product_sources, products = [], {}
    for suffix in ("tcgplayer", "tcgplayer-jumbo"):
        path = SOURCE_DIR / f"{REVIEW}-{suffix}.json"
        data = json.loads(path.read_text())
        product_sources.append({"path": str(path.relative_to(ROOT)), "sha256": sha(path.read_bytes()),
                                "sourceUrls": [x["url"] for x in data.get("sources", [])] or [data["sourceUrl"]]})
        for product in data["products"]:
            products[product["productId"]] = product

    def product_ref(product: dict) -> dict:
        fields = {x["name"]: x["value"] for x in product["extendedData"]}
        assert fields["Rarity"] == "Promo"
        return {"provider": "TCGplayer (via TCGCSV products metadata)", "url": product["url"],
                "literal": fields["Rarity"], "sourceProductId": product["productId"],
                "sourceProductName": product["name"], "sourceGroupId": product["groupId"],
                "sourceCardLanguage": "en", "metadataSourceUrl": f"https://tcgcsv.com/tcgplayer/3/{product['groupId']}/products"}
    overlay = {"schemaVersion": 1, "bundleVersion": 1, "cards": {}, "sets": {}}
    snapshot = {"schemaVersion": 1, "reviewId": REVIEW, "provider": "TCGdex",
                "repository": "https://github.com/tcgdex/cards-database", "commit": COMMIT,
                "files": {}}
    outcomes, images = [], {}

    def source(path: str) -> tuple[str, dict]:
        raw = git_bytes(args.tcgdex, COMMIT, path)
        info = {"url": public_url(path), "sha256": sha(raw), "text": raw.decode()}
        snapshot["files"][path] = info
        return info["text"], {"provider": "TCGdex", "url": info["url"], "sourceResponseSha256": info["sha256"]}

    for code, (directory, source_set_id, denominator) in PRODUCTS.items():
        raw_path = ROOT / "data/english-sets" / f"{code}.json"
        raw_set = json.loads(raw_path.read_text())
        raw_by_url = {x["url"]: x for x in raw_set["cards"]}
        header_path = f"data/McDonald's Collection/{directory}.ts"
        header, header_reference = source(header_path)
        assert ts_string(header, "id") == source_set_id
        assert int(re.search(r"official:\s*(\d+)", header).group(1)) == denominator
        assert re.search(r"name:\s*\{\s*fr:", header), header[:300]
        payload = {"schemaVersion": 1, "brand": "pokemon", "language": "en", "setCode": code,
                   "compactIdentity": True, "cards": {}}
        for row in (x for x in rows if x["setCode"] == code):
            raw = raw_by_url[row["sourceUrl"]]
            assert (raw["sourceId"], raw["name"], raw["number"], raw["language"], raw["setCode"]) == (
                row["sourceId"], row["name"], row["number"], row["language"], row["setCode"])
            assert raw["rarity"] == "" and row["language"] == "en"
            n, d = (int(x) for x in row["number"].split("/"))
            assert d == denominator and 1 <= n <= denominator
            path = f"data/McDonald's Collection/{directory}/{n}.ts"
            card_text, ref = source(path)
            literal = ts_string(card_text, "rarity")
            assert literal == "None"
            native_name = ts_string(card_text, "fr")
            assert not re.search(r"\ben\s*:", card_text), "French-only printing required"
            dex = [int(x) for x in re.search(r"dexId:\s*\[([^]]+)\]", card_text).group(1).split(",") if x.strip()]
            assert len(dex) == 1
            english_species = names[dex[0]]
            alolan = row["name"].startswith("Alolan ")
            if row["name"].removeprefix("Alolan ").casefold() != english_species.casefold():
                assert (code, row["sourceId"], row["name"], row["number"]) == ("EN-TCG11140", "13596", "Lillipup", "38/40")
                check_path = SOURCE_DIR / f"{REVIEW}-lillipup-check.json"
                check = json.loads(check_path.read_text())
                assert (check["sourceId"], check["sourceUrl"], check["number"], check["name"]) == (
                    row["sourceId"], row["sourceUrl"], row["number"], row["name"])
                outcomes.append({"setCode": code, "catalogueSetName": row["catalogueSetName"],
                    "sourceId": row["sourceId"], "sourceUrl": row["sourceUrl"], "name": row["name"],
                    "number": row["number"], "language": row["language"], "referenceStatus": "withheld-source-identity-mismatch",
                    "rejectedCandidate": {**ref, "literal": literal, "sourceNativeName": native_name,
                        "sourceSpeciesDexId": dex[0], "sourceEnglishSpecies": english_species},
                    "boundedIndependentCheck": {"path": str(check_path.relative_to(ROOT)), "sha256": sha(check_path.read_bytes()),
                        "classificationObservations": check["classificationObservations"], "adopted": False},
                    "reason": "TCGdex38.ts incorrectly duplicates39.ts Passerouge/Fletchling, dex661. Target face is Ponchiot/Lillipup38/40 dex506. Exact independent Upcards says Aucune, TCGCrew says Promo. No wrong-species transfer or automatic provider-taxonomy choice."})
                continue
            assert alolan == bool(re.search(r"d[’']Alola", native_name)), native_name
            image = raw["image"]
            if image not in images:
                image_bytes = git_bytes(ROOT, git_head, image)
                images[image] = {"path": image, "repositoryCommit": git_head,
                                 "sha256": sha(image_bytes), "source": "saved TCG Collector catalogue image",
                                 "review": "Manual inspection: French printed faces/names and full numbered fraction; not a per-card rarity-symbol or foil audit."}
            ref.update({"literal": literal, "sourceCardLanguage": "fr", "sourceNativeName": native_name,
                        "sourceSetId": source_set_id, "sourceLocalNumber": str(n), "sourceSetCardCount": denominator})
            language_note = ("현재 영문 목록에 포함된 프랑스어 실물 카드입니다. 프랑스어 세트·번호·도감 번호·폼과 저장된 카드 이미지를 대조했습니다. "
                             "TCGdex 프랑스어 카드 DB의 None 명시값이며, 영어판 등급을 이전하거나 실물 희귀도 기호의 부재를 확정한 값이 아닙니다.")
            identity = {"method": "exact-french-product-full-number-dex-species-regional-form-and-saved-image",
                        "catalogueSetName": raw_set["name"], "catalogueSourceSetId": raw_set["sourceId"],
                        "catalogueSetUrl": raw_set["url"], "catalogueLanguage": "en", "sourceCardLanguage": "fr",
                        "catalogueLanguageMismatch": True, "sourceNativeName": native_name,
                        "sourceSpeciesDexId": dex[0], "sourceEnglishSpecies": english_species,
                        "regionalForm": "alolan" if alolan else "base", "fullNumber": row["number"],
                        "sourceSetId": source_set_id, "sourceSetHeader": header_reference,
                        "savedImage": {**images[image], "sourceImage": raw["sourceImage"], "sprite": raw["sprite"]},
                        "rawSetSha256": sha(raw_path.read_bytes())}
            evidence = {"schemaVersion": 1, "kind": "external-explicit", "exactCardIdentity": True,
                        "physicalPrintingConfirmed": False, "manufacturerNoGradeConfirmed": False,
                        "value": "None", "references": [ref], "reviewId": REVIEW,
                        "catalogueLanguage": "en", "sourceCardLanguage": "fr", "catalogueLanguageMismatch": True,
                        "identityMethod": identity["method"], "identityEvidence": identity,
                        "note": language_note}
            payload["cards"][row["sourceUrl"]] = {"name": row["name"], "number": row["number"],
                "rarity": "", "rarityOriginal": "—", "rarityStatus": "reference-unlisted", "rarityEvidence": evidence}
            outcomes.append({"setCode": code, "catalogueSetName": row["catalogueSetName"],
                "sourceId": row["sourceId"], "sourceUrl": row["sourceUrl"], "name": row["name"],
                "number": row["number"], "language": row["language"], "referenceStatus": "reference-unlisted",
                "explicitReferenceState": "None", "directReferences": [ref], "identityEvidence": identity,
                "physicalPrintingConfirmed": False, "manufacturerNoGradeConfirmed": False})
        assert len(payload["cards"]) == denominator - (1 if code == "EN-TCG11140" else 0)
        overlay["sets"][code] = payload

    # Ancient Mew has no printed collector number. The two 001 values are
    # database ordinals, so match card model by HP, attack, species and art;
    # deliberately do not identify the Japanese/error/foil printing.
    ancient_row = next(x for x in rows if x["setCode"] == "EN-TCG11125" and x["sourceId"] == "9993")
    misc_raw_path = ROOT / "data/english-sets/EN-TCG11125.json"
    misc_raw_set = json.loads(misc_raw_path.read_text())
    ancient_raw = next(x for x in misc_raw_set["cards"] if x["url"] == ancient_row["sourceUrl"])
    assert (ancient_raw["sourceId"], ancient_raw["name"], ancient_raw["number"], ancient_raw["language"], ancient_raw["rarity"]) == ("9993", "Ancient Mew", "No. 001", "en", "")
    ancient_text, ancient_ref = source("data/Miscellaneous/Miscellaneous Promos/001.ts")
    ancient_header, ancient_header_ref = source("data/Miscellaneous/Miscellaneous Promos.ts")
    assert ts_string(ancient_text, "en") == "Ancient Mew" and ts_string(ancient_text, "rarity") == "Promo"
    assert ts_string(ancient_header, "id") == "miscp"
    assert re.search(r"dexId:\s*\[151\]", ancient_text) and re.search(r"hp:\s*30", ancient_text)
    assert 'en: "Psyche"' in ancient_text and 'damage: "40"' in ancient_text
    assert re.search(r"tcgplayer:\s*108589", ancient_text)
    ancient_image = ancient_raw["image"]
    ancient_image_bytes = git_bytes(ROOT, git_head, ancient_image)
    ancient_identity = {
        "method": "exact-international-card-model-name-hp-species-attack-and-saved-face",
        "scope": "external-card-model-reference", "catalogueNumberIsOrdinal": True,
        "printedCollectorNumberConfirmed": False, "targetEditionConfirmed": False,
        "catalogueLanguage": "en", "sourceCardLanguage": "runic", "sourceMetadataLanguage": "en",
        "sourceSetId": "miscp", "sourceLocalOrdinal": "001", "catalogueOrdinal": "No. 001",
        "sourceSetHeader": ancient_header_ref, "hp": 30, "attackName": "Psyche", "attackDamage": 40,
        "speciesDexId": 151, "sourceProductId": 108589,
        "targetSourcePage": {"url": ancient_row["sourceUrl"], "observed": {
            "name": "Ancient Mew", "hp": 30, "attackName": "Psyche", "attackDamage": 40,
            "speciesDexId": 151, "format": "Unlimited", "rarity": "—"},
            "reviewId": REVIEW, "method": "public page read through web retrieval"},
        "savedImage": {"path": ancient_image, "repositoryCommit": git_head, "sha256": sha(ancient_image_bytes),
            "sourceImage": ancient_raw["sourceImage"], "sprite": ancient_raw["sprite"],
            "review": "Ancient Mew runic card face manually inspected; not a Japanese/error/foil variant identification."},
        "rawSetSha256": sha(misc_raw_path.read_bytes()),
    }
    ancient_ref.update({"literal": "Promo", "sourceMetadataLanguage": "en", "sourceCardLanguage": "runic",
                        "scope": "external-card-model-reference", "sourceProductId": 108589})
    ancient_product = products[108589]
    assert ancient_product["name"] == "Ancient Mew"
    ancient_product_ref = product_ref(ancient_product)
    ancient_product_ref.update({"sourceCardLanguage": "runic", "sourceMetadataLanguage": "en"})
    ancient_identity["rejectedDifferentEditionProduct"] = {
        "productId": 482427, "name": products[482427]["name"], "url": products[482427]["url"],
        "reason": "Japanese Exclusive Print is separate and not used to classify the international target."}
    ancient_evidence = {"schemaVersion": 1, "kind": "external-explicit", "exactCardIdentity": True,
        "physicalPrintingConfirmed": False, "manufacturerNoGradeConfirmed": False, "value": "Promo",
        "references": [ancient_product_ref, ancient_ref], "reviewId": REVIEW, "identityMethod": ancient_identity["method"],
        "identityEvidence": ancient_identity, "catalogueNumberIsOrdinal": True,
        "sourceCardLanguage": "runic", "sourceMetadataLanguage": "en", "catalogueLanguage": "en",
        "note": "Ancient Mew 국제판 카드 모델에 대한 TCGdex의 Promo 분류입니다. No.001은 DB 관리 번호이며, 실물 번호·별 기호·일본판 오류·홀로 변형을 확인한 값이 아닙니다."}
    overlay["sets"]["EN-TCG11125"] = {"schemaVersion": 1, "brand": "pokemon", "language": "en",
        "setCode": "EN-TCG11125", "compactIdentity": True, "cards": {ancient_row["sourceUrl"]: {
            "name": "Ancient Mew", "number": "No. 001", "rarity": "Promo", "rarityOriginal": "—",
            "rarityStatus": "reference-explicit", "rarityEvidence": ancient_evidence}}}
    outcomes.append({"setCode": "EN-TCG11125", "catalogueSetName": ancient_row["catalogueSetName"],
        "sourceId": "9993", "sourceUrl": ancient_row["sourceUrl"], "name": "Ancient Mew", "number": "No. 001",
        "language": "en", "referenceStatus": "reference-explicit", "proposedReferenceValue": "Promo",
        "directReferences": [ancient_product_ref, ancient_ref], "identityEvidence": ancient_identity, "physicalPrintingConfirmed": False})

    # Search-retrieved primary TCGplayer product listing exposes all nine
    # event-specific product names and their explicit Promo classifications.
    # A direct product page separately confirms the first product and artist.
    listing_url = "https://www.tcgplayer.com/search/pokemon/product?q=Victory+Medal"
    retailer_snapshot = {"schemaVersion": 1, "reviewId": REVIEW,
        "retrievalMethod": "Public web retrieval; structured observations, not an HTTP byte archive",
        "sources": [{"provider": "TCGplayer", "url": listing_url, "products": [
            {"name": f"Victory Medal - {year} (Battle Road {season})", "set": "League & Championship Cards", "rarity": "Promo"}
            for number, year, season, species, colour, artist in VICTORY.values()]}]}
    misc_by_id = {x["sourceId"]: x for x in misc_raw_set["cards"]}
    for source_id, (number, year, season, species, colour, artist) in VICTORY.items():
        row = next(x for x in rows if x["sourceId"] == source_id and x["setCode"] == "EN-TCG11125")
        raw = misc_by_id[source_id]
        assert (row["name"], row["number"], row["sourceUrl"], row["language"]) == ("Victory Medal", number, raw["url"], "en")
        assert (raw["sourceId"], raw["name"], raw["number"], raw["rarity"]) == (source_id, "Victory Medal", number, "")
        image_bytes = git_bytes(ROOT, git_head, raw["image"])
        model = f"Victory Medal - {year} (Battle Road {season})"
        references = [{"provider": "TCGplayer (public product listing)", "url": listing_url,
                       "literal": "Promo", "sourceProductName": model, "sourceSetName": "League & Championship Cards",
                       "sourceCardLanguage": "en", "extraction": "Explicit classification beside the individual exact event product, not the set's rarity filter or generic distribution label."}]
        product = next(x for x in products.values() if x["name"] == model)
        references.insert(0, product_ref(product))
        identity = {"method": "exact-english-victory-medal-year-season-stamp-art-and-saved-face",
            "catalogueNumberIsOrdinal": True, "printedCollectorNumberConfirmed": False,
            "catalogueLanguage": "en", "sourceCardLanguage": "en", "sourceProductName": model,
            "season": season, "seasonYear": year, "artSpecies": species, "medalColour": colour,
            "illustratorObserved": artist,
            "savedImage": {"path": raw["image"], "repositoryCommit": git_head, "sha256": sha(image_bytes),
                "sourceImage": raw["sourceImage"], "sprite": raw["sprite"],
                "review": "Manually inspected exact English face, Battle Road/PlayPokemon season/year mark, medal colour and artist. Not a printed rarity-symbol or physical foil audit."},
            "rawSetSha256": sha(misc_raw_path.read_bytes())}
        evidence = {"schemaVersion": 1, "kind": "external-explicit", "exactCardIdentity": True,
            "physicalPrintingConfirmed": False, "manufacturerNoGradeConfirmed": False, "value": "Promo",
            "references": references, "reviewId": REVIEW, "identityMethod": identity["method"],
            "identityEvidence": identity, "catalogueNumberIsOrdinal": True, "sourceCardLanguage": "en",
            "note": f"저장된 영문 카드 이미지의 {year} {season} 대회 표시와 그림을 대조한 TCGplayer의 Promo 분류입니다. No.번호는 DB 관리 번호이며, 실물 Promo 기호·홀로 변형을 확정한 값이 아닙니다."}
        overlay["sets"]["EN-TCG11125"]["cards"][row["sourceUrl"]] = {"name": row["name"], "number": number,
            "rarity": "Promo", "rarityOriginal": "—", "rarityStatus": "reference-explicit", "rarityEvidence": evidence}
        outcomes.append({"setCode": "EN-TCG11125", "catalogueSetName": row["catalogueSetName"], "sourceId": source_id,
            "sourceUrl": row["sourceUrl"], "name": row["name"], "number": number, "language": "en",
            "referenceStatus": "reference-explicit", "proposedReferenceValue": "Promo", "directReferences": references,
            "identityEvidence": identity, "physicalPrintingConfirmed": False})

    # The saved English Shadow Lugia face prints HP300 and Shadow Storm1000;
    # the catalogue page's HP120 text is a separate source error, not inherited.
    shadow_row = next(x for x in rows if x["sourceId"] == "48990" and x["setCode"] == "EN-TCG11125")
    shadow_raw = misc_by_id["48990"]
    assert (shadow_raw["name"], shadow_raw["number"], shadow_raw["url"], shadow_raw["rarity"]) == ("Shadow Lugia", "No. 009", shadow_row["sourceUrl"], "")
    shadow_url = "https://pokemonplug.com/en-kr/products/shadow-lugia-nintendo-world-promofirst-partner-pack-jumbo-cards"
    shadow_reference = {"provider": "Pokemon Plug (direct retailer product)", "url": shadow_url, "literal": "Promo",
        "sourceProductName": "Shadow Lugia (Nintendo World Promo)[First Partner Pack Jumbo Cards]",
        "sourceCardLanguage": "en", "sourcePrintedNumber": "N/A", "sourceProductId": 127168}
    shadow_product_ref = product_ref(products[127168])
    retailer_snapshot["sources"].append({"provider": "Pokemon Plug", "url": shadow_url,
        "observed": {"rarity": "Promo", "cardNumber": "N/A", "hp": 300, "type": "Psychic", "stage": "Basic",
                     "attackName": "Shadow Storm", "attackDamage": 1000, "weakness": "Px2", "retreat": 3}})
    shadow_identity = {"method": "exact-english-shadow-lugia-saved-face-hp-attack-type-and-xd-logo",
        "scope": "external-card-model-reference", "catalogueNumberIsOrdinal": True, "printedCollectorNumberConfirmed": False,
        "catalogueLanguage": "en", "sourceCardLanguage": "en", "hp": 300, "attackName": "Shadow Storm", "attackDamage": 1000,
        "sourceMetadataDiscrepancy": {"cataloguePageTextHp": 120, "savedImageHp": 300, "directRetailerHp": 300,
            "policy": "Printed saved face and retailer model match; incorrect catalogue text HP is not used as identity evidence."},
        "targetEditionConfirmed": False,
        "savedImage": {"path": shadow_raw["image"], "repositoryCommit": git_head,
            "sha256": sha(git_bytes(ROOT, git_head, shadow_raw["image"])), "sourceImage": shadow_raw["sourceImage"],
            "sprite": shadow_raw["sprite"], "review": "English300HPShadowLugiaPokemonXDlogoShadowStorm1000 face directly inspected; exact jumbo dimensions/foil not confirmed."}}
    shadow_evidence = {"schemaVersion": 1, "kind": "external-explicit", "exactCardIdentity": True,
        "physicalPrintingConfirmed": False, "manufacturerNoGradeConfirmed": False, "value": "Promo",
        "references": [shadow_product_ref, shadow_reference], "reviewId": REVIEW, "identityMethod": shadow_identity["method"],
        "identityEvidence": shadow_identity, "catalogueNumberIsOrdinal": True, "sourceCardLanguage": "en",
        "note": "영문 Shadow Lugia 300HP·Shadow Storm1000 카드 이미지와 직접 판매처 상품을 대조한 Promo 분류입니다. 원본 카드 DB 설명의 HP120은 이미지의 HP300과 다릅니다. 실물 번호·Promo 기호·점보 크기·홀로 변형은 확정하지 않았습니다."}
    overlay["sets"]["EN-TCG11125"]["cards"][shadow_row["sourceUrl"]] = {"name": "Shadow Lugia", "number": "No. 009",
        "rarity": "Promo", "rarityOriginal": "—", "rarityStatus": "reference-explicit", "rarityEvidence": shadow_evidence}
    outcomes.append({"setCode": "EN-TCG11125", "catalogueSetName": shadow_row["catalogueSetName"], "sourceId": "48990",
        "sourceUrl": shadow_row["sourceUrl"], "name": "Shadow Lugia", "number": "No. 009", "language": "en",
        "referenceStatus": "reference-explicit", "proposedReferenceValue": "Promo", "directReferences": [shadow_product_ref, shadow_reference],
        "identityEvidence": shadow_identity, "physicalPrintingConfirmed": False})

    birds_row = next(x for x in rows if x["sourceId"] == "10135" and x["setCode"] == "EN-TCG11125")
    birds_raw = misc_by_id["10135"]
    assert (birds_raw["name"], birds_raw["number"], birds_raw["url"], birds_raw["rarity"]) == (
        "Articuno, Moltres, and Zapdos", "No. 002", birds_row["sourceUrl"], "")
    birds_product = products[211417]
    birds_fields = {x["name"]: x["value"] for x in birds_product["extendedData"]}
    assert birds_fields["HP"] == "120" and "Big Bang (200)" in birds_fields["Attack 1"]
    assert birds_product["name"] == "Articuno, Moltres, and Zapdos (Warner Bros. Promo)"
    birds_ref = product_ref(birds_product)
    birds_identity = {"method": "exact-english-jumbo-legendary-birds-saved-face-hp-attack-art-and-copyright-era",
        "scope": "external-card-model-reference", "catalogueNumberIsOrdinal": True, "printedCollectorNumberConfirmed": False,
        "catalogueLanguage": "en", "sourceCardLanguage": "en", "hp": 120, "attackDamage": 200,
        "attackNameObserved": "Big Bang Shuffle", "providerAttackName": "Big Bang",
        "attackEffectMatch": "Shuffle Articuno, Moltres, and Zapdos into your deck.",
        "illustratorObserved": "Mitsuhiro Arita", "targetEditionConfirmed": False,
        "savedImage": {"path": birds_raw["image"], "repositoryCommit": git_head,
            "sha256": sha(git_bytes(ROOT, git_head, birds_raw["image"])), "sourceImage": birds_raw["sourceImage"],
            "sprite": birds_raw["sprite"], "review": "English legendary birds120HPfaceBigBangShuffle200Aritaart and2000Englishcopyright observed; exact dimensions/foil not confirmed."}}
    birds_evidence = {"schemaVersion": 1, "kind": "external-explicit", "exactCardIdentity": True,
        "physicalPrintingConfirmed": False, "manufacturerNoGradeConfirmed": False, "value": "Promo", "references": [birds_ref],
        "reviewId": REVIEW, "identityMethod": birds_identity["method"], "identityEvidence": birds_identity,
        "catalogueNumberIsOrdinal": True, "sourceCardLanguage": "en",
        "note": "영문 세 전설의 새 120HP·Big Bang Shuffle200 카드 이미지와 Warner Bros. 상품의 TCGplayer Promo 분류를 대조했습니다. 판매처 공격명은 Big Bang으로 축약되어 있습니다. No.002는 DB 관리 번호이며 실물 기호·점보 크기·홀로 변형을 확정한 값이 아닙니다."}
    overlay["sets"]["EN-TCG11125"]["cards"][birds_row["sourceUrl"]] = {"name": birds_row["name"], "number": "No. 002",
        "rarity": "Promo", "rarityOriginal": "—", "rarityStatus": "reference-explicit", "rarityEvidence": birds_evidence}
    outcomes.append({"setCode": "EN-TCG11125", "catalogueSetName": birds_row["catalogueSetName"], "sourceId": "10135",
        "sourceUrl": birds_row["sourceUrl"], "name": birds_row["name"], "number": "No. 002", "language": "en",
        "referenceStatus": "reference-explicit", "proposedReferenceValue": "Promo", "directReferences": [birds_ref],
        "identityEvidence": birds_identity, "physicalPrintingConfirmed": False})

    # The synthetic Miscellaneous Promos ordinals do not identify trophy years,
    # events, stamps or printing variants. Preserve remaining rows without proof.
    for row in (x for x in rows if x["setCode"] == "EN-TCG11125"):
        if row["sourceId"] in {"9993", "48990", "10135"} | set(VICTORY):
            continue
        outcomes.append({"setCode": row["setCode"], "catalogueSetName": row["catalogueSetName"],
            "sourceId": row["sourceId"], "sourceUrl": row["sourceUrl"], "name": row["name"],
            "number": row["number"], "language": row["language"], "referenceStatus": "not-resolved-by-references",
            "reason": "Synthetic catalogue ordinal and repeated trophy/event names do not establish exact physical edition; no rarity inferred from promotional distribution or name."})
    report = {"schemaVersion": 1, "reviewId": REVIEW, "language": "en", "scope": len(rows),
              "recoveredReferenceGrade": 12, "explicitExternalNone": 91,
              "remainingWithoutAdoptableClassification": 71, "sourceArchives": archives, "productMetadataSources": product_sources,
              "method": "91 exact French products/full fractions/dex species/regional forms with saved French physical-card faces match immutable French TCGdex None fields.12 exact English/international card models or event-stamped faces match explicitTCGplayerPromo products; independent retailer metadata corroboratesShadowLugia. No generic promo-category inference.",
              "policy": "English catalogue language is a container label, not physical card language. All91 adoptedMcDonald'srows are disclosed asFrench.12Promo rows are external model/event classifications with ordinals and unverified physical variants disclosed. Raw rarity/prices/images remain unchanged. ExternalNone does not establish manufacturer no-grade or per-card rarity-symbol absence; normal/holo versions are not classified separately.",
              "limitations": ["2013 release date differs: catalogue2013.10.13 versus TCGdex2013-11-01; identity is based on product/count/number/species and exact saved French card faces, not release-date equivalence.",
                              "70 Miscellaneous Promos remain unresolved; repeated names and synthetic numbers cannot establish trophy/event edition.",
                              "French McDonald's2018Lillipup38/40 withheld: TCGdex38.ts incorrectly duplicates Fletchling39.ts. LiteralNone is not transferred across this identity mismatch.",
                              "Ancient Mew reference classifies the international card model; Japanese/error/foil variants and printed Promo symbol are not confirmed. No.001 is an ordinal.",
                              "VictoryMedal references classify each exact year/season public product; saved faces provide those otherwise-missing event identities. No synthetic ordinal is treated as a printed collector number.",
                              "ShadowLugia target saved face and direct retailer agreeHP300/ShadowStorm1000, while source catalogue text erroneouslystatesHP120. Promo is a card-model reference, not a dimensions/foil audit.",
                              "LegendaryBirds externalPromo is the English WarnerBrosmodel. TCGplayer shortens attacknameBigBangShuffle toBigBang; HP120,damage200,effectmatch. No physicaldimensions/foilclaim.",
                              "TCG Collector direct rarity is blank; TCGdex is an independent database, not manufacturer authority."],
              "countsBySet": dict(Counter(x["setCode"] for x in outcomes if x["referenceStatus"] in {"reference-unlisted", "reference-explicit"})),
              "savedImageProof": list(images.values()), "rows": outcomes}
    assert len(outcomes) == 174 and sum(len(x["cards"]) for x in overlay["sets"].values()) == 103
    save("retailer", retailer_snapshot)
    save("tcgdex", snapshot)
    save("overlay", overlay)
    save("report", report)


if __name__ == "__main__":
    main()
