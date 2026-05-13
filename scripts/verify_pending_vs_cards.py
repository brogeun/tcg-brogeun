"""
verify_pending_vs_cards.py — _pending-pokemon-boxes.json 의 card_count
vs cards-by-set/{code}.json 의 실제 cardCount 비교
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PENDING = ROOT / "data" / "_pending-pokemon-boxes.json"
CARDS_DIR = ROOT / "data" / "cards-by-set"


def main():
    data = json.loads(PENDING.read_text(encoding="utf-8"))
    boxes = data["boxes"]

    match, mismatch, no_file = [], [], []
    for box in boxes:
        code = box["code"]
        expected = box.get("card_count", 0)
        safe_code = code.replace("/", "-")
        p = CARDS_DIR / f"{safe_code}.json"
        if not p.exists():
            no_file.append(code)
            continue
        actual = json.loads(p.read_text(encoding="utf-8")).get("cardCount", 0)
        if expected == actual:
            match.append((code, expected, actual))
        else:
            mismatch.append((code, expected, actual))

    print("=" * 70)
    print(f"  ✓ 정확히 일치: {len(match)}개")
    print(f"  ⚠️  불일치: {len(mismatch)}개")
    print(f"  ❌ 파일 없음: {len(no_file)}개")
    print("=" * 70)

    if mismatch:
        print("\n[불일치 detail]")
        for code, e, a in mismatch:
            diff = a - e
            sign = "+" if diff > 0 else ""
            print(f"  {code:8s}: expected={e:4d}, actual={a:4d} ({sign}{diff})")

    if no_file:
        print(f"\n[파일 없음]: {no_file}")


if __name__ == "__main__":
    main()
