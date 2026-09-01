"""
fetch_set_images.py — 세트 박스 이미지 자체 호스팅

각 세트 URL (tcgcollector / tcgrepublic) 페이지의 og:image 메타 태그
또는 첫 번째 큰 이미지를 추출 → images/sets/{code}.jpg 로 다운.

소요 시간: 한 번 실행 ~3분
운영: 신규 세트 발매 시만 추가 실행 (월 1~2회)

사용:
  python scripts/fetch_set_images.py
  python scripts/fetch_set_images.py --force    # 기존 파일 덮어쓰기
  python scripts/fetch_set_images.py --force --only M6 OP17
"""

import re
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IMG_DIR = ROOT / "images" / "sets"
IMG_DIR.mkdir(parents=True, exist_ok=True)

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# index.html 의 CARDINFO 와 동일한 세트 목록
POKEMON_SETS = [
    ("M6", "https://cdn.snkrdunk.com/upload_bg_removed/6828644c-01c4-44df-ab9e-a447be1cdff9.webp?size=l"),
    ("M5", None),  # M5 = 어비스아이 (URL 없음, 발매 후 업데이트)
    ("M4", "https://www.tcgcollector.com/sets/11800/ninja-spinner"),
    ("M3", "https://www.tcgcollector.com/sets/11684/nullifying-zero"),
    ("M2a", "https://www.tcgcollector.com/sets/11678/mega-dream-ex"),
    ("M2", "https://www.tcgcollector.com/sets/11675/inferno-x"),
    ("M1L", "https://www.tcgcollector.com/sets/11660/mega-brave"),
    ("M1S", "https://www.tcgcollector.com/sets/11661/mega-symphonia"),
    ("SV11B", "https://www.tcgcollector.com/sets/11652/black-bolt"),
    ("SV11W", "https://www.tcgcollector.com/sets/11653/white-flare"),
    ("SV10", "https://www.tcgcollector.com/sets/11649/the-glory-of-team-rocket"),
    ("SV9a", "https://www.tcgcollector.com/sets/11648/hot-air-arena"),
    ("SV9", "https://www.tcgcollector.com/sets/11643/battle-partners"),
    ("SV8a", "https://www.tcgcollector.com/sets/11640/terastal-festival-ex"),
    ("SV8", "https://www.tcgcollector.com/sets/11638/super-electric-breaker"),
    ("SV7a", "https://www.tcgcollector.com/sets/11635/paradise-dragona"),
    ("SV7", "https://www.tcgcollector.com/sets/11629/stellar-miracle"),
    ("SV6a", "https://www.tcgcollector.com/sets/11626/night-wanderer"),
    ("SV6", "https://www.tcgcollector.com/sets/11624/mask-of-change"),
    ("SV5a", "https://www.tcgcollector.com/sets/11622/crimson-haze"),
    ("SV5M", "https://www.tcgcollector.com/sets/11604/cyber-judge"),
]

ONEPIECE_SETS = [
    ("OP17", "https://cdn.snkrdunk.com/upload_bg_removed/067ebb9d-ffc2-49c7-9abc-3eb7eb863388.webp?size=l"),
    ("OP16", None),  # nolink
    ("OP15", "https://tcgrepublic.com/category/subcategory_page_10948.html"),
    ("EB04", "https://tcgrepublic.com/category/subcategory_page_10895.html"),
    ("OP14", "https://tcgrepublic.com/category/subcategory_page_10744.html"),
    ("EB03", "https://tcgrepublic.com/category/subcategory_page_10671.html"),
    ("OP13", "https://tcgrepublic.com/category/subcategory_page_10545.html"),
    ("OP12", "https://tcgrepublic.com/category/subcategory_page_10336.html"),
    ("OP11", "https://tcgrepublic.com/category/subcategory_page_10172.html"),
    ("EB02", "https://tcgrepublic.com/category/subcategory_page_10091.html"),
    ("OP10", "https://tcgrepublic.com/category/subcategory_page_9987.html"),
    ("OP09", "https://tcgrepublic.com/category/subcategory_page_9758.html"),
    ("OP08", "https://tcgrepublic.com/category/subcategory_page_9499.html"),
    ("OP07", "https://tcgrepublic.com/category/subcategory_page_9138.html"),
    ("EB01", "https://tcgrepublic.com/category/subcategory_page_9054.html"),
    ("OP06", "https://tcgrepublic.com/category/category_page_67.html"),
    ("OP05", "https://tcgrepublic.com/category/subcategory_page_8690.html"),
    ("OP04", "https://tcgrepublic.com/category/subcategory_page_8492.html"),
    ("OP03", "https://tcgrepublic.com/category/subcategory_page_8014.html"),
    ("OP02", "https://tcgrepublic.com/category/subcategory_page_7712.html"),
    ("OP01", "https://tcgrepublic.com/category/subcategory_page_7322.html"),
]


def fetch_html(url: str, timeout: int = 15) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        # 인코딩 추측
        for enc in ("utf-8", "euc-kr", "cp949"):
            try:
                return raw.decode(enc)
            except UnicodeDecodeError:
                continue
        return raw.decode("utf-8", errors="ignore")


def extract_image_url(html: str, base_url: str) -> str | None:
    """og:image / twitter:image 메타 태그 우선, 없으면 큰 이미지 첫 번째"""
    # og:image
    m = re.search(r'<meta\s+property=["\']og:image["\']\s+content=["\']([^"\']+)["\']', html, re.IGNORECASE)
    if m:
        return absolutize(m.group(1), base_url)
    # twitter:image
    m = re.search(r'<meta\s+name=["\']twitter:image["\']\s+content=["\']([^"\']+)["\']', html, re.IGNORECASE)
    if m:
        return absolutize(m.group(1), base_url)
    # 첫 번째 큰 이미지 (.jpg / .png / .webp, src 가 절대경로 또는 상대경로)
    for m in re.finditer(r'<img[^>]+src=["\']([^"\']+\.(?:jpg|jpeg|png|webp))["\']', html, re.IGNORECASE):
        url = m.group(1)
        # 작은 아이콘 / 로고 제외
        low = url.lower()
        if any(s in low for s in ("logo", "icon", "favicon", "sprite", "spinner", "loading")):
            continue
        return absolutize(url, base_url)
    return None


def absolutize(url: str, base: str) -> str:
    if url.startswith(("http://", "https://")):
        return url
    if url.startswith("//"):
        return "https:" + url
    if url.startswith("/"):
        m = re.match(r"(https?://[^/]+)", base)
        return (m.group(1) if m else base) + url
    return base.rstrip("/") + "/" + url


def download_image(url: str, dest: Path):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Referer": "https://www.google.com/"})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read()
    dest.write_bytes(data)


def process_set(code: str, url: str | None, force: bool) -> str:
    dest = IMG_DIR / f"{code}.jpg"
    if dest.exists() and not force:
        return f"skip (exists)"
    if not url:
        return "skip (no URL)"
    # 신규 세트는 SNKRDUNK 상품 CDN 이미지를 직접 내려받아 외부 링크 만료를 방지한다.
    if "cdn.snkrdunk.com/upload" in url:
        try:
            download_image(url, dest)
            # CDN 원본은 투명 여백이 큰 WebP이므로 상품 영역을 잘라낸 뒤 JPEG로 저장한다.
            # 그대로 변환하면 신규 박스만 기존 타일보다 지나치게 작게 보인다.
            from PIL import Image, ImageChops
            with Image.open(dest) as im:
                rgba = im.convert("RGBA")
                alpha = rgba.getchannel("A")
                bbox = alpha.getbbox()
                if not bbox:
                    rgb_source = rgba.convert("RGB")
                    bbox = ImageChops.difference(
                        rgb_source, Image.new("RGB", rgb_source.size, "white")
                    ).getbbox()
                if bbox:
                    left, top, right, bottom = bbox
                    margin = max(12, int(max(right - left, bottom - top) * 0.10))
                    bbox = (
                        max(0, left - margin), max(0, top - margin),
                        min(rgba.width, right + margin), min(rgba.height, bottom + margin),
                    )
                    rgba = rgba.crop(bbox)
                    alpha = rgba.getchannel("A")
                if alpha.getextrema()[0] < 255:
                    rgb = Image.new("RGB", rgba.size, "white")
                    rgb.paste(rgba, mask=alpha)
                else:
                    rgb = rgba.convert("RGB")
                rgb.save(dest, "JPEG", quality=92, optimize=True)
            size_kb = dest.stat().st_size // 1024
            return f"✓ SNKRDUNK {size_kb} KB"
        except Exception as e:
            dest.unlink(missing_ok=True)
            return f"FAIL SNKRDUNK image: {e}"
    try:
        html = fetch_html(url)
    except Exception as e:
        return f"FAIL fetch: {e}"
    img_url = extract_image_url(html, url)
    if not img_url:
        return "FAIL no image"
    try:
        download_image(img_url, dest)
        size_kb = dest.stat().st_size // 1024
        return f"✓ {size_kb} KB"
    except Exception as e:
        return f"FAIL download: {e}"


def main():
    force = "--force" in sys.argv
    only_codes = None
    if "--only" in sys.argv:
        idx = sys.argv.index("--only")
        only_codes = {a for a in sys.argv[idx + 1:] if not a.startswith("--")}
    print("=" * 60)
    print(f"세트 박스 이미지 다운로드 → {IMG_DIR.relative_to(ROOT)}/")
    print(f"옵션: force={force} (--force 플래그로 기존 덮어쓰기)")
    print("=" * 60)

    print("\n━━━ 포켓몬 ━━━")
    for code, url in POKEMON_SETS:
        if only_codes and code not in only_codes:
            continue
        result = process_set(code, url, force)
        print(f"  {code:7s} {result}")
        time.sleep(0.5)

    print("\n━━━ 원피스 ━━━")
    for code, url in ONEPIECE_SETS:
        if only_codes and code not in only_codes:
            continue
        result = process_set(code, url, force)
        print(f"  {code:7s} {result}")
        time.sleep(0.5)

    print(f"\n완료. {IMG_DIR.relative_to(ROOT)}/ 확인")


if __name__ == "__main__":
    main()
