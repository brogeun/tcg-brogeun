"""Bounded anonymous refresh of search listing asks, preserving catalogue metadata.

Does not fetch graded charts, use cookies, deploy, or change transaction history.
The first three cards-prices array fields remain compatible with the existing UI;
the appended timestamp/status describe each product's successful listing check.
"""
from __future__ import annotations

import argparse
import copy
import json
import math
import os
import re
import shutil
import tempfile
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

BRANDS = ("pokemon", "onepiece")
ORDERS = ("popular", "new")
META_FIELDS = ("id", "name", "productNumber", "thumbnailUrl", "releasedAt", "brand", "kind")
UTC = timezone.utc


class RefreshError(RuntimeError):
    """No current search dataset should be promoted after this failure."""


def parse_time(value):
    try:
        result = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
        if result.tzinfo is None:
            raise ValueError("timezone required")
        return result.astimezone(UTC)
    except (TypeError, ValueError) as exc:
        raise RefreshError("Invalid dated exchange-rate evidence") from exc


def fx_basis(document, now):
    """Require recent collection and a recent actual business-day close."""
    if not isinstance(document, dict):
        raise RefreshError("Missing exchange-rate document")
    updated = parse_time(document.get("updated"))
    if not timedelta(0) <= now - updated <= timedelta(hours=72):
        raise RefreshError("Exchange rates must have been checked within 72 hours")
    try:
        as_of = date.fromisoformat(document["asOf"])
    except (KeyError, TypeError, ValueError) as exc:
        raise RefreshError("Missing actual exchange-rate close date") from exc
    kst_day = now.astimezone(timezone(timedelta(hours=9))).date()
    if not 0 <= (kst_day - as_of).days <= 5:
        raise RefreshError("Exchange-rate business-day close is more than 5 days old")
    rates = document.get("rates", {})
    for currency in ("USD", "JPY"):
        value = rates.get(currency)
        if type(value) not in (int, float) or not math.isfinite(value) or value <= 0:
            raise RefreshError("Missing positive finite KRW-per-unit exchange rate: " + currency)
    return {"source": document.get("source"), "updated": document["updated"],
            "asOf": document["asOf"], "basis": document.get("basis"),
            "rates": {key: rates[key] for key in ("USD", "JPY")},
            "rateUnit": "KRW per 1 source-currency unit", "outputCurrency": "USD"}


def listing_price(row, basis):
    value = row.get("minPrice")
    display = str(row.get("minPriceFormat") or "").strip()
    declared = row.get("currency")
    source_currency = None
    missing_display = re.fullmatch(r"(₩|[¥￥]|US\s*\$|USD|\$)\s*(?:-{1,2}|[—–])", display)
    if missing_display:
        prefix = missing_display.group(1)
        source_currency = "KRW" if prefix == "₩" else "JPY" if prefix in ("¥", "￥") else "USD"
    elif re.match(r"^₩\s*[\d,]+(?:\.\d+)?(?:~)?$", display):
        source_currency = "KRW"
    elif re.match(r"^[¥￥]\s*[\d,]+(?:\.\d+)?(?:~)?$", display):
        source_currency = "JPY"
    elif re.match(r"^(?:US\s*\$|USD\s*|\$)\s*[\d,]+(?:\.\d+)?(?:~)?$", display):
        source_currency = "USD"
    elif display and display not in ("-", "--"):
        raise RefreshError("Unrecognized listing price currency")
    if declared is not None and declared != source_currency:
        raise RefreshError("Listing currency declaration and display disagree")
    if value in (None, ""):
        return None, source_currency
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        raise RefreshError("Listing price must be a nonnegative finite number")
    if value == 0:
        return None, source_currency
    if missing_display:
        raise RefreshError("Positive listing price has a no-price display marker")
    if source_currency is None:
        raise RefreshError("Positive listing price lacks verified currency display")
    # A currency symbol alone cannot establish that the display belongs to value.
    shown = re.sub(r"^(?:US\s*\$|USD\s*|[$₩¥￥])\s*", "", display).rstrip("~").replace(",", "")
    if not math.isclose(float(shown), float(value), rel_tol=0, abs_tol=0.011):
        raise RefreshError("Listing numeric price and formatted price disagree")
    usd = value
    if source_currency == "KRW":
        usd = value / basis["rates"]["USD"]
    elif source_currency == "JPY":
        usd = value * basis["rates"]["JPY"] / basis["rates"]["USD"]
    if not math.isfinite(usd) or usd <= 0:
        raise RefreshError("Invalid normalized USD listing price")
    normalized = round(usd, 2)
    if normalized <= 0:
        raise RefreshError("Positive listing price is smaller than output precision")
    return normalized, source_currency


class PublicClient:
    def __init__(self, interval=1.0, attempts=3, max_seconds=1800,
                 opener=urllib.request.urlopen, clock=time.monotonic, sleep=time.sleep):
        if interval < 1 or not 1 <= attempts <= 3 or not 1 <= max_seconds <= 3600:
            raise RefreshError("Use interval >=1 second, 1..3 attempts, runtime <=3600 seconds")
        self.interval, self.attempts, self.max_seconds = interval, attempts, max_seconds
        self.opener, self.clock, self.sleep = opener, clock, sleep
        self.started = clock()
        self.last_request = None
        self.requests = 0
        self.page_attempts = {}

    def remaining(self):
        left = self.max_seconds - (self.clock() - self.started)
        if left <= 0:
            raise RefreshError("Search refresh runtime limit reached; previous files retained")
        return left

    def get(self, brand, order, page, per_page):
        url = ("https://snkrdunk.com/en/v1/trading-cards"
               f"?brandId={brand}&categoryId=25&page={page}&perPage={per_page}&order={order}")
        for attempt in range(self.attempts):
            if self.page_attempts.get(url, 0) >= self.attempts:
                raise RefreshError("Per-page request budget exhausted (maximum 3 actual attempts)")
            left = self.remaining()
            wait = max(0, self.interval - (self.clock() - self.last_request)) if self.last_request is not None else 0
            if wait >= left:
                raise RefreshError("Search refresh runtime limit reached")
            self.sleep(wait)
            self.remaining()
            headers = {
                "User-Agent": "TCGHUB-search-refresh/1.0 (+https://tcghub.kr)",
                "Accept": "application/json", "Accept-Language": "en-US,en;q=0.9",
                "Referer": "https://snkrdunk.com/en/",
            }
            if self.page_attempts.get(url, 0):
                # Revalidate the same public page on a retry; keep its URL and budget.
                headers.update({"Cache-Control": "no-cache", "Pragma": "no-cache"})
            request = urllib.request.Request(url, headers=headers)
            self.last_request = self.clock()
            self.requests += 1
            self.page_attempts[url] = self.page_attempts.get(url, 0) + 1
            try:
                with self.opener(request, timeout=min(20, self.remaining())) as response:
                    status = response.getcode()
                    if status in (403, 429):
                        raise RefreshError(f"HTTP {status}: stopped without replacing any search files")
                    if status != 200:
                        raise RefreshError("Unexpected listing HTTP status " + str(status))
                    # urllib redirects are followed, but never trust a different host.
                    if not response.geturl().startswith("https://snkrdunk.com/"):
                        raise RefreshError("Unexpected listing redirect")
                    raw = response.read(8_000_001)
                    if len(raw) > 8_000_000:
                        raise RefreshError("Listing page exceeds byte limit")
                self.remaining()
                try:
                    result = json.loads(raw.decode("utf-8"))
                except (ValueError, UnicodeError) as exc:
                    raise RefreshError("Invalid listing JSON") from exc
                return result
            except urllib.error.HTTPError as exc:
                if exc.code in (403, 429):
                    raise RefreshError(f"HTTP {exc.code}: stopped without replacing any search files") from exc
                if exc.code < 500 or self.page_attempts[url] >= self.attempts:
                    raise RefreshError("Listing HTTP failure " + str(exc.code)) from exc
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                if self.page_attempts[url] >= self.attempts:
                    raise RefreshError("Listing transport failure: " + type(exc).__name__) from exc
        raise RefreshError("Listing attempts exhausted")


def collect_stream(get_page, brand, order, basis, per_page=100, max_pages=500, now=None):
    if not 1 <= per_page <= 100 or not 1 <= max_pages <= 500:
        raise RefreshError("Invalid listing page bounds")
    found, fingerprints, repeated_retries = {}, set(), 0
    for page in range(1, max_pages + 1):
        context = f"brand={brand} order={order} page={page}"
        for page_attempt in range(1, 4):
            cid = None
            try:
                payload = get_page(brand, order, page, per_page)
                if not isinstance(payload, dict) or not isinstance(payload.get("tradingCards"), list):
                    raise RefreshError("Listing schema lacks tradingCards array")
                rows = payload["tradingCards"]
                if len(rows) > per_page:
                    raise RefreshError("Listing response exceeds requested page size")
                if not rows:
                    if not found:
                        raise RefreshError("Empty brand listing without meaningful progress")
                    print(f"[search] {context} rows=0 unique={len(found)} terminal=empty-page", flush=True)
                    return found, {"brand": brand, "order": order, "pages": page,
                                   "products": len(found), "terminal": "empty-page", "repeatedPageRetries": repeated_retries}
                page_ids, page_records = [], {}
                checked_at = (now or (lambda: datetime.now(UTC)))().astimezone(UTC).isoformat()
                for row in rows:
                    if not isinstance(row, dict):
                        raise RefreshError("Invalid listing row")
                    cid = str(row.get("id", ""))
                    if not re.fullmatch(r"[1-9][0-9]{0,19}", cid):
                        raise RefreshError("Invalid numeric listing product ID")
                    if row.get("brand") not in (None, brand) or row.get("brandId") not in (None, brand):
                        raise RefreshError("Listing brand mismatch")
                    if row.get("categoryId") not in (None, 25, "25"):
                        raise RefreshError("Listing category mismatch")
                    if row.get("kind") not in (None, "card", "single", "single-card"):
                        raise RefreshError("Unexpected non-card listing")
                    if not isinstance(row.get("name"), str) or not row["name"].strip():
                        raise RefreshError("Listing product name is missing")
                    count = row.get("listingCount")
                    if count is not None and not ((type(count) is int and count >= 0) or
                                                  (isinstance(count, str) and re.fullmatch(r"[0-9]+\+?", count))):
                        raise RefreshError("Invalid listing count")
                    value, source_currency = listing_price(row, basis)
                    if value is not None and count in (0, "0"):
                        raise RefreshError("Positive listing price with zero listings")
                    if cid in page_records:
                        raise RefreshError("Duplicate product ID within listing page")
                    page_ids.append(cid)
                    page_records[cid] = {"id": cid, "brand": brand, "kind": "card",
                                          **{key: row.get(key) or "" for key in META_FIELDS if key not in ("id", "brand", "kind")},
                                          "minPrice": value, "currency": "USD", "listingCount": count,
                                          "priceCheckedAt": checked_at,
                                          "priceStatus": ("available" if value is not None else
                                                          "no-listings" if count in (0, "0") else "price-unavailable"),
                                          "priceSource": {"type": "listing-ask", "originalPrice": row.get("minPrice"),
                                                          "originalCurrency": source_currency, "url":
                                                          "https://snkrdunk.com/en/v1/trading-cards"
                                                          f"?brandId={brand}&categoryId=25&page={page}&perPage={per_page}&order={order}"}}
                fingerprint = tuple(sorted(page_ids))
                new_ids = len(set(page_ids) - found.keys())
                if fingerprint in fingerprints or new_ids == 0:
                    reason = ("Repeated listing page or no new IDs; traversal incomplete"
                              f" attempt={page_attempt}/3 rows={len(rows)} firstId={page_ids[0]} lastId={page_ids[-1]}")
                    if page_attempt == 3:
                        raise RefreshError(reason)
                    repeated_retries += 1
                    print(f"::warning::[search] {context} {reason}; retrying SAME page, never skipping", flush=True)
                    continue
                break
            except (RefreshError, ValueError, TypeError) as error:
                raise RefreshError(f"{context} rowId={cid} {error}") from error
        # Rejected repeated pages never mutate accepted products/provenance.
        found.update(page_records)
        fingerprints.add(fingerprint)
        if page == 1 or page % 25 == 0:
            print(f"[search] {context} rows={len(rows)} unique={len(found)}", flush=True)
        if len(rows) < per_page:
            print(f"[search] {context} short-page rows={len(rows)}; checking NEXT page for explicit empty terminal", flush=True)
    raise RefreshError(f"brand={brand} order={order} page={max_pages} Listing page limit reached before terminal page")


def build_documents(old, basis, get_page, per_page=100, max_pages=500, now=None):
    now = now or (lambda: datetime.now(UTC))
    if not isinstance(old, dict) or not isinstance(old.get("details"), list):
        raise RefreshError("Existing catalogue details are required")
    previous = {}
    for row in old["details"]:
        if not isinstance(row, dict) or not str(row.get("id", "")).isdigit():
            raise RefreshError("Invalid existing catalogue ID")
        cid = str(row["id"])
        if cid in previous:
            raise RefreshError("Duplicate existing catalogue ID")
        previous[cid] = row
    fetched, streams = {}, []
    for brand in BRANDS:
        brand_rows = {}
        for order in ORDERS:
            rows, stream = collect_stream(get_page, brand, order, basis, per_page, max_pages, now)
            brand_rows.update(rows)
            streams.append(stream)
        old_count = sum(row.get("brand") == brand and row.get("kind", "card") == "card"
                        for row in previous.values())
        if not brand_rows or len(brand_rows) < old_count * .8:
            raise RefreshError("Brand catalogue shrank below 80%; previous search files retained: " + brand)
        for cid, row in brand_rows.items():
            if cid in fetched or cid in previous and previous[cid].get("brand") != brand:
                raise RefreshError("Product ID conflicts between brands")
            fetched[cid] = row
    completed = now().astimezone(UTC).isoformat()
    details = []
    counts = {brand: {"checked": 0, "available": 0, "no-listings": 0,
                      "price-unavailable": 0, "not-listed": 0} for brand in BRANDS}
    for cid, original in previous.items():
        row = copy.deepcopy(original)
        if cid in fetched:
            fresh = fetched.pop(cid)
            if original.get("kind", "card") != "card":
                raise RefreshError("Public single-card ID conflicts with preserved product kind")
            # Preserve names, identifiers, artwork and other user-owned metadata.
            for field in ("minPrice", "currency", "listingCount", "priceCheckedAt", "priceStatus", "priceSource"):
                row[field] = fresh[field]
        elif row.get("brand") in BRANDS and row.get("kind", "card") == "card":
            row.update(minPrice=None, listingCount=None, priceStatus="not-listed", priceCheckedAt=completed)
            row["priceSource"] = {"type": "listing-ask", "status": "absent-from-completed-public-listing"}
        details.append(row)
    details.extend(fetched[cid] for cid in sorted(fetched, key=int))
    for row in details:
        brand = row.get("brand")
        if brand in BRANDS and row.get("kind", "card") == "card":
            counts[brand]["checked"] += 1
            counts[brand][row["priceStatus"]] += 1
    output = copy.deepcopy(old)
    cards = [str(row["id"]) for row in details if row.get("kind", "card") == "card"]
    boxes = [str(row["id"]) for row in details if row.get("kind") == "box"]
    summary = {"source": "SNKRDUNK public category-25 listing asks", "completedAt": completed,
               "complete": True, "streams": streams, "countsByBrand": counts,
               "absencePolicy": "preserve metadata; unavailable price and count become null",
               "currencyNormalization": basis}
    output.update(fetchedAt=completed, details=details, cards=sorted(cards), boxes=sorted(boxes),
                  all=sorted(str(row["id"]) for row in details),
                  byBrand={brand: sorted(str(row["id"]) for row in details if row.get("brand") == brand)
                           for brand in dict.fromkeys([*old.get("byBrand", {}), *BRANDS])},
                  searchPriceRefresh=summary)
    meta, prices = [], {}
    for row in details:
        cid = str(row["id"])
        meta.append({key: cid if key == "id" else row.get(key) or ("card" if key == "kind" else "")
                     for key in META_FIELDS})
        prices[cid] = [row.get("minPrice"), row.get("currency") or "USD", row.get("listingCount"),
                       row.get("priceCheckedAt"), row.get("priceStatus", "unverified")]
    return {"all-cards.json": output,
            "cards-meta.json": {"fetchedAt": completed, "cards": meta},
            "cards-prices.json": {"fetchedAt": completed, "prices": prices,
                                  "priceArrayFields": ["minPrice", "currency", "listingCount", "priceCheckedAt", "priceStatus"],
                                  "searchPriceRefresh": summary}}


def promote_documents(data_dir, documents, expected, replace=os.replace):
    """Stage, validate and retain exact backup bytes before replacing three files."""
    data_dir = Path(data_dir)
    if set(documents) != {"all-cards.json", "cards-meta.json", "cards-prices.json"}:
        raise RefreshError("Unexpected search output set")
    stage = Path(tempfile.mkdtemp(prefix=".search-price-stage-", dir=data_dir))
    replaced, backups, staged = [], {}, {}
    keep_stage = False
    try:
        for name, payload in documents.items():
            current = data_dir / name
            original = current.read_bytes() if current.exists() else None
            if original != expected.get(name):
                raise RefreshError("Search data changed during refresh; refusing to overwrite: " + name)
            backups[name] = original
            if original is not None:
                (stage / ("previous-" + name)).write_bytes(original)
            raw = (json.dumps(payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n").encode("utf-8")
            staged[name] = stage / name
            staged[name].write_bytes(raw)
            json.loads(staged[name].read_bytes())
        # Check again immediately before promotion to protect unrelated edits.
        for name in documents:
            current = data_dir / name
            if (current.read_bytes() if current.exists() else None) != backups[name]:
                raise RefreshError("Search data changed before promotion: " + name)
        try:
            for name in documents:
                replace(staged[name], data_dir / name)
                replaced.append(name)
        except OSError as exc:
            restore_errors = []
            for name in reversed(replaced):
                try:
                    if backups[name] is None:
                        (data_dir / name).unlink()
                    else:
                        replace(stage / ("previous-" + name), data_dir / name)
                except OSError as restore_error:
                    restore_errors.append(name + ": " + str(restore_error))
            if restore_errors:
                keep_stage = True
                raise RefreshError("Promotion and restoration failed; backups retained at " + str(stage)
                                   + ": " + "; ".join(restore_errors)) from exc
            raise RefreshError("Promotion failed; exact original search bytes restored") from exc
    finally:
        if not keep_stage:
            shutil.rmtree(stage)


def refresh(data_dir, client, now=None, per_page=100, max_pages=500):
    data_dir = Path(data_dir)
    now = now or (lambda: datetime.now(UTC))
    names = ("all-cards.json", "cards-meta.json", "cards-prices.json")
    original = {name: (data_dir / name).read_bytes() if (data_dir / name).exists() else None for name in names}
    if original["all-cards.json"] is None:
        raise RefreshError("Existing all-cards.json is required")
    basis = fx_basis(json.loads((data_dir / "fx-rates.json").read_bytes()), now())
    documents = build_documents(json.loads(original["all-cards.json"]), basis, client.get,
                                per_page=per_page, max_pages=max_pages, now=now)
    client.remaining()
    promote_documents(data_dir, documents, original)
    return documents["all-cards.json"]["searchPriceRefresh"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=Path(__file__).resolve().parents[1] / "data")
    parser.add_argument("--delay", type=float, default=1.0, help="Seconds between every request attempt (minimum 1)")
    parser.add_argument("--max-pages", type=int, default=500)
    parser.add_argument("--max-seconds", type=int, default=1800)
    args = parser.parse_args()
    if not 1 <= args.max_pages <= 500:
        parser.error("max-pages must be 1..500")
    try:
        client = PublicClient(interval=args.delay, max_seconds=args.max_seconds)
        result = refresh(args.data_dir, client, max_pages=args.max_pages)
        print(json.dumps({"status": "passed", "requests": client.requests, **result}, ensure_ascii=True))
        return 0
    except (RefreshError, OSError, ValueError) as exc:
        print("Search price refresh failed: " + str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
