"""
Phase 3 새 알고리즘 테스트 — pokemon-card 첫 5장에 대해 등급별 lowest_ask 계산.
정확한 SNKRDUNK API 파라미터:
  - isOnlyOnSale=true → active listing 만
  - conditionId=22 → PSA 10
  - conditionId=23 → PSA 9
  - conditionId=18 → A
"""

import json
import re
import sys
import urllib.request
import urllib.error
from pathlib import Path

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

GRADE_CONDITION_IDS = {
    "psa10": 22,
    "psa9":  23,
    "raw":   18,  # A 탭 (싱글)
}

HEADERS = {
    "User-Agent": UA,
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://snkrdunk.com/en/",
}


def fetch_grade_listings(card_id: str, condition_id: int, only_on_sale: bool = True, max_pages: int = 3) -> list:
    """특정 등급의 listing 가져오기"""
    base = f"https://snkrdunk.com/en/v1/products/SW---{card_id}/used-listings"
    qs_only = "&isOnlyOnSale=true" if only_on_sale else ""
    all_items = []
    for page in range(1, max_pages + 1):
        url = f"{base}?conditionId={condition_id}&page={page}&perPage=50{qs_only}"
        try:
            req = urllib.request.Request(url, headers=HEADERS)
            with urllib.request.urlopen(req, timeout=15) as resp:
                if resp.status != 200:
                    print(f"      HTTP {resp.status}")
                    break
                data = json.loads(resp.read().decode("utf-8"))
        except Exception as e:
            print(f"      err: {e}")
            break
        items = data.get("usedListings") or data.get("usedTradingCards") or []
        if not items:
            break
        all_items.extend(items)
        if len(items) < 50:
            break
    return all_items


def parse_usd(price_str) -> float:
    s = str(price_str)
    m = re.search(r"\$\s*([\d,.]+)", s)
    if m:
        try:
            return float(m.group(1).replace(",", ""))
        except ValueError:
            pass
    return None


def main():
    # pokemon-card 첫 5장 ID 가져오기
    pc = json.loads((DATA_DIR / "price-pokemon-card.json").read_text(encoding="utf-8"))
    cards = pc.get("products", [])[:5]

    print("=" * 70)
    print("Phase 3 새 알고리즘 테스트 — pokemon-card 첫 5장")
    print("=" * 70)
    print(f"파라미터: isOnlyOnSale=true + conditionId(22/23/18) per grade\n")

    for card in cards:
        cid = card["id"]
        name = card.get("name", "")[:60]
        list_price = card.get("lastPrice")
        list_cur = card.get("currency", "")
        print(f"━━━ {cid} ━━━")
        print(f"  이름: {name}")
        print(f"  list page: {list_cur} {list_price}")

        for grade, cond_id in GRADE_CONDITION_IDS.items():
            listings = fetch_grade_listings(cid, cond_id, only_on_sale=True, max_pages=2)
            if not listings:
                print(f"  {grade:>5} (cond {cond_id}): 매물 없음")
                continue
            prices = []
            for it in listings:
                p = parse_usd(it.get("price"))
                if p is not None and p > 0:
                    prices.append(p)
            if not prices:
                print(f"  {grade:>5} (cond {cond_id}): 가격 파싱 실패 ({len(listings)}건)")
                continue
            prices_sorted = sorted(prices)
            lowest = prices_sorted[0]
            top5 = prices_sorted[:5]
            print(f"  {grade:>5} (cond {cond_id}): lowest=${lowest}  N={len(prices)}  top5={top5}")
        print()


if __name__ == "__main__":
    main()
