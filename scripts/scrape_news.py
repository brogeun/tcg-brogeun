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
    """이름은 옛날 그대로 — 실제 동작은 '최근 90일' 동적 필터.
    날짜 못 읽었어도 통과 (사이트 상단=최신 가정).
    """
    if not date_str:
        return True  # 날짜 없으면 일단 통과 (사이트 상단 = 최신)
    m = re.match(r"(\d{4})-(\d{2})-(\d{2})", date_str)
    if not m:
        return True
    try:
        item_date = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        delta = (datetime.now() - item_date).days
        return -1 <= delta <= 90  # 미래 1일 + 과거 90일
    except Exception:
        return True


def scrape_pokemon(driver, src: dict) -> list:
    """pokemoncard.co.kr/news + onepiece-cardgame.kr/topics.do 스크래핑
       단순화: site-specific 패턴 (_news?id= / topics.do?brdNo=) 으로 정확 매칭"""
    print(f"\n━━━ {src['label']}: {src['url']} ━━━")
    try:
        driver.get(src['url'])
        time.sleep(4)
    except Exception as e:
        print(f"  ✗ load err: {e}")
        return []
    # 충분한 스크롤 (lazy 로딩 대응)
    for _ in range(3):
        driver.execute_script("window.scrollBy(0, 1500);")
        time.sleep(0.8)
    driver.execute_script("window.scrollTo(0, 0);")
    time.sleep(1)

    # 이미지 있는 a 태그 = 뉴스 카드 (footer/copyright 제외, 카드 영역 내부만)
    items_js = r"""
        const out = [];
        const seen = new Set();

        // footer/header 안의 링크는 처음부터 제외
        function isInFooterOrHeader(el) {
            return !!el.closest('footer, header, nav, aside, .footer, .header, .nav, .gnb, .lnb, .menu, .copyright');
        }

        // 노이즈 텍스트 (카피라이트, 메뉴 등)
        const NOISE_PATTERNS = [
            /©|copyright|all rights/i,
            /^(home|about|search|login|menu|sitemap)$/i,
            /nintendo.*creatures.*game freak/i,
        ];
        function isNoise(t) {
            return NOISE_PATTERNS.some(p => p.test(t));
        }

        const anchors = document.querySelectorAll('a[href]');
        for (const a of anchors) {
            const href = a.href;
            if (!href || seen.has(href)) continue;
            if (href.startsWith('javascript:') || href.endsWith('#')) continue;
            if (isInFooterOrHeader(a)) continue;

            const img = a.querySelector('img') || (a.closest('article, .news-item, .card, li, div')?.querySelector('img'));
            if (!img) continue;
            const w = img.naturalWidth || img.width || 0;
            if (w > 0 && w < 100) continue;
            // 이미지 src 가 logo/icon 같으면 제외
            const imgSrcCheck = (img.src || '').toLowerCase();
            if (imgSrcCheck.includes('logo') || imgSrcCheck.includes('icon') || imgSrcCheck.includes('symbol')) continue;

            const card = a.closest('article, .news-item, .card, li, div') || a;
            let title = (a.innerText || '').trim();
            if (!title || title.length < 5) {
                const candidates = card.querySelectorAll('h1, h2, h3, h4, h5, .title, .subject, strong, b, p, span');
                let best = '';
                for (const c of candidates) {
                    const t = (c.innerText || '').trim().split('\n')[0].trim();
                    if (t.length >= 5 && t.length <= 200 && !isNoise(t) && t.length > best.length) best = t;
                }
                if (best) title = best;
            }
            if ((!title || title.length < 5) && img.alt) title = img.alt.trim();
            if (!title || title.length < 5) continue;
            title = title.split('\n')[0].trim();
            if (title.length > 200) title = title.slice(0, 200);
            if (isNoise(title)) continue;

            const imgSrc = img.src || img.dataset.src || img.dataset.original || '';

            // 날짜 — 다양한 한글 포맷
            let dateText = '';
            const dateEl = card.querySelector('.date, .day, time, .news-date, .post-date, [class*="date" i]');
            if (dateEl) dateText = (dateEl.innerText || dateEl.dateTime || '').trim();
            if (!dateText) {
                const txt = card.innerText || '';
                // 2026-05-04, 2026.05.04, 2026/05/04
                let m = txt.match(/\d{4}[-./]\s*\d{1,2}[-./]\s*\d{1,2}/);
                // 2026년 05월 04일
                if (!m) m = txt.match(/\d{4}\s*년\s*\d{1,2}\s*월\s*\d{1,2}\s*일/);
                if (m) dateText = m[0];
            }
            seen.add(href);
            out.push({title, href, img: imgSrc, dateText});
            if (out.length >= 40) break;
        }
        return out;
    """
    try:
        raw_items = driver.execute_script(items_js) or []
    except Exception as e:
        print(f"  ✗ extract err: {e}")
        return []
    print(f"  raw 후보: {len(raw_items)}건")

    # 필터링 — 날짜 필터 제거 + 메뉴/푸터 제거
    out = []
    # 정확히 일치하는 메뉴/페이징 단어들 (PRODUCTS/EVENTS 등 카테고리는 detail 보강 전 제목으로 쓰니 제외 X)
    skip_words = [
        "로그인", "회원가입", "메뉴", "검색", "마이페이지", "전체보기", "더보기",
        "Home", "About",
        "플레이어즈", "공식 사이트", "공식사이트", "포켓몬 스토어", "포켓몬스토어",
        "시작하는 방법", "룰", "Q&A", "공지사항", "취급 점포", "취급 점포",
        "Next Page", "Previous Page", "Last Page", "First Page",
        "다음", "이전", "Next", "Prev", "more", "view",
    ]
    skip_url_patterns = ["/login", "/register", "/menu", "/search", "/policy", "/terms"]
    for it in raw_items:
        title = (it.get("title") or "").strip()
        href = it.get("href") or ""
        if len(title) < 5:
            continue
        # 정확히 일치하거나 짧은 제목으로 메뉴인 경우 제외
        if any(title.strip() == w or title.strip().lower() == w.lower() for w in skip_words):
            continue
        # URL 메뉴 패턴 제외
        if any(p in href.lower() for p in skip_url_patterns):
            continue
        # href 가 #, javascript:void, 빈값 인 경우 제외
        if href.startswith("#") or href.startswith("javascript:") or len(href) < 10:
            continue
        date = parse_date(it.get("dateText", "")) or ""
        img_abs = absolutize(it.get("img", ""), src["base_url"])
        # image URL 에서 YYYYMMDD 추출 (게시글 진짜 발매일) — date 비어있거나 오늘이면 우선 적용
        from datetime import datetime as _dt
        today_str = _dt.now().strftime("%Y-%m-%d")
        if not date or date == today_str:
            m_img = re.search(r'(20\d{2})(\d{2})(\d{2})_\d', img_abs)
            if m_img:
                date = f"{m_img.group(1)}-{m_img.group(2)}-{m_img.group(3)}"
        out.append({
            "title": title[:120],
            "image": img_abs,
            "link": absolutize(href, src["base_url"]),
            "date": date,
            "source": src["key"],
            "sourceLabel": src["label"],
        })
    out = out[:20]
    print(f"  필터 후: {len(out)}건")
    # 전체 출력 (디버깅) — 최대 15개
    for i, it in enumerate(out[:15], 1):
        print(f"    {i}. [{it['date']}] {it['title'][:60]}")
    return out


# 원피스 사이트는 list 에서 제목이 카테고리("PRODUCTS")로 잡혀서 detail 페이지 fetch 필요
GENERIC_TITLES = {
    "PRODUCTS", "EVENTS", "NEWS", "NOTICE", "BOOSTERS", "DECKS", "OTHER",
    "상품정보", "이벤트", "공지사항", "뉴스",
}


def fetch_detail_title(driver, url: str) -> str:
    """detail 페이지에서 진짜 제목 추출 — 페이지 완전 로드 검증 후 추출"""
    try:
        # about:blank 으로 먼저 가서 이전 페이지 잔재 클리어 (DOM 캐싱 방지)
        driver.get("about:blank")
        time.sleep(0.3)
        driver.get(url)
    except Exception:
        return None
    # 1) document.readyState 가 complete 될 때까지 최대 8초 대기
    for _ in range(40):
        try:
            ready = driver.execute_script("return document.readyState")
            cur = driver.execute_script("return location.href")
            if ready == "complete" and cur and url.split("?")[0] in cur:
                break
        except Exception:
            pass
        time.sleep(0.2)
    # 2) 추가 안정화 대기 (JS 렌더링 완료)
    time.sleep(1.5)
    # 3) URL 일치 최종 검증
    try:
        cur = driver.execute_script("return location.href") or ""
        # brdno=숫자 같은 식별자 검증
        import re as _re
        m1 = _re.search(r"brdno=(\d+)", url)
        m2 = _re.search(r"brdno=(\d+)", cur)
        if m1 and m2 and m1.group(1) != m2.group(1):
            print(f"    ⚠ URL mismatch: expected brdno={m1.group(1)}, got brdno={m2.group(1)}")
            return None
    except Exception:
        pass
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
    fresh_items: list = []

    driver = make_driver(lang="ko-KR")
    try:
        for src in NEWS_SOURCES:
            try:
                if src["key"] == "pokemon":
                    items = scrape_pokemon(driver, src)
                else:
                    items = scrape_onepiece(driver, src)
                fresh_items.extend(items)
            except Exception as e:
                print(f"  ❌ {src['label']} 에러: {e}")
    finally:
        driver.quit()

    # ── merge with existing — link 으로 중복 체크, 새 항목만 추가 ──
    out_path = DATA_DIR / "news.json"
    existing_items = []
    if out_path.exists():
        try:
            data = json.loads(out_path.read_text("utf-8"))
            existing_items = data.get("items", []) or []
        except Exception:
            existing_items = []

    existing_links = {it.get("link") for it in existing_items if it.get("link")}
    existing_by_title = {(it.get("title") or "").strip(): it for it in existing_items}
    added = 0
    for fresh in fresh_items:
        if fresh.get("link") in existing_links:
            continue
        # 같은 title 있으면 기존 date 보존 (link 만 바뀐 경우)
        ftitle = (fresh.get("title") or "").strip()
        if ftitle in existing_by_title:
            old_date = existing_by_title[ftitle].get("date")
            if old_date:
                fresh["date"] = old_date
        existing_items.append(fresh)
        existing_links.add(fresh.get("link"))
        added += 1

    # 4월~5월 항목만 유지 (옛날 데이터 정리)
    def is_apr_may(date_str):
        if not date_str:
            return False
        m = re.match(r"\d{4}-(\d{2})-\d{2}", date_str)
        if not m:
            return False
        return int(m.group(1)) in (4, 5)

    existing_items = [it for it in existing_items if is_apr_may(it.get("date"))]

    # 날짜 desc 정렬
    existing_items.sort(key=lambda x: x.get("date") or "", reverse=True)

    payload = {
        "ok": True,
        "fetchedAt": fetched_at,
        "count": len(existing_items),
        "items": existing_items,
    }
    txt = json.dumps(payload, ensure_ascii=False, indent=2)
    out_path.write_bytes(txt.encode("utf-8"))
    print(f"\n→ 저장: {out_path.relative_to(DATA_DIR.parent)}  (총 {len(existing_items)}건, 신규 +{added})")


if __name__ == "__main__":
    main()
