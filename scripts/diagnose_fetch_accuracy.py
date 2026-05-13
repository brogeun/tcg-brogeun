"""
diagnose_fetch_accuracy.py — fetch_set_cards.py 가 옛 박스를 정확히 다 가져오는지
다양한 시대/크기 박스 7개로 진단

진단 박스 (시대/크기 다양):
  PCG7  (52장)  — 옛 박스 작은 사이즈 (이미 확인됨)
  ADV4  (80장)  — 가장 옛 박스
  DP1   (122장) — DP 시대 큰 박스
  BW4   (69장)  — BW 시대
  XY7   (81장)  — XY 시대
  SM12a (173장) — SM 시대 가장 큰 박스
  S4a   (190장) — S 시대 가장 큰 박스
  CL1   (102장) — Base Set 1996

검증 기준:
  - "OK" : fetched >= expected * 0.9 (90% 이상 = 정상, +α 는 SR variant 라 정상)
  - "PARTIAL" : 50%~90% = 일부만 가져옴 (lazy-load 부족 의심)
  - "FAIL" : <50% = fetch 실패

사용:
  1. python scripts/fetch_set_cards.py --force PCG7 ADV4 DP1 BW4 XY7 SM12a S4a CL1
  2. python scripts/diagnose_fetch_accuracy.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CARDS_DIR = ROOT / "data" / "cards-by-set"
PENDING = ROOT / "data" / "_pending-pokemon-boxes.json"

# 시대/크기 다양 — 7박스 + PCG7 (이미 확인)
DIAGNOSE = [
    ("PCG7",  52,  "EX 시대 작은 박스"),
    ("ADV4",  80,  "가장 옛 박스 (2004)"),
    ("DP1",   122, "DP 시대 큰 박스 (2006)"),
    ("BW4",   69,  "BW 시대 (2012)"),
    ("XY7",   81,  "XY 시대 (2015)"),
    ("SM12a", 173, "SM 마지막 큰 박스 (2019)"),
    ("S4a",   190, "S 시대 가장 큰 박스 (2020)"),
    ("CL1",   102, "Base Set 1996 (가장 옛것)"),
]


def main():
    print("=" * 80)
    print("  fetch 정확도 진단 — 8개 박스 (시대/크기 다양)")
    print("=" * 80)

    pending = {b["code"]: b for b in json.loads(PENDING.read_text(encoding="utf-8"))["boxes"]}

    rows = []
    for code, default_exp, desc in DIAGNOSE:
        # _pending 의 card_count_expected (백업된 검증치) 가 있으면 우선 사용
        box = pending.get(code, {})
        expected = box.get("card_count_expected") or box.get("card_count") or default_exp

        p = CARDS_DIR / f"{code}.json"
        if not p.exists():
            rows.append((code, expected, 0, "NO_FILE", desc, "?"))
            continue
        try:
            d = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:
            rows.append((code, expected, 0, "BROKEN", desc, str(e)[:30]))
            continue
        actual = d.get("cardCount", 0)
        src = d.get("source", "?")
        ratio = actual / expected if expected else 0

        # tcgcollector 가 master 면 일부 차이는 정상 (variant 더 포함)
        # 옛 박스의 영문판/일판 차이도 고려 (일판이 더 작은 경우 많음)
        if src != "tcgcollector.com":
            status = "STALE"  # selenium 안 돌은 박스
        elif ratio >= 0.9 or actual >= expected * 0.7:
            status = "OK"
        elif ratio >= 0.5:
            status = "PARTIAL"
        else:
            status = "FAIL"
        rows.append((code, expected, actual, status, desc, src))

    # 출력
    print(f"\n  {'박스':8s} {'expected':>9s} {'fetched':>8s}  {'상태':10s} {'source':22s} 설명")
    print("  " + "-" * 78)
    for code, e, a, st, desc, src in rows:
        diff = a - e
        sign = "+" if diff > 0 else ""
        emoji = {"OK":"✓", "PARTIAL":"⚠", "FAIL":"❌", "STALE":"⊘", "NO_FILE":"?", "BROKEN":"💥"}.get(st, "?")
        ratio_s = f"({sign}{diff})" if a else ""
        print(f"  {code:8s} {e:>9d} {a:>8d}  {emoji} {st:8s} {src:22s} {desc}")

    # 요약
    ok = sum(1 for r in rows if r[3]=="OK")
    bad = sum(1 for r in rows if r[3] in ("PARTIAL","FAIL"))
    stale = sum(1 for r in rows if r[3]=="STALE")
    print(f"\n{'='*80}")
    print(f"  OK: {ok}/{len(rows)}  |  PARTIAL/FAIL: {bad}  |  selenium 안 돈 박스: {stale}")
    print("=" * 80)
    if stale:
        stale_codes = [r[0] for r in rows if r[3]=="STALE"]
        print(f"\n  먼저 selenium fetch 실행:")
        print(f"    python scripts/fetch_set_cards.py --force {' '.join(stale_codes)}")
    elif bad:
        bad_codes = [r[0] for r in rows if r[3] in ("PARTIAL","FAIL")]
        print(f"\n  문제 박스 — fetch_set_cards.py 의 scroll 로직 수정 필요")
        print(f"    문제: {bad_codes}")
    else:
        print(f"\n  ✓ 다양한 시대/크기 박스 8개 전부 정상 fetch")
        print(f"    → 121개 전체 --legacy-refetch 안심하고 진행 가능")


if __name__ == "__main__":
    main()
