"""
sync_pending_cardcount.py — _pending-pokemon-boxes.json + manual-boxes-pokemon.json
의 card_count 를 실제 cards-by-set/{code}.json 의 cardCount 로 sync

규칙:
1. 기존 검증 수치는 card_count_expected 필드로 백업 (최초 1회만)
2. card_count 는 cards-by-set 의 cardCount 로 교체
3. cards-by-set/{code}.json 없으면 skip + 경고
4. 멱등 — 이미 sync 된 박스는 변경 없으면 그냥 통과
5. atomic write — partial-write 방지
"""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PENDING = ROOT / "data" / "_pending-pokemon-boxes.json"
MANUAL = ROOT / "data" / "manual-boxes-pokemon.json"
CARDS_DIR = ROOT / "data" / "cards-by-set"


def atomic_write(path: Path, content: str):
    """validate-before-replace atomic write — invalid JSON 으로 절대 덮어쓰지 않음"""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    # validate
    try:
        json.loads(tmp.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"  [atomic_write abort] {path.name}: invalid JSON ({e})")
        tmp.unlink(missing_ok=True)
        raise
    os.replace(tmp, path)


def get_actual_count(code: str):
    safe_code = code.replace("/", "-")
    p = CARDS_DIR / f"{safe_code}.json"
    if not p.exists():
        return None
    try:
        d = json.loads(p.read_text(encoding="utf-8"))
        return d.get("cardCount", 0)
    except Exception as e:
        print(f"  [json fail] {code}: {e}")
        return None


def sync_pending():
    print("=" * 70)
    print("(1) _pending-pokemon-boxes.json sync")
    print("=" * 70)
    data = json.loads(PENDING.read_text(encoding="utf-8"))
    boxes = data["boxes"]
    synced = nochange = no_file = 0
    for box in boxes:
        code = box["code"]
        actual = get_actual_count(code)
        if actual is None:
            no_file += 1
            continue
        current = box.get("card_count", 0)
        if current == actual:
            nochange += 1
            continue
        if "card_count_expected" not in box:
            box["card_count_expected"] = current
        box["card_count"] = actual
        synced += 1
        sign = "+" if actual > current else ""
        print(f"  OK {code:8s}: {current} -> {actual} ({sign}{actual-current})")
    atomic_write(PENDING, json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print(f"\n[_pending] sync:{synced} nochange:{nochange} no_file:{no_file}")


def sync_manual():
    print(f"\n{'='*70}")
    print("(2) manual-boxes-pokemon.json sync")
    print("=" * 70)
    data = json.loads(MANUAL.read_text(encoding="utf-8"))
    products = data["products"]
    synced = nochange = no_field = no_file = 0
    for p in products:
        code = p["code"]
        if "card_count" not in p:
            no_field += 1
            continue
        actual = get_actual_count(code)
        if actual is None:
            no_file += 1
            continue
        current = p["card_count"]
        if current == actual:
            nochange += 1
            continue
        if "card_count_expected" not in p:
            p["card_count_expected"] = current
        p["card_count"] = actual
        synced += 1
        sign = "+" if actual > current else ""
        print(f"  OK {code:8s}: {current} -> {actual} ({sign}{actual-current})")
    atomic_write(MANUAL, json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print(f"\n[manual] sync:{synced} nochange:{nochange} no_field:{no_field} no_file:{no_file}")


def main():
    sync_pending()
    sync_manual()
    print(f"\n{'='*70}")
    print("  Done - next: python scripts/verify_pending_vs_cards.py")
    print("=" * 70)


if __name__ == "__main__":
    main()
