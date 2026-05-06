"""
fetch_box_images.py — 박스 코드 → SNKRDUNK 검색 → 박스 이미지 다운로드

사용:
  python scripts/fetch_box_images.py            # 누락된 박스만
  python scripts/fetch_box_images.py --force    # 전부 재다운로드
  python scripts/fetch_box_images.py SV5K SV4a  # 특정 박스만

흐름:
  1. fetch_set_cards.py 의 POKEMON_SETS 리스트 읽음
  2. images/sets/{code}.jpg 가 없는 박스만 처리 (--force 면 전부)
  3. SNKRDUNK 검색 API 호출 → 박스 product 찾음 → 이미지 URL 추출
  4. JPEG 다운로드 후 images/sets/{code}.jpg 로 저장

검색 우선순위:
  - 1차: 박스 코드 (예: "SV5K") + brand=pokemon + category=14 (박스)
  - 2차: 박스 한국명 한자/일본어 변환 (와일드 포스 → ワイルドフォース)
  - 3차: 영문명 (Wild Force)
"""
import json
import re
import sys
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IMAGES_DIR = ROOT / "images" / "sets"
IMAGES_DIR.mkdir(parents=True, exist_ok=True)
FETCH_SCRIPT = ROOT / "scripts" / "fetch_set_cards.py"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# 박스 코드 → 일본어 박스명 (SNKRDUNK 검색 정확도 ↑)
JP_NAMES = {
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
    "s12a": "VSTARユニバース",
    "s12":  "パラダイムトリガー",
    "s11a": "白熱のアルカナ",
    "s11":  "ロストアビス",
    "s10b": "ポケモンGO",
    "s10a": "ダークファンタズマ",
    "s9a":  "バトルリージョン",
    "s9":   "スターバース",
    "s8b":  "VMAXクライマックス",
    "s8":   "フュージョンアーツ",
    "s7R":  "蒼空ストリーム",
    "s7D":  "摩天パーフェクト",
    "s6a":  "イーブイヒーローズ",
    # 기존 박스도 추가 (재실행 시 누락 보완)
    "M4":   "ニンジャスペナー",
    "M3":   "無効化ゼロ",
    "M2a":  "メガドリームex",
    "M2":   "インフェルノX",
    "M1L":  "メガブレイブ",
    "M1S":  "メガシンフォニア",
    "SV11B": "ブラックボルト",
    "SV11W": "ホワイトフレア",
    "SV10": "ロケット団の栄光",
    "SV9a": "熱風のアリーナ",
    "SV9":  "バトルパートナーズ",
    "SV8a": "テラスタルフェスティバルex",
    "SV8":  "超電ブレイカー",
    "SV7a": "パラダイスドラゴナ",
    "SV7":  "ステラミラクル",
    "SV6a": "ナイトワンダラー",
    "SV6":  "変幻の仮面",
    "SV5a": "クリムゾンヘイズ",
    "SV5M": "サイバージャッジ",
}


def parse_pokemon_sets():
    """fetch_set_cards.py 의 POKEMON_SETS 파싱"""
    text = FETCH_SCRIPT.read_text(encoding="utf-8")
    block = re.search(r"POKEMON_SETS\s*=\s*\[(.*?)^\]", text, re.DOTALL | re.MULTILINE)
    if not block:
        raise RuntimeError("POKEMON_SETS 리스트를 못 찾았습니다.")
    sets = []
    for m in re.finditer(r'\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)', block.group(1)):
        sets.append((m.group(1), m.group(2), m.group(3)))
    return sets


def search_snkrdunk(query, category_id=14, limit=10):
    """SNKRDUNK 검색 API — 박스 카테고리(14) 우선"""
    url = (
        f"https://snkrdunk.com/v1/search?"
        f"keyword={urllib.request.quote(query)}"
        f"&brandIds[]=pokemon"
        f"&categoryIds[]={category_id}"
        f"&limit={limit}"
    )
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json",
        "Referer": "https://snkrdunk.com/",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8"))
        return data.get("apparels") or data.get("items") or data.get("results") or []
    except Exception as e:
        print(f"    검색 실패 ({query}): {e}")
        return []


def find_box_image(code, korean_name):
    """박스 코드/한국명/일본명 으로 SNKRDUNK 검색 → 이미지 URL"""
    queries = []
    jp = JP_NAMES.get(code)
    if jp:
        queries.append(jp)        # 1순위: 일본명 (가장 정확)
    queries.append(code)          # 2순위: 박스 코드
    queries.append(korean_name)   # 3순위: 한국명 (SNKRDUNK 한국어 검색 미지원 가능)

    for q in queries:
        results = search_snkrdunk(q)
        for r in results:
            name = r.get("name", "")
            img = r.get("image_url") or r.get("imageUrl") or r.get("image")
            # 이름에 박스 키워드 포함 (BOX, ボックス) 한 결과 우선
            if img and ("BOX" in name.upper() or "ボックス" in name or "BOX" in q):
                return img, name
        # 박스 키워드 없어도 첫 결과 반환
        if results:
            r = results[0]
            img = r.get("image_url") or r.get("imageUrl") or r.get("image")
            if img:
                return img, r.get("name", "")
    return None, None


def download_image(url, save_path):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Referer": "https://snkrdunk.com/",
    })
    with urllib.request.urlopen(req, timeout=20) as r:
        data = r.read()
    save_path.write_bytes(data)
    return len(data)


def main():
    args = sys.argv[1:]
    force = "--force" in args
    only_codes = [a for a in args if not a.startswith("--")]

    print("=" * 60)
    print("박스 이미지 자동 다운로드 (SNKRDUNK 검색)")
    print("=" * 60)

    sets = parse_pokemon_sets()
    if only_codes:
        sets = [s for s in sets if s[0] in only_codes]

    success = 0
    fail = 0
    skipped = 0
    for code, name, _url in sets:
        save_path = IMAGES_DIR / f"{code}.jpg"
        if save_path.exists() and not force:
            skipped += 1
            continue
        print(f"\n[{code}] {name}")
        img_url, found_name = find_box_image(code, name)
        if not img_url:
            print(f"  ❌ 이미지 못 찾음")
            fail += 1
            continue
        try:
            size = download_image(img_url, save_path)
            print(f"  ✓ {save_path.name} ({size//1024} KB) — {found_name[:40]}")
            success += 1
        except Exception as e:
            print(f"  ❌ 다운로드 실패: {e}")
            fail += 1

    print(f"\n{'=' * 60}")
    print(f"  완료: ✓ {success} / ❌ {fail} / ⏭ {skipped} (이미 있음)")


if __name__ == "__main__":
    main()
