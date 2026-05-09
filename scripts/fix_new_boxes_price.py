"""
fix_new_boxes_price.py — 방금 추가된 5개 박스의 lastPrice JPY → USD 환산

사용:
  python scripts/fix_new_boxes_price.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANUAL_FILE = ROOT / "data" / "manual-boxes-pokemon.json"

# 환산 대상 박스 ID
TARGET_IDS = {"743533", "628148", "518728", "283206", "127743"}


def get_jpy_per_usd():
    fx_file = ROOT / "data" / "fx-rates.json"
    try:
        with open(fx_file, "r", encoding="utf-8") as fh:
            fx = json.load(fh)
        return fx.get("USD", 1462) / fx.get("JPY", 9.33)
    except Exception:
        return 156.0


def main():
    with open(MANUAL_FILE, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    rate = get_jpy_per_usd()
    print(f"환율: 1 USD = {rate:.2f} JPY\n")

    fixed = 0
    for p in data.get("products", []):
        if p.get("id") not in TARGET_IDS:
            continue
        old = p.get("lastPrice", 0)
        if old < 1000:
            print(f"  ⊘ {p['id']} ({p.get('code')}) lastPrice={old} — 이미 USD 같음, 스킵")
            continue
        new = round(old / rate)
        p["lastPrice"] = new
        fixed += 1
        print(f"  ✓ {p['id']} ({p.get('code')}) ${old:.0f} (JPY) → ${new} (USD)")
        print(f"    {p.get('name', '')[:60]}")

    with open(MANUAL_FILE, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    print(f"\n✓ Done. {fixed}개 박스 lastPrice 환산 완료.")


if __name__ == "__main__":
    main()
