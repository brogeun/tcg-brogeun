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

    # 다양한 사이트 구조 대응 — a 태그 안에 텍스트 없어도 부모/자식/img alt 다 찾기
    items_js = r"""
        const selectors = [
            'article a[href]',
            '.news-list a[href]',
            '.list a[href]',
            'ul li a[href]',
            '.post a[href]',
            'a.news-item',
            'a[href*="news"]',
            'a[href*="view"]',
            'a[href*="topics"]',
            'a[href*="article"]',
        ];
        const seen = new Set();
        const out = [];

        // 제목 추출 함수 — 4단계 fallback
        function extractTitle(el) {
            // 1) a 태그 자체 innerText
            let t = (el.innerText || '').trim();
            if (t && t.length >= 5 && t.length <= 200) return t.split('\n')[0].trim();
            // 2) a 안의 img alt
            const img = el.querySelector('img');
            if (img) {
                const alt = (img.alt || '').trim();
                if (alt && alt.length >= 3) return alt;
            }
            // 3) 부모 영역에서 .title, h2, h3, strong 찾기
            const parent = el.closest('article, li, .item, .post, div, tr');
            if (parent) {
                const titleEl = parent.querySelector('.title, .subject, .news-title, h2, h3, h4, strong, b');
                if (titleEl) {
                    const tt = (titleEl.innerText || '').trim();
                    if (tt && tt.length >= 3 && tt.length <= 200) return tt.split('\n')[0].trim();
                }
                // 4) 부모 텍스트 첫 의미있는 줄
                const lines = (parent.innerText || '').split('\n').map(s => s.trim()).filter(s => s.length >= 5 && s.length <= 200);
                // 날짜/메뉴어 같은 거 제외
                const filtered = lines.filter(l => !/^\d{4}[\-./]\d/.test(l) && !/^\d+$/.test(l) && !/^(more|view|read|click)/i.test(l));
                if (filtered.length) return filtered[0];
            }
            // 5) title 속성
            const titleAttr = el.getAttribute('title');
            if (titleAttr && titleAttr.length >= 3) return titleAttr.trim();
            return null;
        }

        for (const sel of selectors) {
            const els = document.querySelectorAll(sel);
            for (const el of els) {
                const href = el.href;
                if (!href || seen.has(href)) continue;
                const title = extractTitle(el);
                if (!title) continue;
                // 이미지
                let img = el.querySelector('img');
                if (!img) {
                    const parent = el.closest('article, li, .item, .post, div');
                    if (parent) img = parent.querySelector('img');
                }
                const imgSrc = img ? (img.src || img.getAttribute('data-src') || img.getAttribute('data-original') || '') : '';
                // 날짜
                const parent = el.closest('article, li, .item, .post, div, tr');
                let dateText = '';
                if (parent) {
                    const dateEl = parent.querySelector('.date, .day, time, .news-date, .post-date');
                    if (dateEl) dateText = (dateEl.innerText || '').trim();
                    if (!dateText) dateText = (parent.innerText || '').slice(-50);
                }
                seen.add(href);
                out.push({title: title, href: href, img: imgSrc, dateText: dateText});
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


# 원피스 사이트는 list 에서 제목이 카테고리("PRODUCTS")로 잡혀서 detail 페이지 fetch 필요
GENERIC_TITLES = {
    "PRODUCTS", "EVENTS", "NEWS", "NOTICE", "BOOSTERS", "DECKS", "OTHER",
    "상품정보", "이벤트", "공지사항", "뉴스",
}


def fetch_detail_title(driver, url: str) -> str:
    """detail 페이지에서 진짜 제목 추출 — 다중 전략, generic 우회"""
    try:
        driver.get(url)
        time.sleep(2.0)
    except Exception:
        return None
    title_js = r"""
        const GENERIC = new Set([
            'PRODUCTS', 'EVENTS', 'NEWS', 'NOTICE', 'BOOSTERS', 'DECKS', 'OTHER',
            '상품정보', '이벤트', '공지사항', '뉴스', 'ONE PIECE', 'ONE PIECE CARD GAME',
            '원피스', '원피스 카드게임', 'ONE PIECE 원피스 카드게임'
        ]);
        const isGeneric = (t) => {
            if (!t) return true;
            const trimmed = t.trim();
            if (GENERIC.has(trimmed) || GENERIC.has(trimmed.toUpperCase())) return true;
            const onlyAlpha = trimmed.toUpperCase().replace(/[^A-Z]/g, '');
            if (onlyAlpha === 'ONEPIECE' || onlyAlpha === 'ONEPIECECARDGAME') return true;
            return false;
        };
        const isGood = (t) => {
            if (!t) return false;
            const trimmed = t.trim();
            if (trimmed.length < 5 || trimmed.length > 200) return false;
            if (isGeneric(trimmed)) return false;
            return true;
        };

        // 1순위: 대괄호 패턴 [STK-22], [OPK-12] 가 들어간 텍스트 (제일 확실)
        const allEls = document.querySelectorAll('h1, h2, h3, h4, .title, .subject, .tit, .board-tit, .bd-title, .post-title, .article-title, div, p, span');
        for (const el of allEls) {
            const t = (el.innerText || '').trim().split('\n')[0].trim();
            if (isGood(t) && /\[[A-Z0-9\-]+\]/.test(t)) {
                return t;
            }
        }
        // 2순위: 큰 폰트 텍스트 중 generic 아닌 것 (페이지 상단)
        let bestByFont = null;
        let bestSize = 0;
        for (const el of allEls) {
            const t = (el.innerText || '').trim().split('\n')[0].trim();
            if (!isGood(t)) continue;
            const rect = el.getBoundingClientRect();
            if (rect.top < 0 || rect.top > 800) continue;
            const fs = parseFloat(getComputedStyle(el).fontSize) || 0;
            if (fs >= 20 && fs > bestSize) {
                bestSize = fs;
                bestByFont = t;
            }
        }
        if (bestByFont) return bestByFont;

        // 3순위: h1/h2/h3 순서
        const headings = document.querySelectorAll('h1, h2, h3, h4');
        for (const el of headings) {
            const t = (el.innerText || '').trim().split('\n')[0].trim();
            if (isGood(t)) return t;
        }
        // 4순위: 일반 .title / .subject 클래스
        const titleEls = document.querySelectorAll('.title, .subject, .tit, .news-title, .post-title, .article-title, .board-tit, .bd-title');
        for (const el of titleEls) {
            const t = (el.innerText || '').trim();
            if (isGood(t)) return t.split('\n')[0].trim();
        }
        // 5순위: <title> 메타 — 가장 긴 segment 채택
        const pageTitle = document.title || '';
        if (pageTitle) {
            const parts = pageTitle.split(/[:|\-]/).map(s => s.trim()).filter(s => isGood(s));
            if (parts.length) {
                parts.sort((a, b) => b.length - a.length);
                return parts[0];
            }
        }
        return null;
    """
    try:
        return driver.execute_script(title_js)
    except Exception:
        return None



def enrich_titles(driver, items: list) -> list:
    """list 단계에서 generic 제목('PRODUCTS' 등)인 것 — detail 페이지 fetch 해서 진짜 제목으로 교체"""
    enriched = 0
    for it in items:
        title = (it.get("title") or "").strip()
        if title in GENERIC_TITLES or len(title) < 6:
            real = fetch_detail_title(driver, it["link"])
            if real and real != title and real not in GENERIC_TITLES:
                print(f"    ↻ [{it.get('date')}] '{title}' → '{real[:60]}'")
                it["title"] = real[:120]
                enriched += 1
    if enriched:
        print(f"  ✓ detail 페이지로 제목 보강: {enriched}건")
    return items


def scrape_onepiece(driver, src: dict) -> list:
    """onepiece-cardgame.kr/topics.do — list 추출 + detail 제목 보강"""
    items = scrape_pokemon(driver, src)
    if items:
        items = enrich_titles(driver, items)
    return items


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
