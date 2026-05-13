"""
audit_card_completeness.py — 121 옛 박스의 cards array 가 정규 + variant 빠짐없이
포함하는지 점검

체크:
  1. 정규 카드 (1~TTT) 누락 번호
  2. variant 카드 (TTT 초과) 가 있는지 + 누락 패턴

S6H 예시:
  cards.length = 80 (정상은 95)
  → variant 범위 (71~95) 중 72,73,74,75,79,80,81,82,83,85 누락

문제 있는 박스 list 출력 → 재fetch 권장
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PENDING = ROOT / "data" / "_pending-pokemon-boxes.json"
CARDS_DIR = ROOT / "data" / "cards-by-set"


def get_numbers_in_box(cards):
    """cards 에서 (number, total) tuple list 추출"""
    nums = []
    for c in cards:
        num = (c.get("number") or "").strip()
        m = re.match(r'(\d+)/(\d+)', num)
        if m:
            nums.append((int(m.group(1)), int(m.group(2))))
        else:
            # name 의 "No. XXX" 추출
            name = c.get("name") or ""
            m2 = re.search(r'No\.\s*(\d+)', name)
            if m2:
                nums.append((int(m2.group(1)), None))
    return nums


def audit_box(code, cards):
    """한 박스 audit. Returns issues list."""
    issues = []
    nums = get_numbers_in_box(cards)
    if not nums:
        return ["카드 번호 추출 실패"]

    # total 분포 (가장 흔한 게 정규 봉입 카드 수)
    from collections import Counter
    totals = [t for _, t in nums if t]
    if totals:
        total_counter = Counter(totals)
        regular_total = total_counter.most_common(1)[0][0]
    else:
        # No. 패턴만 있는 옛 박스
        regular_total = max(n for n, _ in nums)

    # 정규 카드 (1 ~ regular_total) 중 누락 번호
    nums_in_regular = sorted(set(n for n, t in nums if t == regular_total or t is None and n <= regular_total))
    missing_regular = [n for n in range(1, regular_total + 1) if n not in nums_in_regular]
    if missing_regular:
        issues.append(f"정규 누락 {len(missing_regular)}개: {missing_regular[:10]}{'...' if len(missing_regular)>10 else ''}")

    # variant 카드 (regular_total 초과)
    variant_nums = sorted(set(n for n, _ in nums if n > regular_total))
    expected_variant_max = max(variant_nums) if variant_nums else regular_total
    if variant_nums:
        # variant 도 연속인지 (보통 71~95 같이 연속)
        missing_variant = [n for n in range(regular_total + 1, expected_variant_max + 1) if n not in variant_nums]
        if missing_variant:
            issues.append(f"variant 누락 {len(missing_variant)}개 (in {regular_total+1}~{expected_variant_max}): {missing_variant}")

    return issues, regular_total, len(cards), len(variant_nums)


def main():
    pending = json.loads(PENDING.read_text(encoding="utf-8"))["boxes"]
    codes = [b["code"] for b in pending]

    print("=" * 80)
    print(f"  121 옛 박스 카드 완전성 audit")
    print("=" * 80)

    problem_boxes = []
    clean_boxes = []
    for code in codes:
        p = CARDS_DIR / f"{code}.json"
        if not p.exists():
            problem_boxes.append((code, "파일 없음", 0, 0, 0))
            continue
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:
            problem_boxes.append((code, f"JSON 깨짐: {str(e)[:30]}", 0, 0, 0))
            continue

        cards = d.get("cards", [])
        if not cards:
            problem_boxes.append((code, "cards 비어있음", 0, 0, 0))
            continue

        result = audit_box(code, cards)
        if isinstance(result, tuple):
            issues, regular, total_cards, variant_cnt = result
        else:
            issues = result
            regular = total_cards = variant_cnt = 0

        if issues:
            problem_boxes.append((code, "; ".join(issues), regular, total_cards, variant_cnt))
        else:
            clean_boxes.append((code, regular, total_cards, variant_cnt))

    # 출력
    print(f"\n[✓ 정상 박스]: {len(clean_boxes)}개")
    print(f"[⚠ 누락 있는 박스]: {len(problem_boxes)}개\n")

    if problem_boxes:
        print(f"{'='*80}")
        print(f"문제 박스 detail:")
        print(f"{'='*80}")
        for code, issue, reg, total, var in problem_boxes:
            print(f"\n[{code}] 정규={reg}, 총카드={total}, variant수={var}")
            print(f"  {issue}")

    # 재fetch 권장 list
    refetch = [c for c, _, _, _, _ in problem_boxes]
    if refetch:
        out = ROOT / "data" / "_audit-needs-refetch.json"
        out.write_text(json.dumps(refetch, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n{'='*80}")
        print(f"  재fetch 필요 박스 {len(refetch)}개 → {out.name}")
        print(f"{'='*80}")
        print(f"\n  cmd: python scripts/fetch_set_cards.py --force {' '.join(refetch[:10])}{'...' if len(refetch)>10 else ''}")


if __name__ == "__main__":
    main()
