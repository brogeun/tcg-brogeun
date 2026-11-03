"""Reproduce a rejected EN rarity matching experiment without publishing grades.

Identical TCG Collector source IDs are reused in multiple deck/prize panels.
That is insufficient to transfer edition-specific TCGplayer classifications.
The output records 26 withheld WC/Shadowless candidates and an empty overlay.
"""
from __future__ import annotations

import copy
import gzip
import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / "data/collections/sources"
REVIEW_ID = "rarity-resume-en-20261103"


def identity(row):
    return tuple(row[key] for key in ("language", "sourceId", "sourceUrl", "name", "number"))


def main():
    report = json.loads((SOURCES / "rarity-crossdb-20261101.json").read_text())
    archive_manifest = {item["path"]: item for item in report["archives"]}
    rows, input_proofs = [], []
    for path in sorted(SOURCES.glob("rarity-crossdb-20261101-en-*.json.gz")):
        relative = path.relative_to(ROOT).as_posix()
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        assert archive_manifest[relative]["sha256"] == digest
        source = json.loads(gzip.decompress(path.read_bytes()))
        assert source["locale"] == "en"
        rows.extend(source["rows"])
        input_proofs.append({"path": relative, "sha256": digest})
    assert len(rows) == 2053
    references = defaultdict(list)
    for row in rows:
        if row["preferredReferenceStatus"] == "reference-grade":
            references[identity(row)].append(row)

    existing_sets = {}
    for path in sorted((SOURCES / "pokemon-rarity-recheck").glob("part-400*.json")):
        for code, dataset in json.loads(path.read_text())["sets"].items():
            assert code not in existing_sets
            existing_sets[code] = dataset

    withheld = []
    for row in rows:
        if row["preferredReferenceStatus"] != "not-resolved-by-references":
            continue
        matches = references.get(identity(row), [])
        if not matches:
            continue
        assert len({match["preferredReferenceValue"] for match in matches}) == 1
        origin = sorted(matches, key=lambda match: match["setCode"])[0]
        entry = existing_sets[origin["setCode"]]["cards"][row["sourceUrl"]]
        assert entry["name"] == row["name"] and entry["number"] == row["number"]
        assert entry["rarity"] == origin["preferredReferenceValue"]
        assert entry["rarityStatus"] == "reference-explicit"
        direct_refs = copy.deepcopy(entry["rarityEvidence"]["references"])
        assert direct_refs and all(ref["url"].startswith("https://") for ref in direct_refs)
        assert all("world-championship-decks-" in ref["url"] or "base-set-shadowless-" in ref["url"]
                   for ref in direct_refs)

        # Also verify that target rows still have the archived exact identity;
        # this does not establish the provider's physical edition as a match.
        target = json.loads((ROOT / "data/english-sets" / f'{row["setCode"]}.json').read_text())
        current = [card for card in target["cards"]
                   if str(card.get("sourceId")) == row["sourceId"]
                   and card.get("url") == row["sourceUrl"]
                   and card.get("name") == row["name"]
                   and card.get("number") == row["number"]]
        assert len(current) == 1 and not current[0].get("rarity")
        withheld.append({
            "setCode": row["setCode"], "catalogueSetName": row["catalogueSetName"],
            "productType": row["productType"], "sourceId": row["sourceId"],
            "sourceUrl": row["sourceUrl"], "name": row["name"], "number": row["number"],
            "language": "en", "originalStatus": row["preferredReferenceStatus"],
            "referenceStatus": "withheld-edition-mismatch",
            "candidateReferenceValue": entry["rarity"],
            "canonicalReferenceSetCode": origin["setCode"],
            "directReferences": direct_refs,
            "identityMethod": "identical-source-card-catalogue-reuse",
            "physicalPrintingConfirmed": False,
            "targetDeckStampConfirmed": False, "targetEditionConfirmed": False,
            "withheldReason": "Provider product is edition-specific; identical shared catalogue source identity does not establish the target deck printing, stamp or edition.",
        })

    assert len(withheld) == 26
    assert Counter(item["candidateReferenceValue"] for item in withheld) == {"Common": 26}
    output = {
        "schemaVersion": 1, "reviewId": REVIEW_ID, "language": "en", "scope": 888,
        "recoveredReferenceGrade": 0, "withheldEditionMismatch": 26,
        "remainingWithoutAdoptableClassification": 888, "referenceConflictsUnchanged": 10,
        "method": "Byte-identical sourceId, sourceUrl, original name, full number and language across archived panel rows yielded 26 candidates, then all were withheld because direct provider products identify a different edition. Archived references are preserved as rejected-candidate evidence only.",
        "policy": "No new classifications are adopted. Raw rarity and existing reference counts are unchanged. Catalogue card identity does not establish physical printing, foil, stamp or edition. No name normalization, synthetic-number reinterpretation or transfer from an unmatched printing.",
        "countsByProductType": dict(sorted(Counter(item["productType"] for item in withheld).items())),
        "sourceArchives": input_proofs,
        "overlayIntegration": "Do not integrate candidate grades. Overlay is empty because every candidate fails the edition-specific identity requirement.",
        "rows": withheld,
    }
    overlay = {"schemaVersion": 1, "bundleVersion": 1, "cards": {}, "sets": {}}
    (SOURCES / f"{REVIEW_ID}.json").write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n")
    (SOURCES / f"{REVIEW_ID}-overlay.json").write_text(json.dumps(overlay, separators=(",", ":")) + "\n")
    print(json.dumps({"recovered": 0, "withheld": len(withheld),
                      "byProductType": output["countsByProductType"],
                      "setCount": 0, "remaining": 888}))


if __name__ == "__main__":
    main()
