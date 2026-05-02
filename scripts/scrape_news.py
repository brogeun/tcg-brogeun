"""
한국 TCG 뉴스 스크래퍼
대상:
  - https://pokemoncard.co.kr/news (한국 포켓몬 카드 뉴스)
  - https://onepiece-cardgame.kr/topics.do?extraValue=PRODUCTS (한국 원피스 카드 토픽)

출력: data/news.json
필터: 4월·5월 항목만
실행: GitHub Actions 매일 04:00 KST (scrape_snkrdunk.py 다음에 호출)
"""

import json
import re
import time
from pathlib import Path
from datetime import datetime, timezone

from selenium import webdriver
from selenium.webdriver.chrome.options import Options


DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

NEWS_SOURCES = [
    {
        "key": "pokemon",
        "label": "포켓몬",
        "url": "https://pokemoncard.co.kr/news",
        "base_url": "https://pokemoncard.co.kr",
    },
    {
        "key": "onepiece",
        "label": "원피스",
        "url": "https://onepiece-cardgame.kr/topics.do?extraValue=PRODUCTS",
        "base_url": "https://onepiece-cardgame.kr",
    },
]


def make_driver(lang: str = "ko-KR"):
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_argument("--window-size=1280,2400")
    opts.add_argument(f"--lang={lang}")
    opts.add_argument(f"--user-agent={UA}")
    return webdriver.Chrome(options=opts)


def absolutize(url: str, base: str) -> str:
    if not url:
        return ""
    if url.startswith("http://") or url.startswith("https://"):
        return url
    if url.startswith("//"):
        return "https:" + url
    if url.startswith("/"):
        return base + url
    return base + "/" + url


def parse_date(text: str):
    """다양한 날짜 형식에서 YYYY-MM-DD 추출"""
    if not text:
        return None
    # 2026-05-01, 2026.05.01, 2026/05/01
    m = re.search(r"(\d{4})[\-./](\d{1,2})[\-./](\d{1,2})", text)
    if m:
        y, mo, d = m.groups()
        return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"
    # 2026년 5월 1일
    m = re.search(r"(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일", text)
    if m:
        y, mo, d = m.groups()
        return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"
    # 5월 1일 → 현재 연도 가정
    m = re.search(r"(\d{1,2})\s*월\s*(\d{1,2})\s*일", text)
    if m:
        mo, d = m.groups()
        y = datetime.now().year
        return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"
    # MM-DD 또는 MM.DD
    m = re.search(r"^(\d{1,2})[\-.](\d{1,2})$", text.strip())
    if m:
        mo, d = m.groups()
        y = datetime.now().year
        return f"{int(y):04d}-{int(mo):02d}-{int(d):02d}"
    return None


def is_april_or_may(date_str: str) -> bool:
    """YYYY-MM-DD 가 4월 또는 5월인지"""
    if not date_str:
        return False
    m = re.match(r"\d{4}-(\d{2})-\d{2}", date_str)
    if not m:
        return False
    month = int(m.group(1))
    return month in (4, 5)


def scrape_pokemon(driver, src: dict) -> list:
    """pokemoncard.co.kr/news 스크래핑
       구조 추정: 게시판 형태, 각 행에 제목·날짜·썸네일"""
    print(f"\n━━━ {src['label']}: {src['url']} ━━━")
    try:
        driver.get(src['url'])
        time.sleep(3)
    except Exception as e:
        print(f"  ✗ load err: {e}")
        return []
    # 페이지 스크롤
    driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
    time.sleep(1.5)
    driver.execute_script("window.scrollTo(0, 0);")
    time.sleep(0.5)

    # 일반적 게시판 a.title, .news-item, .post 등 패턴 시도
    items_js = r"""
        // 뉴스 항목 후보 셀렉터들
        const selectors = [
            'article a[href]',
            '.news-list a[href]',
            '.list a[href]',
            'ul li a[href]',
            '.post a[href]',
            'a.news-item',
            'a[href*="news"]',
            'a[href*="view"]',
        ];
        const seen = new Set();
        const out = [];
        for (const sel of selectors) {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
                const href = el.href;
                if (!href || seen.has(href)) continue;
                const txt = (el.innerText || '').trim();
                if (!txt || txt.length < 5 || txt.length > 200) continue;
                // 이미지 찾기 (a 태그 안 또는 가까운 부모에서)
                let img = el.querySelector('img');
                if (!img) {
                    const parent = el.closest('article, li, .item, .post, div');
                    if (parent) img = parent.querySelector('img');
                }
                const imgSrc = img ? (img.src || img.getAttribute('data-src') || '') : '';
                // 날짜 텍스트 찾기 (부모 영역에서)
                const parent = el.closest('article, li, .item, .post, div, tr');
                let dateText = '';
                if (parent) {
                    const dateEl = parent.querySelector('.date, .day, time, .news-date');
                    if (dateEl) dateText = (dateEl.innerText || '').trim();
                    if (!dateText) dateText = (parent.innerText || '').slice(-30);
                }
                seen.add(href);
                out.push({title: txt.split('\n')[0].trim(), href: href, img: imgSrc, dateText: dateText});
                if (out.length >= 60) return out;
            }
            if (out.length >= 30) break;
        }
        return out;
    """
    try:
        raw_items = driver.execute_script(items_js) or []
    except Exception as e:
        print(f"  ✗ extract err: {e}")
        return []
    print(f"  raw 후보: {len(raw_items)}건")

    # 필터링
    out = []
    for it in raw_items:
        title = (it.get("title") or "").strip()
        href = it.get("href") or ""
        if len(title) < 5:
            continue
        # 메뉴/카테고리 텍스트 제외
        skip_words = ["로그인", "회원가입", "메뉴", "검색", "마이페이지", "전체보기", "더보기", "Home", "About"]
        if any(w in title for w in skip_words):
            continue
        date = parse_date(it.get("dateText", ""))
        if not is_april_or_may(date):
            continue
        out.append({
            "title": title[:120],
            "image": absolutize(it.get("img", ""), src["base_url"]),
            "link": absolutize(href, src["base_url"]),
            "date": date,
            "source": src["key"],
            "sourceLabel": src["label"],
        })
    print(f"  4·5월 필터 후: {len(out)}건")
    for i, it in enumerate(out[:5], 1):
        print(f"    {i}. [{it['date']}] {it['title'][:60]}")
    return out


def scrape_onepiece(driver, src: dict) -> list:
    """onepiece-cardgame.kr/topics.do — 좀 더 일반화된 추출"""
    print(f"\n━━━ {src['label']}: {src['url']} ━━━")
    try:
        driver.get(src['url'])
        time.sleep(3)
    except Exception as e:
        print(f"  ✗ load err: {e}")
        return []
    driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
    time.sleep(1.5)
    driver.execute_script("window.scrollTo(0, 0);")
    time.sleep(0.5)
    # 같은 추출 스크립트 재사용
    return scrape_pokemon(driver, src)


def main():
    fetched_at = datetime.now(timezone.utc).isoformat()
    all_items: list = []

    driver = make_driver(lang="ko-KR")
    try:
        for src in NEWS_SOURCES:
            try:
                if src["key"] == "pokemon":
                    items = scrape_pokemon(driver, src)
                else:
                    items = scrape_onepiece(driver, src)
                all_items.extend(items)
            except Exception as e:
                print(f"  ❌ {src['label']} 에러: {e}")
    finally:
        driver.quit()

    # 날짜 내림차순 정렬
    all_items.sort(key=lambda x: x.get("date") or "", reverse=True)

    payload = {
        "ok": True,
        "fetchedAt": fetched_at,
        "count": len(all_items),
        "items": all_items,
    }
    out_path = DATA_DIR / "news.json"
    txt = json.dumps(payload, ensure_ascii=False, indent=2)
    out_path.write_bytes(txt.encode("utf-8"))
    print(f"\n→ 저장: {out_path.relative_to(DATA_DIR.parent)}  ({len(all_items)}건)")


if __name__ == "__main__":
    main()
