"""
group_cards_by_set.py — SNKRDUNK 자체 데이터로 세트별 카드 그룹핑

소스: data/all-cards.json (23,102 카드, 모든 일판 세트)
출력: data/cards-by-set/{code}.json

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


def extract_set_code(card: dict):
    """productNumber 에서 세트 코드 추출"""
    pn = (card.get("productNumber") or "").strip()
    if not pn:
        name = card.get("name") or ""
        m = re.search(r"\[([A-Z]+\d*[a-zA-Z]*)[\s\-_]?\d", name)
        if m:
            return m.group(1)
        return None

    # pkmn-tcg-{CODE}-{NUMBER}
    m = re.match(r"pkmn-tcg-([A-Z]+\d*[a-zA-Z]*)-", pn)
    if m:
        return m.group(1)
    # one-piece-{CODE}-{NUMBER} (옛 패턴)
    m = re.match(r"one-piece-(?:tcg-)?([A-Z]+\d+)", pn)
    if m:
        return m.group(1)
    # 원피스 직접: OP15-001, EB04-061, ST10-006
    m = re.match(r"^([A-Z]+\d*)-\d", pn.upper())
    if m:
        return m.group(1)
    # 기타
    m = re.search(r"-([A-Z]+\d*[a-zA-Z]*?)-\d", pn)
    if m:
        return m.group(1)
    return None


def extract_card_number(card: dict) -> str:
    """카드 번호 추출"""
    name = card.get("name") or ""
    m = re.search(r"\[\s*[A-Z]+\d*[a-zA-Z]*\s+(\d+/\d+)\s*\]", name)
    if m:
        return m.group(1)
    m = re.search(r"\[\s*[A-Z]+\d+-(\d+)", name)
    if m:
        return m.group(1)
    pn = card.get("productNumber") or ""
    m = re.search(r"-(\d+)$", pn)
    if m:
        return m.group(1)
    return ""


def main():
    print("=" * 60)
    print("세트별 카드 그룹핑 — SNKRDUNK 자체 데이터")
    print("=" * 60)

    if not ALL_CARDS.exists():
        print(f"⚠ {ALL_CARDS} 없음")
        return

    print(f"  로드: {ALL_CARDS.relative_to(ROOT)}")
    data = json.loads(ALL_CARDS.read_text("utf-8"))
    cards = data.get("details") or data.get("cards") or []
    print(f"  총 카드 수: {len(cards):,}")

    by_set = defaultdict(list)
    by_brand_count = defaultdict(int)
    no_set = 0
    skipped_pokemon = 0
    for c in cards:
        code = extract_set_code(c)
        if not code:
            no_set += 1
            continue
        # 포켓몬은 SNKRDUNK 거래 카드만 등록되어 50%+ 누락됨
        # → tcgcollector 스크래핑 데이터 (fetch_set_cards.py) 우선
        # 여기서는 원피스만 처리
        if c.get("brand") == "pokemon":
            skipped_pokemon += 1
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
    print(f"  포켓몬 스킵 (tcgcollector 우선): {skipped_pokemon:,}")
    print(f"  포켓몬 / 원피스: {by_brand_count.get('pokemon', 0):,} / {by_brand_count.get('onepiece', 0):,}")
    print(f"  세트 수: {len(by_set):,}")

    fetched_at = datetime.now(timezone.utc).isoformat()
    saved = 0
    for code, items in sorted(by_set.items()):
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

    print("\n━━━ 저장된 세트 (TOP 30) ━━━")
    top = sorted(by_set.items(), key=lambda x: -len(x[1]))[:30]
    for code, items in top:
        print(f"  {code:<10} {len(items):>4} 카드")

    print(f"\n완료: {saved} 세트 저장")


if __name__ == "__main__":
    main()
