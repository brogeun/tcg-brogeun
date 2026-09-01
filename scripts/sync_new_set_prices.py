"""M6/OP17 SNKRDUNK 개별 카드 메타·현재가만 기존 카탈로그에 안전 병합."""

import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
sys.path.insert(0, str(ROOT / "scripts"))

import discover_cards
import split_all_cards


TARGETS = {
    "pokemon": "PKMN-TCG-M6-",
    "onepiece": "OP17-",
}

# 목록 API에서 누락되지만 개별 SNKRDUNK 상품 페이지가 확인된 M6 기본 카드.
KNOWN_M6_IDS = {
    "043": "866230",
    "044": "866231",
    "071": "866258",
    "072": "866259",
    "073": "866260",
    "074": "866261",
    "075": "866262",
    "076": "866263",
}


def fetch_target(brand, prefix, passes=3, pages=10):
    found = {}
    for pass_no in range(1, passes + 1):
        before = len(found)
        for order in ("new", "popular"):
            for page in range(1, pages + 1):
                data = discover_cards.fetch_listing_page(brand, discover_cards.CATEGORY_CARD, page, 100, order)
                for item in data.get("tradingCards") or []:
                    pn = str(item.get("productNumber") or "")
                    if not pn.upper().startswith(prefix):
                        continue
                    cid = str(item.get("id") or "")
                    if not cid:
                        continue
                    found[cid] = {
                        "id": cid,
                        "name": item.get("name"),
                        "productNumber": item.get("productNumber"),
                        "thumbnailUrl": item.get("thumbnailUrl"),
                        "releasedAt": item.get("releasedAt"),
                        "minPrice": discover_cards.normalize_min_price_usd(item),
                        "currency": "USD",
                        "listingCount": item.get("listingCount"),
                        "brand": brand,
                        "kind": "card",
                    }
                time.sleep(0.05)
        print(f"  {brand} pass {pass_no}: {len(found)}개 (+{len(found) - before})")
    return list(found.values())


def add_known_m6_cards(rows):
    """목록 API 누락 카드도 세트 그리드에서 정확한 상품 ID로 열리게 보강."""
    by_id = {str(c["id"]): c for c in rows}
    set_data = json.loads((DATA / "cards-by-set" / "M6.json").read_text("utf-8"))
    by_number = {str(c.get("number") or "").split("/")[0].zfill(3): c for c in set_data.get("cards", [])}
    for number, cid in KNOWN_M6_IDS.items():
        card = by_number[number]
        by_id.setdefault(cid, {
            "id": cid,
            "name": card.get("name"),
            "productNumber": f"pkmn-tcg-M6-{number}",
            "thumbnailUrl": card.get("image"),
            "releasedAt": "2026-07-30T15:00:00Z",
            "minPrice": 0,
            "currency": "USD",
            "listingCount": "0",
            "brand": "pokemon",
            "kind": "card",
        })
    return list(by_id.values())


def main():
    path = DATA / "all-cards.json"
    data = json.loads(path.read_text("utf-8"))
    details = data.get("details") or []

    fetched = {}
    for brand, prefix in TARGETS.items():
        rows = fetch_target(brand, prefix)
        if brand == "pokemon":
            rows = add_known_m6_cards(rows)
        if len(rows) < 50:
            raise RuntimeError(f"{brand} {prefix} 수집 수가 너무 적음: {len(rows)}")
        fetched[brand] = rows

    # 기존에 잡힌 변형은 API 정렬 변동으로 다음 실행에서 안 보이더라도 보존한다.
    merged = {str(c.get("id")): c for c in details if c.get("id")}
    for rows in fetched.values():
        merged.update({str(c["id"]): c for c in rows})
    kept = list(merged.values())

    by_brand = {}
    for brand in ("pokemon", "onepiece"):
        by_brand[brand] = sorted({str(c["id"]) for c in kept if c.get("brand") == brand})
    card_ids = sorted({str(c["id"]) for c in kept if c.get("kind", "card") == "card"})

    data.update({
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "byBrand": by_brand,
        "cards": card_ids,
        "all": card_ids,
        "details": kept,
    })
    path.write_bytes(json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8"))
    split_all_cards.main()
    print(f"완료: M6 {len(fetched['pokemon'])}개 / OP17 {len(fetched['onepiece'])}개")


if __name__ == "__main__":
    main()
