#!/usr/bin/env python3
"""Collect original Yuyutei sell listings, with bounded rotation and last-good data.

Python stdlib only. Source sets and product IDs come from public listing markup;
no product-ID enumeration, account, proxy, cart action, or third-party feed is used.
Prices are JPY shop asking prices, never completed sales or buylist prices.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import datetime as dt
import email.utils
import json
import os
import re
import sys
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
BASE = "https://yuyu-tei.jp"
GAMES = {
    "pokemon": ("poc", "포켓몬"),
    "onepiece": ("opc", "원피스"),
    "weiss_schwarz": ("ws", "바이스슈발츠"),
    "union_arena": ("ua", "유니온아레나"),
    "digimon": ("digi", "디지몬"),
}
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}
SET_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{0,60}$")
INDEX_COLUMNS = ["sourceSetCode", "sourceProductId", "setCode", "cardNumber", "rarity", "name",
                 "price", "stock", "stockState", "sourceAsOf", "purchasable",
                 "notObservedInLatestSnapshot", "stale", "fetchStatus"]
REQUIRED_INDEX_COLUMNS = INDEX_COLUMNS[:11]


class SourceDeferred(Exception):
    def __init__(self, reason, attempted=False):
        super().__init__(reason)
        self.attempted = attempted


class RateLimiter:
    def __init__(self, requests_per_second, max_requests=250, cooldown=None):
        self.interval = 1 / requests_per_second
        self.next_request = 0.0
        self.lock = threading.Lock()
        self.max_requests = max_requests
        self.request_count = 0
        self.cooldown = cooldown if cooldown and cooldown.get("nextEligibleAt", "") > utc_now() else None

    def wait(self):
        with self.lock:
            if self.cooldown:
                raise SourceDeferred("source_cooldown_until:" + self.cooldown["nextEligibleAt"])
            if self.max_requests and self.request_count >= self.max_requests:
                raise SourceDeferred("daily_original_source_request_budget_exhausted")
            delay = max(0, self.next_request - time.monotonic())
            if delay:
                time.sleep(delay)
            self.next_request = time.monotonic() + self.interval
            self.request_count += 1

    def record_rate_limit(self, url, retry_after=None, fallback_seconds=900, http_status=429):
        with self.lock:
            if self.cooldown:
                return
            now = dt.datetime.now(dt.timezone.utc)
            seconds = fallback_seconds
            provenance = "conservative_default"
            if retry_after:
                try:
                    seconds = max(1, int(retry_after))
                    provenance = "original_retry_after_header"
                except ValueError:
                    try:
                        seconds = max(1, int((email.utils.parsedate_to_datetime(retry_after) - now).total_seconds()))
                        provenance = "original_retry_after_header"
                    except (TypeError, ValueError):
                        pass
            self.cooldown = {"httpStatus": http_status, "blockReason": "access_denied" if http_status == 403 else "rate_limited",
                             "sourceUrl": url, "observedAt": now.isoformat(timespec="seconds").replace("+00:00", "Z"),
                             "retryAfterSeconds": seconds, "retryAfterPolicy": provenance,
                             "nextEligibleAt": (now + dt.timedelta(seconds=seconds)).isoformat(timespec="seconds").replace("+00:00", "Z")}


class Node:
    __slots__ = ("tag", "attrs", "children", "parent")

    def __init__(self, tag, attrs=(), parent=None):
        self.tag, self.attrs, self.children, self.parent = tag, dict(attrs), [], parent

    def has(self, name):
        return name in self.attrs.get("class", "").split()

    def text(self):
        return " ".join(" ".join(child.text() if isinstance(child, Node) else child
                                 for child in self.children).split())

    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Node):
                yield from child.walk()

    def first(self, predicate):
        return next((node for node in self.walk() if predicate(node)), None)


class DOM(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("root")
        self.current = self.root

    def handle_starttag(self, tag, attrs):
        node = Node(tag, attrs, self.current)
        self.current.children.append(node)
        if tag not in VOID:
            self.current = node

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag not in VOID:
            self.handle_endtag(tag)

    def handle_endtag(self, tag):
        cursor = self.current
        while cursor.parent is not None:
            if cursor.tag == tag:
                self.current = cursor.parent
                return
            cursor = cursor.parent

    def handle_data(self, text):
        # JS/CSS is irrelevant and can dwarf the card data.
        if self.current.tag not in ("script", "style"):
            self.current.children.append(text)


def document(text):
    parser = DOM()
    parser.feed(text)
    return parser.root


def utc_now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def normalize(value):
    return unicodedata.normalize("NFKC", str(value or "")).strip()


def safe_set_url(source_game, source_set):
    if source_game not in {value[0] for value in GAMES.values()} or not SET_RE.fullmatch(source_set):
        raise ValueError("Invalid discovered source game/set")
    return f"{BASE}/sell/{source_game}/s/{urllib.parse.quote(source_set, safe='.-')}"


def discover_sets(text, game):
    """The public advanced-search checkboxes enumerate all actual source sets."""
    source_game = GAMES[game][0]
    root = document(text)
    labels = {node.attrs.get("for"): node.text() for node in root.walk() if node.tag == "label"}
    sets = {}
    for node in root.walk():
        if node.tag != "input" or node.attrs.get("name") != "vers[]":
            continue
        code = node.attrs.get("value", "")
        if not SET_RE.fullmatch(code):
            continue
        sets.setdefault(code, {"sourceSetCode": code, "name": labels.get(node.attrs.get("id"), code),
                               "url": safe_set_url(source_game, code)})
    highlights = []
    pattern = re.compile(rf"^/sell/{re.escape(source_game)}/s/([a-z0-9.-]+)$")
    for node in root.walk():
        if node.tag != "a":
            continue
        parsed = urllib.parse.urlparse(urllib.parse.urljoin(BASE, node.attrs.get("href", "")))
        match = pattern.fullmatch(parsed.path)
        if parsed.netloc == "yuyu-tei.jp" and match and match[1] in sets and match[1] not in highlights:
            highlights.append(match[1])
    return list(sets.values()), highlights


def scope_ancestor(node):
    cursor = node.parent
    while cursor is not None:
        if cursor.has("cards-list"):
            return cursor
        cursor = cursor.parent
    return None


def stock_details(block):
    label = block.first(lambda node: node.tag == "label" and node.has("cart_sell_zaiko"))
    text = label.text() if label else ""
    quantity = re.search(r"在庫\s*[:：]\s*([0-9]+)\s*点", text)
    stock = int(quantity[1]) if quantity else None
    if block.has("sold-out") or stock == 0 or re.search(r"[×✕✖]|在庫なし|品切れ|売り切れ", text):
        return 0, "out_of_stock", False, text
    if stock is not None:
        return stock, "in_stock", True, text
    if re.search(r"[○◯〇]", text):
        return None, "in_stock_quantity_unknown", True, text
    return None, "unknown", None, text


def canonical_set(game, source_set, card_number):
    if game == "union_arena":
        return card_number.split("/", 1)[0].split("-", 1)[0] or source_set
    if game in ("onepiece", "digimon"):
        # Reprints retain the source set so an old number in a new product stays separate.
        return source_set.upper()
    if game == "weiss_schwarz" and "/" in card_number:
        return card_number.rsplit("-", 1)[0]
    return source_set.upper()


def parse_listing(text, game, requested_set, observed_at):
    """Read complete set card blocks; recommendation carousels are excluded."""
    source_game = GAMES[game][0]
    root = document(text)
    records, diagnostics = {}, Counter()
    pattern = re.compile(rf"^/sell/{re.escape(source_game)}/card/([a-z0-9.-]+)/([0-9]+)$")
    for block in root.walk():
        if not block.has("card-product"):
            continue
        section = scope_ancestor(block)
        if section is None:
            continue
        diagnostics["scopedBlocks"] += 1
        anchors = [node for node in block.walk() if node.tag == "a"]
        product = None
        for anchor in anchors:
            parsed = urllib.parse.urlparse(urllib.parse.urljoin(BASE, anchor.attrs.get("href", "")))
            match = pattern.fullmatch(parsed.path)
            if parsed.scheme == "https" and parsed.netloc == "yuyu-tei.jp" and match:
                product = (match[1], match[2], f"{BASE}{parsed.path}")
                break
        if product is None:
            diagnostics["missingOriginalProductLink"] += 1
            continue
        source_set, product_id, source_url = product
        if source_set != requested_set:
            diagnostics["differentSetBlock"] += 1
            continue
        inputs = {node.attrs.get("class", ""): node.attrs.get("value")
                  for node in block.walk() if node.tag == "input"}
        condition = next((value for classes, value in inputs.items() if "cart_kizu" in classes.split()), "0")
        if condition != "0":
            diagnostics["damagedConditionExcluded"] += 1
            continue
        heading = block.first(lambda node: node.tag == "h4")
        art = block.first(lambda node: node.tag == "img" and "card.yuyu-tei.jp/" in node.attrs.get("src", ""))
        price_node = block.first(lambda node: node.tag == "strong" and "円" in node.text())
        number_node = next((node for node in block.children
                            if isinstance(node, Node) and node.tag == "span" and node.text()), None)
        name = heading.text() if heading else ""
        number = normalize(number_node.text() if number_node else "")
        alt = art.attrs.get("alt", "").strip() if art else ""
        rarity = ""
        if number and alt.startswith(number):
            tail = alt[len(number):].strip()
            rarity = tail.split(None, 1)[0] if tail else ""
        if not rarity:
            group = section.first(lambda node: node.tag == "h3")
            badge = group.first(lambda node: node.tag == "span" and node.text()) if group else None
            rarity = badge.text() if badge else ""
        if not number and alt:
            number = normalize(alt.split(None, 1)[0])
        if not name or not number or not rarity:
            diagnostics["missingIdentityFields"] += 1
            continue
        price_match = re.search(r"([0-9][0-9,]*)\s*円", price_node.text()) if price_node else None
        price = int(price_match[1].replace(",", "")) if price_match else None
        if price is not None and price <= 0:
            price = None
        stock, stock_state, purchasable, stock_text = stock_details(block)
        if price is None:
            purchasable = False if stock == 0 else None
        identity = f"yuyutei:{source_game}:{source_set}:{product_id}"
        records[identity] = {
            "id": identity, "game": game, "language": "ja", "grade": "raw",
            "setCode": canonical_set(game, source_set, number), "sourceSetCode": source_set,
            "sourceProductId": product_id, "cardNumber": number,
            # Same card number AND rarity can still have multiple parallel artworks.
            "rarity": rarity, "variant": f"{rarity} {name}", "name": name,
            "source": "yuyutei", "sourceUrl": source_url,
            "image": art.attrs.get("src", "") if art else "",
            "price": price, "currency": "JPY", "priceKind": "asking",
            "stock": stock, "stockState": stock_state, "purchasable": purchasable,
            "stockText": stock_text, "sourceAsOf": observed_at, "fetchedAt": observed_at,
            "history": [],
        }
    diagnostics["parsedProducts"] = len(records)
    return list(records.values()), dict(diagnostics)


def merge_records(old_records, fresh_records, history_days=90, complete_snapshot=False):
    """Keep untouched/failed set rows unchanged and append by ORIGINAL product ID."""
    result = {row["id"]: row for row in old_records if isinstance(row, dict) and row.get("id")}
    observed_ids = {row["id"] for row in fresh_records}
    if complete_snapshot:
        for identity in set(result) - observed_ids:
            retained = dict(result[identity])
            retained.update({"notObservedInLatestSnapshot": True, "purchasable": None,
                             "stock": None, "stockState": "unknown"})
            result[identity] = retained
    for row in fresh_records:
        old = result.get(row["id"], {})
        if old.get("sourceAsOf", "") > row.get("sourceAsOf", ""):
            continue
        row.pop("notObservedInLatestSnapshot", None)
        identity_fields = ("id", "game", "language", "sourceSetCode", "sourceProductId", "cardNumber", "variant", "grade", "currency", "priceKind")
        same_identity = all(old.get(key) == row.get(key) for key in identity_fields)
        history = list(old.get("history", [])) if same_identity else []
        day = row["sourceAsOf"][:10]
        history = [point for point in history if isinstance(point, dict) and point.get("date") != day]
        if row.get("price") is not None:
            history.append({"date": day, "price": row["price"], "stock": row["stock"],
                            "stockState": row["stockState"], "sourceAsOf": row["sourceAsOf"]})
        row["history"] = sorted(history, key=lambda point: point["date"])[-history_days:]
        result[row["id"]] = row
    return sorted(result.values(), key=lambda row: row["id"])


def choose_sets(discovered, highlights, previous, maximum, resume_hours=0):
    if maximum == 0:
        return discovered
    lookup = {row["sourceSetCode"]: row for row in discovered}
    previous_sets = {row["sourceSetCode"]: row for row in previous.get("sets", [])}
    if resume_hours:
        def recently_succeeded(row):
            old = previous_sets.get(row["sourceSetCode"], {})
            try:
                stamp = dt.datetime.fromisoformat(old["lastSuccessAt"].replace("Z", "+00:00"))
                return old.get("collectionScope", "set_listing") == "set_listing" and (dt.datetime.now(dt.timezone.utc) - stamp).total_seconds() < resume_hours * 3600
            except (KeyError, ValueError, TypeError):
                return False
        discovered = [row for row in discovered if not recently_succeeded(row)]
        lookup = {row["sourceSetCode"]: row for row in discovered}
        highlights = [code for code in highlights if code in lookup]
    # Preserve a majority of the bounded budget for sets never collected in full.
    # Product-only samples must not repeatedly lose their first listing to hot sets.
    def pending(row):
        old = previous_sets.get(row["sourceSetCode"], {})
        return not old.get("lastSuccessAt") or old.get("collectionScope") == "product_observations"
    oldest = lambda row: (previous_sets.get(row["sourceSetCode"], {}).get("lastAttemptAt", ""), list(lookup).index(row["sourceSetCode"]))
    uncollected = sorted((row for row in discovered if pending(row)), key=oldest)
    hot = [row["sourceSetCode"] for row in discovered if "NIKKE" in row.get("name", "").upper()]
    hot += [code for code in highlights if code not in hot]
    hot = list(dict.fromkeys(hot))[:max(1, maximum // 6)]
    remaining = sorted((row for row in discovered if row["sourceSetCode"] not in hot),
                       key=lambda row: (previous_sets.get(row["sourceSetCode"], {}).get("lastAttemptAt", ""),
                                        0 if row["sourceSetCode"] in highlights else 1,
                                        list(lookup).index(row["sourceSetCode"])))
    first = uncollected[:max(1, (maximum * 3 + 4) // 5)]
    selected = first + [lookup[code] for code in hot] + remaining
    selected = list({row["sourceSetCode"]: row for row in selected}.values())
    return selected[:maximum]


def read_json(path, default):
    try:
        with path.open(encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return default


def atomic_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_bytes((json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8"))
    os.replace(temporary, path)


def fetch_html(url, timeout, retries=1, limiter=None):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != "https" or parsed.netloc != "yuyu-tei.jp":
        raise ValueError("Only original yuyu-tei.jp HTTPS pages are allowed")
    for attempt in range(retries + 1):
        try:
            if limiter is not None:
                limiter.wait()
            request = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "text/html"})
            with urllib.request.urlopen(request, timeout=timeout) as response:
                final = urllib.parse.urlparse(response.url)
                if final.netloc != "yuyu-tei.jp":
                    raise ValueError("Unexpected source redirect")
                body = response.read(4_000_001)
                if len(body) > 4_000_000:
                    raise ValueError("Original listing exceeds 4 MB safety limit; partial HTML is not a complete snapshot")
                return body.decode("utf-8")
        except urllib.error.HTTPError as error:
            if error.code in (403, 429) and limiter is not None:
                limiter.record_rate_limit(url, error.headers.get("Retry-After"),
                                          fallback_seconds=86400 if error.code == 403 else 900,
                                          http_status=error.code)
                raise SourceDeferred(f"original_source_http_{error.code}_global_circuit_open", attempted=True) from error
            if error.code not in (429, 500, 502, 503, 504) or attempt == retries:
                raise
        except (OSError, TimeoutError):
            if attempt == retries:
                raise
        time.sleep(1 + attempt)
    raise RuntimeError("Source request failed")


def index_row(record, columns=None):
    return [record.get(column) for column in (columns or INDEX_COLUMNS)]


def compact_rows(data):
    """Migrate legacy columns by name without discarding any last-good quotes."""
    columns = data.get("columns", [])
    if not isinstance(columns, list) or len(columns) != len(set(columns)) or not set(REQUIRED_INDEX_COLUMNS).issubset(columns):
        return []
    return [index_row(dict(zip(columns, row))) for row in data.get("rows", [])
            if isinstance(row, list) and len(row) == len(columns)]


def recently_collected(shard, hours):
    try:
        last = dt.datetime.fromisoformat(shard["lastSuccessAt"].replace("Z", "+00:00"))
        return shard.get("collectionScope", "set_listing") == "set_listing" and bool(shard.get("records")) and (dt.datetime.now(dt.timezone.utc) - last).total_seconds() < hours * 3600
    except (KeyError, TypeError, ValueError):
        return False


def publish_manifest(args, summary):
    path = args.output_dir / "yuyutei-market.json"
    existing = read_json(path, {})
    summaries = {row["game"]: row for row in existing.get("games", [])}
    summaries[summary["game"]] = summary
    rows = [summaries[game] for game in GAMES if game in summaries]
    status = "failed" if not any(row["recordCount"] for row in rows) else "partial" if len(rows) < len(GAMES) or any(row["status"] != "ok" for row in rows) else "ok"
    limiter = getattr(args, "limiter", None)
    cooldown = getattr(limiter, "cooldown", None)
    fresh = sum(getattr(args, "_run_fresh_records", {}).values())
    run_outcome = "partial" if cooldown and fresh else "blocked" if cooldown else "refreshed" if fresh else "retained_last_good" if any(row["recordCount"] for row in rows) else "failed"
    manifest = {"schemaVersion": 1, "source": "yuyutei", "priceKind": "asking", "currency": "JPY",
                "generatedAt": utc_now(), "sourceAsOf": max((row.get("sourceAsOf") or "" for row in rows), default=None) or None,
                "status": status, "games": rows,
                "semantics": "Original Japanese shop asking prices. sourceAsOf is observation time; not a completed sale or source-published update timestamp.",
                "identity": "source + sourceGame + sourceSetCode + sourceProductId; never card number alone",
                "schedulePolicy": {"mode": "full_discovered_catalog" if args.max_sets_per_game == 0 else "bounded_stale_rotation",
                                   "maxSetsPerGame": args.max_sets_per_game, "historyDays": args.history_days,
                                   "resumeHours": args.resume_hours, "requestsPerSecond": args.requests_per_second,
                                   "maxRequests": getattr(args, "max_requests", 250)},
                "cooldown": cooldown,
                "requestsThisRun": getattr(limiter, "request_count", 0),
                "lastRun": {"outcome": run_outcome, "recordsFetched": fresh,
                            "providerRequests": getattr(limiter, "request_count", 0),
                            "httpStatus": cooldown.get("httpStatus") if cooldown else None,
                            "startedAt": getattr(args, "run_started_at", None), "reportedAt": utc_now()}}
    atomic_json(path, manifest)
    return manifest


def collect_game(game, args):
    source_game, label = GAMES[game]
    path = args.output_dir / "yuyutei-market" / f"{game}.json"
    previous = read_json(path, {})
    previous_columns = previous.get("columns", [])
    rows_by_set = {}
    for row in compact_rows(previous):
        rows_by_set.setdefault(row[0], []).append(row)
    prior_sets = {row["sourceSetCode"]: row for row in previous.get("sets", [])}
    discovery_url = f"{BASE}/top/{source_game}"
    discovery_error = None
    try:
        text = fetch_html(discovery_url, args.timeout, limiter=args.limiter)
        discovered, highlights = discover_sets(text, game)
        if not discovered:
            # Follow an actual observed set link if top page search markup changes.
            links = re.findall(rf'https://yuyu-tei.jp/sell/{source_game}/s/[a-z0-9.-]+', text)
            links = [url for url in dict.fromkeys(links) if url.rsplit("/", 1)[-1] not in {"new", "sale", "damage", "search"}]
            if not links:
                raise ValueError("No public discovered set catalog")
            text = fetch_html(links[0], args.timeout, limiter=args.limiter)
            discovered, highlights = discover_sets(text, game)
        if not discovered:
            raise ValueError("No original set checkbox catalog; retaining last good rows")
    except Exception as error:
        discovery_error = f"{type(error).__name__}: {error}"
        discovered = [{"sourceSetCode": row["sourceSetCode"], "name": row.get("name", row["sourceSetCode"]),
                       "url": safe_set_url(source_game, row["sourceSetCode"])} for row in prior_sets.values()]
        highlights = []
    selected = choose_sets(discovered, highlights, previous, args.max_sets_per_game, args.resume_hours)
    observed_at = utc_now()

    def collect_set(source_set):
        code = source_set["sourceSetCode"]
        detail_path = args.output_dir / "yuyutei-market" / game / f"{code}.json"
        old_shard = read_json(detail_path, {})
        result = dict(prior_sets.get(code, {})) | source_set
        shard_url = f"/data/yuyutei-market/{game}/{code}.json"
        if detail_path.is_file():
            result["shard"] = shard_url
        else:
            # A first collection deferred by the global circuit has no detail yet.
            result.pop("shard", None)
        if args.resume_hours and recently_collected(old_shard, args.resume_hours):
            result.update({"status": "ok", "sourceAsOf": old_shard.get("sourceAsOf"),
                           "lastSuccessAt": old_shard.get("lastSuccessAt"),
                           "recordCount": len(old_shard["records"]), "reusedRecentSnapshot": True})
            result.pop("error", None)
            return result, [index_row(row) for row in old_shard["records"]], 0
        try:
            text = fetch_html(source_set["url"], args.timeout, limiter=args.limiter)
            fetched_at = utc_now()
            rows, diagnostics = parse_listing(text, game, code, fetched_at)
            result["diagnostics"] = diagnostics
            if not rows:
                raise ValueError("No scoped original products; last-good records retained")
            merged = merge_records(old_shard.get("records", []), rows, args.history_days, complete_snapshot=True)
            result.update({"status": "ok", "sourceAsOf": fetched_at, "lastSuccessAt": fetched_at,
                           "lastAttemptAt": fetched_at, "recordCount": len(merged), "observedRecordCount": len(rows),
                           "collectionScope": "set_listing", "diagnostics": diagnostics, "shard": shard_url})
            result.pop("reusedRecentSnapshot", None)
            result.pop("error", None)
            detail = {"schemaVersion": 1, "source": "yuyutei", "game": game, "language": "ja",
                      "sourceGame": source_game, "sourceSetCode": code, "name": source_set["name"],
                      "sourceUrl": source_set["url"], "generatedAt": fetched_at,
                      "sourceAsOf": fetched_at, "lastSuccessAt": fetched_at,
                      "collectionScope": "set_listing",
                      "priceKind": "asking", "currency": "JPY", "records": merged}
            atomic_json(detail_path, detail)
            return result, [index_row(row) for row in merged], len(rows)
        except Exception as error:
            deferred = isinstance(error, SourceDeferred)
            result.update({"status": "deferred" if deferred else "failed", "error": f"{type(error).__name__}: {error}"})
            if not deferred or error.attempted:
                result["lastAttemptAt"] = utc_now()
            # A preceding run may have saved the set before its next index checkpoint.
            old_rows = [index_row(row) for row in old_shard.get("records", [])]
            if old_rows:
                result.update({"sourceAsOf": old_shard.get("sourceAsOf"),
                               "lastSuccessAt": old_shard.get("lastSuccessAt"), "recordCount": len(old_rows)})
            return result, old_rows, 0

    sets = {row["sourceSetCode"]: dict(prior_sets.get(row["sourceSetCode"], {})) | row for row in discovered}
    completed, fetched_count = 0, 0

    def checkpoint():
        if not hasattr(args, "_run_fresh_records"):
            args._run_fresh_records = {}
        args._run_fresh_records[game] = fetched_count
        index_rows = [row for code in sets for row in rows_by_set.get(code, [])]
        okay = sum(bool(row.get("lastSuccessAt")) and row.get("collectionScope", "set_listing") == "set_listing" for row in sets.values())
        failures = sum(row.get("status") == "failed" for row in sets.values())
        deferred = sum(row.get("status") == "deferred" for row in sets.values())
        coverage = {"discoveredSets": len(sets), "collectedSets": okay, "failedSets": failures,
                    "deferredSets": deferred,
                    "pendingSets": max(0, len(sets) - okay), "setsAttemptedThisRun": completed,
                    "recordsFetchedThisRun": fetched_count}
        status = "failed" if not index_rows else "partial" if discovery_error or failures or deferred or okay < len(sets) else "ok"
        as_of_column = INDEX_COLUMNS.index("sourceAsOf")
        source_as_of = max((row[as_of_column] or "" for row in index_rows), default=None)
        shard = {"schemaVersion": 1, "source": "yuyutei", "game": game, "language": "ja",
                 "sourceGame": source_game, "priceKind": "asking", "currency": "JPY", "generatedAt": utc_now(),
                 "sourceAsOf": source_as_of, "status": status, "coverage": coverage,
                 "discoveryUrl": discovery_url, "discoveryError": discovery_error,
                 "sets": list(sets.values()), "columns": INDEX_COLUMNS, "rows": index_rows}
        atomic_json(path, shard)
        return {"game": game, "label": label, "sourceGame": source_game,
                "shard": f"/data/yuyutei-market/{game}.json", "recordCount": len(index_rows),
                "pricedCount": sum(row[INDEX_COLUMNS.index("price")] is not None for row in index_rows),
                "sourceAsOf": source_as_of, "status": status, "coverage": coverage}

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = [executor.submit(collect_set, source_set) for source_set in selected]
        for future in concurrent.futures.as_completed(futures):
            metadata, rows, fetched = future.result()
            sets[metadata["sourceSetCode"]] = metadata
            if rows:
                rows_by_set[metadata["sourceSetCode"]] = rows
            completed += 1
            fetched_count += fetched
            if completed % 25 == 0:
                progress = checkpoint()
                publish_manifest(args, progress)
                print(f"yuyutei {game}: {completed}/{len(selected)} sets checked", flush=True)
    summary = checkpoint()
    publish_manifest(args, summary)
    print(json.dumps(summary, ensure_ascii=True), flush=True)
    return summary


def parse_original_product(text, source_url, observed_at):
    """Import a previously fetched ORIGINAL product observation, never a proxy row."""
    parsed_url = urllib.parse.urlparse(source_url)
    match = re.fullmatch(r"/sell/(poc|opc|ws|ua|digi)/card/([a-z0-9.-]+)/([0-9]+)", parsed_url.path)
    if parsed_url.scheme != "https" or parsed_url.netloc != "yuyu-tei.jp" or not match:
        raise ValueError("Seed is not an original Yuyutei product URL")
    source_game, source_set, product_id = match.groups()
    game = next(game for game, value in GAMES.items() if value[0] == source_game)
    products = []
    for raw in re.findall(r'<script\b[^>]*type=["\']application/ld\+json["\'][^>]*>(.*?)</script>', text, re.S | re.I):
        data = json.loads(raw)
        if isinstance(data, dict) and data.get("@type") == "Product":
            products.append(data)
    if len(products) != 1:
        raise ValueError("Expected one original Product JSON-LD in saved HTML")
    product = products[0]
    image = product.get("image", "")
    expected_image = f"https://card.yuyu-tei.jp/{source_game}/front/{source_set}/{product_id}.jpg"
    if image != expected_image:
        raise ValueError("Original image identity disagrees with product URL")
    title = product.get("name", "").split(None, 1)
    if len(title) != 2:
        raise ValueError("Original product rarity/name missing")
    rarity, name = title
    number = normalize(product.get("description"))
    offer = product.get("offers", {})
    if offer.get("priceCurrency") != "JPY":
        raise ValueError("Seed does not contain an original JPY sell offer")
    price_text = str(offer.get("price", ""))
    price = int(price_text) if re.fullmatch(r"[0-9]+", price_text) and int(price_text) > 0 else None
    doc = document(text)
    original_label = doc.first(lambda node: node.tag == "label" and node.attrs.get("id", "").startswith("cart_sell_zaiko"))
    block = Node("div", [("class", "card-product sold-out" if str(offer.get("availability", "")).endswith("OutOfStock") else "card-product")])
    if original_label is not None:
        label = Node("label", [("class", "cart_sell_zaiko")], block)
        label.children.append(original_label.text())
        block.children.append(label)
    stock, state, purchasable, stock_text = stock_details(block)
    if price is None:
        purchasable = False if stock == 0 else None
    observed_at = dt.datetime.fromisoformat(observed_at.replace("Z", "+00:00")).astimezone(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
    return {"id": f"yuyutei:{source_game}:{source_set}:{product_id}", "game": game, "language": "ja", "grade": "raw",
            "setCode": canonical_set(game, source_set, number), "sourceSetCode": source_set,
            "sourceProductId": product_id, "cardNumber": number, "rarity": rarity,
            "variant": f"{rarity} {name}", "name": name, "source": "yuyutei", "sourceUrl": source_url,
            "image": image, "price": price, "currency": "JPY", "priceKind": "asking",
            "stock": stock, "stockState": state, "purchasable": purchasable, "stockText": stock_text,
            "sourceAsOf": observed_at, "fetchedAt": observed_at, "history": [],
            "sourceEvidence": "saved_original_product_html_current_task"}


def seed_original_observations(folder, args):
    evidence = read_json(folder / "yuyu_results.json", {})
    observations = evidence.get("quotes", [])
    if not observations or "original" not in str(evidence.get("upstream", "")).lower():
        raise ValueError("Original observation manifest missing; no proxy feed seed accepted")
    grouped, discovery = {}, {}
    for observation in observations:
        source_url = observation["source_url"]
        source_set, product_id = observation["source_set"], observation["source_product_id"]
        text = (folder / f"card_{source_set}_{product_id}.html").read_text(encoding="utf-8")
        record = parse_original_product(text, source_url, observation["observed_at"])
        grouped.setdefault((record["game"], source_set), []).append(record)
        discovery.setdefault(record["game"], discover_sets(text, record["game"])[0])
    for game in discovery:
        source_game, label = GAMES[game]
        index_path = args.output_dir / "yuyutei-market" / f"{game}.json"
        previous = read_json(index_path, {})
        sets = {row["sourceSetCode"]: row for row in discovery[game]}
        sets.update({row["sourceSetCode"]: row for row in previous.get("sets", [])})
        by_set = {}
        for row in compact_rows(previous):
            by_set.setdefault(row[0], []).append(row)
        for (record_game, code), records in grouped.items():
            if record_game != game:
                continue
            detail_path = args.output_dir / "yuyutei-market" / game / f"{code}.json"
            previous_detail = read_json(detail_path, {})
            merged = merge_records(previous_detail.get("records", []), records, args.history_days)
            as_of = max(record["sourceAsOf"] for record in merged)
            detail = {"schemaVersion": 1, "source": "yuyutei", "game": game, "sourceGame": source_game,
                      "language": "ja", "sourceSetCode": code, "name": sets.get(code, {}).get("name", code),
                      "sourceUrl": safe_set_url(source_game, code), "priceKind": "asking", "currency": "JPY",
                      "generatedAt": utc_now(), "sourceAsOf": as_of, "lastSuccessAt": as_of,
                      "collectionScope": previous_detail.get("collectionScope", "product_observations"),
                      "records": merged}
            atomic_json(detail_path, detail)
            sets[code] = sets.get(code, {"sourceSetCode": code, "name": code, "url": safe_set_url(source_game, code)}) | {
                "sourceAsOf": as_of, "lastSuccessAt": as_of, "recordCount": len(merged),
                "status": "partial", "collectionScope": detail["collectionScope"],
                "shard": f"/data/yuyutei-market/{game}/{code}.json"}
            by_set[code] = [index_row(record) for record in merged]
        rows = [row for code in sets for row in by_set.get(code, [])]
        complete = sum(row.get("collectionScope", "set_listing") == "set_listing" and bool(row.get("lastSuccessAt")) for row in sets.values())
        coverage = {"discoveredSets": len(sets), "collectedSets": complete, "failedSets": 0,
                    "pendingSets": len(sets) - complete, "partialProductSets": sum(row.get("collectionScope") == "product_observations" for row in sets.values()),
                    "setsAttemptedThisRun": 0, "recordsFetchedThisRun": 0}
        as_of = max((row[INDEX_COLUMNS.index("sourceAsOf")] for row in rows), default=None)
        index = {"schemaVersion": 1, "source": "yuyutei", "game": game, "sourceGame": source_game,
                 "language": "ja", "priceKind": "asking", "currency": "JPY", "generatedAt": utc_now(),
                 "sourceAsOf": as_of, "status": "partial", "coverage": coverage,
                 "sets": list(sets.values()), "columns": INDEX_COLUMNS, "rows": rows,
                 "discoveryEvidence": "advanced_search_set_codes_in_saved_original_product_html"}
        atomic_json(index_path, index)
        summary = {"game": game, "label": label, "sourceGame": source_game,
                   "shard": f"/data/yuyutei-market/{game}.json", "recordCount": len(rows),
                   "pricedCount": sum(row[INDEX_COLUMNS.index("price")] is not None for row in rows),
                   "sourceAsOf": as_of, "status": "partial", "coverage": coverage}
        publish_manifest(args, summary)
    return sum(len(records) for records in grouped.values())


def validate_output(output_dir):
    """Validate saved deployable artifacts without contacting the source."""
    manifest = read_json(output_dir / "yuyutei-market.json", {})
    errors, total = [], 0
    if manifest.get("schemaVersion") != 1 or not manifest.get("games"):
        return ["Missing or invalid yuyutei manifest"], 0
    for entry in manifest["games"]:
        game = entry.get("game")
        if game not in GAMES:
            errors.append(f"Unknown game {game}")
            continue
        source_game = GAMES[game][0]
        index_path = output_dir / "yuyutei-market" / f"{game}.json"
        index = read_json(index_path, {})
        columns = index.get("columns", [])
        if not isinstance(columns, list) or not set(REQUIRED_INDEX_COLUMNS).issubset(columns) or len(columns) != len(set(columns)) or index.get("game") != game:
            errors.append(f"Invalid compact index {game}")
            continue
        rows = index.get("rows", [])
        if len(rows) != entry.get("recordCount"):
            errors.append(f"Manifest count mismatch {game}")
        by_set, ids = {}, set()
        for row in rows:
            if not isinstance(row, list) or len(row) != len(columns):
                errors.append(f"Invalid compact row {game}")
                continue
            record = dict(zip(columns, row))
            identity = (record["sourceSetCode"], record["sourceProductId"])
            if identity in ids:
                errors.append(f"Duplicate original product {game}:{identity}")
            ids.add(identity)
            by_set.setdefault(record["sourceSetCode"], []).append(row)
        for code, compact_rows in by_set.items():
            if not SET_RE.fullmatch(code):
                errors.append(f"Unsafe source set {game}:{code}")
                continue
            detail_path = output_dir / "yuyutei-market" / game / f"{code}.json"
            detail = read_json(detail_path, {})
            records = detail.get("records", [])
            if len(records) != len(compact_rows) or sorted((index_row(row, columns) for row in records), key=lambda row: row[1]) != sorted(compact_rows, key=lambda row: row[1]):
                errors.append(f"Index/detail mismatch {game}:{code}")
            for record in records:
                expected_id = f"yuyutei:{source_game}:{code}:{record.get('sourceProductId')}"
                expected_url = f"{BASE}/sell/{source_game}/card/{code}/{record.get('sourceProductId')}"
                if record.get("id") != expected_id or record.get("sourceUrl") != expected_url:
                    errors.append(f"Original product identity mismatch {expected_id}")
                if record.get("grade") != "raw" or record.get("currency") != "JPY" or record.get("priceKind") != "asking":
                    errors.append(f"Price semantics mismatch {expected_id}")
                if record.get("price") is not None and (not isinstance(record["price"], int) or record["price"] <= 0):
                    errors.append(f"Invalid asking price {expected_id}")
                if record.get("stock") == 0 and record.get("purchasable") is not False:
                    errors.append(f"Out-of-stock product presented purchasable {expected_id}")
                history = record.get("history", [])
                dates = [point.get("date") for point in history]
                if len(set(dates)) != len(dates):
                    errors.append(f"Duplicate daily history dates {expected_id}")
            total += len(records)
            if detail_path.exists() and detail_path.stat().st_size >= 25 * 1024 * 1024:
                errors.append(f"Cloudflare asset size limit {detail_path}")
        if index_path.stat().st_size >= 25 * 1024 * 1024:
            errors.append(f"Cloudflare asset size limit {index_path}")
    return errors, total


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--games", default=",".join(GAMES))
    parser.add_argument("--max-sets-per-game", type=int, default=45, help="Bounded stale-set rotation; 0 requests every discovered set subject to global budget")
    parser.add_argument("--workers", type=int, default=3)
    parser.add_argument("--timeout", type=int, default=25)
    parser.add_argument("--history-days", type=int, default=90)
    parser.add_argument("--requests-per-second", type=float, default=0.5, help="Global original-source request ceiling")
    parser.add_argument("--max-requests", type=int, default=250, help="Daily source GET ceiling including discovery/retries; 0 unlimited manual backfill")
    parser.add_argument("--resume-hours", type=float, default=20, help="Reuse successful recent set shards; 0 always refreshes")
    parser.add_argument("--output-dir", type=Path, default=REPO / "data")
    parser.add_argument("--validate-only", action="store_true", help="Validate generated shards; no source requests")
    parser.add_argument("--seed-original-html-dir", type=Path, help="Import verified original product HTML observations, with their original timestamps")
    parser.add_argument("--seed-only", action="store_true", help="Do not make any source requests")
    parser.add_argument("--record-cooldown-seconds", type=int, default=0, help="Persist a known preceding HTTP429 local cooldown without a new GET")
    args = parser.parse_args(argv)
    args.run_started_at = utc_now()
    if args.validate_only:
        errors, total = validate_output(args.output_dir)
        print(json.dumps({"source": "yuyutei", "validatedRecords": total,
                          "errors": errors[:50], "errorCount": len(errors)}, ensure_ascii=True))
        return 1 if errors else 0
    games = [game.strip() for game in args.games.split(",") if game.strip()]
    if not games or any(game not in GAMES for game in games):
        parser.error("Unknown game; supported: " + ",".join(GAMES))
    if args.max_sets_per_game < 0 or args.max_requests < 0 or not 1 <= args.workers <= 6 or not 5 <= args.timeout <= 60 or not 1 <= args.history_days <= 365 or not 0 < args.requests_per_second <= 2 or args.resume_hours < 0 or args.record_cooldown_seconds < 0:
        parser.error("Invalid collection limits")
    old_manifest = read_json(args.output_dir / "yuyutei-market.json", {})
    args.limiter = RateLimiter(args.requests_per_second, args.max_requests, old_manifest.get("cooldown"))
    if args.record_cooldown_seconds:
        args.limiter.record_rate_limit(BASE, fallback_seconds=args.record_cooldown_seconds)
    if args.seed_original_html_dir:
        count = seed_original_observations(args.seed_original_html_dir, args)
        print(json.dumps({"seededOriginalProductObservations": count, "sourceRequests": 0}))
    if args.seed_only:
        if not args.seed_original_html_dir:
            parser.error("--seed-only requires --seed-original-html-dir")
        return 0
    summaries = []
    for game in games:
        summaries.append(collect_game(game, args))
    return 0 if any(row["recordCount"] for row in summaries) else 1


if __name__ == "__main__":
    raise SystemExit(main())
