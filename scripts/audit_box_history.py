"""
audit_box_history.py — 박스 가격 history 전수조사

용도:
  모든 박스 (price-{brand}-box.json + manual-boxes-{brand}.json 합산) 의
  data/history/{id}.json 존재/데이터 갯수 확인 → 가격 차트 비어있는 박스 리스트업.

사용:
  python scripts/audit_box_history.py
"""
import json
import sys
from pathlib import Path

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

ROOT = Path(__file__).resolve().parent.parent
HISTORY_DIR = ROOT / "data" / "history"


def load_boxes():
    """4개 박스 데이터 파일에서 모든 박스 메타 추출 → list of dict"""
    boxes = []
    for brand in ["pokemon", "onepiece"]:
        for fname in [f"price-{brand}-box.json", f"manual-boxes-{brand}.json"]:
            f = ROOT / "data" / fname
            if not f.exists():
                continue
            with open(f, "r", encoding="utf-8") as fh:
                d = json.load(fh)
            for p in d.get("products", []):
                boxes.append({
                    "id": str(p.get("id", "")),
                    "name": p.get("name", ""),
                    "code": p.get("code", ""),
                    "brand": brand,
                    "source": fname,
                })
    return boxes


def check_history(box_id):
    """data/history/{id}.json 의 점 갯수 반환 (0 = 비어있음, -1 = 파일없음)"""
    f = HISTORY_DIR / f"{box_id}.json"
    if not f.exists():
        return -1, None
    try:
        with open(f, "r", encoding="utf-8") as fh:
            d = json.load(fh)
        history = d.get("history") or d.get("entries") or []
        return len(history), d.get("name", "")
    except Exception:
        return -2, None


def main():
    boxes = load_boxes()
    # 중복 제거 (id 같으면 한번만)
    seen = set()
    unique_boxes = []
    for b in boxes:
        if b["id"] in seen:
            continue
        seen.add(b["id"])
        unique_boxes.append(b)

    print(f"\n{'='*80}")
    print(f"박스 history 전수조사 — 총 {len(unique_boxes)}개 박스 (중복 제거)")
    print(f"{'='*80}\n")

    no_file = []   # history 파일 자체가 없음
    empty = []     # 파일은 있는데 entries 0개
    sparse = []    # entries 1~9개 (의미있는 차트 그리기 어려움)
    ok = []        # entries 10개 이상 — 정상 백필

    for b in unique_boxes:
        cnt, hist_name = check_history(b["id"])
        if cnt == -1:
            no_file.append(b)
        elif cnt == -2:
            no_file.append(b)
        elif cnt == 0:
            empty.append(b)
        elif cnt < 10:
            b["count"] = cnt
            sparse.append(b)
        else:
            b["count"] = cnt
            ok.append(b)

    # 결과 출력
    if no_file:
        print(f"❌ history 파일 자체가 없음 — {len(no_file)}개 (백필 한 번도 안 돌아감)")
        for b in no_file:
            print(f"  · {b['brand']:8s} {b['code'] or '-':6s} (id {b['id']:8s}) — {b['name'][:60]}")
        print()

    if empty:
        print(f"⚠️  history 파일은 있지만 entries 0개 — {len(empty)}개")
        for b in empty:
            print(f"  · {b['brand']:8s} {b['code'] or '-':6s} (id {b['id']:8s}) — {b['name'][:60]}")
        print()

    if sparse:
        print(f"⚠️  entries < 10 (차트 그리기 어려움) — {len(sparse)}개")
        for b in sparse:
            print(f"  · {b['brand']:8s} {b['code'] or '-':6s} (id {b['id']:8s}) [{b['count']:2d}건] {b['name'][:60]}")
        print()

    print(f"✅ 정상 (entries ≥ 10) — {len(ok)}개")
    print(f"\n총 {len(unique_boxes)}개 중 {len(ok)}개 OK, {len(no_file) + len(empty) + len(sparse)}개 문제\n")


if __name__ == "__main__":
    main()
