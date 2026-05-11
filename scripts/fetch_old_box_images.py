"""
fetch_old_box_images.py — bulbapedia 에서 121개 옛날 박스 이미지 다운로드

_pending-pokemon-boxes.json 의 박스 → 영문명으로 bulbapedia URL 생성 →
og:image 또는 본문 첫 이미지 추출 → /images/box/{CODE}.jpg 저장.

사용:
  python scripts/fetch_old_box_images.py            # 누락 박스만
  python scripts/fetch_old_box_images.py --force    # 전부 재다운로드
  python scripts/fetch_old_box_images.py S6H S6K    # 특정 박스만
"""
import json
import re
import sys
import time
import urllib.request
import urllib.error
import urllib.parse
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PENDING = ROOT / "data" / "_pending-pokemon-boxes.json"
IMAGES_DIR = ROOT / "images" / "box"
IMAGES_DIR.mkdir(parents=True, exist_ok=True)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

# 영문명 → bulbapedia 페이지 slug 보정 (예외 처리)
BULBA_OVERRIDES = {
    "Silver Lance": "Silver_Lance_(TCG)",
    "Jet-Black Spirit": "Jet-Black_Spirit_(TCG)",
    "Matchless Fighter": "Matchless_Fighters_(TCG)",
    "Rapid Strike Master": "Rapid_Strike_Master_(TCG)",
    "Single Strike Master": "Single_Strike_Master_(TCG)",
    "Shiny Star V": "Shiny_Star_V_(TCG)",
    "Amazing Volt Tackle": "Amazing_Volt_Tackle_(TCG)",
    "Legendary Heartbeat": "Legendary_Heartbeat_(TCG)",
    "Infinity Zone": "Infinity_Zone_(TCG)",
    "Explosive Walker": "Explosive_Walker_(TCG)",
    "Rebellion Crash": "Rebellion_Crash_(TCG)",
    "VMAX Rising": "VMAX_Rising_(TCG)",
    "Shield": "Shield_Expansion_(TCG)",
    "Sword": "Sword_Expansion_(TCG)",
    "Base Expansion Pack (Ruby & Sapphire)": "EX_Ruby_%26_Sapphire_(TCG)",
    "Expansion Pack (Ruby & Sapphire)": "EX_Ruby_%26_Sapphire_(TCG)",
    "Magma vs Aqua: Two Ambitions": "EX_Team_Magma_vs_Team_Aqua_(TCG)",
    "Rulers of the Heavens": "EX_Dragon_(TCG)",
    "Miracle of the Desert": "EX_Sandstorm_(TCG)",
    "Mysterious Mountains": "Skyridge_(TCG)",
    "Split Earth": "Aquapolis_(TCG)",
    "Wind from the Sea": "Aquapolis_(TCG)",
    "The Town on No Map": "Aquapolis_(TCG)",
    "Base Expansion Pack": "Expedition_Base_Set_(TCG)",
    "Darkness, and to Light": "Neo_Destiny_(TCG)",
    "Awakening Legends": "Neo_Revelation_(TCG)",
    "Crossing the Ruins": "Neo_Discovery_(TCG)",
    "Gold, Silver, to a New World": "Neo_Genesis_(TCG)",
    "Challenge from the Darkness": "Gym_Challenge_(TCG)",
    "Leaders' Stadium": "Gym_Heroes_(TCG)",
    "Team Rocket": "Team_Rocket_(TCG)",
    "Mystery of the Fossils": "Fossil_(TCG)",
    "Pokémon Jungle": "Jungle_(TCG)",
    "Base Set / Expansion Pack": "Base_Set_(TCG)",
}

def bulba_url(en_name: str) -> str:
    if en_name in BULBA_OVERRIDES:
        return f"https://bulbapedia.bulbagarden.net/wiki/{BULBA_OVERRIDES[en_name]}"
    # 일반 변환: 공백 → _, 콜론/괄호 정리
    name = en_name.split("(")[0].strip()
    name = name.replace(":", "").rstrip()
    slug = urllib.parse.quote(name.replace(" ", "_"))
    return f"https://bulbapedia.bulbagarden.net/wiki/{slug}_(TCG)"

def fetch_html(url: str, timeout=20) -> str | None:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", errors="ignore")
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None  # 페이지 없음
        print(f"  [http {e.code}] {url}")
        return None
    except Exception as e:
        print(f"  [fail] {e}")
        return None

def extract_image_url(html: str) -> str | None:
    # 1. og:image (가장 정확)
    m = re.search(r'<meta property="og:image" content="([^"]+)"', html)
    if m:
        return m.group(1)
    # 2. 본문 첫 큰 이미지 (infobox 의 박스 이미지)
    m = re.search(r'<img[^>]+src="(//archives\.bulbagarden\.net/media/upload/[^"]+\.(?:jpg|jpeg|png))"', html, re.I)
    if m:
        return "https:" + m.group(1)
    return None

def download_image(url: str, dest: Path) -> bool:
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=20) as r:
            data = r.read()
        dest.write_bytes(data)
        return True
    except Exception as e:
        print(f"  [download fail] {e}")
        return False

def main():
    args = sys.argv[1:]
    force = "--force" in args
    only = [a for a in args if not a.startswith("--")]

    with PENDING.open(encoding="utf-8") as f:
        boxes = json.load(f)["boxes"]

    if only:
        boxes = [b for b in boxes if b["code"] in only]

    print(f"=== bulbapedia 박스 이미지 다운로드 ({len(boxes)}개) ===\n")
    ok, skipped, failed = [], [], []
    for box in boxes:
        code = box["code"]
        en = box.get("en_name", "")
        # 파일명에 "/" 안 들어가게
        safe_code = code.replace("/", "-")
        dest = IMAGES_DIR / f"{safe_code}.jpg"
        if dest.exists() and not force:
            skipped.append(code)
            continue
        if not en:
            print(f"[{code}] 영문명 없음 — skip")
            failed.append(code)
            continue

        page_url = bulba_url(en)
        print(f"[{code}] {en}")
        print(f"  page: {page_url}")
        html = fetch_html(page_url)
        if not html:
            print(f"  ✗ page not found")
            failed.append(code)
            time.sleep(0.5)
            continue

        img_url = extract_image_url(html)
        if not img_url:
            print(f"  ✗ 이미지 못 찾음")
            failed.append(code)
            time.sleep(0.5)
            continue

        print(f"  img: {img_url[:80]}...")
        if download_image(img_url, dest):
            size = dest.stat().st_size
            print(f"  ✓ saved {size} bytes → {dest.name}")
            ok.append(code)
        else:
            failed.append(code)
        time.sleep(0.5)  # rate limit 예방

    print(f"\n=== 결과 ===")
    print(f"  ✓ 성공: {len(ok)}")
    print(f"  ⊘ 이미 있음 (skip): {len(skipped)}")
    print(f"  ✗ 실패: {len(failed)}")
    if failed:
        print(f"\n실패 박스 (수동 다운로드 필요):")
        for c in failed:
            box = next((b for b in boxes if b["code"] == c), None)
            print(f"  - {c} ({box.get('en_name', '?')})")

if __name__ == "__main__":
    main()
