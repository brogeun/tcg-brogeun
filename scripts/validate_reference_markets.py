"""Offline integrity checks for published reference prices; no collection or repricing."""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta, timezone
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import sys
from urllib.parse import urlparse


class InvalidData(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise InvalidData(message)


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def price(value, label):
    require(value is None or (number(value) and value > 0), f"{label}: price must be positive finite or null/unavailable")


def count(value, label):
    require(isinstance(value, int) and not isinstance(value, bool) and value >= 0, f"{label}: invalid nonnegative count")


def stamp(value):
    if value is None:
        return None
    require(isinstance(value, str), "observation time must be ISO text")
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise InvalidData("invalid ISO observation time") from exc
    require(parsed.tzinfo is not None, "observation time must include timezone")
    return parsed.astimezone(timezone.utc)


def web_url(value, host, path_pattern=None):
    require(isinstance(value, str), f"{host}: missing source URL")
    parsed = urlparse(value)
    require(parsed.scheme == "https" and parsed.hostname in {host, "www." + host} and not parsed.username and not parsed.password,
            f"{host}: unsafe or unrelated source URL")
    if path_pattern:
        require(re.fullmatch(path_pattern, parsed.path) is not None, f"{host}: source product identity disagrees with URL")


class Validator:
    SOURCE_FILES = {"us": "/data/us-market.json", "yuyutei": "/data/yuyutei-market.json",
                    "mercari": "/data/mercari-references.json", "snkrdunk": "/data/snkrdunk-games.json"}

    def __init__(self, root, *, now=None, stale_hours=72, outcomes=None):
        self.root = Path(root).resolve()
        self.now = now or datetime.now(timezone.utc)
        self.stale_after = timedelta(hours=stale_hours)
        self.outcomes = outcomes or {}
        self.results = {}
        self.current = None
        self.invalid = False

    def safe_path(self, reference, prefix="/data/"):
        require(isinstance(reference, str) and reference.startswith(prefix) and "\\" not in reference and "%" not in reference,
                "unsafe published data path")
        parts = PurePosixPath(reference).parts
        require(".." not in parts and "." not in reference.split("/") and re.fullmatch(r"/data/[A-Za-z0-9_./-]+\.json", reference),
                "unsafe published data path")
        resolved = (self.root / reference.lstrip("/")).resolve()
        require(resolved.is_relative_to(self.root), "published data path escapes project root")
        return resolved

    def load(self, reference):
        file = self.safe_path(reference)
        require(file.is_file(), f"missing published file: {reference}")
        try:
            data = json.loads(file.read_text(encoding="utf-8-sig"), parse_constant=lambda token: (_ for _ in ()).throw(ValueError(token)))
        except (OSError, ValueError) as exc:
            raise InvalidData(f"invalid JSON: {reference}") from exc
        require(isinstance(data, dict), f"JSON object required: {reference}")
        return data

    def semantic(self, data, *, source, currency=None, kind=None):
        require(data.get("schemaVersion") == 1, "unsupported reference schema version")
        require(data.get("source") == source, "source provenance mismatch")
        if currency:
            require(data.get("currency") == currency, "source currency mismatch")
        if kind:
            require(data.get("priceKind") == kind, "source price kind mismatch")

    def observed(self, value):
        parsed = stamp(value)
        if parsed is None:
            return
        if self.current.get("oldestQuoteAt") is None or parsed < stamp(self.current["oldestQuoteAt"]):
            self.current["oldestQuoteAt"] = value
        if self.now - parsed > self.stale_after:
            self.current["stale"] = True

    def partial(self, note=None):
        self.current["status"] = "partial"
        if note and note not in self.current["notes"]:
            self.current["notes"].append(note)

    def run(self):
        for name, reference in self.SOURCE_FILES.items():
            result = {"status": "healthy", "asOf": None, "stale": False, "coverage": {}, "errors": [], "notes": []}
            self.results[name] = self.current = result
            if not self.safe_path(reference).is_file():
                result.update(status="unavailable", notes=["No published source snapshot available"])
            else:
                try:
                    getattr(self, "validate_" + name)(self.load(reference))
                except (InvalidData, TypeError, KeyError, IndexError, AttributeError) as exc:
                    self.invalid = True
                    result.update(status="unavailable", errors=[str(exc)[:280]])
            aliases = {"us": ("us", "us_market", "TCGCSV", "tcgcsv"), "yuyutei": ("yuyutei", "yuyu"),
                       "mercari": ("mercari",), "snkrdunk": ("snkrdunk", "snkr")}[name]
            outcome = next((self.outcomes[key] for key in aliases if key in self.outcomes), None)
            if isinstance(outcome, dict):
                outcome = outcome.get("outcome", outcome.get("status", outcome.get("conclusion")))
            if outcome is not None:
                result["refreshOutcome"] = str(outcome)
            if outcome in {"failure", "failed", "cancelled", "timed_out", "error"} and result["status"] != "unavailable":
                result["stale"] = True
                self.partial("Refresh failed; original last-good observation times retained")
            if result["stale"] and result["status"] == "healthy":
                self.partial("Source includes retained or aged observations")
        states = [result["status"] for result in self.results.values()]
        status = "healthy" if all(state == "healthy" for state in states) else "unavailable" if all(state == "unavailable" for state in states) else "partial"
        return {"schemaVersion": 1, "generatedAt": self.now.isoformat().replace("+00:00", "Z"), "status": status, "sources": self.results}

    def validate_us(self, manifest):
        self.semantic(manifest, source="TCGCSV", currency="USD")
        require(manifest.get("language", "en") == "en", "US source must remain English")
        self.current["asOf"] = manifest.get("sourceAsOf")
        stamp(self.current["asOf"])
        coverage = manifest.get("coverage", {})
        require(isinstance(coverage, dict) and isinstance(manifest.get("sets"), list), "invalid US manifest coverage/sets")
        self.current["coverage"] = coverage
        seen, matched, priced, quotes, sealed_total, stale_sets = set(), 0, 0, 0, 0, 0
        for entry in manifest["sets"]:
            code = entry.get("code")
            require(isinstance(code, str) and re.fullmatch(r"EN-[A-Za-z0-9_-]+", code), "invalid English set code")
            require(code not in seen, "duplicate US set code")
            seen.add(code)
            require(entry.get("file") == f"/data/us-market/{code}.json", "US shard path/set mismatch")
            data = self.load(entry["file"])
            self.semantic(data, source="TCGCSV", currency="USD")
            require(data.get("setCode") == code and data.get("language", "en") == "en", "US shard set/language mismatch")
            cards, sealed = data.get("cards", {}), data.get("sealed", [])
            require(isinstance(cards, dict) and isinstance(sealed, list), "invalid US card/sealed collections")
            observed = data.get("sourceAsOf")
            if cards or sealed:
                require(observed is not None, "priced US shard lacks original observation time")
                self.observed(observed)
            if entry.get("status") in {"unmapped", "ambiguous"}:
                require(not cards and not sealed, "unmapped US set contains inferred products")
                self.partial("Some English sets have no verified provider mapping")
            if entry.get("status") == "stale" or data.get("stale"):
                stale_sets += 1
                self.current["stale"] = True
            set_quotes, set_priced, product_ids = 0, 0, set()
            for source_id, card in cards.items():
                require(str(source_id).isdigit(), "invalid English source card ID")
                require("psa10" not in card and "psa9" not in card and "grade" not in card,
                        "US ungraded reference must not replace PSA fields")
                require(card.get("sourcePrinting", "unspecified") == "unspecified", "US catalog printing must not be inferred")
                item_quotes, has_price = self.us_product(card)
                require(str(card["productId"]) not in product_ids, "US provider product mapped to multiple catalog identities")
                product_ids.add(str(card["productId"]))
                set_quotes += item_quotes
                set_priced += int(has_price)
            for item in sealed:
                require(item.get("kind") == "sealed", "US sealed product kind missing or incorrect")
                self.us_product(item)
            declared_matched = data.get("coverage", {}).get("matchedCards", len(cards))
            count(declared_matched, "US matched cards")
            unavailable_matches = data.get("coverage", {}).get("matchedWithoutPrice", 0)
            require(declared_matched == len(cards) + unavailable_matches, "US matched-without-price coverage disagrees with cards")
            for key, actual in (("matchedCount", declared_matched), ("pricedCount", set_priced), ("printingCount", set_quotes), ("sealedCount", len(sealed))):
                if key in entry:
                    require(entry[key] == actual, f"US {code} {key} disagrees with shard")
            require(entry.get("matchedCount", len(cards)) <= entry.get("cardCount", len(cards)), "US matched count exceeds catalog size")
            matched += declared_matched
            priced += set_priced
            quotes += set_quotes
            sealed_total += len(sealed)
        for key, actual in (("catalogSets", len(seen)), ("matchedCards", matched), ("pricedCards", priced), ("printingQuotes", quotes), ("sealedProducts", sealed_total), ("staleSets", stale_sets)):
            if key in coverage:
                require(coverage[key] == actual, f"US manifest {key} disagrees with shards")

    def us_product(self, item):
        require(isinstance(item, dict) and str(item.get("productId", "")).isdigit(), "invalid TCGplayer product ID")
        product_id = str(item["productId"])
        web_url(item.get("sourceUrl"), "tcgplayer.com", rf"/product/{re.escape(product_id)}(?:/[^\s]*)?")
        require(not any(key in item for key in ("price", "marketPrice", "lastSalePrice")), "US price flattened across printings")
        printings = item.get("printings", {})
        require(isinstance(printings, dict), "US printings must be a mapping")
        quote_count, has_price = 0, False
        for printing, quote in printings.items():
            require(isinstance(printing, str) and printing and isinstance(quote, dict), "invalid US printing quote")
            require(quote.get("subTypeName") == printing, "US printing key/subTypeName mismatch")
            require(quote.get("currency") == "USD" and quote.get("priceKind") == "market_estimate", "US quote currency/kind mismatch")
            require(quote.get("listingPriceKind") == "asking_price" and quote.get("conditionScope") == "ungraded provider aggregate",
                    "US ask or condition scope changed")
            require(quote.get("isLastCompletedSale") is False and "PSA" not in printing.upper(), "US estimate promoted to graded/completed sale")
            for field in ("marketPrice", "lowPrice", "midPrice", "highPrice", "directLowPrice"):
                price(quote.get(field), f"US {field}")
            quote_count += 1
            has_price = has_price or any(quote.get(field) is not None for field in ("marketPrice", "lowPrice", "midPrice", "highPrice", "directLowPrice"))
        return quote_count, has_price

    def validate_yuyutei(self, manifest):
        self.semantic(manifest, source="yuyutei", currency="JPY", kind="asking")
        require(isinstance(manifest.get("games"), list), "invalid Yuyutei game manifest")
        self.current["asOf"] = manifest.get("sourceAsOf")
        stamp(self.current["asOf"])
        if manifest.get("cooldown"):
            cooldown = manifest["cooldown"]
            require(isinstance(cooldown, dict), "invalid shop cooldown provenance")
            stamp(cooldown.get("observedAt"))
            stamp(cooldown.get("nextEligibleAt"))
            self.current["cooldown"] = {field: cooldown[field] for field in ("httpStatus", "observedAt", "nextEligibleAt", "retryAfterSeconds") if field in cooldown}
            self.partial("Source rate limit; earlier valid observations and pending coverage retained")
        games, records_total, collected, discovered, partial_product_sets = set(), 0, 0, 0, 0
        for game in manifest["games"]:
            key, source_game = game.get("game"), game.get("sourceGame")
            require(isinstance(key, str) and re.fullmatch(r"[a-z0-9_]+", key) and key not in games, "invalid/duplicate Yuyutei game")
            require(isinstance(source_game, str) and re.fullmatch(r"[a-z0-9_-]+", source_game), "invalid Yuyutei source game")
            games.add(key)
            require(game.get("shard") == f"/data/yuyutei-market/{key}.json", "Yuyutei game shard path mismatch")
            data = self.load(game["shard"])
            self.semantic(data, source="yuyutei", currency="JPY", kind="asking")
            require(data.get("game") == key and data.get("sourceGame") == source_game and data.get("language") == "ja", "Yuyutei game identity mismatch")
            columns, rows, sets = data.get("columns"), data.get("rows"), data.get("sets")
            require(isinstance(columns, list) and len(columns) == len(set(columns)) and isinstance(rows, list) and isinstance(sets, list), "invalid Yuyutei compact index")
            required = {"sourceSetCode", "sourceProductId", "cardNumber", "price", "stock", "stockState", "sourceAsOf", "purchasable"}
            require(required.issubset(columns), "Yuyutei compact index lacks identity/quote columns")
            compact = {}
            for row in rows:
                require(isinstance(row, list) and len(row) == len(columns), "Yuyutei compact row width mismatch")
                item = dict(zip(columns, row))
                identity = (item["sourceSetCode"], str(item["sourceProductId"]))
                require(identity not in compact, "duplicate Yuyutei exact source product ID")
                self.yuyu_quote(item)
                compact[identity] = item
            detail_ids, set_ids = set(), set()
            for entry in sets:
                code = entry.get("sourceSetCode")
                require(isinstance(code, str) and re.fullmatch(r"[A-Za-z0-9_.-]+", code) and code not in set_ids, "invalid/duplicate Yuyutei source set")
                set_ids.add(code)
                require(code not in {".", ".."}, "unsafe Yuyutei set code")
                if not entry.get("shard") and not entry.get("recordCount") and not any(identity[0] == code for identity in compact):
                    self.partial("Discovered shop sets are pending their first collection")
                    continue
                require(entry.get("shard") == f"/data/yuyutei-market/{key}/{code}.json", "Yuyutei set shard path mismatch")
                detail_path = self.safe_path(entry["shard"])
                if not detail_path.is_file() and entry.get("status") in {"failed", "pending", "deferred"} and not entry.get("recordCount"):
                    self.partial("Some shop sets are explicitly unavailable or pending")
                    continue
                detail = self.load(entry["shard"])
                self.semantic(detail, source="yuyutei", currency="JPY", kind="asking")
                require(detail.get("game") == key and detail.get("sourceGame") == source_game and detail.get("sourceSetCode") == code,
                        "Yuyutei set identity mismatch")
                require(isinstance(detail.get("records"), list), "invalid Yuyutei set records")
                if entry.get("status") != "ok":
                    if entry.get("status") in {"failed", "stale", "previous-retained-after-error"} or entry.get("error"):
                        self.partial("Some shop sets retain earlier successful observations")
                        self.current["stale"] = True
                    else:
                        self.partial("Some shop sets contain verified product observations only")
                for item in detail["records"]:
                    require(item.get("source") == "yuyutei" and item.get("game") == key and item.get("sourceSetCode") == code,
                            "Yuyutei product provenance mismatch")
                    identity = (code, str(item.get("sourceProductId")))
                    require(identity in compact and identity not in detail_ids, "Yuyutei detail product missing/duplicated in compact index")
                    detail_ids.add(identity)
                    expected_id = f"yuyutei:{source_game}:{code}:{identity[1]}"
                    require(item.get("id") == expected_id, "Yuyutei exact ID changed")
                    require(item.get("sourceUrl") == f"https://yuyu-tei.jp/sell/{source_game}/card/{code}/{identity[1]}", "Yuyutei source URL does not match product")
                    require(item.get("currency") == "JPY" and item.get("priceKind") == "asking" and item.get("grade") == "raw", "shop ask promoted to graded/sale quote")
                    self.yuyu_quote(item)
                    for field in ("cardNumber", "price", "stock", "stockState", "sourceAsOf", "purchasable"):
                        require(item.get(field) == compact[identity].get(field), f"Yuyutei compact/detail {field} mismatch")
                    for point in item.get("history", []):
                        price(point.get("price"), "Yuyutei history")
                        stamp(point.get("sourceAsOf"))
                if "recordCount" in entry:
                    require(entry["recordCount"] == len(detail["records"]), "Yuyutei set count mismatch")
            require(detail_ids == set(compact), "Yuyutei compact products lack their exact set detail")
            if "recordCount" in game:
                require(game["recordCount"] == len(rows), "Yuyutei manifest record count mismatch")
            coverage = game.get("coverage", {})
            for field in ("discoveredSets", "collectedSets", "failedSets", "pendingSets"):
                if field in coverage:
                    count(coverage[field], "Yuyutei " + field)
            if game.get("status") != "ok" or coverage.get("pendingSets", 0) or coverage.get("failedSets", 0):
                self.partial("Shop coverage is incomplete; unavailable prices are not inferred")
            records_total += len(rows)
            collected += coverage.get("collectedSets", 0)
            discovered += coverage.get("discoveredSets", 0)
            partial_product_sets += coverage.get("partialProductSets", 0)
        if manifest.get("status") != "ok":
            self.partial()
        self.current["coverage"] = {"games": len(games), "records": records_total, "collectedSets": collected, "discoveredSets": discovered, "partialProductSets": partial_product_sets}

    def yuyu_quote(self, item):
        require(isinstance(item.get("sourceSetCode"), str) and re.fullmatch(r"[A-Za-z0-9_.-]+", item["sourceSetCode"]), "invalid shop set identity")
        require(str(item.get("sourceProductId", "")).isdigit(), "invalid exact shop product ID")
        price(item.get("price"), "Yuyutei")
        stock, state, purchasable = item.get("stock"), item.get("stockState"), item.get("purchasable")
        require(state in {"in_stock", "out_of_stock", "in_stock_quantity_unknown", "unknown"}, "invalid shop stock state")
        require(stock is None or (isinstance(stock, int) and not isinstance(stock, bool) and stock >= 0), "invalid shop stock quantity")
        require(purchasable is None or isinstance(purchasable, bool), "invalid shop purchasable state")
        if state == "in_stock":
            require(stock is not None and stock > 0 and purchasable is True, "known shop stock contradicts availability")
        elif state == "in_stock_quantity_unknown":
            require(stock is None and purchasable is True, "unknown shop quantity was invented")
        elif state == "out_of_stock":
            require(stock in (0, None) and purchasable is False, "out-of-stock quote marked purchasable")
        else:
            require(stock is None and purchasable is not True, "unknown shop stock promoted to available")
        require(item.get("sourceAsOf") is not None, "shop quote lacks original observation time")
        self.observed(item["sourceAsOf"])

    def validate_mercari(self, data):
        self.semantic(data, source="mercari")
        require(isinstance(data.get("references"), list) and isinstance(data.get("verifiedQuotes", []), list), "invalid Mercari reference arrays")
        self.current["asOf"] = data.get("updatedAt")
        stamp(self.current["asOf"])
        ids, candidates, stale = set(), 0, 0
        for item in data["references"]:
            item_id = item.get("itemId")
            require(isinstance(item_id, str) and re.fullmatch(r"m\d+", item_id), "invalid Mercari item ID")
            require(item.get("id") == "mercari:" + item_id and item_id not in ids, "duplicate/mismatched Mercari identity")
            ids.add(item_id)
            web_url(item.get("sourceUrl"), "jp.mercari.com", rf"/item/{item_id}/?")
            state, verification = item.get("saleStatus"), item.get("verification")
            require(state in {"unknown", "active", "sold"}, "invalid Mercari sale status")
            require(verification in {"unverified", "verified_exact"}, "invalid Mercari verification state")
            require(isinstance(item.get("valuationEligible"), bool), "Mercari valuation eligibility missing")
            if state == "unknown" or verification != "verified_exact":
                require(item["valuationEligible"] is False, "unknown/unverified Mercari candidate promoted to valuation")
                candidates += 1
            if state != "sold":
                require(not item.get("soldAt"), "Mercari sold time inferred without confirmed sold status")
            quote = item.get("price")
            if quote is not None:
                require(isinstance(quote, dict) and quote.get("currency") == "JPY", "Mercari native price currency mismatch")
                price(quote.get("amount"), "Mercari")
                if quote.get("amount") is not None:
                    require(item.get("observedAt") is not None, "Mercari displayed price lacks actual observation time")
            require(item.get("priceBasis", "displayed_listing_price") == "displayed_listing_price", "Mercari listing promoted to completed sale")
            self.observed(item.get("observedAt"))
            if item.get("stale") or item.get("fetchStatus") == "error":
                stale += 1
                self.current["stale"] = True
        for quote in data.get("verifiedQuotes", []):
            require(quote.get("verification") == "verified_exact" and quote.get("saleStatus") != "unknown" and quote.get("valuationEligible") is True,
                    "Mercari verified quote lacks explicit exact verification")
        coverage = data.get("coverage", {})
        if "trackedCount" in coverage:
            require(coverage["trackedCount"] == len(ids), "Mercari tracked count mismatch")
        if "verifiedQuoteCount" in coverage:
            require(coverage["verifiedQuoteCount"] == len(data.get("verifiedQuotes", [])), "Mercari verified count mismatch")
        self.current["coverage"] = {"tracked": len(ids), "unverifiedCandidates": candidates, "verifiedQuotes": len(data.get("verifiedQuotes", [])), "staleReferences": stale,
                                    "discovery": coverage.get("discovery", "unknown")}
        if candidates or coverage.get("discovery") == "manual_urls":
            self.partial("Watchlist candidates; not an exhaustive market or canonical valuation feed")

    def validate_snkrdunk(self, manifest):
        self.semantic(manifest, source="SNKRDUNK")
        require(isinstance(manifest.get("games"), list), "invalid SNKRDUNK games")
        self.current["asOf"] = manifest.get("fetchedAt")
        stamp(self.current["asOf"])
        games, products_total, graded = set(), 0, 0
        for game in manifest["games"]:
            key = game.get("id")
            require(isinstance(key, str) and re.fullmatch(r"[a-z0-9_]+", key) and key not in games, "invalid/duplicate SNKRDUNK game")
            games.add(key)
            if game.get("listingComplete") is not True:
                self.partial("Catalog pagination is partial")
            for kind in ("card", "box"):
                reference = game.get(kind + "Url")
                require(reference == f"/data/price-{key}-{kind}.json", "SNKRDUNK snapshot path/game mismatch")
                data = self.load(reference)
                self.semantic(data, source="SNKRDUNK", currency="USD")
                require(data.get("brand") == key and data.get("kind") == kind and isinstance(data.get("products"), list), "SNKRDUNK snapshot provenance mismatch")
                if "count" in data:
                    require(data["count"] == len(data["products"]), "SNKRDUNK base product count mismatch")
                products = list(data["products"])
                shard_paths = data.get("shards", [])
                require(isinstance(shard_paths, list) and len(shard_paths) == len(set(shard_paths)), "invalid/duplicate SNKRDUNK shard paths")
                for shard_path in shard_paths:
                    require(isinstance(shard_path, str) and re.fullmatch(rf"/data/snkrdunk-games/{re.escape(key)}-{kind}-\d{{4}}\.json", shard_path), "unsafe SNKRDUNK chunk identity/path")
                    shard = self.load(shard_path)
                    self.semantic(shard, source="SNKRDUNK")
                    require(shard.get("brand") == key and shard.get("kind") == kind and isinstance(shard.get("products"), list), "SNKRDUNK chunk provenance mismatch")
                    require(shard.get("count") == len(shard["products"]), "SNKRDUNK chunk count mismatch")
                    products.extend(shard["products"])
                if "totalCount" in data:
                    require(data["totalCount"] == len(products), "SNKRDUNK complete sharded total count mismatch")
                ids = set()
                if data.get("collection", {}).get("complete") is not True:
                    self.partial("One or more catalog listings are incomplete")
                for item in products:
                    product_id = str(item.get("id", ""))
                    require(product_id.isdigit() and product_id not in ids, "invalid/duplicate SNKRDUNK product ID")
                    ids.add(product_id)
                    require(item.get("brand") == key and item.get("kind") == kind and item.get("currency") == "USD", "SNKRDUNK product provenance mismatch")
                    web_url(item.get("url"), "snkrdunk.com", rf"/(?:apparels|en/trading-cards)/{product_id}/?")
                    price(item.get("minPrice"), "SNKRDUNK catalog")
                    self.observed(item.get("priceCheckedAt", data.get("fetchedAt")))
                    ask = item.get("catalogAsk", {})
                    require(ask.get("kind") == "lowest_listing_ask" and ask.get("condition") == "unspecified", "SNKRDUNK catalog ask promoted to condition/last sale")
                    price(ask.get("amount"), "SNKRDUNK native ask")
                    if ask.get("amount") is not None:
                        require(ask.get("currency") in {"USD", "JPY", "KRW"}, "unsupported native SNKRDUNK currency")
                    for grade, quote in item.get("grades", {}).items():
                        require(grade in {"raw", "psa10", "psa9"}, "unknown SNKRDUNK graded quote")
                        require(quote.get("currency") == "JPY" and quote.get("price_kind") == "lowest_listing_ask", "SNKRDUNK grade currency/kind mismatch")
                        price(quote.get("lowest_ask"), "SNKRDUNK grade ask")
                        if quote.get("active_count") is not None:
                            count(quote["active_count"], "SNKRDUNK active listings")
                        if quote.get("availability") == "no-listing":
                            require(quote.get("lowest_ask") is None, "SNKRDUNK no-listing state has an invented ask")
                        if quote.get("chart_latest_price") is not None:
                            price(quote["chart_latest_price"], "SNKRDUNK chart")
                            require(quote.get("chart_price_kind") == "recorded_trade_chart" and number(quote.get("chart_latest_at")), "SNKRDUNK chart provenance/time missing")
                    if item.get("grades"):
                        graded += 1
                        self.observed(item.get("gradeCheckedAt"))
                    if item.get("gradeStatus") == "previous-retained-after-error":
                        self.current["stale"] = True
                    if item.get("historyUrl"):
                        require(item["historyUrl"] == f"/data/snkrdunk-history/{product_id}.json", "SNKRDUNK history identity mismatch")
                        self.load(item["historyUrl"])
                if kind + "Count" in game:
                    require(game[kind + "Count"] == len(ids), "SNKRDUNK manifest product count mismatch")
                products_total += len(ids)
        self.current["coverage"] = {"games": len(games), "products": products_total, "gradeCheckedProducts": graded}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", default=".")
    parser.add_argument("--output", default="data/reference-market-health.json")
    parser.add_argument("--stale-hours", type=float, default=72)
    args = parser.parse_args(argv)
    try:
        require(math.isfinite(args.stale_hours) and args.stale_hours > 0, "stale-hours must be positive")
        outcomes = json.loads(os.environ.get("REFERENCE_SOURCE_OUTCOMES", "{}"))
        require(isinstance(outcomes, dict), "REFERENCE_SOURCE_OUTCOMES must be a JSON object")
        validator = Validator(args.root, stale_hours=args.stale_hours, outcomes=outcomes)
        report = validator.run()
        output = Path(args.output)
        if not output.is_absolute():
            output = validator.root / output
        output = output.resolve()
        require(output.is_relative_to(validator.root) and output.suffix == ".json", "health output must be a JSON path within root")
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary = output.with_suffix(output.suffix + ".tmp")
        temporary.write_text(json.dumps(report, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
        temporary.replace(output)
        print(json.dumps({"status": report["status"], "invalid": validator.invalid,
                          "sources": {name: row["status"] for name, row in report["sources"].items()},
                          "errors": {name: row["errors"] for name, row in report["sources"].items() if row["errors"]}}, ensure_ascii=False))
        return 1 if validator.invalid else 0
    except (InvalidData, OSError, ValueError) as exc:
        print(f"Reference market validation failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
