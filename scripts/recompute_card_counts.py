"""
recompute_card_counts.py — cards-by-set 각 박스의 정규 봉입 카드 수 재계산

원리:
  카드의 number 필드가 "001/070" 같은 "XXX/TTT" 형식 → TTT 가 박스 정규 카드 수.
  variant (SR/HR/SAR 등) 는 같은 TTT 또는 "071/070" 같은 별도 번호.

규칙:
  1. cards array 의 모든 number 에서 "/TTT" 추출
  2. 가장 흔한 TTT 값 = 정규 봉입 카드 수
  3. cards array 자체는 변경 없음 (사이트 그리드에서 variant 다 표시)
  4. cardCount 필드만 정규 카드 수로 업데이트
  5. _pending JSON 의 card_count 도 동일하게 sync

121 옛 박스만 처리 (기존 박스는 안 건드림).
"""
import json
import os
import re
from pathlib import Path
from collections import Counter

ROOT = Path(__file__).resolve().parent.parent
PENDING = ROOT / "data" / "_pending-pokemon-boxes.json"
MANUAL = ROOT / "data" / "manual-boxes-pokemon.json"
CARDS_DIR = ROOT / "data" / "cards-by-set"


def atomic_write(path: Path, content: str):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    json.loads(tmp.read_text(encoding="utf-8"))  # validate
    os.replace(tmp, path)


def regular_count_from_cards(cards: list) -> tuple:
    """cards 에서 정규 봉입 카드 수 추출.

    1순위: number "XXX/TTT" → TTT 추출
    2순위: name "No. XXX" 패턴 → 가장 큰 XXX (옛 박스 DP/Neo/Gym/CL용)
    Returns (정규수, total_distribution)
    """
    # 1순위 — number "/TTT"
    totals = []
    for c in cards:
        num = (c.get("number") or "").strip()
        m = re.search(r'/(\d+)', num)
        if m:
            totals.append(int(m.group(1)))
    if totals:
        counter = Counter(totals)
        most_common_total, _ = counter.most_common(1)[0]
        return most_common_total, dict(counter)

    # 2순위 — name "No. XXX" 패턴 (옛 박스용)
    nos = []
    for c in cards:
        name = c.get("name") or ""
        m = re.search(r'No\.\s*(\d+)', name)
        if m:
            nos.append(int(m.group(1)))
    if nos:
        max_no = max(nos)
        return max_no, {"max_no": max_no, "card_count_with_no": len(nos)}

    return None, {}


def main():
    pending = json.loads(PENDING.read_text(encoding="utf-8"))
    legacy_codes = {b["code"]: b for b in pending["boxes"]}

    print("=" * 78)
    print(f"  cards-by-set cardCount 재계산 — 정규 봉입 카드 수 (variant 제외)")
    print("=" * 78)

    updated_cards = 0
    updated_pending = 0
    no_data = []
    rows = []
    for code, box in legacy_codes.items():
        p = CARDS_DIR / f"{code}.json"
        if not p.exists():
            no_data.append(code)
            continue
        d = json.loads(p.read_text(encoding="utf-8"))
        cards = d.get("cards", [])
        old_count = d.get("cardCount", 0)
        regular, dist = regular_count_from_cards(cards)
        if regular is None:
            no_data.append(code)
            continue

        rows.append((code, old_count, regular, dist))

        # cards array 의 variant_count 도 함께 저장 (보너스 카드 수)
        variant_count = len(cards) - regular
        if d.get("cardCount") != regular or d.get("regularCount") != regular:
            d["cardCount"] = regular
            d["regularCount"] = regular
            d["variantCount"] = variant_count
            d["totalCardsInGrid"] = len(cards)
            atomic_write(p, json.dumps(d, ensure_ascii=False, indent=2))
            updated_cards += 1

        # _pending sync
        if box.get("card_count") != regular:
            box["card_count"] = regular
            updated_pending += 1

    # _pending 저장
    atomic_write(PENDING, json.dumps(pending, ensure_ascii=False, indent=2))

    # manual-boxes-pokemon.json 도 sync
    manual = json.loads(MANUAL.read_text(encoding="utf-8"))
    updated_manual = 0
    for p in manual["products"]:
        code = p["code"]
        if code in legacy_codes:
            new = legacy_codes[code].get("card_count")
            if new and p.get("card_count") != new:
                p["card_count"] = new
                updated_manual += 1
    atomic_write(MANUAL, json.dumps(manual, ensure_ascii=False, indent=2))

    # 리포트
    print(f"\n{'code':10s} {'fetched':>9s} {'정규':>6s}  total 분포")
    print("-" * 78)
    for code, old, reg, dist in rows[:20]:
        dist_s = ", ".join(f"/{k}:{v}" for k, v in sorted(dist.items(), key=lambda x:-x[1])[:3])
        print(f"  {code:10s} {old:>7d} {reg:>6d}   {dist_s}")
    if len(rows) > 20:
        print(f"  ... +{len(rows)-20}개")

    print(f"\n{'='*78}")
    print(f"  cards-by-set cardCount 변경: {updated_cards}개")
    print(f"  _pending card_count 변경: {updated_pending}개")
    print(f"  manual card_count 변경: {updated_manual}개")
    if no_data:
        print(f"  ⚠ number 데이터 없는 박스: {no_data}")
    print("=" * 78)


if __name__ == "__main__":
    main()
