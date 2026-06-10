"""
refresh_top_cards_psa10.py — TOP 카드 목록의 가격을 PSA10 기준으로 갱신

대상:
  data/price-pokemon-card.json
  data/price-onepiece-card.json

작동:
  각 entry 의 id (cid) → data/history/{cid}.json 에서 최신 psa10_price 추출
  → entry 의 lastPrice (JPY) + currency='JPY' 갱신
  → psa10 없으면 raw_price fallback + 표시 라벨용 _grade 필드 추가

사용:
  python scripts/refresh_top_cards_psa10.py

안전:
  - Atomic write (tmp -> 검증 -> os.replace)
  - 기존 minPrice 백업 (_orig_minPrice)
  - PSA10 / raw 둘 다 없으면 기존 값 유지
"""

import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
HISTORY = DATA / "history"


def get_latest_grade_price(cid, grade_key):
    """history/{cid}.json 에서 최신 grade_key 값 (예: psa10_price)"""
    p = HISTORY / f"{cid}.json"
    if not p.exists():
        return None
    try:
        raw = p.read_bytes().rstrip(b"\x00")
        d = json.loads(raw)
        hist = d.get("history", [])
        # 최근부터 역순
        for r in reversed(hist):
            v = r.get(grade_key)
            if v and v > 0:
                return v
    except Exception:
        pass
    return None


def atomic_save(path, data):
    tmp = path.with_suffix(".tmp")
    blob = json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8")
    try:
        tmp.write_bytes(blob)
        json.loads(tmp.read_text(encoding="utf-8"))
        os.replace(str(tmp), str(path))
        return True
    except Exception as e:
        try:
            tmp.unlink()
        except Exception:
            pass
        print(f"  ! atomic_save fail: {e}")
        return False


def process(path):
    if not path.exists():
        print(f"  ! {path} 없음 — skip")
        return
    d = json.loads(path.read_text("utf-8"))
    products = d.get("products", [])
    print(f"\n=== {path.name}: {len(products)}장 ===")
    updated_psa10 = 0
    updated_raw = 0
    skipped = 0

    for p in products:
        cid = str(p.get("id") or "")
        if not cid:
            continue

        # 기존 minPrice 백업 (USD)
        if "_orig_lastPrice" not in p:
            p["_orig_lastPrice"] = p.get("lastPrice")
            p["_orig_currency"] = p.get("currency", "USD")

        # 1) PSA10 우선
        psa10 = get_latest_grade_price(cid, "psa10_price")
        if psa10:
            p["lastPrice"] = psa10
            p["currency"] = "JPY"
            p["_grade"] = "PSA10"
            updated_psa10 += 1
            continue

        # 2) raw fallback
        raw = get_latest_grade_price(cid, "raw_price")
        if raw:
            p["lastPrice"] = raw
            p["currency"] = "JPY"
            p["_grade"] = "raw"
            updated_raw += 1
            continue

        # 3) 둘 다 없음 — 기존 minPrice 유지
        p["_grade"] = "minPrice"
        skipped += 1

    print(f"  PSA10 갱신: {updated_psa10}장")
    print(f"  raw fallback: {updated_raw}장")
    print(f"  기존 minPrice 유지: {skipped}장")

    if atomic_save(path, d):
        print(f"  [OK] saved {path.name}")


def main():
    print("=" * 60)
    print("TOP 카드 목록 PSA10 가격 갱신")
    print("=" * 60)
    process(DATA / "price-pokemon-card.json")
    process(DATA / "price-onepiece-card.json")
    print("\n[Done]")
    print("  → 사이트 카드 시세 그리드의 가격 = PSA10 등급 기준")


if __name__ == "__main__":
    main()
