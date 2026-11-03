"""Review legacy Japanese price links using exact-source and market artwork.

Candidate names/sets come from the production identity matcher. They only narrow
the comparison; no inventory ordinal or Pokemon Pokedex number establishes a link.
This script reports image evidence and never replaces the market price snapshot.

Requires Pillow and imagehash. Run without --apply to review the evidence first;
--sets selects a bounded set list and --apply merges only the strict matches.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import io
import json
import re
import subprocess
from pathlib import Path
from urllib.request import Request, urlopen

import imagehash
from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".cache/price-vintage"


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def market_image(product):
    url = product.get("thumbnailUrl") or product.get("image") or ""
    if not re.fullmatch(r"https://cdn\.snkrdunk\.com/[^\s]+", url):
        raise ValueError("Untrusted market image")
    path = CACHE / "market" / (str(product["id"]) + ".webp")
    if not path.exists():
        req = Request(url, headers={"User-Agent": "TCGHUB artwork audit/1.0"})
        with urlopen(req, timeout=25) as response:
            content = response.read()
        with Image.open(io.BytesIO(content)) as image:
            image.verify()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    return path


def card_frame(path):
    with Image.open(path) as original:
        image = original.convert("RGBA")
        alpha = image.getchannel("A")
        if alpha.getextrema()[0] < 255:
            image = image.crop(alpha.getbbox())
        else:
            # SNKRDUNK sometimes composites the card on a white square. Crop
            # only an actual white border; preserve printed yellow/grey edges.
            rgb = image.convert("RGB")
            delta = ImageChops.difference(rgb, Image.new("RGB", rgb.size, "white"))
            mask = delta.convert("L").point(lambda value: 255 if value > 24 else 0)
            bounds = mask.getbbox()
            if bounds and (bounds[2] - bounds[0]) / (bounds[3] - bounds[1]) < .85:
                image = image.crop(bounds)
        background = Image.new("RGBA", image.size, "white")
        background.alpha_composite(image)
        rgb = background.convert("RGB")
        if not .60 < rgb.width / rgb.height < .82:
            raise ValueError("Unexpected card crop")
        return rgb.resize((630, 880), Image.Resampling.LANCZOS)


def fingerprints(path):
    image = card_frame(path)
    return (imagehash.phash(image),
            imagehash.phash(image.crop((40, 70, 590, 800))),
            imagehash.phash(image.crop((55, 145, 575, 455))))


def compare(row):
    code, target = row["code"], row["target"]
    current = next(card for card in read(ROOT / f"data/cards-by-set/{code}.json")["cards"]
                   if card.get("image") == target.get("image") and card.get("url") == target.get("url"))
    source_path = ROOT / current.get("localImage", "").lstrip("/")
    if not current.get("localImage") or not source_path.is_file():
        return {"code": code, "name": target["name"], "status": "source-unavailable"}
    try:
        own = fingerprints(source_path)
    except Exception as error:
        return {"code": code, "name": target["name"], "status": "source-image-error", "error": str(error)}
    comparisons = []
    for product in row["products"]:
        if re.search(r"\b(?:1ED|1ST|FIRST EDITION|NO RARITY|UNLIMITED|SERIAL|SIGNED)\b", product["name"], re.I):
            continue
        try:
            path = market_image(product)
            other = fingerprints(path)
            scores = [int(a - b) for a, b in zip(own, other)]
            comparisons.append({"id": str(product["id"]), "product": product,
                                "distance": scores[0], "detailDistance": scores[1], "artDistance": scores[2],
                                "marketSHA256": hashlib.sha256(path.read_bytes()).hexdigest()})
        except Exception as error:
            comparisons.append({"id": str(product["id"]), "error": str(error)})
    valid = sorted((c for c in comparisons if "distance" in c), key=lambda c: c["distance"] + c["detailDistance"] + c["artDistance"])
    result = {"code": code, "name": target["name"], "image": target["image"],
              "sourceLocalImage": current["localImage"], "sourceUrl": current.get("imageSourceUrl"),
              "comparisons": [{k: v for k, v in c.items() if k != "product"} for c in comparisons], "status": "pending"}
    if not valid:
        return result
    best = valid[0]
    margin = min(64, sum(valid[1][k] for k in ("distance", "detailDistance", "artDistance")) -
                 sum(best[k] for k in ("distance", "detailDistance", "artDistance"))) if len(valid) > 1 else 64
    result["margin"] = margin
    if best["distance"] > 8 or best["detailDistance"] > 14 or best["artDistance"] > 12 or margin < 10:
        return result
    product = best["product"]
    result["status"] = "verified"
    result["link"] = {"brand": "pokemon", "boxCode": code, "setCode": target.get("setCode") or code,
                      "number": target.get("number", ""), "fullId": target.get("fullId", ""),
                      "image": target["image"], "id": str(product["id"]),
                      "marketName": product["name"], "marketProductNumber": product["productNumber"],
                      "marketImage": product["thumbnailUrl"],
                      "sourceSHA256": hashlib.sha256(source_path.read_bytes()).hexdigest(),
                      "marketSHA256": best["marketSHA256"], "method": "artwork-comparison", "margin": margin,
                      **{k: best[k] for k in ("distance", "detailDistance", "artDistance")},
                      "sourceLocalImage": current["localImage"], "sourceImageUrl": current.get("imageSourceUrl"),
                      "sourcePageUrl": current.get("url") or current.get("sourceUrl"),
                      "reviewedAt": "2026-11-04"}
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--sets", nargs="+", default=["Neo1", "Neo2", "Neo3", "Neo4", "CL1", "CL2", "CL3", "CL4", "Gym1", "Gym2"])
    args = parser.parse_args()
    if any(not re.fullmatch(r"[A-Za-z0-9_-]+", code) for code in args.sets):
        raise ValueError("Unsafe set code")
    # Use the same namespace/title/edition guards as the production resolver.
    # Candidate selection is never permission to attach a price by itself.
    node = r"""
const fs=require('fs'),match=require('./assets/contained-card-match.js');
const products=JSON.parse(fs.readFileSync('data/all-cards.json','utf8')).details;
const resolve=match.createResolver(products),rows=[];
for(const code of JSON.parse(process.argv[1])){
  const cards=JSON.parse(fs.readFileSync(`data/cards-by-set/${code}.json`,'utf8')).cards;
  for(const card of cards){
    const target={...card,brand:'pokemon',language:'ja',boxCode:code,setCode:card.setCode||code};
    rows.push({code,target,products:resolve.candidates(target)});
  }
}
process.stdout.write(JSON.stringify(rows));
"""
    candidates = subprocess.run(["node", "-e", node, json.dumps(args.sets)], cwd=ROOT,
                                capture_output=True, encoding="utf-8", check=True)
    write(CACHE / "candidates.json", json.loads(candidates.stdout))
    rows = read(CACHE / "candidates.json")
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        results = list(pool.map(compare, rows))
    write(CACHE / "comparison-results.json", results)
    counts = {}
    for row in results:
        counts[row["status"]] = counts.get(row["status"], 0) + 1
    if args.apply:
        document = read(ROOT / "data/contained-card-market-links.json")
        key = lambda x: (x["brand"], x["boxCode"].upper(), (x.get("fullId") or x.get("number") or "").upper(), x["image"])
        links = {key(row): row for row in document["links"]}
        added = 0
        for row in results:
            if row["status"] != "verified":
                continue
            link = row["link"]
            if key(link) not in links:
                links[key(link)] = link
                added += 1
            elif str(links[key(link)]["id"]) != link["id"]:
                raise ValueError("New artwork evidence contradicts a previous verified product")
        document["links"] = list(links.values())
        output = ROOT / "data/contained-card-market-links.json"
        output.write_text(json.dumps(document, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
        counts["added"] = added
    print(json.dumps(counts), flush=True)


if __name__ == "__main__":
    main()
