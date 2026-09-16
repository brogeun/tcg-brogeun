"""Synchronize only M6a/MF Japanese products and grade-specific JPY asks.
Generated outputs: anniversary-market.json, anniversary-audit.json, and the two
existing set catalogues. No guessed prices or cross-set/card-number fallbacks.
"""
import concurrent.futures
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
BOXES = {"881421": "M6a", "881423": "MF"}
PREFIX = re.compile(r"^pkmn-tcg-(M6a|MF)(?:-|$)", re.I)
HEADERS = {"User-Agent": "Mozilla/5.0", "Accept-Language": "ja-JP,ja;q=0.9"}
VARIANT = re.compile(r"Mirror|Reverse|Master.?Ball|Monster.?Ball|Poke.?Ball|ミラー|マスター|モンスターボール", re.I)


def get(url):
    for attempt in range(3):
        try:
            response = requests.get(url, headers=HEADERS, timeout=25)
            response.raise_for_status()
            return response
        except requests.RequestException:
            if attempt == 2:
                raise
            time.sleep(1 + attempt * 2)


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def parse_product(html, proof):
    pid = str(proof["id"])
    product = chips = listings = None
    for script in BeautifulSoup(html, "html.parser").select("script"):
        text = script.string or ""
        flight = re.search(r"self\.__next_f\.push\((\[.*\])\)\s*;?\s*$", text, re.S)
        if flight:
            packet = json.loads(flight[1])
            for line in str(packet[1]).splitlines():
                try:
                    decoded = json.loads(line[line.index(":") + 1:])
                except (ValueError, TypeError):
                    continue
                for obj in walk(decoded):
                    apparel = obj.get("apparelData")
                    if isinstance(apparel, dict) and str(apparel.get("id")) == pid and apparel.get("productNumber"):
                        product = apparel
                    if str(obj.get("apparelId")) == pid and isinstance(obj.get("listings"), list):
                        listings = obj["listings"]
        hydration = re.search(r'\.push\((\{"mutations".*\})\)\s*;?\s*$', text, re.S)
        if hydration:
            for query in json.loads(hydration[1]).get("queries", []):
                if query.get("queryKey", [None])[0] == f"/v2/products/{pid}/size-chips":
                    chips = query.get("state", {}).get("data", {}).get("data", {}).get("chips")
    if not product or product.get("productNumber", "").lower() != proof["productNumber"].lower():
        raise ValueError(f"{pid}: identity mismatch")
    if not any(b.get("id") == "pokemon" for b in product.get("brands", [])):
        raise ValueError(f"{pid}: wrong brand")
    if re.search(r"\[(?:EN|ENG|KR|CHN)\]|英語版|韓国語版|中国語版", product.get("localizedName", "")):
        raise ValueError(f"{pid}: wrong language")
    code = PREFIX.match(product["productNumber"])[1]
    code = "M6a" if code.lower() == "m6a" else "MF"
    grades = []
    if pid in BOXES:
        row = next((r for r in listings or [] if r.get("variant", {}).get("filterSizeID") == "quantity_1"), None)
        if row is None:
            raise ValueError(f"{pid}: single-box quote missing")
        value = row.get("minNewListingPrice")
        grades = [{"key": "box", "label": "1개 · 미개봉", "lowestAsk": value if isinstance(value, int) and value > 0 else None}]
    else:
        if not isinstance(chips, list) or not chips:
            raise ValueError(f"{pid}: grade chips missing")
        keys = {18:"raw", 22:"psa10", 23:"psa9", 25:"bgs10_bl", 26:"bgs10_gl", 27:"bgs95"}
        for chip in chips:
            if not isinstance(chip.get("conditionId"), int) or not isinstance(chip.get("hasListing"), bool):
                raise ValueError(f"{pid}: malformed grade chip")
            value = chip.get("usedMinPrice")
            active = chip["hasListing"]
            if active and (not isinstance(value, int) or value <= 0):
                raise ValueError(f"{pid}: active grade without a price")
            grades.append({"key": keys.get(chip["conditionId"], str(chip["conditionId"])),
                           "label": chip["text"], "lowestAsk": value if active else None})
    image = product.get("primaryMedia", {}).get("imageUrl", "")
    if not image.startswith("https://cdn.snkrdunk.com/"):
        raise ValueError(f"{pid}: product image missing")
    name = product["name"]
    fraction = re.search(r"\[(?:M6a|MF)\s+([^\]]+)\]", name, re.I)
    return {"id": pid, "setCode": code, "brand": "pokemon", "kind": "box" if pid in BOXES else "card",
            "name": name, "productNumber": product["productNumber"], "thumbnailUrl": image,
            "number": fraction[1] if fraction else "", "variant": bool(VARIANT.search(name)),
            "currency": "JPY", "grades": grades, "sourceUrl": f"https://snkrdunk.com/apparels/{pid}",
            "fetchedAt": datetime.now(timezone.utc).isoformat(), "status": "ok"}


def discover():
    found = {}
    runs = []
    for order in ("new", "popular"):
        blank = 0
        for page in range(1, 21):
            url = f"https://snkrdunk.com/en/v1/trading-cards?brandId=pokemon&categoryId=25&page={page}&perPage=100&order={order}"
            rows = get(url).json().get("tradingCards")
            if not isinstance(rows, list):
                raise ValueError("Catalogue response invalid")
            targets = [r for r in rows if PREFIX.match(r.get("productNumber", ""))]
            for row in targets:
                found[str(row["id"])] = row
            blank = 0 if targets else blank + 1
            if not rows or blank >= 4:
                break
        runs.append({"order": order, "pages": page})
    if len(found) < 200:
        raise ValueError("Partial catalogue; keeping previous files")
    return found, runs


def title(name):
    return re.sub(r"^Basic ", "", name.split(" (")[0], flags=re.I).lower().replace("é", "e")


def link_catalogue(source, products):
    # Discard only our prior generated additions before regenerating.
    cards = [dict(c) for c in source["cards"] if not c.get("marketSupplement")]
    source_count = len(cards)
    assigned = set()
    for card in cards:
        candidates = [p for p in products if not p["variant"] and
                      ((not card.get("unprintedNumber") and p["number"].upper() == card["number"].upper()) or
                       (card.get("unprintedNumber") and title(p["name"].split(" [")[0]) == title(card["name"])))]
        card["marketIds"] = [p["id"] for p in candidates]
        assigned.update(card["marketIds"])
        if len(candidates) == 1 and not card.get("image"):
            card["image"] = candidates[0]["thumbnailUrl"]
            card["imageStatus"] = "available"
            card["imageSource"] = "snkrdunk.com"
    for p in products:
        if p["id"] in assigned:
            continue
        cards.append({"sourceId": "snkrdunk:" + p["id"], "number": p["number"] or p["productNumber"],
                      "name": p["name"], "image": p["thumbnailUrl"], "imageStatus": "available",
                      "rarity": "", "url": p["sourceUrl"], "marketIds": [p["id"]], "marketSupplement": True,
                      "isBundle": bool(re.search(r"2 Piece Set", p["name"], re.I)),
                      "versionLabel": "2장 묶음 상품" if re.search(r"2 Piece Set", p["name"], re.I) else "스니덩 추가 버전" if p["variant"] else "스니덩 추가 카드"})
    return {**source, "sourceCardCount": source_count, "cardCount": len(cards), "cards": cards,
            "pendingImageCount": sum(not c.get("image") for c in cards)}


def write_json(path, data):
    # Generated data only. Atomic replacement protects the last complete snapshot.
    temp = path.with_suffix(".json.tmp")
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temp.replace(path)


def main():
    found, runs = discover()
    proofs = list(found.values()) + [{"id": 881421, "productNumber": "pkmn-tcg-M6a"}, {"id": 881423, "productNumber": "pkmn-tcg-MF-PD"}]
    products, failures = {}, []
    def fetch_one(proof):
        pid = str(proof["id"])
        return parse_product(get(f"https://snkrdunk.com/apparels/{pid}").text, proof)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        jobs = {pool.submit(fetch_one, proof): str(proof["id"]) for proof in proofs}
        for future in concurrent.futures.as_completed(jobs):
            pid = jobs[future]
            try:
                products[pid] = future.result()
            except Exception as error:
                failures.append({"id": pid, "error": str(error)})
            if (len(products) + len(failures)) % 40 == 0:
                print(f"Checked {len(products)+len(failures)}/{len(proofs)}; failures={len(failures)}", flush=True)
    if failures:
        print(json.dumps(failures, ensure_ascii=False), flush=True)
        raise ValueError("Incomplete price audit; previous snapshots kept")
    reports, catalogues = {}, {}
    for code in ("M6a", "MF"):
        path = DATA / "cards-by-set" / f"{code}.json"
        original = json.loads(path.read_text(encoding="utf-8"))
        relevant = sorted([p for p in products.values() if p["kind"] == "card" and p["setCode"] == code], key=lambda p:int(p["id"]))
        result = link_catalogue(original, relevant)
        catalogues[code] = result
        reports[code] = {"sourceCards": result["sourceCardCount"], "totalWithVersions": result["cardCount"],
                         "marketProducts": len(relevant), "linkedSourceCards": sum(bool(c.get("marketIds")) for c in result["cards"] if not c.get("marketSupplement")),
                         "unlinked": [{"number":c["number"],"name":c["name"]} for c in result["cards"] if not c.get("marketIds")],
                         "pendingImages": result["pendingImageCount"]}
    snapshot = {"schemaVersion":1, "updatedAt":datetime.now(timezone.utc).isoformat(), "products":products}
    for code, catalogue in catalogues.items():
        write_json(DATA / "cards-by-set" / f"{code}.json", catalogue)
    write_json(DATA / "anniversary-market.json", snapshot)
    write_json(DATA / "anniversary-audit.json", {"updatedAt":snapshot["updatedAt"],"listingRuns":runs,"sets":reports,"failures":failures})
    print(json.dumps(reports, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
