"""Collect public official news metadata. Run daily from GitHub Actions.

Keep the existing items schema; store image URLs, not image files or article bodies.
Failed sources retain their last successful items and timestamps.
"""
import json
import re
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen

from bs4 import BeautifulSoup

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
RETENTION_DAYS = 180
MAX_ITEMS = 100
MAX_SOURCE_ITEMS = 40
NEWS_SOURCES = [
    {"key": "pokemon", "label": "포켓몬", "url": "https://pokemoncard.co.kr/news"},
    {"key": "onepiece", "label": "원피스", "url": "https://onepiece-cardgame.kr/topics.do?extraValue=&page=0&size=5"},
]


def canonical_link(url):
    parts = urlsplit(url.strip())
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return ""
    host = parts.hostname.lower().removeprefix("www.")
    query = [(k.lower(), v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if not k.lower().startswith("utm_") and k.lower() not in ("fbclid", "gclid")]
    return urlunsplit(("https", host, parts.path.rstrip("/") or "/", urlencode(sorted(query)), ""))


def parse_date(text):
    match = re.search(r"(20\d{2})\s*(?:년|[-./])\s*(\d{1,2})\s*(?:월|[-./])\s*(\d{1,2})", text or "")
    if not match:
        return None
    try:
        return datetime(*map(int, match.groups())).date().isoformat()
    except ValueError:
        return None


def request_html(url, form=None):
    data = urlencode(form).encode() if form else None
    for attempt in range(2):
        try:
            request = Request(url, data=data, headers={"User-Agent": "TCGHub-News/1.0", "Referer": url})
            with urlopen(request, timeout=20) as response:
                return response.read().decode("utf-8")
        except Exception:
            if attempt:
                raise
            time.sleep(1)


def text(node):
    return node.get_text(" ", strip=True) if node else ""


def image_url(node, base):
    raw = (node.get("src") or node.get("data-src") or "") if node else ""
    if not raw or re.search(r"logo|icon|dummy|mainImg|ogp\.png", raw, re.I):
        return ""
    url = urljoin(base, raw)
    return url if urlsplit(url).scheme in ("http", "https") else ""


def parse_listing(html, source):
    soup = BeautifulSoup(html, "html.parser")
    pokemon = source["key"] == "pokemon"
    anchors = soup.select("li > a[href]") if pokemon else soup.select("a.item[href]")
    items = []
    for anchor in anchors:
        title = text(anchor.select_one("h3" if pokemon else ".tit"))
        date = parse_date(text(anchor.select_one(".list-split" if pokemon else ".date")))
        link = urljoin(source["url"], anchor.get("href", ""))
        if not title or not date or not canonical_link(link):
            continue
        items.append({"title": title, "date": date, "link": link,
                      "image": image_url(anchor.select_one("img"), source["url"]),
                      "source": source["key"], "sourceLabel": source["label"]})
    return items


def detail_image(html, link):
    soup = BeautifulSoup(html, "html.parser")
    # Scope to actual article body, excluding site logos, menus and related posts.
    selector = ".bx-board img" if "pokemoncard.co.kr" in link else ".sub_p_post_detail .pre_wrap img"
    for node in soup.select(selector):
        url = image_url(node, link)
        if url:
            return url
    return ""


def collect_source(source):
    items, seen = [], set()
    pages = 2 if source["key"] == "pokemon" else 8
    for page in range(1, pages + 1):
        if source["key"] == "pokemon":
            response = request_html("https://pokemoncard.co.kr/v3/news_ajax",
                                    {"pn": page, "cate": "2", "sword": "", "rcode": "menu_news"})
            parts = response.split("#|#")
            if len(parts) < 3:
                raise ValueError("Pokemon listing response format changed")
            html = parts[1]
        else:
            # This site's first page is zero-based (UI displays it as page 1).
            html = request_html(f"https://onepiece-cardgame.kr/topics.do?extraValue=&page={page - 1}&size=5")
        batch = parse_listing(html, source)
        if not batch:
            if page == 1:
                raise ValueError("No valid news items on first page")
            break
        fresh = [item for item in batch if canonical_link(item["link"]) not in seen]
        if not fresh:
            break
        for item in fresh:
            seen.add(canonical_link(item["link"]))
            items.append(item)
        if len(items) >= MAX_SOURCE_ITEMS:
            break
        time.sleep(0.3)
    for item in items[:MAX_SOURCE_ITEMS]:
        parts = urlsplit(item["link"])
        known_detail = (parts.hostname in ("pokemoncard.co.kr", "www.pokemoncard.co.kr") and parts.path == "/_news") or (
            parts.hostname in ("onepiece-cardgame.kr", "www.onepiece-cardgame.kr") and parts.path.endswith("/view.do"))
        if known_detail:
            try:
                representative = detail_image(request_html(item["link"]), item["link"])
                if representative:
                    item["image"] = representative
            except Exception as exc:
                print(f"Detail image fallback: {item['link']}: {exc}", flush=True)
            time.sleep(0.2)
    return items[:MAX_SOURCE_ITEMS]


def merge_items(existing, fresh, successful, now=None):
    now = now or datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=RETENTION_DAYS)).date().isoformat()
    merged = {canonical_link(item.get("link", "")): dict(item) for item in existing
              if canonical_link(item.get("link", ""))}
    for item in fresh:
        key = canonical_link(item["link"])
        merged[key] = {**merged.get(key, {}), **item}
    failed = [item for item in merged.values() if item.get("source") not in successful]
    healthy = [item for item in merged.values() if item.get("source") in successful and item.get("date", "") >= cutoff]
    healthy.sort(key=lambda item: (item.get("date", ""), item.get("link", "")), reverse=True)
    # A failed source's last known data is never aged out due to a fetch failure.
    result = failed + healthy[:max(0, MAX_ITEMS - len(failed))]
    return sorted(result, key=lambda item: (item.get("date", ""), item.get("link", "")), reverse=True)


def main():
    path = DATA_DIR / "news.json"
    previous = json.loads(path.read_text("utf-8")) if path.exists() else {"items": []}
    fresh, successful, errors = [], set(), {}
    statuses = dict(previous.get("sources", {}))
    for source in NEWS_SOURCES:
        key = source["key"]
        try:
            items = collect_source(source)
            fresh.extend(items)
            successful.add(key)
            statuses[key] = {"lastSuccessAt": datetime.now(timezone.utc).isoformat(), "count": len(items)}
            print(f"{key}: {len(items)} collected, newest {max(item['date'] for item in items)}", flush=True)
        except Exception as exc:
            errors[key] = str(exc)
            print(f"{key}: failed; previous data preserved: {exc}", file=sys.stderr, flush=True)
    if not successful:
        raise RuntimeError("All sources failed; news.json left unchanged")
    items = merge_items(previous.get("items", []), fresh, successful)
    payload = {"ok": True, "fetchedAt": datetime.now(timezone.utc).isoformat(), "count": len(items),
               "sourceCounts": {key: sum(item["source"] == key for item in fresh) for key in successful},
               "sources": statuses, "errors": errors, "items": items}
    temporary = path.with_suffix(".json.tmp")
    temporary.write_bytes((json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8"))
    temporary.replace(path)
    print(f"Saved {len(items)} items", flush=True)
    return 1 if errors else 0


if __name__ == "__main__":
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    sys.exit(main())
