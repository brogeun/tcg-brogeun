"""Verify My First Battle No Rarity references against exact individual pages.

Only writes the rarity906-en-decks-20261104 evidence report and additive overlay.
Raw card grades, prices, images, IDs and catalogue numbering are never changed.
Synthetic card ordinals are not treated as printed numbers. Both supported
normal/blue-border variants must share the explicit provider classification.
Four TCGdex identity-content conflicts are not typo-corrected: a different
direct source is used only where its exact subdeck/name/ordinal/illustrator
agrees with the target. Dex No Rarity is a provider classification only.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import re
import subprocess
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / "data/collections/sources"
PREFIX = "rarity906-en-decks-20261104"
DECKS = {"EN-TCG11587": "bulbasaur", "EN-TCG11588": "pikachu",
         "EN-TCG11589": "charmander", "EN-TCG11590": "squirtle"}
STARTERS = {"Bulbasaur", "Pikachu", "Charmander", "Squirtle"}


def sha256(value):
    return hashlib.sha256(value).hexdigest()


def balanced(text, start, opening, closing):
    """Return a bracketed TS value, ignoring braces inside quoted strings."""
    depth, quote_char, escaped = 0, None, False
    for index in range(start, len(text)):
        char = text[index]
        if quote_char:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote_char:
                quote_char = None
            continue
        if char in "\"'`":
            quote_char = char
        elif char == opening:
            depth += 1
        elif char == closing:
            depth -= 1
            if depth == 0:
                return text[start:index + 1]
    raise ValueError("Unbalanced source value")


def variants(text):
    match = re.search(r"\bvariants:\s*\[", text)
    assert match
    array = balanced(text, match.end() - 1, "[", "]")
    output, index = [], 1
    while index < len(array) - 1:
        if array[index] != "{":
            index += 1
            continue
        block = balanced(array, index, "{", "}")
        stamps = re.search(r"\bstamp:\s*\[([^\]]*)\]", block)
        subtype = re.search(r"\bsubtype:\s*\"([^\"]+)\"", block)
        product_id = re.search(r"\btcgplayer:\s*(\d+)", block)
        output.append({"stamps": re.findall(r"\"([^\"]+)\"", stamps.group(1)) if stamps else [],
                       "subtype": subtype.group(1) if subtype else "normal-border",
                       "tcgplayerProductId": int(product_id.group(1)) if product_id else None})
        index += len(block)
    return output


def model(source):
    raw = source["rawTs"].encode()
    assert sha256(raw) == source["sha256"]
    assert hashlib.sha1(b"blob " + str(len(raw)).encode() + b"\0" + raw).hexdigest() == source["gitBlobSha"]
    text = source["rawTs"]
    names = re.findall(r'\bname:\s*\{\s*en:\s*"([^"]+)"', text)
    rarity = re.search(r'\brarity:\s*"([^"]+)"', text)
    hp = re.search(r"\bhp:\s*(\d+)", text)
    illustrator = re.search(r'\billustrator:\s*"([^"]+)"', text)
    category = re.search(r'\bcategory:\s*"([^"]+)"', text)
    effect = re.search(r'\beffect:\s*\{\s*en:\s*"([^"]+)"', text)
    assert names and rarity and rarity.group(1) == "None"
    return {"name": names[0], "attackNames": names[1:], "rarity": rarity.group(1),
            "hp": hp.group(1) if hp else None,
            "illustrator": illustrator.group(1) if illustrator else None,
            "category": category.group(1),
            "trainerEffect": effect.group(1) if effect and category.group(1) == "Trainer" else None,
            "variants": variants(text), "source": source}


def refresh_source(checkout):
    commit = subprocess.check_output(["git", "-C", str(checkout), "rev-parse", "HEAD"], text=True).strip()
    set_path = Path("data/Scarlet & Violet/My First Battle.ts")
    files = [set_path] + sorted((checkout / set_path.with_suffix("")).glob("*.ts"), key=lambda p: int(p.stem))
    records = []
    for item in files:
        relative = item.relative_to(checkout) if item.is_absolute() else item
        raw = (checkout / relative).read_bytes()
        blob = subprocess.check_output(["git", "-C", str(checkout), "rev-parse", f"{commit}:{relative.as_posix()}"], text=True).strip()
        records.append({"path": relative.as_posix(), "repositoryCommit": commit,
                        "url": "https://github.com/tcgdex/cards-database/blob/" + commit + "/" + quote(relative.as_posix()),
                        "gitBlobSha": blob, "sha256": sha256(raw), "rawTs": raw.decode()})
    output = {"schemaVersion": 1, "provider": "TCGdex (direct pinned Git source)",
              "repositoryCommit": commit, "records": records}
    (SOURCES / f"{PREFIX}-tcgdex.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")


def page_text(node):
    if isinstance(node, str):
        return node
    if isinstance(node, dict):
        return str(node.get("text", "")) + "\n" + "\n".join(page_text(x) for x in node.get("children", []))
    return ""


def mirror_json(text):
    """Undo extraction-only Markdown escapes and literal control characters."""
    text = re.sub(r'\\([^"\\/bfnrtu])', r'\1', text)
    output, inside, escaped = [], False, False
    for char in text:
        if inside and ord(char) < 32:
            output.append(json.dumps(char)[1:-1])
            continue
        output.append(char)
        if escaped:
            escaped = False
        elif char == "\\" and inside:
            escaped = True
        elif char == '"':
            inside = not inside
    return json.loads("".join(output))


def finalize_original_prints(models, previous_content_conflicts):
    """Publish only original-print proof, never the earlier name-only trial."""
    proof_path = SOURCES / f"{PREFIX}-original-print-proof.json"
    proof = json.loads(proof_path.read_text())
    metadata_path = SOURCES / f"{PREFIX}-tcgcsv-mfb.json"
    metadata = json.loads(metadata_path.read_text())["results"][0]
    products = {item["productId"]: item for item in mirror_json(metadata["text"])["results"]}
    overlay = {"schemaVersion": 1, "bundleVersion": 1, "cards": {}, "sets": {}}
    accepted, held = [], list(proof["withheld"])
    aliases = {"Basic Grass Energy": "Grass Energy", "Basic Fire Energy": "Fire Energy",
               "Basic Water Energy": "Water Energy", "Basic Lightning Energy": "Lightning Energy"}
    for row in proof["accepted"]:
        code, url = row["setCode"], row["sourceUrl"]
        target_set = json.loads((ROOT / "data/english-sets" / f"{code}.json").read_text())
        target = next(card for card in target_set["cards"] if card["url"] == url)
        assert all(target[key] == row[key] for key in ["sourceId", "name", "number"])
        assert target["sourceImage"] == row["sourceImageUrl"] and not target["rarity"]
        original_model = models[aliases.get(target["name"], target["name"])]
        eligible = [variant for variant in original_model["variants"]
                    if DECKS[code] in variant["stamps"] and variant["subtype"] == row["sourceSubtype"]]
        assert len(eligible) == 1 and eligible[0]["tcgplayerProductId"] == row["providerProductId"]
        product = products[row["providerProductId"]]
        expected = target["name"] + (" (Blue Border)" if row["sourceSubtype"] == "blue-border" else "")
        assert product["name"] == row["providerProductName"] == expected
        assert product["groupId"] == 23330
        fields = {item["name"]: item["value"] for item in product["extendedData"]}
        assert fields["Rarity"] == "Unconfirmed"  # Never alias this into None.
        assert row["sourceModelUrl"] == original_model["source"]["url"]
        assert row["visualArtworkVariantMatchReviewed"] and row["artCropDHashDistance"] <= 12
        evidence = {
            "schemaVersion": 1, "kind": "external-explicit", "exactCardIdentity": True,
            "physicalPrintingConfirmed": False, "manufacturerNoGradeConfirmed": False,
            "value": "None", "reviewId": PREFIX,
            "identityMethod": "exact-original-variant-product-and-artwork-match",
            "catalogueNumberIsOrdinal": True, "printedNumberMatchClaimed": False,
            "sourceProductId": product["productId"], "sourceSubtype": row["sourceSubtype"],
            "sourceImageSha256": row["sourceImageSha256"],
            "providerImageSha256": row["providerImageSha256"],
            "references": [{"provider": "TCGdex", "url": row["sourceModelUrl"], "literal": "None"}],
            "otherReferences": [{"provider": "TCGplayer (exact original variant; identity only)",
                                 "url": product["url"], "literal": "Unconfirmed"}],
            "identityNote": "The pinned TCGdex model explicitly says None and links this exact original subdeck/normal-or-blue-border product. That product's original front artwork, border and stamp were compared with the stored target source image. Current changed Dex/TCG Collector artwork was not used to identify the stored face. TCGplayer itself says Unconfirmed, which is retained as an unknown state and is not converted to None. No. catalogue ordinals are not claimed as printed numbers.",
        }
        old_conflict = previous_content_conflicts.get((code, url))
        if old_conflict:
            evidence["changedPageContentConflict"] = old_conflict["conflicts"]
            evidence["changedPageConflictResolution"] = "Stored original face and exact primary product image establish the adopted source-model link; changed page scalar fields are not treated as original-face evidence."
        overlay["sets"].setdefault(code, {"schemaVersion": 1, "brand": "pokemon", "language": "en",
                                           "setCode": code, "compactIdentity": True, "cards": {}})["cards"][url] = {
            "name": target["name"], "number": target["number"], "rarity": "", "rarityOriginal": "—",
            "rarityStatus": "reference-unlisted", "rarityEvidence": evidence}
        accepted.append({**row, "status": "reference-unlisted", "value": "None"})
    for code in DECKS:
        for target in json.loads((ROOT / "data/english-sets" / f"{code}.json").read_text())["cards"]:
            if target["name"] in {"Potion", "Switch"}:
                held.append({"setCode": code, "sourceId": target["sourceId"], "sourceUrl": target["url"],
                             "name": target["name"], "number": target["number"],
                             "status": "withheld-original-product-image-unavailable",
                             "reason": "Primary original product image returned 403 and several TCGdex Trainer variant links identify the wrong product. Name/subdeck alone is not used to prove the original artwork."})

    # Best of Game: the exact nine-card group has 15 original Winner/non-Winner
    # products. Every eligible variant explicitly has Promo in TCGplayer.
    csv_path = SOURCES / f"{PREFIX}-tcgcsv.json"
    csv = json.loads(csv_path.read_text())
    original_text = next(item["text"] for item in csv["results"] if "/1455/" in item["url"])
    best_products = mirror_json(original_text)["results"]
    assert len(best_products) == 15 and all(item["groupId"] == 1455 for item in best_products)
    archives = []
    for path in sorted(SOURCES.glob("rarity-crossdb-20261101-en-*.json.gz")):
        archives.extend(json.loads(gzip.decompress(path.read_bytes()))["rows"])
    prior = {item["sourceUrl"]: item for item in archives if item["setCode"] == "EN-TCG11114"}
    target_set = json.loads((ROOT / "data/english-sets/EN-TCG11114.json").read_text())
    best_accepted = []
    for target in target_set["cards"]:
        assert not target["rarity"]
        number = int(target["number"])
        base_name = target["name"] + " - " + str(number)
        candidates = []
        for product in best_products:
            fields = {item["name"]: item["value"] for item in product["extendedData"]}
            if product["name"] not in {base_name, base_name + " [Winner]"}:
                continue
            assert fields["Number"] == f"{number:03}/009" and fields["Rarity"] == "Promo"
            candidates.append(product)
        assert candidates
        old = prior[target["url"]]
        assert old["name"] == target["name"] and old["number"] == target["number"]
        alternative = [{"provider": ref["provider"], "url": ref["ref"]["cardSourceUrl"], "literal": ref["rawValue"]}
                       for ref in old["refs"]]
        evidence = {
            "schemaVersion": 1, "kind": "external-explicit", "exactCardIdentity": True,
            "physicalPrintingConfirmed": False, "manufacturerNoGradeConfirmed": False,
            "value": "Promo", "reviewId": PREFIX,
            "identityMethod": "exact-nine-card-set-name-number-and-original-variant-consensus",
            "references": [{"provider": "TCGplayer (via TCGCSV exact product metadata)", "url": item["url"], "literal": "Promo"} for item in candidates],
            "otherReferences": alternative,
            "sourceMetadataUrl": "https://tcgcsv.com/tcgplayer/3/1455/products",
            "sourceMetadataExtractedTextSha256": sha256(original_text.encode()),
            "resolutionNote": "Exact TCGplayer product metadata is preferred under the existing reference policy. All eligible original Winner/non-Winner products for this exact set/name/number agree Promo. The differing TCGdex None and PokémonTCG API Promo remain visible; None and Promo are not global aliases and raw rarity is not overwritten.",
        }
        overlay["sets"].setdefault("EN-TCG11114", {"schemaVersion": 1, "brand": "pokemon", "language": "en",
                                                   "setCode": "EN-TCG11114", "compactIdentity": True, "cards": {}})["cards"][target["url"]] = {
            "name": target["name"], "number": target["number"], "rarity": "Promo", "rarityOriginal": "—",
            "rarityStatus": "reference-explicit", "rarityEvidence": evidence}
        best_accepted.append({"setCode": "EN-TCG11114", "sourceId": target["sourceId"], "sourceUrl": target["url"],
                              "name": target["name"], "number": target["number"], "status": "reference-explicit",
                              "value": "Promo", "productIds": [item["productId"] for item in candidates],
                              "alternativeReferencesRetained": alternative})
    assert len(accepted) == 38 and len(held) == 10 and len(best_accepted) == 9
    result = {
        "schemaVersion": 1, "reviewId": PREFIX, "scopedUnresolvedRows": 234,
        "scope": {"ENEnergy": 88, "ENFixedDecks": 63, "ENWorldChampionship": 73, "ENReferenceConflicts": 10},
        "newReferenceGrade": 9, "newExplicitExternalNone": 38, "resolvedTotal": 47,
        "remainingWithinScope": 187,
        "remainingReasons": {"energy88": "Synthetic numbers and changing art/year/edition require an exact original product/face link; no C inferred from Energy.",
                             "fixedDecks25": "Ten MFB original-variant holds plus 15 other deck cards need exact original printing evidence.",
                             "worldChampionship73": "Owner/year/deck-specific product identity remains required; rejected WC/Shadowless cross-print transfers remain rejected.",
                             "referenceConflict1": "McDonalds2015 Rhyhorn None vs Common is outside the resolved Best of Game consensus."},
        "policy": "External reference classifications only. No manufacturer no-grade assertion. Raw card grades, prices, IDs, images, set memberships and printed numbering are untouched. TCGplayer Unconfirmed is retained literally and is never normalized into None. Current changed artwork is not proof of an original stored face.",
        "myFirstBattleAccepted": accepted, "myFirstBattleWithheld": held,
        "bestOfGameAccepted": best_accepted,
        "changedPageContentConflictsRetained": list(previous_content_conflicts.values()),
        "evidenceFiles": [{"path": path.relative_to(ROOT).as_posix(), "sha256": sha256(path.read_bytes())}
                          for path in [proof_path, metadata_path, csv_path,
                                       SOURCES / f"{PREFIX}-tcgdex.json", SOURCES / f"{PREFIX}-tcgcollector.json"]],
    }
    (SOURCES / f"{PREFIX}.json").write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    (SOURCES / f"{PREFIX}-overlay.json").write_text(json.dumps(overlay, ensure_ascii=False, separators=(",", ":")) + "\n")
    print(json.dumps({"newReferenceGrade": 9, "newExplicitExternalNone": 38, "resolvedTotal": 47, "remainingWithinScope": 187}))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--tcgdex-root", type=Path)
    args = parser.parse_args()
    if args.tcgdex_root:
        refresh_source(args.tcgdex_root.resolve())
    source_path = SOURCES / f"{PREFIX}-tcgdex.json"
    sources = json.loads(source_path.read_text())
    set_record = sources["records"][0]
    assert 'id: "mfb"' in set_record["rawTs"] and 'official: 48' in set_record["rawTs"]
    assert 'releaseDate: "2023-09-29"' in set_record["rawTs"]
    models = {item["name"]: item for item in map(model, sources["records"][1:])}
    assert len(models) == 34
    pages_path = SOURCES / f"{PREFIX}-tcgcollector.json"
    pages = {item["url"]: item for item in json.loads(pages_path.read_text())["results"]}
    assert len(pages) == 40
    overlay = {"schemaVersion": 1, "bundleVersion": 1, "cards": {}, "sets": {}}
    accepted, withheld, energy_held = [], [], []
    for code, deck in DECKS.items():
        raw_set = json.loads((ROOT / "data/english-sets" / f"{code}.json").read_text())
        assert raw_set["language"] == "en" and raw_set["release"] == "2023.09.29"
        assert raw_set["name"] == "My First Battle (" + deck.capitalize() + ")"
        assert len(raw_set["cards"]) == 12
        for target in raw_set["cards"]:
            assert not target.get("rarity")
            identity = {"setCode": code, "sourceId": target["sourceId"], "sourceUrl": target["url"],
                        "name": target["name"], "number": target["number"], "language": "en"}
            if target["name"].startswith("Basic "):
                energy_held.append({**identity, "status": "withheld-name-alias-needs-independent-proof"})
                continue
            current = models[target["name"]]  # Original names are exact, never fuzzy-matched.
            eligible = [variant for variant in current["variants"] if deck in variant["stamps"]]
            assert eligible
            if target["name"] in STARTERS:
                assert {variant["subtype"] for variant in eligible} == {"normal-border", "blue-border"}
            else:
                assert len(eligible) == 1
            page = pages[target["url"]]
            assert page["language"] == "en" and page["final_url"] == target["url"]
            assert page["page_metadata"]["canonical"] == target["url"]
            assert page["title"] == f'{target["name"]} ({raw_set["name"]} {target["number"]}) (International TCG)'
            assert raw_set["url"] in page["links"] and target["sourceImage"] in page["image_links"]
            params = [parse_qs(urlparse(url).query) for url in page["links"]]
            seen_hp = {p["hitPointsMin"][0] for p in params if "hitPointsMin" in p and p.get("hitPointsMax") == p["hitPointsMin"]}
            seen_artists = {p["illustratorSearch"][0] for p in params if "illustratorSearch" in p}
            text = page_text(page["text"])
            issues, spelling_note = [], None
            if current["hp"] and current["hp"] not in seen_hp:
                issues.append({"field": "hp", "TCGdex": current["hp"], "TCGCollector": sorted(seen_hp)})
            if current["illustrator"] not in seen_artists:
                if current["illustrator"].casefold() in {artist.casefold() for artist in seen_artists}:
                    spelling_note = {"field": "illustrator", "type": "case-only-alias", "TCGdex": current["illustrator"], "TCGCollector": sorted(seen_artists)}
                else:
                    issues.append({"field": "illustrator", "TCGdex": current["illustrator"], "TCGCollector": sorted(seen_artists)})
            for attack in current["attackNames"]:
                if attack not in text:
                    issues.append({"field": "attackName", "TCGdex": attack, "TCGCollector": "not in fresh page text"})
            if current["trainerEffect"] and current["trainerEffect"] not in text:
                issues.append({"field": "trainerEffect", "TCGdex": current["trainerEffect"], "TCGCollector": "not in fresh page text"})
            proof = {**identity, "sourceModelId": Path(current["source"]["path"]).stem,
                     "sourceModelUrl": current["source"]["url"], "sourceLiteral": "None",
                     "subdeck": deck, "supportedVariants": eligible,
                     "matchingAttackNames": current["attackNames"], "matchingHp": current["hp"],
                     "TCGCollectorIllustrators": sorted(seen_artists), "TCGdexIllustrator": current["illustrator"],
                     "caseOnlyAlias": spelling_note,
                     "catalogueNumberIsOrdinal": True, "printedNumberMatchClaimed": False,
                     "physicalPrintingConfirmed": False, "manufacturerNoGradeConfirmed": False}
            if issues:
                withheld.append({**proof, "status": "withheld-identity-content-conflict", "conflicts": issues})
                continue
            evidence = {
                "schemaVersion": 1, "kind": "external-explicit", "exactCardIdentity": True,
                "physicalPrintingConfirmed": False, "manufacturerNoGradeConfirmed": False,
                "value": "None", "reviewId": PREFIX,
                "identityMethod": "product-subdeck-content-and-variant-consensus",
                "referenceScope": "exact-subdeck-card-model-all-listed-variants",
                "catalogueNumberIsOrdinal": True, "printedNumberMatchClaimed": False,
                "subdeck": deck, "sourceModelId": proof["sourceModelId"],
                "supportedVariants": eligible,
                "references": [
                    {"provider": "TCGdex", "url": current["source"]["url"], "literal": "None"},
                    {"provider": "TCG Collector (identity only)", "url": target["url"], "literal": "exact English subdeck, name, HP/attacks or Trainer effect, illustrator and image source"}],
                "identityNote": "My First Battle exact subdeck and original name are checked against fresh catalogue HP/attack names or Trainer effect and illustrator. TCGdex explicitly classifies the matched model None and lists only None-classified eligible normal/blue-border variants. Catalogue No. ordinals are not printed numbers; physical printing is not independently confirmed.",
            }
            if spelling_note:
                evidence["controlledLiteralAlias"] = spelling_note
            overlay["sets"].setdefault(code, {"schemaVersion": 1, "brand": "pokemon", "language": "en",
                                               "setCode": code, "compactIdentity": True, "cards": {}})["cards"][target["url"]] = {
                "name": target["name"], "number": target["number"], "rarity": "", "rarityOriginal": "—",
                "rarityStatus": "reference-unlisted", "rarityEvidence": evidence}
            accepted.append({**proof, "status": "reference-unlisted"})
    assert len(accepted) == 36 and len(withheld) == 4 and len(energy_held) == 8
    assert {row["name"] for row in withheld} == {"Gloom", "Exeggutor", "Growlithe", "Arcanine"}

    conflicts = {(row["setCode"], row["sourceUrl"]): row for row in withheld}
    finalize_original_prints(models, conflicts)


if __name__ == "__main__":
    main()
