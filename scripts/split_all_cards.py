# -*- coding: utf-8 -*-
"""
all-cards.json (9MB) → 2개 파일로 분리
  - cards-meta.json   : 거의 안 변하는 메타 (id/name/productNumber/thumbnailUrl/releasedAt/brand/kind)
                        → 브라우저가 하루 캐시 (_headers) — 재방문 시 다운로드 없음
  - cards-prices.json : 자주 변하는 값만 (id → [minPrice, currency, listingCount])
                        → 소형 (수백 KB), 매일 갱신

프론트(loadCardSearchData)는 이 2개를 우선 로드하고, 없으면 all-cards.json 폴백.
all-cards.json 을 재생성하는 모든 곳(discover_cards.py 후 / scrape.yml) 에서 실행할 것.
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
SRC = DATA / "all-cards.json"
META_OUT = DATA / "cards-meta.json"
PRICES_OUT = DATA / "cards-prices.json"


def main():
    if not SRC.exists():
        print("all-cards.json 없음 — skip")
        return

    with open(SRC, encoding="utf-8") as f:
        d = json.load(f)

    details = d.get("details") or []
    meta = []
    prices = {}
    for c in details:
        cid = str(c.get("id") or "")
        if not cid:
            continue
        meta.append({
            "id": cid,
            "name": c.get("name") or "",
            "productNumber": c.get("productNumber") or "",
            "thumbnailUrl": c.get("thumbnailUrl") or "",
            "releasedAt": c.get("releasedAt") or "",
            "brand": c.get("brand") or "",
            "kind": c.get("kind") or "card",
        })
        # [minPrice, currency, listingCount] — 키 반복 없애 용량 최소화
        prices[cid] = [c.get("minPrice"), c.get("currency") or "USD", c.get("listingCount")]

    with open(META_OUT, "w", encoding="utf-8") as f:
        json.dump({"fetchedAt": d.get("fetchedAt"), "cards": meta}, f, ensure_ascii=False, separators=(",", ":"))
    with open(PRICES_OUT, "w", encoding="utf-8") as f:
        json.dump({"fetchedAt": d.get("fetchedAt"), "prices": prices}, f, ensure_ascii=False, separators=(",", ":"))

    print(f"✓ cards-meta.json   {META_OUT.stat().st_size/1e6:.1f}MB ({len(meta)} cards)")
    print(f"✓ cards-prices.json {PRICES_OUT.stat().st_size/1e6:.1f}MB")


if __name__ == "__main__":
    main()
