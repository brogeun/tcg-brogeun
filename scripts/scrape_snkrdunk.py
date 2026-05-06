"""
SNKRDUNK 인기 카드 TOP 10 스크래퍼
GitHub Actions 가 매일 04:00 KST 에 실행
결과를 data/top10-{brand}.json 으로 저장
"""

import json
import re
import time
import sys
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime, timezone

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.support.ui import WebDriverWait

# ─────────── 설정 ───────────
# 홈 TOP 10 (브랜드 카테고리 페이지)
TOP10_URLS = {
    "pokemon": "https://snkrdunk.com/brands/pokemon/categories/6",
    "onepiece": "https://snkrdunk.com/brands/onepiece/categories/6",
}

# 카드 시세 페이지 — 사용자가 직접 지정한 EN URL (슬라이드 파라미터 포함)
# 박스: categoryId=14 / 카드: categoryId=25&slide=right
PRICE_URLS_PRIMARY = {
    "pokemon-box":   "https://snkrdunk.com/en/brands/pokemon/trading-cards?categoryId=14",
    "pokemon-card":  "https://snkrdunk.com/en/brands/pokemon/trading-cards?categoryId=25&slide=right",
    "onepiece-box":  "https://snkrdunk.com/en/brands/onepiece/trading-cards?categoryId=14",
    "onepiece-card": "https://snkrdunk.com/en/brands/onepiece/trading-cards?categoryId=25&slide=right",
}
# Primary 가 비어있을 때 fallback — /en/brands/.../trading-cards (전체) 받아서 이름 패턴으로 박스/카드 분리
PRICE_URLS_FALLBACK = {
    "pokemon-box":   ("https://snkrdunk.com/en/brands/pokemon/trading-cards",  "box"),
    "pokemon-card":  ("https://snkrdunk.com/en/brands/pokemon/trading-cards",  "card"),
    "onepiece-box":  ("https://snkrdunk.com/en/brands/onepiece/trading-cards", "box"),
    "onepiece-card": ("https://snkrdunk.com/en/brands/onepiece/trading-cards", "card"),
}
# 이름으로 박스/카드 분류
# 카드: [세트코드 번호] 대괄호가 있음  (예: [s12a 226/172], [P-055], [SV-P 289])
# 박스: 대괄호 없고 「」 풀와이드 따옴표 안에 세트명
CARD_BRACKET_RE = re.compile(r'\[[^\]]*\d+[^\]]*\]')
# 강제 박스 키워드 (대괄호 있어도 박스로 분류 — 예: 박스 상품에 카드번호 표기될 일 거의 없으나 안전장치)
HARD_BOX_KEYWORDS = ('ボックス', 'BOX', 'スペシャルBOX', 'スターターデッキ')

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def make_driver(lang: str = "en-US"):
    """헤드리스 Chrome 인스턴스 — 기본은 EN (lang=en-US), JP 필요시 ja-JP 지정"""
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_argument("--window-size=1280,2400")
    opts.add_argument(f"--lang={lang}")
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

URL_RE = re.compile(r'(?:/en)?/(?:apparels|trading-cards)/(\d+)')
IMG_CDN_RE = re.compile(
    r'<img[^>]+src="(https://cdn\.snkrdunk\.com/upload[^"]+)"', re.IGNORECASE
)
ALT_RE = re.compile(r'<img[^>]+alt="([^"]+)"', re.IGNORECASE)
# ¥ 또는 $ 가격 (둘 다 매칭)
PRICE_RE = re.compile(r'¥\s*([\d,]+)|\$\s*([\d.,]+)|US\$\s*([\d.,]+)')

# 모듈 레벨 환율 캐시 (한 번만 fetch)
_USD_JPY_CACHE = {"rate": 150.0, "fetched": False}


def get_usd_jpy() -> float:
    if _USD_JPY_CACHE["fetched"]:
        return _USD_JPY_CACHE["rate"]
    try:
        req = urllib.request.Request(
            "https://api.exchangerate-api.com/v4/latest/USD",
            headers={"User-Agent": UA},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            d = json.loads(resp.read().decode("utf-8"))
        rate = float(d["rates"]["JPY"])
        if 100 < rate < 200:
            _USD_JPY_CACHE["rate"] = rate
    except Exception as e:
        print(f"  FX fetch err: {e}")
    _USD_JPY_CACHE["fetched"] = True
    return _USD_JPY_CACHE["rate"]


def extract_from_html(html: str, max_items: int = 10) -> list:
    """HTML 문자열에서 URL 위치 기준 forward 전용 윈도우로 상품 정보 추출.
       BUG FIX: 이전엔 앞 800자 포함했는데, 옆 카드 영역까지 침범해서 ID-name mismatch 발생.
       이제 URL 다음 → 다음 URL 직전까지만 검색."""
    out = []
    seen = set()
    matches = list(URL_RE.finditer(html))
    positions = [m.start() for m in matches]
    for i, m in enumerate(matches):
        if len(out) >= max_items:
            break
        product_id = m.group(1)
        if product_id in seen:
            continue
        # 윈도우 = [현재 URL 매치 끝, 다음 URL 매치 시작) — 절대 이웃 카드 침범 안 함
        # (이미지/가격이 보통 <a href=URL><img><div>price</div></a> 형식으로 URL 뒤에 옴)
        start = m.end()
        next_pos = positions[i + 1] if i + 1 < len(positions) else (start + 5000)
        end = min(len(html), next_pos, start + 5000)
        window = html[start:end]

        # 이미지 (CDN upload URL)
        img_m = IMG_CDN_RE.search(window)
        if not img_m:
            continue
        image = img_m.group(1).replace("?size=m", "?size=l")

        # 가격 — ¥ 또는 $ 그대로 저장, 환산 절대 안 함
        price_m = PRICE_RE.search(window)
        if not price_m:
            continue
        try:
            if price_m.group(1):  # ¥ (JP 사이트)
                price_val = int(price_m.group(1).replace(",", ""))
                currency = "JPY"
            else:  # $ 또는 US$ (EN 사이트)
                usd_str = price_m.group(2) or price_m.group(3)
                price_val = float(usd_str.replace(",", ""))
                currency = "USD"
        except (ValueError, AttributeError):
            continue
        # 합리적 범위 체크 (USD 1~10000, JPY 50~100M)
        if currency == "USD" and not (1 <= price_val <= 10000):
            continue
        if currency == "JPY" and not (50 <= price_val <= 100000000):
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
                "lastPrice": price_val,
                "currency": currency,
                "url": f"https://snkrdunk.com/en/trading-cards/{product_id}?slide=right",
            }
        )
    return out


def deep_scroll(driver, max_height: int = 12000, step: int = 400, pause: float = 0.7):
    """최대 12000px 까지 천천히 내려가며 lazy load 확실히 발동 — Phase 2 깊은 스크롤용"""
    cur = 0
    last_height = 0
    while cur <= max_height:
        driver.execute_script(f"window.scrollTo(0, {cur});")
        time.sleep(pause)
        cur += step
        # 페이지 끝 도달 체크 (3회 연속 height 변화 없으면 stop)
        h = driver.execute_script("return document.body.scrollHeight")
        if h == last_height and cur > 4000:
            break
        last_height = h
    # 마지막에 다시 위로
    driver.execute_script("window.scrollTo(0, 0);")
    time.sleep(0.5)


def scrape_url(label: str, url: str, max_items: int = 10) -> list:
    print(f"\n[{label}] {url}")
    driver = make_driver()
    try:
        driver.get(url)
        time.sleep(4)
        # 1차: 기본 스크롤 + 이미지 대기
        scroll_thoroughly(driver)
        wait_for_product_images(driver, timeout=20, min_count=5)
        # 2차: max_items 가 클 때만 깊은 스크롤 (Phase 2 = 30개)
        if max_items > 10:
            print(f"  ⤵ 깊은 스크롤 (목표 {max_items}개)")
            deep_scroll(driver, max_height=12000, step=400, pause=0.7)
        else:
            for y in [200, 600, 1000, 1400, 1800, 2200, 2600, 3000, 1500, 0]:
                driver.execute_script(f"window.scrollTo(0, {y});")
                time.sleep(1.0)
        time.sleep(2)
        html = driver.page_source
        print(f"  HTML 길이: {len(html):,} 자")
        products = extract_from_html(html, max_items=max_items)
        print(f"[{label}] 추출 완료: {len(products)}개")
        # 0개일 때 디버그
        if not products:
            apparel_count = len(re.findall(r'/apparels?/\d+', html))
            yen_count = len(re.findall(r'¥\s*[\d,]+', html))
            usd_count = len(re.findall(r'\$\s*[\d.,]+', html))
            print(f"  [DEBUG] HTML 안 검색 결과:")
            print(f"    /apparel(s)/ 패턴: {apparel_count}개")
            print(f"    ¥ 가격 패턴: {yen_count}개")
            print(f"    $ 가격 패턴: {usd_count}개")
            # 처음 발견되는 product-like URL 5개
            urls = re.findall(r'href="([^"]*/(?:apparels?|products|trading-cards)/[^"]*)"', html)[:5]
            print(f"    상품 추정 URL 샘플: {urls}")
        for i, p in enumerate(products[:10], 1):
            img_status = "✓" if p.get("image") else "✗"
            cur = p.get("currency", "JPY")
            sym = "$" if cur == "USD" else "¥"
            val = p['lastPrice']
            val_str = f"{val:>8,.2f}" if cur == "USD" else f"{val:>7,}"
            print(f"  {i}. {img_status} {sym}{val_str} | {p['name'][:50]}")
        if len(products) > 10:
            print(f"  ... +{len(products) - 10}개 더")
        return products
    finally:
        driver.quit()


def is_box_product(name: str) -> bool:
    """카드: [세트코드 번호] 대괄호 있음. 박스: 대괄호 없거나 ボックス/BOX 단어 직접 포함."""
    if not name:
        return False
    # 강제 박스: 명시적 박스 키워드
    if any(kw in name for kw in HARD_BOX_KEYWORDS):
        return True
    # 카드는 [...숫자...] 대괄호 패턴 보유
    if CARD_BRACKET_RE.search(name):
        return False
    # 그 외 (대괄호 없는 일반 상품) → 박스/덱/세트로 간주
    return True


def filter_by_kind(products: list, kind: str) -> list:
    """kind='box' → 박스, kind='card' → 박스 아닌 것"""
    if kind == "box":
        return [p for p in products if is_box_product(p["name"])]
    return [p for p in products if not is_box_product(p["name"])]


def save_payload(filename: str, label: str, products: list, fetched_at: str):
    payload = {
        "ok": True,
        "brand": label,
        "count": len(products),
        "products": products,
        "fetchedAt": fetched_at,
    }
    out_path = DATA_DIR / filename
    # write_bytes 로 LF 강제 — write_text 는 platform 따라 CRLF 변환할 수 있음
    txt = json.dumps(payload, ensure_ascii=False, indent=2)
    out_path.write_bytes(txt.encode("utf-8"))
    print(f"  → 저장: {out_path.relative_to(DATA_DIR.parent)}")


def fetch_usd_jpy() -> float:
    """USD → JPY 환율 (모듈 캐시 사용)"""
    return get_usd_jpy()


# ─────────── SNKRDUNK 등급별 매물 API (정확한 파라미터) ───────────
# isOnlyOnSale=true → active 매물만 / conditionId=N → 등급 필터
GRADE_CONDITION_IDS = {
    "psa10": 22,
    "psa9":  23,
    "raw":   18,  # A 탭 (싱글)
}

API_HEADERS = {
    "User-Agent": UA,
    "Accept": "application/json",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://snkrdunk.com/en/",
}


def fetch_grade_listings(card_id: str, condition_id: int = 22, only_on_sale: bool = True, max_pages: int = 20) -> list:
    """SNKRDUNK API — 카드의 active listings 받기. 깊은 페이지네이션 + 중복 제거.
       max_pages=20 → 최대 1000건 (대부분 카드 충분).
       반환: [{id, listingUID, price, condition, isSold}, ...]"""
    base = f"https://snkrdunk.com/en/v1/products/SW---{card_id}/used-listings"
    qs_only = "&isOnlyOnSale=true" if only_on_sale else ""
    seen_uids = set()
    all_items = []
    no_new_count = 0  # 새 listing 0건 페이지가 연속 N번 → 끝
    for page in range(1, max_pages + 1):
        url = f"{base}?conditionId={condition_id}&page={page}&perPage=50{qs_only}"
        try:
            req = urllib.request.Request(url, headers=API_HEADERS)
            with urllib.request.urlopen(req, timeout=15) as resp:
                if resp.status != 200:
                    break
                data = json.loads(resp.read().decode("utf-8"))
        except (urllib.error.HTTPError, urllib.error.URLError, json.JSONDecodeError):
            break
        items = data.get("usedListings") or data.get("usedTradingCards") or []
        if not items:
            break
        # 중복 제거 (API 가 conditionId 무시하고 같은 listing 반복할 수 있음)
        new_items = []
        for it in items:
            uid = it.get("listingUID") or it.get("id")
            if uid and uid not in seen_uids:
                seen_uids.add(uid)
                new_items.append(it)
        all_items.extend(new_items)
        # 새 listing 0개면 카운터 ↑, 2번 연속이면 stop (API 가 같은 페이지 무한 반복하는 경우)
        if not new_items:
            no_new_count += 1
            if no_new_count >= 2:
                break
        else:
            no_new_count = 0
        # 한 페이지가 50건 미만 → 마지막 페이지
        if len(items) < 50:
            break
        time.sleep(0.05)  # rate limit (페이지간 50ms)
    return all_items


def parse_grade(condition: str) -> str:
    """SNKRDUNK 탭과 1:1 매칭 — psa10/psa9/raw(A탭) 만 반환, 나머지 None.
       탭: All / A / B / C / D / PSA 10 / PSA 9 / PSA 8 or under / BGS 10 BL / BGS 10 GL
       우리는 A(=raw), PSA10, PSA9 만 추적."""
    if not condition:
        return None
    c = condition.strip().upper().replace(" ", "")  # "PSA 10" → "PSA10"
    # 정확히 매칭 (B, C, D, PSA8, BGS 등은 무시)
    if c == "PSA10": return "psa10"
    if c == "PSA9":  return "psa9"
    if c == "A":     return "raw"
    return None


def extract_raw_price(raw_price) -> tuple:
    """API 응답의 price 필드에서 (amount, currency, raw_str) 추출 — 변형 없이 그대로"""
    if raw_price is None:
        return (None, None, "")
    # dict 형태: {amount: 35799, currency: "JPY"}
    if isinstance(raw_price, dict):
        try:
            amt = float(raw_price.get("amount") or 0)
            cur = (raw_price.get("currency") or "").upper() or None
            if amt > 0:
                return (amt, cur, json.dumps(raw_price, ensure_ascii=False))
        except (ValueError, TypeError):
            pass
        return (None, None, json.dumps(raw_price, ensure_ascii=False))
    # 숫자 형태 (그냥 int/float)
    if isinstance(raw_price, (int, float)) and raw_price > 0:
        return (float(raw_price), None, str(raw_price))
    # 문자열 형태: "¥35,799" or "$240.00" 등
    s = str(raw_price)
    m_jpy = re.search(r"¥\s*([\d,]+)", s)
    if m_jpy:
        try:
            return (float(m_jpy.group(1).replace(",", "")), "JPY", s)
        except ValueError:
            pass
    m_usd = re.search(r"\$\s*([\d,.]+)", s)
    if m_usd:
        try:
            return (float(m_usd.group(1).replace(",", "")), "USD", s)
        except ValueError:
            pass
    # 순수 숫자 문자열
    m_num = re.search(r"([\d,.]+)", s)
    if m_num:
        try:
            return (float(m_num.group(1).replace(",", "")), None, s)
        except ValueError:
            pass
    return (None, None, s)


def parse_sold_prices(listings: list, usd_jpy: float) -> dict:
    """등급별(psa10/psa9/raw) 가격 통계 — 통화 변형 없이 원본 그대로.
       SNKRDUNK 가 헤드라인에 표시하는 'US $X~' 는 unsold listing 의 최저가 (lowest ask).
       그래서 unsold 의 min 을 'lowest_ask' 로 저장. + sold 의 avg 도 같이 보관 (히스토리)."""
    by_grade: dict = {}  # grade → {unsold:[(amt,cur)], sold:[(amt,cur)], raw_samples:[]}
    for it in listings:
        amt, cur, raw_str = extract_raw_price(it.get("price"))
        if amt is None or amt <= 0:
            continue
        grade = parse_grade(it.get("condition", ""))
        if grade is None:
            continue
        if cur is None:
            cur = "JPY" if amt >= 1000 else "USD"
        bucket = "sold" if it.get("isSold") else "unsold"
        by_grade.setdefault(grade, {"unsold": [], "sold": [], "raw_samples": []})
        by_grade[grade][bucket].append((amt, cur))
        if len(by_grade[grade]["raw_samples"]) < 5:
            sold_tag = "sold" if it.get("isSold") else "ask"
            by_grade[grade]["raw_samples"].append(f"[{sold_tag}] {raw_str}")
    out: dict = {}
    for grade, info in by_grade.items():
        unsold = info["unsold"]
        sold = info["sold"]
        all_prices = unsold + sold
        if not all_prices:
            continue
        # 다수파 통화로 정규화
        jpy_count = sum(1 for _, c in all_prices if c == "JPY")
        usd_count = sum(1 for _, c in all_prices if c == "USD")
        currency = "JPY" if jpy_count >= usd_count else "USD"
        unsold_vals = [p for p, c in unsold if c == currency]
        sold_vals = [p for p, c in sold if c == currency]
        # SNKRDUNK 헤드라인 매칭 — unsold 최저가
        lowest_ask = round(min(unsold_vals), 2) if unsold_vals else None
        # sold avg (직전 5건)
        recent_sold_avg = round(sum(sold_vals[:5]) / min(5, len(sold_vals)), 2) if sold_vals else None
        out[grade] = {
            "currency":         currency,
            "lowest_ask":       lowest_ask,        # ← SNKRDUNK 의 'US $X~' 와 동일
            "unsold_count":     len(unsold_vals),
            "recent_sold_avg":  recent_sold_avg,   # 보조 정보 (직전 5건 평균)
            "sold_count":       len(sold_vals),
            "raw_samples":      info["raw_samples"],
        }
    return out


def collect_card_ids() -> set:
    """이미 저장된 JSON 들에서 모든 카드 ID 추출"""
    ids = set()
    for pattern in ("top10-*.json", "price-*.json"):
        for path in DATA_DIR.glob(pattern):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                for p in data.get("products", []):
                    if p.get("id"):
                        ids.add(p["id"])
            except Exception:
                pass
    return ids


def main():
    fetched_at = datetime.now(timezone.utc).isoformat()
    fail_count = 0
    total = 0

    # 1) 홈 TOP 10 (브랜드 카테고리, 10개씩)
    print("=" * 60)
    print("Phase 1: 홈 TOP 10 수집")
    print("=" * 60)
    for brand, url in TOP10_URLS.items():
        total += 1
        try:
            products = scrape_url(brand, url, max_items=10)
            if not products:
                print(f"[{brand}] ⚠ 0개 추출 - 기존 데이터 유지")
                fail_count += 1
                continue
            save_payload(f"top10-{brand}.json", brand, products, fetched_at)
        except Exception as e:
            print(f"[{brand}] ❌ 에러: {e}")
            fail_count += 1

    # 2) 카드 시세 페이지 데이터 — primary 실패 시 /categories/6 fallback + 이름 분류
    print()
    print("=" * 60)
    print("Phase 2: 카드 시세 데이터 수집 (목표 30개씩)")
    print("=" * 60)
    # fallback 의 경우 같은 URL 두 번 fetch 안 되도록 캐싱
    fallback_cache: dict = {}
    for label, primary_url in PRICE_URLS_PRIMARY.items():
        total += 1
        try:
            products = scrape_url(label, primary_url, max_items=30)
            if len(products) < 5:
                # primary 가 5개 미만 → fallback 로 전환
                fb_url, kind = PRICE_URLS_FALLBACK[label]
                print(f"[{label}] ⤺ primary 부족 ({len(products)}개) → fallback {fb_url} ({kind})")
                if fb_url in fallback_cache:
                    all_products = fallback_cache[fb_url]
                    print(f"  (캐시 사용 — {len(all_products)}개)")
                else:
                    all_products = scrape_url(f"{label}-fallback", fb_url, max_items=60)
                    fallback_cache[fb_url] = all_products
                products = filter_by_kind(all_products, kind)[:30]
                print(f"  → {kind} 필터링 결과: {len(products)}개")
            if not products:
                print(f"[{label}] ⚠ 0개 추출 - 기존 데이터 유지")
                fail_count += 1
                continue
            save_payload(f"price-{label}.json", label, products, fetched_at)
        except Exception as e:
            print(f"[{label}] ❌ 에러: {e}")
            fail_count += 1

    # 3) 카드별 등급 가격 — SNKRDUNK 공식 API 정확한 파라미터로 호출
    #    isOnlyOnSale=true (active 만) + conditionId 별 (PSA10=22, PSA9=23, A=18)
    #    각 grade min(price) = SNKRDUNK 헤드라인 'US $X~' 와 동일
    print()
    print("=" * 60)
    print("Phase 3: 카드별 등급 가격 (API conditionId 별 호출)")
    print("=" * 60)
    usd_jpy = fetch_usd_jpy()
    # 박스 ID 모으기 (등급 없으니 스킵)
    box_ids = set()
    for f in ("price-pokemon-box.json", "price-onepiece-box.json"):
        try:
            d = json.loads((DATA_DIR / f).read_text(encoding="utf-8"))
            for p in d.get("products", []):
                if p.get("id"):
                    box_ids.add(p["id"])
        except Exception:
            pass
    all_ids = sorted(collect_card_ids())
    card_ids = [cid for cid in all_ids if cid not in box_ids]
    print(f"  전체 추적 ID: {len(all_ids)}개  /  박스 제외 카드만: {len(card_ids)}개")
    cards_detail = {}
    debug_count = 0
    for i, cid in enumerate(card_ids, 1):
        grades = {}
        debug_this = (debug_count < 3)
        if debug_this:
            print(f"  [DEBUG] card {cid}:")
        # ⚡ active 매물만 받기 (isOnlyOnSale=true) — 사용자가 SNKRDUNK 페이지에서 보는 매물 그대로
        all_listings = fetch_grade_listings(cid, condition_id=22, only_on_sale=True, max_pages=20)
        # 안전장치: client-side isSold 필터 (API 가 isOnlyOnSale 무시할 가능성 대비)
        active_only = [it for it in all_listings if not it.get("isSold")]
        if debug_this and all_listings:
            from collections import Counter
            sample0 = all_listings[0]
            conds_all = Counter((it.get("condition") or "").strip() for it in all_listings)
            print(f"    [전체 응답 {len(all_listings)}건, active {len(active_only)}건]")
            print(f"    sample[0] cond={sample0.get('condition')!r} isSold={sample0.get('isSold')} price={sample0.get('price')!r}")
            print(f"    conditions 분포={dict(conds_all)}")

        # condition 매칭 함수 (lenient)
        def matches(cond_str, grade_key):
            c = (cond_str or "").strip()
            cu = c.upper().replace(" ", "")
            if grade_key == "psa10":
                return cu.startswith("PSA10") and not cu.startswith("PSA100")
            if grade_key == "psa9":
                return cu.startswith("PSA9") and not cu.startswith("PSA90") and not cu.startswith("PSA99")
            if grade_key == "raw":
                return c == "A" or cu == "A"
            return False

        for grade, cond_id in GRADE_CONDITION_IDS.items():
            filtered = [it for it in active_only if matches(it.get("condition"), grade)]
            if debug_this:
                print(f"    {grade:>5}: '{grade}' 매칭 active listing {len(filtered)}건")
            if not filtered:
                continue
            # USD 가격 추출
            prices = []
            for it in filtered:
                amt, _, _ = extract_raw_price(it.get("price"))
                if amt and amt > 0:
                    prices.append(amt)
            if not prices:
                continue
            # outlier 필터 — median 의 50% 미만은 mispriced 의심 (불량 grading, 잘못된 listing)
            prices_sorted = sorted(prices)
            med = prices_sorted[len(prices_sorted) // 2]
            cleaned = [p for p in prices if p >= med * 0.5]
            if not cleaned:
                cleaned = prices  # 전부 outlier 면 fallback
            cleaned_sorted = sorted(cleaned)
            lowest = cleaned_sorted[0]
            grades[grade] = {
                "lowest_ask": lowest,
                "currency": "USD",
                "active_count": len(prices),
                "after_filter": len(cleaned),
                "top5": [round(p, 2) for p in cleaned_sorted[:5]],
            }
            if debug_this:
                top5 = [f"${p}" for p in cleaned_sorted[:5]]
                print(f"    {grade:>5} → lowest=${lowest}  active {len(prices)}건 (filter 후 {len(cleaned)}건)  top5=[{', '.join(top5)}]")

        # ⚠ 이상 감지 — 2개 이상 등급의 lowest_ask 가 동일하면 API 필터 실패 의심
        # 정상이라면 PSA 10 > PSA 9 > A 또는 적어도 다른 값이어야 함
        non_empty_prices = [(g, info["lowest_ask"]) for g, info in grades.items() if info.get("lowest_ask")]
        if len(non_empty_prices) >= 2:
            unique_prices = set(p for _, p in non_empty_prices)
            if len(unique_prices) == 1:
                # 모든 등급 동일 가격 → retry 1번
                if debug_this:
                    print(f"  ⚠ 모든 등급 동일 가격 ${non_empty_prices[0][1]} → retry...")
                time.sleep(1.0)
                all_listings_retry = fetch_grade_listings(cid, condition_id=22, only_on_sale=True, max_pages=20)
                active_retry = [it for it in all_listings_retry if not it.get("isSold")]
                grades_retry = {}
                for g_key in grades.keys():
                    filtered_r = [it for it in active_retry if matches(it.get("condition"), g_key)]
                    if not filtered_r:
                        continue
                    prices_r = []
                    for it in filtered_r:
                        amt, cur, raw_str = extract_raw_price(it.get("price"))
                        if amt and amt > 0:
                            prices_r.append(amt)
                    if not prices_r:
                        continue
                    pr_sorted = sorted(prices_r)
                    grades_retry[g_key] = {
                        "lowest_ask": pr_sorted[0],
                        "currency": "USD",
                        "active_count": len(prices_r),
                        "top5": [round(p, 2) for p in pr_sorted[:5]],
                    }
                # retry 결과가 더 다양하면 적용
                retry_prices = set(info["lowest_ask"] for info in grades_retry.values() if info.get("lowest_ask"))
                if len(retry_prices) > 1:
                    grades = grades_retry
                    if debug_this:
                        print(f"  ✓ retry 결과 다양함 → 채택")
                else:
                    # 여전히 다 같으면 → 신뢰 낮음, active_count 가장 큰 1개만 남김
                    biggest = max(non_empty_prices, key=lambda kv: grades[kv[0]].get("active_count", 0))
                    grades = {biggest[0]: grades[biggest[0]]}
                    if debug_this:
                        print(f"  ⚠ retry 후도 동일 → '{biggest[0]}' 만 신뢰, 나머지 제거")

        if debug_this:
            debug_count += 1
        cards_detail[cid] = {
            "id": cid,
            "grades": grades,
        }
        if i % 10 == 0 or i == len(card_ids):
            non_empty = sum(1 for v in grades.values() if v.get("recent_avg") or v.get("lowest_ask"))
            print(f"  [{i}/{len(card_ids)}] {cid} → 등급 채워진 칸: {non_empty}/3")
        time.sleep(0.2)

    # 박스 placeholder 등록
    for bid in box_ids:
        cards_detail.setdefault(bid, {"id": bid, "grades": {}})

    out_path = DATA_DIR / "cards-detail.json"
    detail_txt = json.dumps({
        "ok": True,
        "fetchedAt": fetched_at,
        "usdJpy": usd_jpy,
        "count": len(cards_detail),
        "cards": cards_detail,
    }, ensure_ascii=False, indent=2)
    out_path.write_bytes(detail_txt.encode("utf-8"))
    print(f"  → 저장: {out_path.relative_to(DATA_DIR.parent)}")

    # ─────────── Phase A — history 누적 (sales-chart 기반) ───────────
    # 백필과 동일한 데이터 소스 사용 (실거래가) → line 끊김 없음
    # 각 카드별로 sales-chart oneMonth 받아서 history 에 merge.
    # 같은 날짜 있으면 최신값으로 갱신, 없으면 추가.
    print("\n[Phase A] 가격 history 누적 (sales-chart 기반)")
    history_dir = DATA_DIR / "history"
    history_dir.mkdir(exist_ok=True)

    GRADE_OPTION_IDS_HIST = {"psa10": 22, "psa9": 23, "raw": 18}

    def fetch_card_history_1ea(cid, opt_id, max_pages=5):
        """카드 sales-history — size==1 거래만 등급별로 수집 (일별 단가 list)"""
        from collections import defaultdict as _dd
        from datetime import datetime as _dt, timedelta as _td
        prices_by_date = _dd(list)
        for page in range(1, max_pages + 1):
            url = (f"https://snkrdunk.com/v1/apparels/{cid}/sales-history"
                   f"?page={page}&per_page=20&salesChartOptionId={opt_id}")
            try:
                req = urllib.request.Request(url, headers={
                    "User-Agent": UA, "Accept": "application/json",
                    "Referer": "https://snkrdunk.com/",
                })
                with urllib.request.urlopen(req, timeout=15) as r:
                    d2 = json.loads(r.read().decode("utf-8"))
            except Exception:
                break
            items = d2.get("history") or []
            if not items: break
            today_now = _dt.now()
            for it in items:
                date_str = (it.get("date") or "").strip()
                m = re.match(r"(\d{4})[/-](\d{2})[/-](\d{2})", date_str)
                if m: dt_str = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
                else:
                    m2 = re.match(r"(\d+)\s*(日|day)", date_str)
                    dt_str = (today_now - _td(days=int(m2.group(1)))).strftime("%Y-%m-%d") if m2 else today_now.strftime("%Y-%m-%d")
                pr = it.get("price")
                if isinstance(pr, str):
                    pm = re.search(r"([\d,]+)", pr.replace("¥", ""))
                    pr = int(pm.group(1).replace(",", "")) if pm else None
                if pr is None: continue
                sz_val = None
                for sk in ("quantity", "count", "qty", "size", "amount", "num",
                           "size_text", "sizeText", "lot_size", "set_size",
                           "boxes", "set", "lot", "pieces", "個数"):
                    sv = it.get(sk)
                    if sv is None: continue
                    if isinstance(sv, dict):
                        sv = sv.get("count") or sv.get("size") or sv.get("amount") or sv.get("text")
                    if isinstance(sv, (int, float)):
                        sz_val = int(sv); break
                    if isinstance(sv, str):
                        sm = re.search(r"(\d+)", sv)
                        if sm: sz_val = int(sm.group(1)); break
                if sz_val is None:
                    nm = re.search(r"(\d+)\s*(個|箱|本|点|セット|set|×|x)",
                                   (it.get("name") or it.get("title") or ""), re.I)
                    if nm: sz_val = int(nm.group(1))
                if sz_val != 1: continue
                prices_by_date[dt_str].append(pr)
            if len(items) < 20: break
            time.sleep(0.2)
        return dict(prices_by_date)

    appended = 0
    fetched_at = datetime.now(timezone.utc).isoformat()
    all_ids = collect_card_ids()
    print(f"  대상 ID: {len(all_ids)} 개")
    for cid in sorted(all_ids):
        hist_path = history_dir / f"{cid}.json"
        existing = {"history": []}
        if hist_path.exists():
            try:
                raw = hist_path.read_bytes().replace(b"\x00", b"").rstrip()
                existing = json.loads(raw)
            except Exception:
                # 깨진 JSON 복구 시도
                try:
                    last = raw.rfind(b"}")
                    if last > 0:
                        existing = json.loads(raw[:last+1] + b"\n  ]\n}")
                except Exception:
                    existing = {"history": []}
        by_date = {h["date"]: dict(h) for h in existing.get("history", []) if h.get("date")}

        # 박스/카드 분기 — 이름에 [세트코드 번호] 있으면 카드, 없으면 박스
        # 정확한 분류는 product 페이지에서 확인할 수도 있지만, 기존 데이터 키로 추정
        is_card = any(any(k.endswith("_price") and k != "box_price" for k in r) for r in existing.get("history", []))
        is_box = any("box_price" in r for r in existing.get("history", []))
        # 데이터가 아예 없으면 둘 다 시도
        if not is_card and not is_box:
            is_card = True
            is_box = True

        any_new = False
        if is_box:
            # 박스: sales-history 페이지네이션 (size==1 거래만)
            from collections import defaultdict as _dd
            from datetime import datetime as _dt, timedelta as _td
            box_prices = _dd(list)
            box_vols = _dd(int)
            for page in range(1, 5):
                url = f"https://snkrdunk.com/v1/apparels/{cid}/sales-history?page={page}&per_page=20"
                try:
                    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json", "Referer": "https://snkrdunk.com/"})
                    with urllib.request.urlopen(req, timeout=15) as r:
                        d2 = json.loads(r.read().decode("utf-8"))
                except Exception:
                    break
                items = d2.get("history") or []
                if not items: break
                today_now = _dt.now()
                for it in items:
                    date_str = (it.get("date") or "").strip()
                    m = re.match(r"(\d{4})[/-](\d{2})[/-](\d{2})", date_str)
                    if m: dt_str = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
                    else:
                        m2 = re.match(r"(\d+)\s*(日|day)", date_str)
                        dt_str = (today_now - _td(days=int(m2.group(1)))).strftime("%Y-%m-%d") if m2 else today_now.strftime("%Y-%m-%d")
                    pr = it.get("price")
                    if isinstance(pr, str):
                        pm = re.search(r"([\d,]+)", pr.replace("¥", ""))
                        pr = int(pm.group(1).replace(",", "")) if pm else None
                    if pr is None: continue
                    sz_val = None
                    for sk in ("quantity", "count", "qty", "size", "amount", "num",
                               "size_text", "sizeText", "lot_size", "set_size",
                               "boxes", "set", "lot", "pieces", "個数"):
                        sv = it.get(sk)
                        if sv is None: continue
                        if isinstance(sv, dict):
                            sv = sv.get("count") or sv.get("size") or sv.get("amount") or sv.get("text")
                        if isinstance(sv, (int, float)):
                            sz_val = int(sv); break
                        if isinstance(sv, str):
                            sm = re.search(r"(\d+)", sv)
                            if sm: sz_val = int(sm.group(1)); break
                    if sz_val is None:
                        nm = re.search(r"(\d+)\s*(個|箱|本|点|セット|set|×|x)",
                                       (it.get("name") or it.get("title") or ""), re.I)
                        if nm: sz_val = int(nm.group(1))
                    if sz_val != 1: continue
                    box_prices[dt_str].append(pr)
                    box_vols[dt_str] += 1
                if len(items) < 20: break
                time.sleep(0.2)
            for date, prs in box_prices.items():
                avg = sum(prs) // len(prs)
                if date not in by_date:
                    by_date[date] = {"date": date}
                by_date[date]["box_price"] = avg
                by_date[date]["box_vol"] = box_vols[date]
                any_new = True

        if is_card:
            # 카드: 등급별 sales-history 1個 거래만 수집
            for grade, opt_id in GRADE_OPTION_IDS_HIST.items():
                prices_by_date = fetch_card_history_1ea(cid, opt_id, max_pages=5)
                for date, prs in prices_by_date.items():
                    if not prs: continue
                    avg = sum(prs) // len(prs)
                    if date not in by_date:
                        by_date[date] = {"date": date}
                    by_date[date][f"{grade}_price"] = avg
                    by_date[date][f"{grade}_vol"] = len(prs)
                    any_new = True
                time.sleep(0.3)

        if not any_new and not by_date:
            continue

        new_history = sorted(by_date.values(), key=lambda h: h.get("date", ""))
        if len(new_history) > 360:
            new_history = new_history[-360:]
        out = json.dumps({
            "id": str(cid),
            "updatedAt": fetched_at,
            "source": "daily (sales-history 1ea)",
            "history": new_history,
        }, ensure_ascii=False, indent=2)
        try:
            hist_path.unlink()
        except Exception:
            pass
        hist_path.write_bytes(out.encode("utf-8"))
        appended += 1

    print(f"  → history 갱신: {appended} 카드/박스")
    print(f"\n완료. 실패 {fail_count}/{total}")
    if fail_count == total:
        print("전체 실패 → exit 1")
        sys.exit(1)


if __name__ == "__main__":
    main()
