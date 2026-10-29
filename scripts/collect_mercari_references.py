#!/usr/bin/env python3
"""Refresh a bounded watchlist of public Mercari listing references.

Only original public HTML is fetched. Its displayed price is a listing reference,
never an exact-card valuation or proof of a completed transaction. Missing status,
language, edition and grade stay unknown. No login, Joocasa, browser emulation,
paid service, or automatic search-discovery API is used.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from html.parser import HTMLParser
import json
import math
from pathlib import Path
import re
import sys
from typing import Any, Callable
import unicodedata
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import HTTPRedirectHandler, Request, build_opener

REPO_ROOT = Path(__file__).resolve().parents[1]
MAX_RESPONSE_BYTES = 1_500_000
USER_AGENT = "Mozilla/5.0 (compatible; TCGHUBReferenceCollector/1.0; +https://tcghub.kr)"
GAME_KEYS = {"pokemon", "onepiece", "weiss_schwarz", "union_arena", "dragon_ball_fusion_world", "yugioh", "digimon"}
SOURCE_SEARCH_URL = "https://jp.mercari.com/search?keyword={query}"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def normalize(value: str) -> str:
    return unicodedata.normalize("NFKC", value).replace("−", "-").replace("‐", "-")


def valid_item_url(url: str) -> bool:
    parsed = urlparse(url)
    return (parsed.scheme == "https" and parsed.netloc == "jp.mercari.com"
            and re.fullmatch(r"/item/m\d{11}", parsed.path) is not None
            and not parsed.query and not parsed.fragment)


class SameSourceRedirects(HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, msg, headers, newurl):
        if not valid_item_url(newurl):
            raise HTTPError(request.full_url, code, "Unexpected source redirect", headers, fp)
        return super().redirect_request(request, fp, code, msg, headers, newurl)


class PublicListingHTML(HTMLParser):
    """Script/i18n dictionaries are not evidence of a listing's state."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.skip = 0
        self.title_parts: list[str] = []
        self.in_title = False
        self.visible_parts: list[str] = []
        self.current_button: list[str] | None = None
        self.buttons: list[str] = []
        self.in_recommendations = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in {"script", "style", "template"}:
            self.skip += 1
        if tag == "meta":
            self.meta[attrs.get("name") or attrs.get("property") or ""] = attrs.get("content", "")
        if tag == "title":
            self.in_title = True
        if tag == "button" and not self.skip and not self.in_recommendations:
            self.current_button = []

    def handle_endtag(self, tag):
        if tag in {"script", "style", "template"}:
            self.skip = max(0, self.skip - 1)
        if tag == "title":
            self.in_title = False
        if tag == "button" and self.current_button is not None:
            self.buttons.append("".join(self.current_button).strip())
            self.current_button = None

    def handle_data(self, data):
        if self.in_title:
            self.title_parts.append(data)
        if not self.skip and data.strip():
            self.visible_parts.append(data.strip())
            if "この商品を見ている人におすすめ" in data:
                self.in_recommendations = True
            if self.current_button is not None:
                self.current_button.append(data)


def infer_identity(title: str, details: str = "") -> dict[str, Any]:
    """These are seller text claims, not authenticated card identities."""
    text = normalize(title + "\n" + details)
    game = None
    game_patterns = [
        ("union_arena", r"ユニオンアリーナ|UNION\s*ARENA"),
        ("weiss_schwarz", r"ヴァイスシュヴァルツ|WEISS\s*SCHWARZ"),
        ("dragon_ball_fusion_world", r"FUSION\s*WORLD|フュージョンワールド"),
        ("onepiece", r"ワンピース|ONE\s*PIECE"),
        ("pokemon", r"ポケモン|POK[EÉ]MON"),
        ("yugioh", r"遊戯王|YU[\s-]*GI[\s-]*OH"),
        ("digimon", r"デジモン|DIGIMON"),
    ]
    found_games = [key for key, pattern in game_patterns if re.search(pattern, text, re.I)]
    if len(found_games) == 1:
        game = found_games[0]
    numbers = sorted(set(n.upper() for n in re.findall(
        r"\b(?:(?:OP|ST|EB|PRB|FB|FS|BT|EX)\d{2}-\d{2,3}|P-\d{3}|[A-Z0-9]{2,6}/S?\d{2,4}-[A-Z]?\d{2,3}|[A-Z]{2,5}-\d-\d{3})\b", text, re.I)))
    languages = set()
    if re.search(r"英語版|ENGLISH(?:\s+(?:EDITION|VERSION|2ND))?|\bLANGUAGE\s*:\s*EN\b", text, re.I):
        languages.add("en")
    if re.search(r"日本語版|JAPANESE(?:\s+(?:EDITION|VERSION))?|\bLANGUAGE\s*:\s*JA\b", text, re.I):
        languages.add("ja")
    grade_claims = set((company.upper(), score) for company, score in re.findall(
        r"\b(PSA|BGS|CGC|ARS)\s*(10|[1-9](?:\.5)?)\b", text, re.I))
    grade = "".join(next(iter(grade_claims))) if len(grade_claims) == 1 else None
    if not grade_claims and re.search(r"未鑑定|未グレーディング|鑑定なし|\bRAW\b", text, re.I):
        grade = "raw"
    counts = {int(n) for n in re.findall(r"(\d+)\s*枚", normalize(title))}
    if not counts:
        counts = {int(n) for n in re.findall(r"(?:種別\s*[:：]?\s*シングルカード\s*|合計枚数/個数\s*[:：]?\s*)(\d+)\s*枚", normalize(details))}
    quantity = next(iter(counts)) if len(counts) == 1 else None
    bundle = True if re.search(r"まとめ売り|まとめ|引退品|\b(?:BUNDLE|LOT)\b", text, re.I) or (quantity and quantity > 1) else False if quantity == 1 else None
    variant = None
    if re.search(r"スーパーパラレル|コミパラ|\bMANGA\b", text, re.I):
        variant = "manga"
    elif re.search(r"パラレル|\bSEC-P\b", text, re.I):
        variant = "parallel"
    elif re.search(r"通常版|通常イラスト|通常SEC|\bSTANDARD(?:\s+ART)?\b", text, re.I):
        variant = "standard"
    set_code = None
    if re.search(r"ENGLISH\s+2ND\s+ANNIVERSARY|英語版\s*2周年", text, re.I):
        set_code = "EN-2ND-ANNIVERSARY"
    elif re.search(r"(?:セット|収録弾)\s*[:：]?\s*[【\[]?OP-?05|新時代の主役", text, re.I):
        set_code = "OP05"
    return {"game": game, "language": next(iter(languages)) if len(languages) == 1 else None,
            "setCode": set_code, "cardNumber": numbers[0] if len(numbers) == 1 else None,
            "cardNumbers": numbers, "variant": variant, "grade": grade,
            "quantity": quantity, "bundle": bundle}


def parse_listing(html: str, item: dict[str, Any], observed_at: str) -> dict[str, Any]:
    parser = PublicListingHTML()
    parser.feed(html)
    title = parser.meta.get("og:title") or "".join(parser.title_parts)
    title = re.sub(r"\s*(?:by メルカリ|- メルカリ)$", "", title).strip()
    if not title:
        raise ValueError("Original HTML did not contain a listing title")
    visible = "\n".join(parser.visible_parts).split("この商品を見ている人におすすめ", 1)[0]
    details = visible.split("商品の説明", 1)[1].split("出品者", 1)[0] if "商品の説明" in visible else ""
    identity = infer_identity(title, details)
    buttons = {re.sub(r"\s+", "", normalize(button)) for button in parser.buttons}
    sold, active = "売り切れました" in buttons, "購入手続きへ" in buttons
    status = "sold" if sold and not active else "active" if active and not sold else "unknown"
    raw_price = parser.meta.get("product:price:amount", "")
    amount = int(raw_price) if re.fullmatch(r"\d+", raw_price) else None
    currency = parser.meta.get("product:price:currency") or None
    if amount is None or amount <= 0 or not math.isfinite(amount) or currency != "JPY":
        raise ValueError("Original HTML did not contain a positive JPY listing price")
    issues = [field + "_unknown" for field in ("game", "language", "setCode", "cardNumber", "variant", "grade", "quantity") if identity.get(field) is None]
    if status == "unknown":
        issues.append("sale_status_unknown")
    if identity["bundle"]:
        issues.append("bundle_not_single_card")
    # Even complete seller claims are not a trusted canonical binding or an actual settlement record.
    issues.append("canonical_identity_not_verified")
    return {
        "id": "mercari:" + item["itemId"], "itemId": item["itemId"], "sourceUrl": item["sourceUrl"],
        "title": title, "imageUrl": parser.meta.get("og:image") or None,
        "price": {"amount": amount, "currency": currency}, "observedAt": observed_at,
        "lastSuccessfulAt": observed_at, "lastAttemptAt": observed_at,
        "saleStatus": status, "soldAt": None,
        "priceBasis": "displayed_listing_price", "sourceCaptureKind": "public_html_metadata",
        "statusEvidence": "visible_product_button" if status != "unknown" else None,
        "verification": "unverified", "valuationEligible": False,
        "identity": identity,
        "matchHints": {"game": identity["game"] or item.get("game"), "cardNumbers": identity["cardNumbers"]},
        "issues": issues, "fetchStatus": "ok", "stale": False,
    }


def fetch_public_html(url: str, timeout: float) -> str:
    if not valid_item_url(url):
        raise ValueError("Only canonical public jp.mercari.com/item/m... URLs are supported")
    request = Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html"})
    with build_opener(SameSourceRedirects()).open(request, timeout=timeout) as response:
        if response.status != 200 or not valid_item_url(response.geturl()):
            raise ValueError("Unexpected source response")
        raw = response.read(MAX_RESPONSE_BYTES + 1)
        if len(raw) > MAX_RESPONSE_BYTES:
            raise ValueError("Source response exceeded bounded download limit")
        return raw.decode("utf-8")


def load_watchlist(path: Path, max_items: int) -> list[dict[str, Any]]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or not isinstance(data.get("items"), list):
        raise ValueError("Watchlist requires an items array")
    selected = []
    ids = set()
    for raw in data["items"]:
        if not isinstance(raw, dict) or raw.get("enabled", True) is not True:
            continue
        item = dict(raw)
        item_id = item.get("itemId", "")
        url = item.get("sourceUrl", "")
        if not isinstance(item_id, str) or re.fullmatch(r"m\d{11}", item_id) is None or not isinstance(url, str) or not valid_item_url(url) or url.rsplit("/", 1)[-1] != item_id:
            raise ValueError("Watchlist contains an invalid canonical item URL or ID")
        if item_id in ids:
            raise ValueError("Watchlist contains duplicate item IDs")
        if item.get("game") is not None and item["game"] not in GAME_KEYS:
            raise ValueError("Watchlist contains an unsupported game hint")
        ids.add(item_id)
        selected.append(item)
    if not selected or len(selected) > max_items:
        raise ValueError("Enabled watchlist size must be between 1 and --max-items")
    return selected


def refresh(items: list[dict[str, Any]], previous: dict[str, Any], observed_at: str,
            fetcher: Callable[[str, float], str] = fetch_public_html, timeout: float = 20) -> dict[str, Any]:
    old = {row.get("itemId"): row for row in previous.get("references", []) if isinstance(row, dict)}

    def collect(item):
        try:
            return parse_listing(fetcher(item["sourceUrl"], timeout), item, observed_at)
        except (HTTPError, URLError, TimeoutError, ValueError, UnicodeError, OSError) as error:
            prior = old.get(item["itemId"])
            row = dict(prior) if prior else {"id": "mercari:" + item["itemId"], "itemId": item["itemId"],
                "sourceUrl": item["sourceUrl"], "title": None, "imageUrl": None, "price": None,
                "observedAt": None, "lastSuccessfulAt": None, "saleStatus": "unknown", "soldAt": None,
                "identity": {}, "matchHints": {"game": item.get("game"), "cardNumbers": []},
                "priceBasis": "displayed_listing_price", "sourceCaptureKind": "public_html_metadata"}
            row.update({"lastAttemptAt": observed_at, "fetchStatus": "error", "stale": True,
                        "verification": "unverified", "valuationEligible": False,
                        "lastError": type(error).__name__ + ": " + str(error)[:180]})
            row["lastKnownSaleStatus"] = row.get("saleStatus", "unknown")
            row["saleStatus"] = "unknown"
            row["statusEvidence"] = None
            row["soldAt"] = None
            row["issues"] = sorted(set(row.get("issues", []) + ["refresh_failed", "canonical_identity_not_verified"]))
            return row

    with ThreadPoolExecutor(max_workers=min(3, len(items))) as pool:
        rows = list(pool.map(collect, items))
    succeeded = sum(row["fetchStatus"] == "ok" for row in rows)
    return {
        "schemaVersion": 1, "source": "mercari", "updatedAt": observed_at,
        "coverage": {"mode": "watchlist", "discovery": "manual_urls", "trackedCount": len(items),
                     "fetchedCount": succeeded, "errorCount": len(rows) - succeeded, "verifiedQuoteCount": 0,
                     "searchUrlTemplate": SOURCE_SEARCH_URL,
                     "notes": ["Known public listing URLs are refreshed; new listings are not automatically discovered.",
                               "Prices are listing references. Unknown sale status is preserved; sold dates are not inferred.",
                               "Reference candidates are excluded from portfolio valuations and market-price averages."]},
        "references": rows, "verifiedQuotes": [],
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--watchlist", type=Path, default=REPO_ROOT / "data/mercari-reference-watchlist.json")
    parser.add_argument("--output", type=Path, default=REPO_ROOT / "data/mercari-references.json")
    parser.add_argument("--max-items", type=int, default=20)
    parser.add_argument("--timeout", type=float, default=20)
    args = parser.parse_args(argv)
    if not 1 <= args.max_items <= 100 or not 1 <= args.timeout <= 60:
        parser.error("max-items must be 1..100 and timeout 1..60 seconds")
    try:
        items = load_watchlist(args.watchlist, args.max_items)
        previous = json.loads(args.output.read_text(encoding="utf-8")) if args.output.exists() else {}
        if not isinstance(previous, dict):
            raise ValueError("Previous output must be a JSON object")
        result = refresh(items, previous, utc_now(), timeout=args.timeout)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = args.output.with_name(args.output.name + ".tmp")
        temporary.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(args.output)
        print(json.dumps({"source": "mercari", **{key: result["coverage"][key] for key in
            ("trackedCount", "fetchedCount", "errorCount", "verifiedQuoteCount")}}, ensure_ascii=False))
        return 0 if result["coverage"]["fetchedCount"] else 1
    except (OSError, ValueError, TypeError) as error:
        print("Mercari reference refresh failed: " + str(error), file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
