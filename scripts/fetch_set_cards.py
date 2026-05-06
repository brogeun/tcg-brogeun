"""
fetch_set_cards.py — 세트별 풀 카드 데이터 (모든 variants 포함) 수집

검증된 셀렉터:
  - tcgcollector.com:  .card-image-grid-item (공식 카드 그리드)
  - tcgrepublic.com:   카드 그리드 a 태그 (요소별 추출)

displayAs=images 모드로 모든 카드 (RR, AR, SAR, SR 등) 한 페이지에 표시.

출력: data/cards-by-set/{code}.json
포맷:
{
  "code": "M4",
  "name": "닌자 스페너",
  "fetchedAt": "2026-05-05T...",
  "cardCount": 120,
  "cards": [
    {"number": "001/083", "name": "Weedle", "image": "https://...", "rarity": "C", "url": "https://..."}
  ]
}

사용:
  python scripts/fetch_set_cards.py            # 전체
  python scripts/fetch_set_cards.py M4 OP15    # 특정 세트만
  python scripts/fetch_set_cards.py --force    # 기존 덮어쓰기
  python scripts/fetch_set_cards.py --pokemon  # 포켓몬만
  python scripts/fetch_set_cards.py --onepiece # 원피스만
"""

import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.chrome.options import Options


ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "cards-by-set"
OUT_DIR.mkdir(parents=True, exist_ok=True)

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

POKEMON_SETS = [
    ("M4", "닌자 스페너", "https://www.tcgcollector.com/sets/11800/ninja-spinner"),
    ("M3", "무니키스 제로", "https://www.tcgcollector.com/sets/11684/nullifying-zero"),
    ("M2a", "메가 드림 ex", "https://www.tcgcollector.com/sets/11678/mega-dream-ex"),
    ("M2", "인페르노 X", "https://www.tcgcollector.com/sets/11675/inferno-x"),
    ("M1L", "메가 브레이브", "https://www.tcgcollector.com/sets/11660/mega-brave"),
    ("M1S", "메가 심포니아", "https://www.tcgcollector.com/sets/11661/mega-symphonia"),
    ("SV11B", "블랙 볼트", "https://www.tcgcollector.com/sets/11652/black-bolt"),
    ("SV11W", "화이트 플레어", "https://www.tcgcollector.com/sets/11653/white-flare"),
    ("SV10", "로켓단의 영광", "https://www.tcgcollector.com/sets/11649/the-glory-of-team-rocket"),
    ("SV9a", "열풍의 아레나", "https://www.tcgcollector.com/sets/11648/hot-air-arena"),
    ("SV9", "배틀 파트너즈", "https://www.tcgcollector.com/sets/11643/battle-partners"),
    ("SV8a", "테라스탈 페스티벌 ex", "https://www.tcgcollector.com/sets/11640/terastal-festival-ex"),
    ("SV8", "초전 브레이커", "https://www.tcgcollector.com/sets/11638/super-electric-breaker"),
    ("SV7a", "파라다이스 드래고나", "https://www.tcgcollector.com/sets/11635/paradise-dragona"),
    ("SV7", "스텔라 미라클", "https://www.tcgcollector.com/sets/11629/stellar-miracle"),
    ("SV6a", "나이트 원더러", "https://www.tcgcollector.com/sets/11626/night-wanderer"),
    ("SV6", "변환의 가면", "https://www.tcgcollector.com/sets/11624/mask-of-change"),
    ("SV5a", "크림슨 헤이즈", "https://www.tcgcollector.com/sets/11622/crimson-haze"),
    ("SV5M", "사이버 저지", "https://www.tcgcollector.com/sets/11604/cyber-judge"),
    ("SV5K", "와일드 포스", "https://www.tcgcollector.com/sets/11603/wild-force"),
    ("SV4a", "샤이니 트레저 ex", "https://www.tcgcollector.com/sets/11602/shiny-treasure-ex"),
    ("SV4M", "미래의 일섬", "https://www.tcgcollector.com/sets/11593/future-flash"),
    ("SV4K", "고대의 포효", "https://www.tcgcollector.com/sets/11592/ancient-roar"),
    ("SV3a", "레이징 서프", "https://www.tcgcollector.com/sets/11583/raging-surf"),
    ("SV3", "흑염의 지배자", "https://www.tcgcollector.com/sets/11578/ruler-of-the-black-flame"),
    ("SV2a", "포켓몬 카드 151", "https://www.tcgcollector.com/sets/11575/pokemon-card-151"),
    ("SV2D", "클레이 버스트", "https://www.tcgcollector.com/sets/11570/clay-burst"),
    ("SV2P", "스노우 해저드", "https://www.tcgcollector.com/sets/11569/snow-hazard"),
    ("SV1a", "트리플렛 비트", "https://www.tcgcollector.com/sets/11566/triplet-beat"),
    # ─── Sword & Shield Era ───
    ("s12a", "VSTAR 유니버스", "https://www.tcgcollector.com/sets/11503/vstar-universe"),
    ("s12", "패러다임 트리거", "https://www.tcgcollector.com/sets/11499/paradigm-trigger"),
    ("s11a", "백휘의 아르카나", "https://www.tcgcollector.com/sets/11497/incandescent-arcana"),
    ("s11", "로스트 어비스", "https://www.tcgcollector.com/sets/11484/lost-abyss"),
    ("s10b", "포켓몬 GO", "https://www.tcgcollector.com/sets/11481/pokemon-go"),
    ("s10a", "다크 판타즈마", "https://www.tcgcollector.com/sets/11469/dark-phantasma"),
    ("s9a", "배틀 리전", "https://www.tcgcollector.com/sets/11456/battle-region"),
    ("s9", "스타 버스", "https://www.tcgcollector.com/sets/11452/star-birth"),
    ("s8b", "VMAX 클라이맥스", "https://www.tcgcollector.com/sets/11449/vmax-climax"),
    ("s8", "퓨전 아츠", "https://www.tcgcollector.com/sets/11437/fusion-arts"),
    ("s7R", "블루 스카이 스트림", "https://www.tcgcollector.com/sets/11430/blue-sky-stream"),
    ("s7D", "마천의 퍼펙트", "https://www.tcgcollector.com/sets/11429/skyscraping-perfection"),
    ("s6a", "이브이 히어로즈", "https://www.tcgcollector.com/sets/11424/eevee-heroes"),
]

ONEPIECE_SETS = [
    ("OP15", "OP-15", "https://tcgrepublic.com/category/subcategory_page_10948.html"),
    ("EB04", "Extra Booster 04", "https://tcgrepublic.com/category/subcategory_page_10895.html"),
    ("OP14", "OP-14", "https://tcgrepublic.com/category/subcategory_page_10744.html"),
    ("EB03", "Extra Booster 03", "https://tcgrepublic.com/category/subcategory_page_10671.html"),
    ("OP13", "계승된 의지", "https://tcgrepublic.com/category/subcategory_page_10545.html"),
    ("OP12", "마스터의 유산", "https://tcgrepublic.com/category/subcategory_page_10336.html"),
    ("OP11", "신속의 일격", "https://tcgrepublic.com/category/subcategory_page_10172.html"),
    ("EB02", "애니메이션 25주년", "https://tcgrepublic.com/category/subcategory_page_10091.html"),
    ("OP10", "로열 블러드", "https://tcgrepublic.com/category/subcategory_page_9987.html"),
    ("OP09", "신세계의 황제들", "https://tcgrepublic.com/category/subcategory_page_9758.html"),
    ("OP08", "두 전설", "https://tcgrepublic.com/category/subcategory_page_9499.html"),
    ("OP07", "500년 후의 미래", "https://tcgrepublic.com/category/subcategory_page_9138.html"),
    ("EB01", "메모리얼 컬렉션", "https://tcgrepublic.com/category/subcategory_page_9054.html"),
    ("OP06", "선장의 날개", "https://tcgrepublic.com/category/category_page_67.html"),
    ("OP05", "새로운 시대의 개막", "https://tcgrepublic.com/category/subcategory_page_8690.html"),
    ("OP04", "음모의 왕국", "https://tcgrepublic.com/category/subcategory_page_8492.html"),
    ("OP03", "힘의 기둥", "https://tcgrepublic.com/category/subcategory_page_8014.html"),
    ("OP02", "정상 전쟁", "https://tcgrepublic.com/category/subcategory_page_7712.html"),
    ("OP01", "로맨스 던", "https://tcgrepublic.com/category/subcategory_page_7322.html"),
]


def make_driver(headless: bool = True):
    opts = Options()
    if headless:
        opts.add_argument("--headless=new")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--window-size=1920,3000")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_argument(f"--user-agent={UA}")
    driver = webdriver.Chrome(options=opts)
    try:
        driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
    except Exception:
        pass
    return driver


def scroll_to_bottom(driver, max_iter=20, sleep=1.0):
    """무한 스크롤 — 페이지 끝까지"""
    last_h = 0
    for _ in range(max_iter):
        driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
        time.sleep(sleep)
        h = driver.execute_script("return document.body.scrollHeight")
        if h == last_h:
            break
        last_h = h
    driver.execute_script("window.scrollTo(0, 0);")
    time.sleep(0.5)


def scrape_pokemon_set(driver, code: str, name: str, url: str) -> dict:
    """tcgcollector — .card-image-grid-item 직접 매칭"""
    full_url = url + ("&" if "?" in url else "?") + "displayAs=images&setCardCountMode=anyCardVariant"
    print(f"  fetching {full_url}")
    driver.get(full_url)
    # 카드 그리드 로드 대기 — 최대 30초
    for i in range(30):
        time.sleep(1)
        count = driver.execute_script("return document.querySelectorAll('.card-image-grid-item').length")
        if count > 0:
            print(f"    {count}개 그리드 아이템 감지 ({i+1}초)")
            break
    else:
        # 디버깅 — 0 카드일 때 페이지 상태 출력
        title = driver.execute_script("return document.title")
        body_text = driver.execute_script("return (document.body.innerText || '').slice(0, 300)")
        current_url = driver.current_url
        print(f"    ⚠ 그리드 못 찾음 (30초)")
        print(f"      title: {title}")
        print(f"      url: {current_url}")
        print(f"      body: {body_text[:200]}")
    scroll_to_bottom(driver, max_iter=30, sleep=1.5)

    js = r"""
        const out = [];
        // tcgcollector 의 공식 카드 그리드 클래스 (검증됨)
        const items = document.querySelectorAll('.card-image-grid-item');
        for (const item of items) {
            // 카드 링크
            const a = item.querySelector('a[href*="/cards/"]');
            const href = a ? a.href : '';
            // 이미지
            const img = item.querySelector('img');
            if (!img) continue;
            const imgSrc = img.src || img.dataset.src || img.getAttribute('data-src') || '';
            if (!imgSrc) continue;
            // 카드 번호 (001/083 패턴)
            const text = (item.innerText || '').trim();
            const numMatch = text.match(/(\d{1,3}\/\d{1,3})/);
            const number = numMatch ? numMatch[1] : '';
            // 이름 (img alt 또는 카드 이름 영역)
            let cardName = (img.alt || '').trim();
            if (!cardName) {
                const nameEl = item.querySelector('.card-image-grid-item-name, .card-name');
                if (nameEl) cardName = (nameEl.innerText || '').trim();
            }
            // rarity (가능하면)
            const rarityEl = item.querySelector('.card-image-grid-item-rarity, [class*="rarity"]');
            const rarity = rarityEl ? (rarityEl.innerText || rarityEl.title || '').trim() : '';
            out.push({number, name: cardName, image: imgSrc, rarity, url: href});
        }
        return out;
    """
    cards = driver.execute_script(js) or []
    return {
        "code": code,
        "name": name,
        "brand": "pokemon",
        "source": "tcgcollector.com",
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "cardCount": len(cards),
        "cards": cards,
    }


def scrape_onepiece_page(driver, page_url: str) -> list:
    """tcgrepublic 한 페이지 카드 추출"""
    print(f"    page: {page_url}")
    driver.get(page_url)
    time.sleep(3)
    scroll_to_bottom(driver, max_iter=5)

    js = r"""
        const out = [];
        const seen = new Set();
        // tcgrepublic 다양한 패턴 시도
        const anchors = document.querySelectorAll('a[href*="goods_view"], a[href*="product_detail"], a[href*="/product/"]');
        for (const a of anchors) {
            const href = a.href;
            if (seen.has(href)) continue;
            const img = a.querySelector('img') || a.parentElement?.querySelector('img');
            if (!img) continue;
            const imgSrc = img.src || img.dataset.src || img.getAttribute('data-src') || '';
            if (!imgSrc) continue;
            const w = img.naturalWidth || img.width || 0;
            if (w > 0 && w < 80) continue;
            const alt = (img.alt || '').trim();
            const card = a.closest('li, article, .item, .product, .goods, div') || a;
            const cardText = (card.innerText || alt || '').trim();
            const numMatch = cardText.match(/(?:OP|EB|ST|STK|OPK|EB)\d*[-_\s]?\d{1,4}/i);
            const number = numMatch ? numMatch[0] : '';
            seen.add(href);
            out.push({
                number,
                name: alt || cardText.slice(0, 100).trim().split('\n')[0],
                image: imgSrc,
                rarity: '',
                url: href,
            });
        }
        return out;
    """
    return driver.execute_script(js) or []


def scrape_onepiece_set(driver, code: str, name: str, url: str) -> dict:
    """tcgrepublic — 페이지네이션 처리 (?p=1, ?p=2, ...)"""
    print(f"  scraping {code} from {url}")
    all_cards = []
    seen_urls = set()
    max_pages = 10  # 안전장치
    for page in range(1, max_pages + 1):
        page_url = url if page == 1 else (url + ("&" if "?" in url else "?") + f"p={page}")
        cards = scrape_onepiece_page(driver, page_url)
        if not cards:
            break
        # 중복 제거 (이전 페이지와 동일한 카드면 끝)
        new_cards = [c for c in cards if c["url"] not in seen_urls]
        if not new_cards:
            print(f"    페이지 {page}: 새 카드 없음 → 종료")
            break
        for c in new_cards:
            seen_urls.add(c["url"])
            all_cards.append(c)
        print(f"    페이지 {page}: +{len(new_cards)}건 (누적 {len(all_cards)})")
        time.sleep(0.5)

    return {
        "code": code,
        "name": name,
        "brand": "onepiece",
        "source": "tcgrepublic.com",
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "cardCount": len(all_cards),
        "cards": all_cards,
    }


def main():
    args_no_flag = [a for a in sys.argv[1:] if not a.startswith("--")]
    force = "--force" in sys.argv
    only_pokemon = "--pokemon" in sys.argv
    only_onepiece = "--onepiece" in sys.argv
    visible = "--visible" in sys.argv  # 브라우저 보이게 (디버깅)
    only_codes = set(a.upper() for a in args_no_flag) if args_no_flag else None

    print("=" * 60)
    print(f"세트별 풀 카드 데이터 수집 → {OUT_DIR.relative_to(ROOT)}/")
    if only_codes:
        print(f"필터: {only_codes}")
    print("=" * 60)

    driver = make_driver(headless=not visible)
    success, failed = 0, 0
    set_counter = 0
    try:
        if not only_onepiece:
            print("\n━━━ 포켓몬 (tcgcollector.com) ━━━")
            for code, name, url in POKEMON_SETS:
                if only_codes and code not in only_codes:
                    continue
                out_path = OUT_DIR / f"{code}.json"
                if out_path.exists() and not force:
                    try:
                        existing = json.loads(out_path.read_text("utf-8"))
                        if existing.get("cardCount", 0) > 0:
                            print(f"  {code:7s} skip (exists, {existing['cardCount']} 카드)")
                            continue
                        else:
                            print(f"  {code:7s} 0 카드 → 재시도")
                    except Exception:
                        pass

                # 매 세트마다 driver 재시작 (세션 누적 = 카드 0건 원인)
                if set_counter > 0:
                    driver.quit()
                    time.sleep(1)
                    driver = make_driver(headless=not visible)

                try:
                    data = scrape_pokemon_set(driver, code, name, url)
                    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
                    print(f"  {code:7s} ✓ {data['cardCount']} 카드")
                    success += 1
                except Exception as e:
                    print(f"  {code:7s} ✗ {e}")
                    failed += 1
                set_counter += 1
                time.sleep(3)

        if not only_pokemon:
            print("\n━━━ 원피스 (tcgrepublic.com) ━━━")
            for code, name, url in ONEPIECE_SETS:
                if only_codes and code not in only_codes:
                    continue
                out_path = OUT_DIR / f"{code}.json"
                if out_path.exists() and not force:
                    try:
                        existing = json.loads(out_path.read_text("utf-8"))
                        if existing.get("cardCount", 0) > 0:
                            print(f"  {code:7s} skip (exists, {existing['cardCount']} 카드)")
                            continue
                        else:
                            print(f"  {code:7s} 0 카드 → 재시도")
                    except Exception:
                        pass

                # 매 세트마다 driver 재시작
                if set_counter > 0:
                    driver.quit()
                    time.sleep(1)
                    driver = make_driver(headless=not visible)

                try:
                    data = scrape_onepiece_set(driver, code, name, url)
                    out_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
                    print(f"  {code:7s} ✓ {data['cardCount']} 카드")
                    success += 1
                except Exception as e:
                    print(f"  {code:7s} ✗ {e}")
                    failed += 1
                set_counter += 1
                time.sleep(3)
    finally:
        driver.quit()

    print(f"\n완료: 성공 {success} / 실패 {failed}")
    print(f"파일: {OUT_DIR.relative_to(ROOT)}/")


if __name__ == "__main__":
    main()
