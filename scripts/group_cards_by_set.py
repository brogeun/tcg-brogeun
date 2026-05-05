"""
group_cards_by_set.py — SNKRDUNK 자체 데이터로 세트별 카드 그룹핑

소스: data/all-cards.json (23,102 카드, 모든 일판 세트)
출력: data/cards-by-set/{code}.json (세트별 카드 목록)

장점:
  - 외부 API 의존 0 (TCGdex 누락 세트 다 커버: M5, M4, M2a, M2, M1L 등)
  - 즉시 실행 (5초)
  - SNKRDUNK 와 100% 동기화 (가격 데이터와 매칭 보장)

사용:
  python scripts/group_cards_by_set.py
"""

import json
import re
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ALL_CARDS = ROOT / "data" / "all-cards.json"
OUT_DIR = ROOT / "data" / "cards-by-set"
OUT_DIR.mkdir(parents=True, exist_ok=True)


def extract_set_code(card: dict) -> str | None:
    """productNumber 에서 세트 코드 추출

    예시:
      pkmn-tcg-M4-001       → M4
      pkmn-tcg-SV11B-203    → SV11B
      pkmn-tcg-S8a-001      → S8a
      pkmn-tcg-M-P-020      → M-P (프로모)
      pkmn-tcg-SVP-272      → SVP (프로모)
      one-piece-OP15-001    → OP15
      one-piece-EB04-046    → EB04
    """
    pn = (card.get("productNumber") or "").strip()
    if not pn:
        # name 에서 추출 시도 (예: "[M4 045/093]" 또는 "[OP15-001]")
        name = card.get("name") or ""
        m = re.search(r"\[([A-Z]+\d*[a-zA-Z]*)[\s\-_]?\d", name)
        if m:
            return m.group(1)
        return None

    # pkmn-tcg-{CODE}-{NUMBER}
    m = re.match(r"pkmn-tcg-([A-Z]+\d*[a-zA-Z]*)-", pn)
    if m:
        return m.group(1)
    # one-piece-{CODE}-{NUMBER}
    m = re.match(r"one-piece-(?:tcg-)?([A-Z]+\d+)", pn)
    if m:
        return m.group(1)
    # 기타 패턴
    m = re.search(r"-([A-Z]+\d*[a-zA-Z]*?)-\d", pn)
    if m:
        return m.group(1)
    return None


def extract_card_number(card: dict) -> str:
    """카드 번호 추출 (예: '001/093', 'M4-001')"""
    name = card.get("name") or ""
    # [M4 045/093] 패턴
    m = re.search(r"\[\s*[A-Z]+\d*[a-zA-Z]*\s+(\d+/\d+)\s*\]", name)
    if m:
        return m.group(1)
    # [OP15-001] 패턴
    m = re.search(r"\[\s*[A-Z]+\d+-(\d+)", name)
    if m:
        return m.group(1)
    # productNumber 끝 숫자
    pn = card.get("productNumber") or ""
    m = re.search(r"-(\d+)$", pn)
    if m:
        return m.group(1)
    return ""


def main():
    print(f"=" * 60)
    print(f"세트별 카드 그룹핑 — SNKRDUNK 자체 데이터")
    print(f"=" * 60)

    if not ALL_CARDS.exists():
        print(f"⚠ {ALL_CARDS} 없음")
        return

    print(f"  로드: {ALL_CARDS.relative_to(ROOT)}")
    data = json.loads(ALL_CARDS.read_text("utf-8"))
    cards = data.get("details") or data.get("cards") or []
    print(f"  총 카드 수: {len(cards):,}")

    # 세트별 그룹핑
    by_set = defaultdict(list)
    by_brand_count = defaultdict(int)
    no_set = 0
    for c in cards:
        code = extract_set_code(c)
        if not code:
            no_set += 1
            continue
        by_set[code].append({
            "id": str(c.get("id", "")),
            "name": (c.get("name") or "").strip(),
            "number": extract_card_number(c),
            "image": c.get("thumbnailUrl") or "",
            "minPrice": c.get("minPrice"),
            "currency": c.get("currency") or "USD",
            "listingCount": c.get("listingCount"),
        })
        by_brand_count[c.get("brand") or "?"] += 1

    print(f"  분류 안 된 카드: {no_set:,}")
    print(f"  포켓몬 / 원피스: {by_brand_count.get('pokemon', 0):,} / {by_brand_count.get('onepiece', 0):,}")
    print(f"  세트 수: {len(by_set):,}")

    # 세트별 저장
    fetched_at = datetime.now(timezone.utc).isoformat()
    saved = 0
    for code, items in sorted(by_set.items()):
        # 카드 번호 순 정렬
        items.sort(key=lambda x: (
            int(x["number"].split("/")[0]) if x["number"].split("/")[0].isdigit() else 9999,
            x["name"],
        ))
        out = {
            "code": code,
            "fetchedAt": fetched_at,
            "cardCount": len(items),
            "cards": items,
        }
        (OUT_DIR / f"{code}.json").write_text(
            json.dumps(out, ensure_ascii=False, indent=2),
            encoding="utf-8"
        )
        saved += 1

    print(f"\n━━━ 저장된 세트 (TOP 30, 카드 수 desc) ━━━")
    top = sorted(by_set.items(), key=lambda x: -len(x[1]))[:30]
    for code, items in top:
        print(f"  {code:<10} {len(items):>4} 카드")

    print(f"\n✓ 완료: {saved}개 세트 → {OUT_DIR.relative_to(ROOT)}/")


if __name__ == "__main__":
    main()
