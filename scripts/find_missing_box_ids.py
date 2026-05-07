"""
find_missing_box_ids.py — 카드정보 페이지에 보이는 박스 중 SNKRDUNK ID 누락된 거 검색

포켓몬 누락 9개 (SV11B~SV5M 사이) + 원피스 누락 16개 (OP01~OP14, EB01~EB04) — 총 25개
SNKRDUNK 검색 API 로 일본명/영문명 매칭해서 ID 자동 추가.

사용:
  python scripts/find_missing_box_ids.py
"""
import json
import urllib.request
import urllib.parse
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PRICE_POKE = ROOT / "data" / "price-pokemon-box.json"
PRICE_OP   = ROOT / "data" / "price-onepiece-box.json"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

# 포켓몬 누락 9개 — code → (jp_name, eng_name)
MISSING_POKEMON = {
    "SV11B": ("ブラックボルト", "Black Bolt"),
    "SV11W": ("ホワイトフレア", "White Flare"),
    "SV10":  ("ロケット団の栄光", "The Glory of Team Rocket"),
    "SV8":   ("超電ブレイカー", "Super Electric Breaker"),
    "SV7a":  ("楽園ドラゴーナ", "Paradise Dragona"),
    "SV6a":  ("ナイトワンダラー", "Night Wanderer"),
    "SV6":   ("変幻の仮面", "Mask of Change"),
    "SV5a":  ("クリムゾンヘイズ", "Crimson Haze"),
    "SV5M":  ("サイバージャッジ", "Cyber Judge"),
}

# 원피스 누락 9개 — code → (jp_name, eng_name)
# (OP10/12/13/14, EB02/03/04 는 사용자가 직접 ID 알려줘서 이미 처리됨)
MISSING_ONEPIECE = {
    "OP01": ("ロマンスドーン",       "ROMANCE DAWN"),
    "OP02": ("頂上決戦",             "PARAMOUNT WAR"),
    "OP03": ("強大な敵",             "PILLARS OF STRENGTH"),
    "OP04": ("謀略の王国",           "KINGDOMS OF INTRIGUE"),
    "OP05": ("新時代の主役",         "AWAKENING OF THE NEW ERA"),
    "OP06": ("双璧の覇者",           "WINGS OF THE CAPTAIN"),
    "OP08": ("二つの伝説",           "TWO LEGENDS"),
    "OP11": ("神速の拳",             "A FIST OF DIVINE SPEED"),
    "EB01": ("メモリアルコレクション", "MEMORIAL COLLECTION"),
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


def find_box_id(code, jp_name, eng_name, brand):
    """일본명/영문명 + BOX 키워드로 검색 → 매칭되는 첫 박스 product 의 ID"""
    # brand 별 검색어 prefix
    prefix = "ポケモンカード" if brand == "pokemon" else "ワンピースカード"
    queries = [
        f"{prefix} {jp_name} BOX",
        f"{prefix} {jp_name} ボックス",
        f"{jp_name} BOX",
        f"{jp_name} ボックス",
        f"{eng_name} BOX",
        jp_name,
        eng_name,
    ]
    for q in queries:
        result = search_snkrdunk(q)
        if "error" in result:
            time.sleep(1)
            continue
        items = (result.get("apparels") or result.get("items") or
                 result.get("results") or result.get("hits") or [])
        # 1차: 박스 키워드 + 이름 매칭
        for item in items[:10]:
            name = (item.get("name") or item.get("title") or "")
            if not (jp_name in name or eng_name.upper() in name.upper()):
                continue
            up = name.upper()
            if "BOX" in up or "ボックス" in name:
                return item.get("id"), name
        time.sleep(0.5)
    # 최후 — 매칭 박스 못 찾으면 첫 결과
    for q in queries[:3]:
        result = search_snkrdunk(q)
        items = (result.get("apparels") or result.get("items") or
                 result.get("results") or result.get("hits") or [])
        for item in items[:5]:
            name = (item.get("name") or item.get("title") or "")
            if jp_name in name or eng_name.upper() in name.upper():
                return item.get("id"), name
        time.sleep(0.5)
    return None, None


def process(missing, brand, price_file):
    """missing 박스들 검색 + price-{brand}-box.json 에 추가"""
    try:
        existing = json.loads(price_file.read_bytes().rstrip(b'\x00').rstrip())
    except Exception:
        existing = {"count": 0, "products": []}
    existing_ids = {str(p.get("id")) for p in existing.get("products", [])}
    existing_codes = {p.get("code") for p in existing.get("products", []) if p.get("code")}

    print(f"\n=== {brand.upper()} ({len(missing)}개) ===")
    found = []
    not_found = []
    for code, (jp_name, eng_name) in missing.items():
        if code in existing_codes:
            print(f"  {code:6} skip — 이미 등록됨")
            continue
        print(f"  {code:6} '{jp_name}' / '{eng_name}'", end=" ", flush=True)
        bid, name = find_box_id(code, jp_name, eng_name, brand)
        if not bid:
            print("❌")
            not_found.append(code)
            continue
        if str(bid) in existing_ids:
            print(f"skip (ID {bid} 이미 존재)")
            continue
        print(f"✓ ID={bid} ({name[:40]})")
        found.append({
            "id": str(bid),
            "name": name,
            "code": code,
            "jp_name": jp_name,
            "currency": "USD",
            "url": f"https://snkrdunk.com/en/trading-cards/{bid}?slide=right",
        })
        time.sleep(1.5)

    if found:
        existing["products"].extend(found)
        existing["count"] = len(existing["products"])
        price_file.unlink(missing_ok=True)
        price_file.write_bytes(
            json.dumps(existing, ensure_ascii=False, indent=2).encode("utf-8")
        )
        print(f"\n  → {len(found)}개 추가됨")
    if not_found:
        print(f"  ❌ 못 찾음 ({len(not_found)}개): {', '.join(not_found)}")
    return found, not_found


def main():
    print("=" * 60)
    print("누락 박스 ID 자동 검색")
    print("=" * 60)
    f1, n1 = process(MISSING_POKEMON, "pokemon", PRICE_POKE)
    f2, n2 = process(MISSING_ONEPIECE, "onepiece", PRICE_OP)
    print(f"\n=== 최종 ===")
    print(f"  포켓몬: {len(f1)}/{len(MISSING_POKEMON)} 추가 / 못 찾음: {n1}")
    print(f"  원피스: {len(f2)}/{len(MISSING_ONEPIECE)} 추가 / 못 찾음: {n2}")


if __name__ == "__main__":
    main()
