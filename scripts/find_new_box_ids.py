"""
find_new_box_ids.py — 신규 23개 포켓몬 박스의 SNKRDUNK product ID 찾기

SNKRDUNK 검색 API 로 박스 일본명 검색 → 첫 박스 product 의 ID 추출
→ data/price-pokemon-box.json 에 추가

사용:
  python scripts/find_new_box_ids.py
"""
import json
import urllib.request
import urllib.parse
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRICE_FILE = ROOT / "data" / "price-pokemon-box.json"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

# 신규 23개 박스 — code → 일본 박스명 (BOX 검색용)
NEW_BOXES = {
    "SV5K": "ワイルドフォース",
    "SV4a": "シャイニートレジャーex",
    "SV4M": "未来の一閃",
    "SV4K": "古代の咆哮",
    "SV3a": "レイジングサーフ",
    "SV3":  "黒炎の支配者",
    "SV2a": "ポケモンカード151",
    "SV2D": "クレイバースト",
    "SV2P": "スノーハザード",
    "SV1a": "トリプレットビート",
    "S12a": "VSTARユニバース",
    "S12":  "パラダイムトリガー",
    "S11a": "白熱のアルカナ",
    "S11":  "ロストアビス",
    "S10b": "ポケモンGO",
    "S10a": "ダークファンタズマ",
    "S9a":  "バトルリージョン",
    "S9":   "スターバース",
    "S8b":  "VMAXクライマックス",
    "S8":   "フュージョンアーツ",
    "S7R":  "蒼空ストリーム",
    "S7D":  "摩天パーフェクト",
    "S6a":  "イーブイヒーローズ",
}


def search_snkrdunk(query):
    """SNKRDUNK 검색 — apparels (상품) 결과"""
    url = f"https://snkrdunk.com/v1/search?keyword={urllib.parse.quote(query)}&category_id=14"
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Accept": "application/json",
        "Referer": "https://snkrdunk.com/",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        return {"error": str(e)}


def find_box_id(code, jp_name):
    """박스 일본명으로 검색 → BOX 키워드 포함된 첫 결과 ID"""
    queries = [
        f"{jp_name} BOX",
        f"{jp_name} ボックス",
        jp_name,
    ]
    for q in queries:
        result = search_snkrdunk(q)
        items = (result.get("apparels") or result.get("items") or
                 result.get("results") or result.get("hits") or [])
        for item in items[:5]:
            name = item.get("name") or item.get("title") or ""
            # 박스 키워드 + 일본명 매칭
            if jp_name not in name:
                continue
            if "BOX" in name.upper() or "ボックス" in name:
                return item.get("id"), name
        # 박스 키워드 없어도 첫 결과
        if items:
            item = items[0]
            return item.get("id"), item.get("name", "")
        time.sleep(0.5)
    return None, None


def main():
    # 기존 price-pokemon-box.json 읽기
    try:
        existing = json.loads(PRICE_FILE.read_bytes().rstrip(b'\x00').rstrip())
    except Exception:
        existing = {"products": []}
    existing_ids = {str(p.get("id")) for p in existing.get("products", [])}
    existing_names = " ".join(p.get("name", "") for p in existing.get("products", []))

    print(f"기존 박스: {len(existing_ids)}개")
    print()

    new_products = []
    for code, jp_name in NEW_BOXES.items():
        # 이미 들어있는지 (이름 매칭) — 매핑은 ID 로 검증해야 정확하지만 이름으로 우선 체크
        if jp_name in existing_names:
            print(f"  {code:<6} skip — 이미 존재 ({jp_name})")
            continue
        print(f"  {code:<6} searching '{jp_name}'...", end=" ", flush=True)
        bid, name = find_box_id(code, jp_name)
        if not bid:
            print("❌ 못 찾음")
            continue
        if str(bid) in existing_ids:
            print(f"skip — ID {bid} 이미 존재")
            continue
        print(f"✓ ID {bid} ({name[:40]})")
        new_products.append({
            "id": str(bid),
            "name": name,
            "code": code,
            "jp_name": jp_name,
        })
        time.sleep(1.5)

    if not new_products:
        print("\n추가할 박스 없음")
        return

    # 기존 + 신규 merge
    existing["products"].extend(new_products)
    PRICE_FILE.unlink(missing_ok=True)
    PRICE_FILE.write_bytes(json.dumps(existing, ensure_ascii=False, indent=2).encode("utf-8"))
    print(f"\n✓ {len(new_products)}개 박스 추가됨 → {PRICE_FILE.name}")


if __name__ == "__main__":
    main()
