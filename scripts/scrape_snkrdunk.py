"""
SNKRDUNK 인기 카드 TOP 10 스크래퍼
GitHub Actions 가 매일 04:00 KST 에 실행
결과를 data/top10-{brand}.json 으로 저장
"""

import json
import time
import sys
from pathlib import Path
from datetime import datetime, timezone

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.common.by import By

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
    opts.add_argument("--window-size=1280,2000")
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
        print(f"  ⚠ 이미지 로드 대기 타임아웃 — 진행 강행")


def extract_top10(driver):
    """JS 로 페이지에서 TOP 10 추출 (DOM 직접 파싱)"""
    js = r"""
    const out = [];
    const seen = new Set();
    const links = document.querySelectorAll('a[href*="/apparels/"]');
    for (const a of links) {
        if (out.length >= 10) break;
        const href = a.getAttribute('href') || '';
        const m = href.match(/\/apparels\/(\d+)/);
        if (!m) continue;
        const id = m[1];
        if (seen.has(id)) continue;

        // 이미지: a 안 → 부모 컨테이너 검색
        let image = null;
        const findImg = (root) => {
            const imgs = root.querySelectorAll('img');
            for (const img of imgs) {
                const src = img.currentSrc || img.src || img.getAttribute('src') || '';
                if (src.includes('cdn.snkrdunk.com/upload')) {
                    return src.replace(/\?size=m\b/, '?size=l');
                }
            }
            return null;
        };
        image = findImg(a);
        if (!image) {
            let p = a.parentElement;
            for (let i = 0; i < 4 && p; i++) {
                image = findImg(p);
                if (image) break;
                p = p.parentElement;
            }
        }

        // 이름: alt → 텍스트
        let name = null;
        const imgs = a.querySelectorAll('img');
        for (const img of imgs) {
            const alt = (img.alt || '').trim();
            if (alt.length > 5 && alt !== 'SNKRDUNK' && !/^[a-z\-_]+$/.test(alt)) {
                name = alt; break;
            }
        }
        if (!name) {
            let p = a.parentElement;
            for (let i = 0; i < 3 && p; i++) {
                const imgs2 = p.querySelectorAll('img');
                for (const img of imgs2) {
                    const alt = (img.alt || '').trim();
                    if (alt.length > 5 && alt !== 'SNKRDUNK' && !/^[a-z\-_]+$/.test(alt)) {
                        name = alt; break;
                    }
                }
                if (name) break;
                p = p.parentElement;
            }
        }
        if (!name) {
            const txt = (a.textContent || '').trim();
            if (txt.length > 5) name = txt.slice(0, 100);
        }

        // 가격: 부모 컨테이너에서 ¥숫자 패턴 찾기
        let price = null;
        let p = a.parentElement;
        for (let i = 0; i < 4 && p; i++) {
            const t = p.textContent || '';
            const pm = t.match(/¥\s*([\d,]+)/);
            if (pm) {
                const n = parseInt(pm[1].replace(/,/g, ''), 10);
                if (n >= 50 && n <= 100000000) { price = n; break; }
            }
            p = p.parentElement;
        }

        if (!price) continue;
        if (!name) name = 'Card #' + id;

        seen.add(id);
        out.push({
            id: id,
            name: name,
            image: image,
            lastPrice: price,
            url: 'https://snkrdunk.com/apparels/' + id
        });
    }
    return out;
    """
    result = driver.execute_script(js)
    return result if result is not None else []


def scrape_brand(brand, url):
    print(f"\n[{brand}] {url}")
    driver = make_driver()
    try:
        driver.get(url)
        time.sleep(4)  # 초기 렌더
        scroll_thoroughly(driver)
        wait_for_product_images(driver, timeout=20, min_count=5)
        time.sleep(2)  # 안정화
        # 한 번 더 스크롤 (혹시 누락된 lazy 이미지)
        driver.execute_script("window.scrollTo(0, 0);")
        time.sleep(1)
        products = extract_top10(driver)
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
                print(f"[{brand}] ⚠ 0개 추출 — 기존 데이터 유지")
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
