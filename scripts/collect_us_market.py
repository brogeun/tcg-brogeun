"""Collect separate English Pokemon market references from public TCGCSV snapshots.

Existing English catalog identities and PriceCharting PSA10 files are read-only.
No credentials, browser automation, archives, or transaction claims are involved.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import html
import json
import math
import os
from pathlib import Path
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://tcgcsv.com"
USER_AGENT = "TCGHubMarketCollector/1.0 (+https://tcghub.kr; public price references)"
POLICY_VERSION = "us-market-20261029-2"
PRINTINGS = {"Normal", "Holofoil", "Reverse Holofoil", "1st Edition", "1st Edition Holofoil", "Unlimited", "Unlimited Holofoil"}
SEALED = re.compile(r"\b(?:elite trainer box|booster (?:box|pack|bundle|display)|\d+-pack blister|\d+-player starter set|theme deck|ultra-premium collection|premium collection|poster collection|binder collection|mini tin|collection box)\b", re.I)
SET_ALIASES = {
    "scarlet and violet base set": "scarlet and violet",
    "sword and shield base set": "sword and shield",
    "sm base set": "sun and moon",
    "xy base set": "xy",
    "heartgold soulsilver": "heartgold and soulsilver",
    "expedition": "expedition base set",
    "mega evolution promo": "mega evolution promos",
    "scarlet and violet promo cards": "scarlet and violet promos",
    "sword and shield promo cards": "sword and shield promos",
    "sm promos": "sun and moon promos",
    "hgss promos": "heartgold and soulsilver promos",
    "wotc promo": "wizards of the coast promos",
}
NAME_ALIASES = {
    "nidoran f": "nidoran-f", "nidoran ♀": "nidoran-f", "nidoran♀": "nidoran-f",
    "nidoran m": "nidoran-m", "nidoran ♂": "nidoran-m", "nidoran♂": "nidoran-m",
    "imposter professor oak": "impostor professor oak",
}
# Reviewed 2026-10-29 against complete TCGCSV group products. Each tuple pins
# group ID, BOTH source release dates, and the minimum exact card-identity anchors.
# Names must still uniquely agree; no general release-date tolerance is permitted.
REVIEWED_DATE_OVERRIDES = {
    'EN-TCG11673': (24451, '2025-09-13', '2025-09-26', 73),
    'EN-TCG11508': (22872, '2023-01-01', '2023-03-31', 151),
    'EN-TCG1180': (1861, '2016-10-31', '2016-12-14', 108),
    'EN-TCG1179': (1451, '2013-09-30', '2013-12-16', 106),
    'EN-TCG1178': (1407, '2011-03-01', '2011-04-25', 60),
    'EN-TCG1146': (1381, '2010-11-02', '2010-11-03', 90),
    'EN-TCG1140': (1367, '2009-05-20', '2009-05-16', 96),
    'EN-TCG1131': (1383, '2007-02-14', '2007-02-01', 89),
    'EN-TCG1122': (1428, '2004-11-08', '2004-11-01', 94),
    'EN-TCG1117': (1392, '2003-09-17', '2003-09-18', 93),
    'EN-TCG116': (1441, '2000-08-14', '2000-10-14', 84),
    'EN-TCG1189': (1446, '2009-03-01', '2026-10-28', 17),
    'EN-TCG1188': (1450, '2008-09-01', '2026-10-28', 17),
    'EN-TCG1187': (1414, '2008-03-01', '2026-10-28', 17),
    'EN-TCG1186': (1432, '2007-09-01', '2026-10-28', 14),
    'EN-TCG1185': (1439, '2007-03-01', '2026-10-28', 7),
    'EN-TCG1184': (1452, '2006-08-01', '2026-10-28', 13),
    'EN-TCG1183': (1442, '2006-04-01', '2026-10-28', 16),
    'EN-TCG1182': (1447, '2005-08-01', '2026-10-28', 16),
    'EN-TCG1181': (1422, '2004-09-01', '2026-10-28', 15),
}
RARITY_COMPATIBILITY = {
    ("holo rare v", "ultra rare"), ("rare holo ex", "ultra rare"),
    ("holo rare vmax", "ultra rare"), ("rare holo lv.x", "ultra rare"),
    ("holo rare vstar", "ultra rare"), ("rare secret", "secret rare"),
    ("secret rare", "rare secret"),
}


def now():
    return datetime.now(timezone.utc).isoformat()


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return default


def atomic_json(path, payload):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    os.replace(temporary, path)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def name(value):
    text = unicodedata.normalize("NFKC", html.unescape(str(value or "")))
    text = text.replace("’", "'").replace("‘", "'")
    text = re.sub(r"\s+", " ", text).strip().casefold()
    # Explicit provider spelling aliases; retain every other word and suffix.
    text = text.replace("pokémon", "pokemon").replace("pokédex", "pokedex")
    return NAME_ALIASES.get(text, text)


def set_name(value):
    text = name(value).replace("&", " and ")
    text = re.sub(r"^(?:sv|swsh|me|mee|sve)\d*\s*:\s*", "", text)
    text = re.sub(r"^(?:sm|xy)\s*-\s*", "", text)
    # Keep words such as Shadowless, Trainer Gallery and Classic Collection.
    text = re.sub(r"[():]", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    return SET_ALIASES.get(text, text)


def number(value):
    value = unicodedata.normalize("NFKC", str(value or "")).strip().upper()
    parts = []
    for part in value.split("/"):
        match = re.fullmatch(r"([A-Z]*)(\d+)([A-Z]*)", part)
        parts.append(match[1] + str(int(match[2])) + match[3] if match else part)
    return "/".join(parts)


def rarity(value):
    text = name(value)
    return "holo rare" if text == "rare holo" else text


def compatible_rarity(source, target):
    source, target = rarity(source), rarity(target)
    return bool(source and target and (source == target or (source, target) in RARITY_COMPATIBILITY))


def field(product, key):
    entries = [str(entry.get("value", "")) for entry in product.get("extendedData", []) if entry.get("name") == key]
    return entries[0] if len(entries) == 1 else ""


def product_name(product):
    text = str(product.get("name", ""))
    match = re.search(r"(?:\s+-\s+|\s+)([A-Za-z]*\d+[A-Za-z]*(?:/[A-Za-z]*\d+[A-Za-z]*)?)$", text)
    if match and number(match[1]) == number(field(product, "Number")):
        return text[:match.start()]
    return text


def kind(product):
    if field(product, "Number"):
        return "card"
    if field(product, "Rarity"):
        return "unknown"
    return "sealed" if SEALED.search(str(product.get("name", ""))) else "unknown"


def trusted_product_url(product):
    pid = str(product.get("productId", ""))
    url = str(product.get("url", ""))
    return url if pid.isdigit() and re.fullmatch(r"https://www\.tcgplayer\.com/product/" + pid + r"(?:/[A-Za-z0-9%._~-]+)?", url) else None


def map_sets(sets, groups):
    by_signature = defaultdict(list)
    for group in groups:
        if group.get("categoryId") != 3 or not isinstance(group.get("groupId"), int):
            continue
        date = str(group.get("publishedOn", ""))[:10]
        by_signature[(set_name(group.get("name")), date)].append(group)
    result = {}
    group_users = defaultdict(list)
    for entry in sets:
        signature = (set_name(entry.get("name")), str(entry.get("release", "")).replace(".", "-")[:10])
        candidates = by_signature.get(signature, []) if all(signature) else []
        override = None
        if not candidates and entry["code"] in REVIEWED_DATE_OVERRIDES:
            reviewed = REVIEWED_DATE_OVERRIDES[entry["code"]]
            same_name = [group for group in groups if group.get("categoryId") == 3 and set_name(group.get("name")) == signature[0]]
            if len(same_name) == 1 and signature[1] == reviewed[1] and same_name[0].get("groupId") == reviewed[0] and str(same_name[0].get("publishedOn", ""))[:10] == reviewed[2]:
                candidates, override = same_name, reviewed
        if len(candidates) == 1:
            result[entry["code"]] = {"status": "mapped", "group": candidates[0], "method": "reviewed-date-override+exact-card-anchors" if override else "reviewed-name-normalization+exact-release+unique"}
            if override:
                result[entry["code"]]["override"] = {"catalogRelease": override[1], "providerRelease": override[2], "minimumMatchedCards": override[3]}
            group_users[candidates[0]["groupId"]].append(entry["code"])
        else:
            result[entry["code"]] = {"status": "ambiguous" if candidates else "unmapped", "reason": "multiple-provider-set-candidates" if candidates else "no-exact-reviewed-name-and-release-match"}
    for codes in group_users.values():
        if len(codes) > 1:
            for code in codes:
                result[code] = {"status": "ambiguous", "reason": "provider-group-shared-by-multiple-catalog-sets"}
    return result


def positive(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0


def printing_quotes(rows, product_id):
    by_printing = defaultdict(list)
    for row in rows:
        if str(row.get("productId")) == str(product_id):
            by_printing[row.get("subTypeName")].append(row)
    quotes, rejected = {}, Counter()
    for printing, matches in by_printing.items():
        if printing not in PRINTINGS:
            rejected["unsupported-printing"] += 1
            continue
        if len(matches) != 1:
            rejected["ambiguous-printing"] += 1
            continue
        row = matches[0]
        if row.get("currency", "USD") != "USD":
            rejected["conflicting-currency"] += 1
            continue
        values = {key: row.get(key) if positive(row.get(key)) else None for key in ("marketPrice", "lowPrice", "midPrice", "highPrice", "directLowPrice")}
        if not any(value is not None for value in values.values()):
            rejected["no-positive-price"] += 1
            continue
        quotes[printing] = {**values, "currency": "USD", "priceKind": "market_estimate", "listingPriceKind": "asking_price", "conditionScope": "ungraded provider aggregate", "subTypeName": printing, "isLastCompletedSale": False}
    return quotes, rejected


def build_shard(catalog, group, products, prices, source_as_of, captured_at):
    code = catalog["code"]
    if catalog.get("language") != "en" or not isinstance(catalog.get("cards"), list):
        raise ValueError("Wrong English catalog shape/language")
    if any(product.get("categoryId") != 3 or product.get("groupId") != group["groupId"] for product in products):
        raise ValueError("Provider product escaped requested category/group")
    ids = [str(product.get("productId")) for product in products]
    if any(not pid.isdigit() for pid in ids) or len(ids) != len(set(ids)):
        raise ValueError("Invalid or duplicate provider product identity")
    by_number = defaultdict(list)
    prices_by_id = defaultdict(list)
    for row in prices:
        if not isinstance(row, dict):
            raise ValueError("Malformed provider price row")
        prices_by_id[str(row.get("productId"))].append(row)
    for product in products:
        if kind(product) == "card":
            by_number[number(field(product, "Number"))].append(product)
    output, rejected, statuses = {}, Counter(), Counter()
    unmatched = []
    seen_source_ids = set()
    for card in catalog["cards"]:
        source_id = str(card.get("sourceId", ""))
        if not source_id or card.get("setCode") != code or card.get("language") != "en" or source_id in seen_source_ids:
            raise ValueError("Invalid catalog card identity or set namespace")
        seen_source_ids.add(source_id)
        matches = [product for product in by_number.get(number(card.get("number")), [])
                   if name(card.get("name")) == name(product_name(product)) and trusted_product_url(product)]
        if len(matches) != 1:
            status = "ambiguous" if matches else "unmatched"
            statuses[status] += 1
            if len(unmatched) < 40:
                unmatched.append({"sourceId": source_id, "number": card.get("number"), "name": card.get("name"), "reason": status})
            continue
        product = matches[0]
        if not compatible_rarity(card.get("rarity"), field(product, "Rarity")):
            statuses["unmatched"] += 1
            if len(unmatched) < 40:
                unmatched.append({"sourceId": source_id, "number": card.get("number"), "name": card.get("name"), "reason": "rarity-conflict-or-unspecified"})
            continue
        statuses["matched"] += 1
        quotes, failures = printing_quotes(prices_by_id[str(product["productId"])], product["productId"])
        rejected.update(failures)
        if not quotes:
            statuses["matched-no-positive-price"] += 1
            continue
        output[source_id] = {"productId": str(product["productId"]), "sourceUrl": product["url"], "number": card["number"], "name": card["name"], "rarity": card.get("rarity"), "sourcePrinting": "unspecified", "printings": quotes}
    sealed = []
    for product in products:
        if kind(product) != "sealed" or not trusted_product_url(product):
            continue
        quotes, failures = printing_quotes(prices_by_id[str(product["productId"])], product["productId"])
        rejected.update(failures)
        if quotes:
            sealed.append({"productId": str(product["productId"]), "name": product["name"], "sourceUrl": product["url"], "kind": "sealed", "printings": quotes})
    return {"schemaVersion": 1, "policyVersion": POLICY_VERSION, "source": "TCGCSV", "upstreamMarket": "TCGplayer", "currency": "USD", "language": "en", "setCode": code, "sourceAsOf": source_as_of, "generatedAt": captured_at, "providerGroupId": group["groupId"], "providerGroupName": group["name"], "cards": output, "sealed": sorted(sealed, key=lambda product: product["productId"]), "coverage": {"catalogCards": len(catalog["cards"]), "matchedCards": statuses["matched"], "pricedCards": len(output), "unmatchedCards": statuses["unmatched"], "ambiguousCards": statuses["ambiguous"], "matchedWithoutPrice": statuses["matched-no-positive-price"], "printingQuotes": sum(len(card["printings"]) for card in output.values()), "sealedCount": len(sealed), "rejectedPrices": dict(rejected), "unmatchedSample": unmatched}}


class Provider:
    def __init__(self, cache_dir, offline=False, force=False, interval=0.1):
        self.cache = Path(cache_dir)
        self.offline, self.force = offline, force
        self.interval = max(0.1, interval)
        self.previous_request = 0.0
        self.requests = 0
        self.provenance = []

    def request(self, url):
        time.sleep(max(0.0, self.interval - (time.monotonic() - self.previous_request)))
        self.requests += 1
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "application/json,text/plain;q=0.9"})
            with urllib.request.urlopen(req, timeout=30) as response:
                raw = response.read(8_000_001)
                if response.status != 200 or len(raw) > 8_000_000:
                    raise ValueError("Provider HTTP status or resource size invalid")
                return raw
        finally:
            self.previous_request = time.monotonic()

    def version(self):
        path = self.cache / "provider-version.json"
        cached = read_json(path)
        if self.offline:
            if not cached:
                raise ValueError("Offline provider version unavailable")
            return cached["version"], cached["sourceAsOf"]
        raw = self.request(BASE + "/last-updated.txt")
        token = raw.decode("utf-8").strip()
        parsed = datetime.fromisoformat(token.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("Provider snapshot lacks timezone")
        source_as_of = parsed.astimezone(timezone.utc).isoformat()
        atomic_json(path, {"version": token, "sourceAsOf": source_as_of, "checkedAt": now(), "sourceUrl": BASE + "/last-updated.txt"})
        return token, source_as_of

    def json(self, key, url, revision):
        path = self.cache / (key + ".json")
        metadata = self.cache / (key + ".meta.json")
        meta = read_json(metadata, {})
        raw = path.read_bytes() if path.exists() else None
        valid = raw is not None and meta.get("url") == url and meta.get("sha256") == digest(raw)
        if valid and (self.offline or not self.force and meta.get("revision") == revision):
            self.provenance.append(meta)
            return json.loads(raw)
        if self.offline:
            raise ValueError("Offline cache unavailable or corrupt: " + key)
        raw = self.request(url)
        data = json.loads(raw)
        if not isinstance(data, dict) or data.get("success") is False or not isinstance(data.get("results"), list):
            raise ValueError("Provider response lacks successful results array")
        meta = {"url": url, "revision": revision, "sha256": digest(raw), "fetchedAt": now(), "userAgent": USER_AGENT}
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".tmp")
        temporary.write_bytes(raw)
        os.replace(temporary, path)
        atomic_json(metadata, meta)
        self.provenance.append(meta)
        return data


def valid_shard(value, code):
    return isinstance(value, dict) and value.get("schemaVersion") == 1 and value.get("source") == "TCGCSV" and value.get("currency") == "USD" and value.get("setCode") == code and isinstance(value.get("cards"), dict) and isinstance(value.get("sealed"), list)


def empty_shard(code, source_as_of, reason):
    return {"schemaVersion": 1, "policyVersion": POLICY_VERSION, "source": "TCGCSV", "upstreamMarket": "TCGplayer", "currency": "USD", "language": "en", "setCode": code, "sourceAsOf": source_as_of, "cards": {}, "sealed": [], "status": "unmapped", "reason": reason, "coverage": {"catalogCards": 0, "matchedCards": 0, "pricedCards": 0, "unmatchedCards": 0, "ambiguousCards": 0, "printingQuotes": 0, "sealedCount": 0}}


def sync(root=ROOT, cache_dir=None, offline=False, force=False, max_groups=220):
    root = Path(root)
    cache_dir = Path(cache_dir or root / ".cache/us-market")
    previous = read_json(root / "data/us-market.json", {})
    provider = Provider(cache_dir, offline, force)
    catalog_path = root / "data/english-catalog.json"
    catalog = read_json(catalog_path)
    if not catalog or catalog.get("schemaVersion") != 1 or not isinstance(catalog.get("sets"), list):
        raise ValueError("English catalog unavailable")
    sets = catalog["sets"]
    if len({entry.get("code") for entry in sets}) != len(sets) or any(not re.fullmatch(r"EN-[A-Z0-9-]+", entry.get("code", "")) for entry in sets):
        raise ValueError("Invalid or duplicate English set code")
    fingerprint = hashlib.sha256(catalog_path.read_bytes())
    for entry in sets:
        path = root / "data/english-sets" / (entry["code"] + ".json")
        fingerprint.update(path.read_bytes())
    catalog_hash = fingerprint.hexdigest()
    run = {"startedAt": now(), "status": "running", "policyVersion": POLICY_VERSION, "networkRequests": 0, "failures": []}
    try:
        version, source_as_of = provider.version()
        run["providerVersion"] = version
        if not force and previous.get("providerVersion") == version and previous.get("catalogFingerprint") == catalog_hash and previous.get("policyVersion") == POLICY_VERSION:
            previous_entries = previous.get("sets", [])
            if len(previous_entries) == len(sets) and all(valid_shard(read_json(root / "data/us-market" / (entry["code"] + ".json")), entry["code"]) for entry in previous_entries) and not previous.get("coverage", {}).get("staleSets"):
                run.update(status="unchanged", completedAt=now(), networkRequests=provider.requests, coverage=previous.get("coverage"))
                atomic_json(cache_dir / "last-run.json", run)
                return run
        groups = provider.json("groups", BASE + "/tcgplayer/3/groups", version)["results"]
        mappings = map_sets(sets, groups)
        mapped_ids = {value["group"]["groupId"] for value in mappings.values() if value["status"] == "mapped"}
        if len(mapped_ids) > max_groups:
            raise ValueError("Mapped group count exceeds the bounded request budget")
        updates, entries = {}, []
        captured_at = now()
        previous_entries = {entry["code"]: entry for entry in previous.get("sets", [])}
        for index, entry in enumerate(sets, 1):
            code = entry["code"]
            old = read_json(root / "data/us-market" / (code + ".json"))
            mapping = mappings[code]
            stale = False
            if mapping["status"] != "mapped":
                if valid_shard(old, code) and old.get("cards"):
                    shard, stale = old, True
                    run["failures"].append({"code": code, "reason": "mapping-conflict; previous good data retained"})
                else:
                    shard = empty_shard(code, source_as_of, mapping["reason"])
                    updates[code] = shard
            else:
                group = mapping["group"]
                try:
                    source = read_json(root / "data/english-sets" / (code + ".json"))
                    if not source or source.get("code") != code or len(source.get("cards", [])) != entry["cardCount"]:
                        raise ValueError("Catalog card count or set identity mismatch")
                    gid = group["groupId"]
                    products = provider.json(f"products-{gid}", f"{BASE}/tcgplayer/3/{gid}/products", str(group.get("modifiedOn") or version))["results"]
                    prices = provider.json(f"prices-{gid}", f"{BASE}/tcgplayer/3/{gid}/prices", version)["results"]
                    if not products or not prices:
                        raise ValueError("Empty provider catalog or prices; previous data retained")
                    shard = build_shard(source, group, products, prices, source_as_of, captured_at)
                    if mapping.get("override") and shard["coverage"]["matchedCards"] < mapping["override"]["minimumMatchedCards"]:
                        raise ValueError("Reviewed date override lost its exact card-identity anchor minimum")
                    shard["sourceUrls"] = [f"{BASE}/tcgplayer/3/{gid}/products", f"{BASE}/tcgplayer/3/{gid}/prices"]
                    shard["mapping"] = {"method": mapping["method"], "catalogName": entry["name"], "catalogAbbreviation": entry.get("displayCode"), "providerName": group["name"], "providerAbbreviation": group.get("abbreviation"), "release": str(entry.get("release", "")).replace(".", "-")}
                    if mapping.get("override"):
                        shard["mapping"]["reviewedDateOverride"] = mapping["override"]
                    updates[code] = shard
                except (OSError, ValueError, KeyError, TypeError) as error:
                    run["failures"].append({"code": code, "reason": str(error)[:240]})
                    if valid_shard(old, code):
                        shard, stale = old, True
                    else:
                        shard = empty_shard(code, None, "provider-unavailable")
                        shard["status"] = "unavailable"
                        updates[code] = shard
                        stale = True
            coverage = shard.get("coverage", {})
            entries.append({"code": code, "name": entry["name"], "file": "/data/us-market/" + code + ".json", "cardCount": entry["cardCount"], "matchedCount": coverage.get("matchedCards", 0), "pricedCount": len(shard["cards"]), "sealedCount": len(shard["sealed"]), "printingCount": coverage.get("printingQuotes", 0), "sourceAsOf": shard.get("sourceAsOf"), "status": "stale" if stale else mapping["status"], "reason": shard.get("reason")})
            if index % 20 == 0 or index == len(sets):
                print(f'US market: {index}/{len(sets)} sets; {provider.requests} requests; {len(run["failures"])} retained/failures', flush=True)
        if not offline:
            ending_version, _ = provider.version()
            if ending_version != version:
                raise ValueError("Provider changed snapshot during collection; no output data published")
        coverage = {"catalogSets": len(sets), "catalogCards": sum(entry["cardCount"] for entry in sets), "mappedSets": sum(entry["status"] == "mapped" for entry in entries), "unmappedSets": sum(entry["status"] in ("unmapped", "ambiguous") for entry in entries), "staleSets": sum(entry["status"] == "stale" for entry in entries), "matchedCards": sum(entry["matchedCount"] for entry in entries), "pricedCards": sum(entry["pricedCount"] for entry in entries), "printingQuotes": sum(entry["printingCount"] for entry in entries), "sealedProducts": sum(entry["sealedCount"] for entry in entries)}
        available_dates = [entry["sourceAsOf"] for entry in entries if entry["sourceAsOf"] and (entry["pricedCount"] or entry["sealedCount"])]
        manifest = {"schemaVersion": 1, "policyVersion": POLICY_VERSION, "source": "TCGCSV", "upstreamMarket": "TCGplayer", "currency": "USD", "language": "en", "generatedAt": now(), "sourceAsOf": min(available_dates) if available_dates else source_as_of, "providerSourceAsOf": source_as_of, "providerVersion": version, "catalogFingerprint": catalog_hash, "status": "partial-provider-failure" if run["failures"] else "complete-for-mapped-sets", "priceKind": "ungraded_market_reference", "coverage": coverage, "sets": entries}
        for code, shard in updates.items():
            atomic_json(root / "data/us-market" / (code + ".json"), shard)
        atomic_json(root / "data/us-market.json", manifest)
        run.update(status=manifest["status"], completedAt=now(), coverage=coverage, networkRequests=provider.requests, sourceRequests=provider.provenance)
        atomic_json(cache_dir / "last-run.json", run)
        return run
    except (OSError, ValueError, KeyError, TypeError) as error:
        run.update(status="failed-kept-previous" if previous.get("sets") else "failed-no-published-data", completedAt=now(), error=str(error)[:500], networkRequests=provider.requests)
        atomic_json(cache_dir / "last-run.json", run)
        if previous.get("sets"):
            return run
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--cache-dir", type=Path)
    parser.add_argument("--offline", action="store_true")
    parser.add_argument("--force", action="store_true")
    parser.add_argument("--max-groups", type=int, default=220)
    args = parser.parse_args()
    try:
        result = sync(args.root, args.cache_dir, args.offline, args.force, args.max_groups)
        print(json.dumps({key: result.get(key) for key in ("status", "coverage", "networkRequests", "error")}, ensure_ascii=False))
    except (OSError, ValueError, KeyError, TypeError) as error:
        print("US market not published: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
