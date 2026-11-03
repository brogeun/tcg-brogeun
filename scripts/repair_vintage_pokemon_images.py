"""Restore exact legacy Japanese artwork from its existing TCG Collector page.

The original image field remains an identity key for reviewed market bindings.
Only localImage is used for display; imageSourceUrl records the current source.
No card names, editions, collection numbers, rarities or market IDs are inferred.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import io
import json
import re
import threading
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import requests
from bs4 import BeautifulSoup
from PIL import Image
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "data/pokemon-vintage-image-repairs.json"
LOCAL = threading.local()


def session():
    if not hasattr(LOCAL, "session"):
        client = requests.Session()
        client.headers["User-Agent"] = "TCGHUB catalogue artwork repair/1.0"
        client.mount("https://", HTTPAdapter(max_retries=Retry(
            total=3, backoff_factor=0.8, status_forcelist=[429, 500, 502, 503, 504],
            allowed_methods=["GET"], respect_retry_after_header=True)))
        LOCAL.session = client
    return LOCAL.session


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def exact_source_id(source_url):
    parsed = urlparse(source_url)
    match = re.fullmatch(r"/cards/(\d+)/[^/]+/?", parsed.path)
    if parsed.scheme != "https" or parsed.hostname != "www.tcgcollector.com" or not match:
        raise ValueError("Unrecognised source card page")
    return match[1]


def source_identity(source_url):
    parsed = urlparse(source_url)
    if parsed.scheme == "https" and parsed.hostname == "pooka.app":
        match = re.fullmatch(r"/card/(ja-[a-z0-9-]+)/[^/]+/?", parsed.path)
        if match:
            return match[1]
    return exact_source_id(source_url)


def basic_energy_name(name):
    return re.fullmatch(r"(?:Grass|Fire|Water|Lightning|Psychic|Fighting|Darkness|Metal) Energy", name) is not None


def card_title(name):
    return re.sub(r"\s+\([^)]*(?:No\.\s*\d+|\d+/\d+)\)$", "", name.strip())


def reviewed_split_sources(code, cards):
    """The provider merged old DP4 identities and moved its split set.

    Accept a replacement only when the current, exact Japanese split contains
    the same complete card-title multiset and every title is unique on both
    sides. Never search another set or silently select a repeated title.
    """
    if code != "DP4-Bd":
        return {}
    address = "https://www.tcgcollector.com/sets/12146/dawn-dash"
    response = session().get(address, timeout=30)
    response.raise_for_status()
    soup = BeautifulSoup(response.text, "html.parser")
    canonical = soup.find("link", rel="canonical")
    if not canonical or canonical.get("href") != address:
        raise ValueError("The reviewed Japanese Dawn Dash split identity changed")
    old = {}
    current = {}
    for card in cards:
        title = card_title(card["name"])
        if title in old:
            raise ValueError("Original Dawn Dash card title is ambiguous")
        old[title] = card
    for anchor in soup.select("a.card-image-grid-item-link"):
        image = anchor.find("img")
        source = anchor.get("href", "")
        if source.startswith("/"):
            source = "https://www.tcgcollector.com" + source
        if not image:
            continue
        exact_source_id(source)
        name = image.get("alt", "").strip()
        title = card_title(name)
        if title in current:
            raise ValueError("Current Dawn Dash card title is ambiguous")
        current[title] = {"currentSourceUrl": source, "currentName": name}
    if len(old) != 70 or len(current) != 70 or set(old) != set(current):
        raise ValueError("Dawn Dash split no longer has the exact reviewed 70-card composition")
    page_sha = hashlib.sha256(response.content).hexdigest()
    return {card.get("url") or card.get("sourceUrl"): {
        **current[title], "currentSetUrl": address, "currentSetPageSHA256": page_sha,
    } for title, card in old.items()}


def reviewed_metadata_repair(code, card):
    """One explicit name correction independently verified with the publisher.

    The original source page ID, image identity and collector number stay intact.
    This is not a general rule allowing a changed source title to replace a card.
    """
    source = card.get("url") or card.get("sourceUrl") or ""
    old = "PlusPower (Galactic's Conquest 084/096)"
    corrected = "Level Max (Galactic's Conquest 084/096)"
    expected = "https://www.tcgcollector.com/cards/26775/pluspower-galactics-conquest-084-096"
    if code != "Pt1" or source != expected:
        return
    if card.get("name") not in {old, corrected} or card.get("number") != "084/096":
        raise ValueError("The explicitly reviewed Pt1 metadata repair identity changed")
    card["originalSourceName"] = old
    card["name"] = corrected
    card["metadataRepair"] = {
        "originalName": old, "correctedName": corrected,
        "evidence": "https://www.pokemon-card.com/card-search/details.php/card/21256/regu/",
        "officialNumber": "DPt1-B 084/096",
    }


def normalized_inventory_title(value):
    # Collector's synthetic No. positions can be reordered without changing the
    # stable card ID. Preserve the complete card title and set; ignore only the
    # final inventory position, never a printed collection number or edition.
    return re.sub(r"\bNo\.\s*\d+(?=\))", "No.", value.strip())


def source_artwork(html, name, source_id, max_width=640, allow_plain_energy=False):
    soup = BeautifulSoup(html, "html.parser")
    canonical = soup.find("link", rel="canonical")
    if not canonical or exact_source_id(canonical.get("href", "")) != source_id:
        raise ValueError("Source page canonical card identity changed")
    matches = [tag for tag in soup.find_all("img")
               if normalized_inventory_title(tag.get("alt", "")) == normalized_inventory_title(name)]
    if not matches and allow_plain_energy and basic_energy_name(name):
        matches = [tag for tag in soup.find_all("img")
                   if tag.get("alt", "").strip().startswith(name + " (")]
    if not matches:
        raise ValueError("No artwork with the exact existing source card name")
    candidates = []
    for tag in matches:
        if tag.get("src"):
            candidates.append((int(tag.get("width", 0) or 0), tag["src"]))
        for part in tag.get("srcset", "").split(","):
            result = re.fullmatch(r"\s*(https://\S+)\s+(\d+)w\s*", part)
            if result:
                candidates.append((int(result[2]), result[1]))
    for _, address in sorted(set(candidates), reverse=True):
        parsed = urlparse(address)
        if parsed.scheme == "https" and parsed.hostname == "static.tcgcollector.com" and parsed.path.startswith("/content/images/"):
            within_limit = [(width, url) for width, url in candidates if width <= max_width]
            selected = max(within_limit or candidates, key=lambda item: item[0])[1]
            selected_address = urlparse(selected)
            if selected_address.scheme != "https" or selected_address.hostname != "static.tcgcollector.com" or not selected_address.path.startswith("/content/images/"):
                raise ValueError("Selected source image is outside the original host")
            return selected, matches[0].get("alt", "").strip(), canonical["href"]
    raise ValueError("Exact source artwork does not have a permitted image URL")


def exact_artwork(html, name, source_id, max_width=640):
    return source_artwork(html, name, source_id, max_width)[0]


def image_metadata(content):
    with Image.open(io.BytesIO(content)) as image:
        image.verify()
    with Image.open(io.BytesIO(content)) as image:
        width, height = image.size
        image_format = image.format
    if width < 250 or height < 350 or not 0.5 <= width / height <= 0.9:
        raise ValueError(f"Unexpected card artwork dimensions {width}x{height}")
    extensions = {"WEBP": "webp", "JPEG": "jpg", "PNG": "png"}
    if image_format not in extensions:
        raise ValueError("Unsupported source image format")
    return width, height, extensions[image_format]


def repair_one(code, card, previous, max_width=640, replacement=None):
    source = card.get("url") or card.get("sourceUrl") or ""
    source_id = source_identity(source)
    key = code + ":" + source_id
    existing = previous.get(key)
    if existing and existing.get("sourceUrl") == source and existing.get("sourceName") == card.get("name") and existing.get("originalImage") == card.get("image"):
        local_path = ROOT / existing["localImage"].lstrip("/")
        if local_path.is_file():
            content = local_path.read_bytes()
            if hashlib.sha256(content).hexdigest() == existing.get("sha256"):
                image_metadata(content)
                return key, existing
    is_pooka = urlparse(source).hostname == "pooka.app"
    if is_pooka:
        original = urlparse(card.get("image", ""))
        if original.scheme != "https" or original.hostname != "cdn.pooka.app" or original.path != f"/card/{source_id}.png" or card.get("sourceId") != source_id:
            raise ValueError("Existing Pooka artwork does not match its source card ID")
        image_url = "https://cdn.pooka.app" + original.path
        current_name, canonical_url = card["name"], source
    else:
        requested_source = replacement["currentSourceUrl"] if replacement else source
        current_id = exact_source_id(requested_source)
        expected_name = replacement["currentName"] if replacement else card["name"]
        response = session().get(requested_source, timeout=30)
        response.raise_for_status()
        if exact_source_id(response.url) != current_id:
            raise ValueError("Source page redirected to another card")
        image_url, current_name, canonical_url = source_artwork(response.text, expected_name, current_id, max_width,
            allow_plain_energy=bool(card.get("unprintedNumber") and basic_energy_name(card["name"])))
    picture = session().get(image_url, timeout=30)
    picture.raise_for_status()
    if not picture.headers.get("Content-Type", "").startswith("image/"):
        raise ValueError("Source returned a non-image response")
    if urlparse(picture.url).hostname != ("cdn.pooka.app" if is_pooka else "static.tcgcollector.com"):
        raise ValueError("Image redirected outside the original source")
    width, height, extension = image_metadata(picture.content)
    prefix = "pooka" if is_pooka else "tcg"
    local_image = f"/images/pokemon-vintage/{code}/{prefix}-{source_id}.{extension}"
    output = ROOT / local_image.lstrip("/")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_suffix(output.suffix + ".part")
    temporary.write_bytes(picture.content)
    temporary.replace(output)
    record = {
        "setCode": code, "sourceId": source_id, "sourceUrl": source,
        "sourceName": card["name"], "originalImage": card.get("image", ""),
        "sourceCurrentName": current_name, "canonicalSourceUrl": canonical_url,
        "imageSourceUrl": image_url, "localImage": local_image,
        "sha256": hashlib.sha256(picture.content).hexdigest(),
        "width": width, "height": height, "bytes": len(picture.content),
        "verifiedAt": datetime.now(timezone.utc).isoformat(),
        "method": "exact-existing-pooka-source-image-card-id" if is_pooka else "exact-source-page-canonical-id-and-title-set",
        "sourceTitleMatch": "basic-energy-title-on-existing-page" if current_name != card["name"] and basic_energy_name(card["name"]) else "exact-title-and-set",
    }
    if replacement:
        record.update({"sourceTitleMatch": "exact-unique-title-in-reviewed-split-set",
            "sourceReplacementSet": replacement["currentSetUrl"],
            "sourceReplacementSetSHA256": replacement["currentSetPageSHA256"],
            "sourceReplacementId": exact_source_id(replacement["currentSourceUrl"])})
    if card.get("metadataRepair"):
        record["originalSourceName"] = card["originalSourceName"]
        record["metadataRepair"] = card["metadataRepair"]
    return key, record


def sync_catalogue(entries):
    path = ROOT / "data/japanese-catalog.json"
    data = read_json(path)
    by_source = {(row["setCode"].upper(), row["sourceUrl"]): row for row in entries}
    changed = 0
    for card in data["cards"]:
        code = str(card.get("boxCode") or card.get("setCode") or "").upper()
        row = by_source.get((code, card.get("sourceUrl") or card.get("url") or ""))
        if not row:
            continue
        if card.get("image") != row["originalImage"]:
            # Some set files had already received an exact-card local snapshot,
            # while the canonical search catalogue retained its old remote URL.
            # The same source page and exact title identify this discrepancy;
            # preserve both original identity keys rather than replacing either.
            if normalized_inventory_title(card.get("name", "")) != normalized_inventory_title(row["sourceName"]):
                raise ValueError(f"Canonical artwork identity changed for {row['sourceUrl']}")
            row["canonicalOriginalImage"] = card.get("image", "")
        if card.get("sourceId") and str(card["sourceId"]) not in {row["sourceId"], "tcgcollector-" + row["sourceId"]}:
            # These existing supplemental sourceId fields belong to Pooka's
            # rarity provenance, while sourceUrl retains the original TCG page.
            # Keep both namespaces; never reinterpret the Pooka ID as a market ID.
            if code not in {"DP1", "ADV4"} or not re.fullmatch(r"ja-[a-z0-9-]+", str(card["sourceId"])):
                raise ValueError("Canonical card source ID disagrees with the exact page")
            row["canonicalSourceId"] = str(card["sourceId"])
        card["localImage"] = row["localImage"]
        card["imageSourceUrl"] = row["imageSourceUrl"]
        card["currentSourceUrl"] = row.get("canonicalSourceUrl") or row["sourceUrl"]
        if row.get("metadataRepair"):
            repair = row["metadataRepair"]
            if card.get("name") not in {repair["originalName"], repair["correctedName"]}:
                raise ValueError("Canonical name disagrees with the explicit official metadata repair")
            card["name"] = repair["correctedName"]
            card["originalSourceName"] = repair["originalName"]
            card["metadataRepair"] = repair
        changed += 1
    write_json(path, data)
    print(f"Canonical Japanese catalogue artwork paths synchronised: {changed}", flush=True)


def validate(entries, codes, check_catalogue=False):
    selected = [row for row in entries if row["setCode"] in codes]
    by_key = {}
    for row in selected:
        relative = Path(row["localImage"].lstrip("/"))
        if ".." in relative.parts or relative.parts[:2] != ("images", "pokemon-vintage"):
            raise ValueError("Unsafe local artwork path")
        content = (ROOT / relative).read_bytes()
        width, height, _ = image_metadata(content)
        if hashlib.sha256(content).hexdigest() != row["sha256"] or len(content) != row["bytes"] or (width, height) != (row["width"], row["height"]):
            raise ValueError("Artwork content does not match its verification manifest")
        current_title = row.get("sourceCurrentName", row["sourceName"])
        plain_energy = row.get("sourceTitleMatch") == "basic-energy-title-on-existing-page" and basic_energy_name(row["sourceName"]) and current_title.startswith(row["sourceName"] + " (")
        split_title = row.get("sourceTitleMatch") == "exact-unique-title-in-reviewed-split-set" and row["setCode"] == "DP4-Bd" and row.get("sourceReplacementSet") == "https://www.tcgcollector.com/sets/12146/dawn-dash" and card_title(current_title) == card_title(row["sourceName"])
        if not plain_energy and not split_title and normalized_inventory_title(current_title) != normalized_inventory_title(row["sourceName"]):
            raise ValueError("Verified source title or set changed")
        key = (row["setCode"], row["sourceUrl"])
        if key in by_key:
            raise ValueError("Duplicate verified source artwork identity")
        by_key[key] = row
    total = 0
    for code in codes:
        data = read_json(ROOT / f"data/cards-by-set/{code}.json")
        for card in data["cards"]:
            row = by_key[(code, card.get("url") or card.get("sourceUrl"))]
            if card.get("image") != row["originalImage"] or card.get("localImage") != row["localImage"] or card.get("imageSourceUrl") != row["imageSourceUrl"] or card.get("currentSourceUrl") != (row.get("canonicalSourceUrl") or row["sourceUrl"]):
                raise ValueError("Set artwork display paths or original identity changed")
            total += 1
            if row.get("metadataRepair") and (card.get("name") != row["metadataRepair"]["correctedName"] or card.get("metadataRepair") != row["metadataRepair"]):
                raise ValueError("Explicit official metadata repair was not preserved")
    if check_catalogue:
        catalogue = read_json(ROOT / "data/japanese-catalog.json")
        seen = set()
        for card in catalogue["cards"]:
            key = (card.get("boxCode") or card.get("setCode"), card.get("sourceUrl") or card.get("url"))
            if key in by_key:
                row = by_key[key]
                if card.get("localImage") != row["localImage"] or card.get("image") not in {row["originalImage"], row.get("canonicalOriginalImage", row["originalImage"])} or card.get("currentSourceUrl") != (row.get("canonicalSourceUrl") or row["sourceUrl"]):
                    raise ValueError("Canonical catalogue display path or original identity changed")
                seen.add(key)
        missing = set(by_key) - seen
        if missing:
            raise ValueError(f"Canonical catalogue is missing {len(missing)} verified source cards")
    print(f"Validated {total} exact artwork files, hashes, dimensions and catalogue paths", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sets", nargs="+", default=["Neo1", "Neo2", "Neo3", "Neo4"])
    parser.add_argument("--workers", type=int, default=6)
    parser.add_argument("--max-width", type=int, default=640)
    parser.add_argument("--sync-catalogue", action="store_true")
    parser.add_argument("--validate-only", action="store_true")
    parser.add_argument("--download-input", action="store_true", help="Download missing set JSON from the deployed site")
    args = parser.parse_args()
    if any(not re.fullmatch(r"[A-Za-z0-9+_-]+", code) for code in args.sets):
        parser.error("Invalid set code")
    previous = read_json(MANIFEST) if MANIFEST.is_file() else {"schemaVersion": 1, "images": []}
    by_key = {row["setCode"] + ":" + row["sourceId"]: row for row in previous["images"]}
    if args.validate_only:
        validate(previous["images"], args.sets, check_catalogue=args.sync_catalogue)
        return
    sets = {}
    for code in args.sets:
        path = ROOT / f"data/cards-by-set/{code}.json"
        if not path.is_file() and args.download_input:
            response = session().get(f"https://tcghub.kr/data/cards-by-set/{code}.json", timeout=30)
            response.raise_for_status()
            value = response.json()
            if value.get("code") != code or value.get("brand") != "pokemon" or not isinstance(value.get("cards"), list):
                raise ValueError("Unexpected deployed source set identity")
            write_json(path, value)
        sets[code] = read_json(path)
        for card in sets[code]["cards"]:
            reviewed_metadata_repair(code, card)
    jobs = [(code, card) for code, data in sets.items() for card in data["cards"]]
    replacements = {code: reviewed_split_sources(code, data["cards"]) for code, data in sets.items()}
    errors = []
    done = 0
    def run(job):
        code, card = job
        return repair_one(code, card, by_key, args.max_width, replacements[code].get(card.get("url") or card.get("sourceUrl")))
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(12, args.workers))) as pool:
        futures = {pool.submit(run, job): job for job in jobs}
        for future in concurrent.futures.as_completed(futures):
            code, card = futures[future]
            try:
                key, value = future.result()
                by_key[key] = value
            except Exception as error:
                errors.append({"setCode": code, "sourceUrl": card.get("url"), "error": str(error)})
            done += 1
            if done % 20 == 0 or done == len(jobs):
                write_json(MANIFEST, {"schemaVersion": 1, "images": sorted(by_key.values(), key=lambda row: (row["setCode"], row["sourceId"])), "errors": errors})
                print(f"Artworks verified {done}/{len(jobs)}; errors={len(errors)}", flush=True)
    for code, data in sets.items():
        if any(error["setCode"] == code for error in errors):
            print(f"{code}: source JSON retained until every artwork is verified", flush=True)
            continue
        for card in data["cards"]:
            source_id = source_identity(card.get("url") or card.get("sourceUrl") or "")
            entry = by_key[code + ":" + source_id]
            card["localImage"] = entry["localImage"]
            card["imageSourceUrl"] = entry["imageSourceUrl"]
            card["currentSourceUrl"] = entry.get("canonicalSourceUrl") or entry["sourceUrl"]
        write_json(ROOT / f"data/cards-by-set/{code}.json", data)
        print(f"{code}: {len(data['cards'])} exact artwork paths restored", flush=True)
    if errors:
        print(json.dumps(errors[:10], ensure_ascii=False), flush=True)
        raise SystemExit(1)
    if args.sync_catalogue:
        sync_catalogue(by_key.values())
        write_json(MANIFEST, {"schemaVersion": 1, "images": sorted(by_key.values(), key=lambda row: (row["setCode"], row["sourceId"])), "errors": []})
    validate(by_key.values(), args.sets, check_catalogue=args.sync_catalogue)


if __name__ == "__main__":
    main()
