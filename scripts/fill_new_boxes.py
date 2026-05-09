"""
fill_new_boxes.py — 신규 박스 메타 SNKRDUNK API 자동 fetch + manual-boxes-pokemon.json 추가

용도:
  CARDINFO에는 있지만 manual-boxes에 없는 박스를 SNKRDUNK API로
  메타 정보 (name, jp_name, image, lastPrice) 자동 fetch 후 manual-boxes에 추가.

사용:
  python scripts/fill_new_boxes.py
"""
import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANUAL_FILE = ROOT / "data" / "manual-boxes-pokemon.json"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

# 추가할 박스: (id, code, korean_label_for_log)
NEW_BOXES = [
    ("743533", "M3",   "무니키스 제로"),
    ("628148", "M1S",  "메가 심포니아"),
    ("518728", "SV9a", "열풍의 아레나"),
    ("283206", "SV7",  "스텔라 미라클"),
    ("127743", "SV3",  "흑염의 지배자"),
]


def fetch_meta(box_id):
    url = f"https://snkrdunk.com/v1/apparels/{box_id}"
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json",
        "Accept-Language": "ja,en;q=0.9",
        "Referer": "https://snkrdunk.com/",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        print(f"    ✗ fetch 실패 — {e}")
        return None


def get_jpy_to_usd_rate():
    """data/fx-rates.json 에서 USD/JPY 환산 비율 계산"""
    fx_file = ROOT / "data" / "fx-rates.json"
    try:
        with open(fx_file, "r", encoding="utf-8") as fh:
            fx = json.load(fh)
        usd_to_krw = fx.get("USD", 1462)
        jpy_to_krw = fx.get("JPY", 9.33)
        return usd_to_krw / jpy_to_krw  # 1 USD = N JPY
    except Exception:
        return 156.0  # 기본값


def extract(data, box_id, code, jpy_per_usd):
    """SNKRDUNK 응답에서 필드 추출 (JPY → USD 자동 환산)"""
    a = data.get("apparel") or data.get("data", {}).get("apparel") or data
    if not a or not isinstance(a, dict):
        return None
    name = a.get("name") or a.get("title") or ""
    if not name:
        return None
    jp_name = (a.get("nameJa") or a.get("japaneseName") or a.get("jpName")
               or a.get("nameJp") or a.get("japanese_name") or "")
    image = (a.get("imageUrl") or a.get("thumbnailUrl") or a.get("image")
             or a.get("thumbnail") or "")
    if isinstance(image, list) and image:
        image = image[0]
    if isinstance(image, dict):
        image = image.get("url") or image.get("src") or ""
    # 가격 — SNKRDUNK API 는 JPY 반환 → USD 환산 필요
    last_price_jpy = (a.get("lastSoldPrice") or a.get("minPrice") or a.get("latestPrice")
                      or a.get("lastPrice") or a.get("price") or 0)
    try:
        last_price_jpy = float(last_price_jpy) if last_price_jpy else 0
    except (TypeError, ValueError):
        last_price_jpy = 0
    # JPY → USD (1 USD ≈ 156 JPY)
    last_price_usd = round(last_price_jpy / jpy_per_usd) if last_price_jpy else 0

    return {
        "id": box_id,
        "name": name,
        "code": code,
        "jp_name": jp_name,
        "currency": "USD",
        "url": f"https://snkrdunk.com/en/trading-cards/{box_id}?slide=right",
        "lastPrice": last_price_usd,
        "image": image,
    }


def main():
    if not MANUAL_FILE.exists():
        print(f"❌ {MANUAL_FILE} not found")
        return

    with open(MANUAL_FILE, "r", encoding="utf-8") as fh:
        data = json.load(fh)

    existing_ids = {p["id"] for p in data.get("products", [])}
    jpy_per_usd = get_jpy_to_usd_rate()
    print(f"환율: 1 USD = {jpy_per_usd:.2f} JPY (data/fx-rates.json)")
    added = 0
    skipped = 0

    for box_id, code, kor_label in NEW_BOXES:
        print(f"\n→ {box_id} ({code}) — {kor_label}")
        # 안전 모드 — 이미 있으면 절대 건드리지 않고 스킵
        if box_id in existing_ids:
            skipped += 1
            print(f"    ⊘ 이미 manual-boxes 에 있음 — 스킵 (기존 데이터 보존)")
            continue
        resp = fetch_meta(box_id)
        if not resp:
            continue
        info = extract(resp, box_id, code, jpy_per_usd)
        if not info:
            print(f"    ✗ 메타 추출 실패")
            print(f"      응답 키: {list(resp.keys())[:8]}")
            print(f"      raw 일부: {json.dumps(resp, ensure_ascii=False)[:300]}")
            continue
        data["products"].append(info)
        added += 1
        print(f"    ✓ 추가됨")
        print(f"      name: {info['name'][:70]}")
        if info.get("jp_name"):
            print(f"      jp:   {info['jp_name']}")
        print(f"      price: ${info['lastPrice']}")
        time.sleep(0.5)

    data["count"] = len(data["products"])
    with open(MANUAL_FILE, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)

    print(f"\n{'='*60}")
    print(f"✓ Done. 신규 추가 {added}, 스킵 {skipped} (기존 보존). 총 {data['count']}개.")
    print(f"  → {MANUAL_FILE}")
    print()
    print("다음 단계 — history 백필:")
    print("  python scripts/backfill_box_history.py 743533 628148 518728 283206 127743")


if __name__ == "__main__":
    main()
