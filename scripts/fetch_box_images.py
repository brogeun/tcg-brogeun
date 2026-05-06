"""
fetch_box_images.py — tcgcollector 박스 페이지 og:image → 박스 이미지 다운로드

사용:
  python scripts/fetch_box_images.py            # 누락된 박스만
  python scripts/fetch_box_images.py --force    # 전부 재다운로드
  python scripts/fetch_box_images.py SV5K SV4a  # 특정 박스만

흐름:
  1. fetch_set_cards.py 의 POKEMON_SETS 리스트 읽음
  2. images/sets/{code}.jpg 가 없는 박스만 처리 (--force 면 전부)
  3. tcgcollector 박스 페이지 HTML fetch
  4. <meta property="og:image" content="..."> 또는 박스 패키지 이미지 추출
  5. 이미지 다운로드 후 images/sets/{code}.jpg 로 저장

장점:
  - tcgcollector 가 박스 대표 이미지를 og:image 로 제공
  - 한국 IP 잘 받음 (외부 차단 X)
  - selenium 불필요 (urllib 만으로 충분)
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


def fetch_html(url, timeout=20):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,*/*",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")


def extract_box_image(html, set_url):
    """박스 페이지 HTML 에서 대표 이미지 URL 추출
    우선순위:
      1. og:image (페이지 대표 이미지 — 보통 박스 사진)
      2. <img class="set-logo"> 또는 set-image 클래스
      3. 첫 번째 큰 이미지
    """
    # 1) og:image
    m = re.search(
        r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\']([^"\']+)["\']',
        html, re.IGNORECASE)
    if m:
        return m.group(1)
    m = re.search(
        r'<meta[^>]+content=["\']([^"\']+)["\'][^>]+property=["\']og:image["\']',
        html, re.IGNORECASE)
    if m:
        return m.group(1)

    # 2) set-logo / set-image / set-symbol-image-... 클래스
    for cls in ("set-logo", "set-image", "set-symbol", "set-image-large"):
        m = re.search(
            rf'<img[^>]+class=["\'][^"\']*{cls}[^"\']*["\'][^>]+src=["\']([^"\']+)["\']',
            html, re.IGNORECASE)
        if m:
            src = m.group(1)
            if src.startswith("//"): src = "https:" + src
            elif src.startswith("/"): src = "https://www.tcgcollector.com" + src
            return src

    # 3) twitter:image fallback
    m = re.search(
        r'<meta[^>]+name=["\']twitter:image["\'][^>]+content=["\']([^"\']+)["\']',
        html, re.IGNORECASE)
    if m:
        return m.group(1)

    return None


def download_image(url, save_path):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Referer": "https://www.tcgcollector.com/",
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()
    save_path.write_bytes(data)
    return len(data)


def main():
    args = sys.argv[1:]
    force = "--force" in args
    only_codes = [a for a in args if not a.startswith("--")]

    print("=" * 60)
    print("박스 이미지 자동 다운로드 (tcgcollector og:image)")
    print("=" * 60)

    sets = parse_pokemon_sets()
    if only_codes:
        sets = [s for s in sets if s[0] in only_codes]

    success = 0
    fail = 0
    skipped = 0
    for code, name, url in sets:
        save_path = IMAGES_DIR / f"{code}.jpg"
        if save_path.exists() and not force:
            skipped += 1
            continue
        print(f"\n[{code}] {name}")
        # tcgcollector URL 에 displayAs 같은 쿼리 제거
        clean_url = url.split("?")[0]
        try:
            html = fetch_html(clean_url)
        except Exception as e:
            print(f"  ❌ HTML fetch 실패: {e}")
            fail += 1
            continue
        img_url = extract_box_image(html, clean_url)
        if not img_url:
            print(f"  ❌ og:image 추출 실패")
            fail += 1
            continue
        print(f"  → og:image: {img_url[:80]}{'...' if len(img_url) > 80 else ''}")
        try:
            size = download_image(img_url, save_path)
            print(f"  ✓ {save_path.name} ({size//1024} KB)")
            success += 1
        except Exception as e:
            print(f"  ❌ 다운로드 실패: {e}")
            fail += 1

    print(f"\n{'=' * 60}")
    print(f"  완료: ✓ {success} / ❌ {fail} / ⏭ {skipped} (이미 있음)")


if __name__ == "__main__":
    main()
