"""
SNKRDUNK 카탈로그 전수 수집 — listing API 직접 호출 버전

API: GET /en/v1/trading-cards?brandId=X&categoryId=Y&page=N&perPage=200&order=popular

응답 구조:
{
  "tradingCards": [
    {"id": 674424, "productNumber": "...", "name": "...", "minPrice": 13,
     "thumbnailUrl": "...", "releasedAt": "...", "listingCount": "88", ...},
    ...
  ]
}

페이지네이션 — 응답이 빈 배열일 때까지 page 증가.
Selenium 없이 plain HTTP request — 빠르고 안정적, 만 단위 카드 가능.

사용법:
  python scripts/discover_cards.py
      → 양쪽 brand 모두 (포켓몬 + 원피스)

  python scripts/discover_cards.py pokemon
      → 포켓몬만

  python scripts/discover_cards.py --per-page=200
      → 페이지당 200개 (기본 100)

  python scripts/discover_cards.py --include-box
      → 박스 카테고리 (14)도 함께 수집
"""

import json
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)
COOKIES_FILE = ROOT / "cookies.json"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# 카테고리 ID
CATEGORY_CARD = 25
CATEGORY_BOX = 14


def load_cookie_header():
    if not COOKIES_FILE.exists():
        return ""
    try:
        cookies = json.loads(COOKIES_FILE.read_text("utf-8"))
        return "; ".join(f"{c['name']}={c['value']}" for c in cookies if c.get("name"))
    except Exception:
        return ""


COOKIE_HEADER = load_cookie_header()


def fetch_listing_page(brand, category, page, per_page=100, order="popular"):
    """SNKRDUNK listing API — 1페이지 fetch"""
    url = (f"https://snkrdunk.com/en/v1/trading-cards"
           f"?brandId={brand}&categoryId={category}&page={page}&perPage={per_page}&order={order}")
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json",
        "Accept-Language": "en-US,en;q=0.9",
        "Cookie": COOKIE_HEADER,
        "Referer": f"https://snkrdunk.com/en/brands/{brand}/trading-cards?categoryId={category}",
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def discover_category(brand, category, per_page=100, order="popular", max_pages=500):
    """1개 brand+category 의 전체 카드 페이지네이션 수집"""
    all_cards = []
    seen_ids = set()
    page = 1
    consecutive_empty = 0

    while page <= max_pages:
        try:
            d = fetch_listing_page(brand, category, page, per_page, order)
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = 5 + page // 50
                print(f"      [429] rate limit — {wait}s 대기")
                time.sleep(wait)
                continue
            print(f"      ⚠ page {page}: HTTP {e.code} {e.reason}")
            break
        except Exception as e:
            print(f"      ⚠ page {page}: {e}")
            time.sleep(2)
            continue

        items = d.get("tradingCards") or []
        if not items:
            consecutive_empty += 1
            if consecutive_empty >= 2:
                print(f"      page {page}: 빈 응답 2회 연속 → 종료")
                break
            page += 1
            continue
        consecutive_empty = 0

        new_count = 0
        for item in items:
            cid = str(item.get("id", ""))
            if not cid or cid in seen_ids:
                continue
            seen_ids.add(cid)
            all_cards.append({
                "id": cid,
                "name": item.get("name"),
                "productNumber": item.get("productNumber"),
                "thumbnailUrl": item.get("thumbnailUrl"),
                "releasedAt": item.get("releasedAt"),
                "minPrice": item.get("minPrice"),
                "currency": "USD",  # API returns USD
                "listingCount": item.get("listingCount"),
            })
            new_count += 1

        if new_count == 0:
            # 받았는데 모두 중복 → 이미 마지막
            print(f"      page {page}: 새 ID 0개 → 종료")
            break

        if page % 10 == 0 or page <= 3:
            print(f"      page {page}: 누적 {len(all_cards)}개")

        page += 1
        time.sleep(0.25)  # rate limit 보수적

    return all_cards


def main():
    args = sys.argv[1:]
    include_box = "--include-box" in args
    per_page = 100
    order = "popular"
    for a in args:
        if a.startswith("--per-page="):
            try:
                per_page = int(a.split("=", 1)[1])
            except Exception:
                pass
        elif a.startswith("--order="):
            order = a.split("=", 1)[1]

    selected_brands = ["pokemon", "onepiece"]
    pos_args = [a for a in args if not a.startswith("--")]
    if pos_args:
        b = pos_args[0].lower()
        if b in ("pokemon", "포켓몬"):
            selected_brands = ["pokemon"]
        elif b in ("onepiece", "원피스"):
            selected_brands = ["onepiece"]

    categories = [(CATEGORY_CARD, "card")]
    if include_box:
        categories.append((CATEGORY_BOX, "box"))

    print("================================================")
    print("SNKRDUNK 카탈로그 전수 수집 (listing API)")
    print(f"브랜드: {selected_brands}")
    print(f"카테고리: {[k for _, k in categories]}")
    print(f"perPage: {per_page} / order: {order}")
    print(f"쿠키: {'있음' if COOKIE_HEADER else '없음 (anonymous)'}")
    print("================================================")

    by_brand = {b: {"card": [], "box": []} for b in selected_brands}

    for brand in selected_brands:
        for cat_id, cat_kind in categories:
            print(f"\n[{brand} / {cat_kind}] 수집 중...")
            t0 = time.time()
            cards = discover_category(brand, cat_id, per_page=per_page, order=order)
            elapsed = time.time() - t0
            print(f"  ✓ {brand}/{cat_kind}: {len(cards)}개 ({elapsed:.1f}초)")
            by_brand[brand][cat_kind] = cards

    # 정리
    all_cards_list = []
    only_card_ids = set()
    only_box_ids = set()
    by_brand_ids = {}

    for brand, cats in by_brand.items():
        ids_for_brand = set()
        for c in cats["card"]:
            c["brand"] = brand
            c["kind"] = "card"
            all_cards_list.append(c)
            only_card_ids.add(c["id"])
            ids_for_brand.add(c["id"])
        for c in cats["box"]:
            c["brand"] = brand
            c["kind"] = "box"
            all_cards_list.append(c)
            only_box_ids.add(c["id"])
            ids_for_brand.add(c["id"])
        by_brand_ids[brand] = sorted(ids_for_brand)

    out = {
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "byBrand": by_brand_ids,
        "cards": sorted(only_card_ids),       # 카드 ID — 백필 기본 대상
        "boxes": sorted(only_box_ids) if include_box else [],
        "all": sorted(only_card_ids | only_box_ids),
        "details": all_cards_list,            # 풀 메타데이터 (이름, 썸네일 등)
    }
    out_path = DATA_DIR / "all-cards.json"
    out_path.write_bytes(json.dumps(out, ensure_ascii=False, indent=2).encode("utf-8"))

    # 분리 파일 (cards-meta.json + cards-prices.json) 자동 재생성 — 프론트 경량 로딩용
    try:
        import split_all_cards
        split_all_cards.main()
    except Exception as e:
        print(f"⚠ split_all_cards 실패 (non-fatal): {e}")

    total_cards = len(only_card_ids)
    total_boxes = len(only_box_ids)
    print(f"\n================================================")
    print(f"✓ data/all-cards.json 저장")
    print(f"   카드: {total_cards}개")
    if include_box:
        print(f"   박스: {total_boxes}개")
    for brand, ids in by_brand_ids.items():
        print(f"   {brand}: {len(ids)}개")
    print(f"================================================")

    if total_cards > 100:
        eta_no_vol_min = max(1, total_cards * 3 // 60)
        eta_with_vol_hr = max(1, total_cards * 25 // 3600)
        print(f"\n다음 단계 — 전체 백필:")
        print(f"  python scripts/backfill_history.py --resume --days=180 --no-volume")
        print(f"   → 가격 라인만 (예상 ~{eta_no_vol_min}분)")
        print(f"")
        print(f"  python scripts/backfill_history.py --resume --days=180 --max-pages=10")
        print(f"   → 가격+거래량 (예상 ~{eta_with_vol_hr}시간)")


if __name__ == "__main__":
    main()
