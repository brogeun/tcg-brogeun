"""
SNKRDUNK 인기 카드 TOP 10 스크래퍼
GitHub Actions 가 매일 04:00 KST 에 실행
결과를 data/top10-{brand}.json 으로 저장
"""

import json
import re
import time
import sys
from pathlib import Path
from datetime import datetime, timezone

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait

# ─────────── 설정 ───────────
URLS = {
    "pokemon": "https://snkrdunk.com/brands/pokemon/categories/6",
    "onepiece": "https://snkrdunk.com/brands/onepiece/categories/6",
}

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def make_driver():
    """헤드리스 Chrome 인스턴스"""
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_argument("--window-size=1280,2400")
    opts.add_argument("--lang=ja-JP")
    opts.add_argument(f"--user-agent={UA}")
    return webdriver.Chrome(options=opts)


def scroll_thoroughly(driver, pause=1.5):
    """페이지 위→아래→위 반복 스크롤로 lazy load 확실히 발동"""
    sequence = [0, 400, 800, 1200, 1600, 2000, 2400, 1200, 0, 800, 0]
    for y in sequence:
        driver.execute_script(f"window.scrollTo({{ top: {y}, behavior: 'smooth' }});")
        time.sleep(pause)


def wait_for_product_images(driver, timeout=20, min_count=5):
    """실제 상품 이미지가 N개 이상 로드될 때까지 대기"""
    js_check = """
        const imgs = document.querySelectorAll('img[src*="cdn.snkrdunk.com/upload"]');
        if (imgs.length < arguments[0]) return false;
        let loaded = 0;
        for (const img of imgs) {
            if (img.complete && img.naturalHeight !== 0) loaded++;
        }
        return loaded >= arguments[0];
    """
    try:
        WebDriverWait(driver, timeout).until(
            lambda d: d.execute_script(js_check, min_count)
        )
        print(f"  ✓ {min_count}개 이상 상품 이미지 로드 확인")
    except Exception:
        print(f"  ⚠ 이미지 로드 대기 타임아웃 - 진행 강행")


# ─────────── HTML 문자열 기반 추출 (ScrapingBee Worker 방식과 동일) ───────────

URL_RE = re.compile(r'/apparels/(\d+)')
IMG_CDN_RE = re.compile(
    r'<img[^>]+src="(https://cdn\.snkrdunk\.com/upload[^"]+)"', re.IGNORECASE
)
ALT_RE = re.compile(r'<img[^>]+alt="([^"]+)"', re.IGNORECASE)
PRICE_RE = re.compile(r'¥\s*([\d,]+)')


def extract_from_html(html: str) -> list:
    """HTML 문자열에서 URL 위치 기준 ±윈도우로 상품 정보 추출"""
    out = []
    seen = set()
    for m in URL_RE.finditer(html):
        if len(out) >= 10:
            break
        product_id = m.group(1)
        if product_id in seen:
            continue
        # 윈도우: 앞 800자 + 뒤 4000자
        start = max(0, m.start() - 800)
        end = min(len(html), m.start() + 4000)
        window = html[start:end]

        # 이미지 (CDN upload URL)
        img_m = IMG_CDN_RE.search(window)
        if not img_m:
            continue  # 이미지 없으면 패스 (lazy load 안 된 거)
        image = img_m.group(1).replace("?size=m", "?size=l")

        # 가격 (윈도우 내 첫 ¥ 패턴)
        price_m = PRICE_RE.search(window)
        if not price_m:
            continue
        try:
            price = int(price_m.group(1).replace(",", ""))
        except ValueError:
            continue
        if not (50 <= price <= 100000000):
            continue

        # 이름 (img alt 중 의미있는 것)
        name = None
        for alt_m in ALT_RE.finditer(window):
            alt = alt_m.group(1).strip()
            if (
                len(alt) > 5
                and alt != "SNKRDUNK"
                and not re.fullmatch(r"[a-z\-_]+", alt)
            ):
                name = alt
                break
        if not name:
            name = f"Card #{product_id}"

        seen.add(product_id)
        out.append(
            {
                "id": product_id,
                "name": name,
                "image": image,
                "lastPrice": price,
                "url": f"https://snkrdunk.com/apparels/{product_id}",
            }
        )
    return out


def scrape_brand(brand: str, url: str) -> list:
    print(f"\n[{brand}] {url}")
    driver = make_driver()
    try:
        driver.get(url)
        time.sleep(4)
        scroll_thoroughly(driver)
        wait_for_product_images(driver, timeout=20, min_count=5)
        # 한 번 더 위에서 아래로 천천히 스크롤 (lazy 강제)
        for y in [200, 600, 1000, 1400, 1800, 2200, 0]:
            driver.execute_script(f"window.scrollTo(0, {y});")
            time.sleep(1.0)
        time.sleep(2)
        html = driver.page_source
        print(f"  HTML 길이: {len(html):,} 자")
        products = extract_from_html(html)
        print(f"[{brand}] 추출 완료: {len(products)}개")
        for i, p in enumerate(products, 1):
            img_status = "✓" if p.get("image") else "✗"
            print(f"  {i}. {img_status} ¥{p['lastPrice']:>7,} | {p['name'][:50]}")
        return products
    finally:
        driver.quit()


def main():
    fetched_at = datetime.now(timezone.utc).isoformat()
    fail_count = 0
    for brand, url in URLS.items():
        try:
            products = scrape_brand(brand, url)
            if not products:
                print(f"[{brand}] ⚠ 0개 추출 - 기존 데이터 유지")
                fail_count += 1
                continue
            payload = {
                "ok": True,
                "brand": brand,
                "count": len(products),
                "products": products,
                "fetchedAt": fetched_at,
            }
            out_path = DATA_DIR / f"top10-{brand}.json"
            out_path.write_text(
                json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            print(f"[{brand}] 저장: {out_path.relative_to(DATA_DIR.parent)}")
        except Exception as e:
            print(f"[{brand}] ❌ 에러: {e}")
            fail_count += 1
    if fail_count == len(URLS):
        print("\n전체 실패 → exit 1")
        sys.exit(1)
    print(f"\n완료. 실패 {fail_count}/{len(URLS)}")


if __name__ == "__main__":
    main()
