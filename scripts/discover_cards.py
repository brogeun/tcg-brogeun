"""
SNKRDUNK 카드 카탈로그 전수 수집 (로컬 PC 실행 전용)

목적: 백필 대상 카드 ID 풀을 확장.
기본 daily scraper 는 TOP 10 + 30 cards × 2 brands = ~70 카드만 추적.
이 스크립트는 SNKRDUNK pokemon / onepiece 카드 카테고리를
끝까지 스크롤해서 *모든* product ID 를 수집한다.

결과: data/all-cards.json
이후 backfill_history.py 가 이 파일이 있으면 우선 사용.

사용법:
  python scripts/discover_cards.py
      → 양쪽 brand 모두 (포켓몬 + 원피스)

  python scripts/discover_cards.py pokemon
      → 포켓몬만

  python scripts/discover_cards.py --include-box
      → 박스도 함께 수집 (기본은 카드만)

소요시간: 카드 수에 따라 5-30분 (수만 장이면 더 길 수 있음)
"""

import json
import re
import time
import sys
from pathlib import Path
from datetime import datetime, timezone

from selenium import webdriver
from selenium.webdriver.chrome.options import Options

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DATA_DIR.mkdir(exist_ok=True)

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# SNKRDUNK 카테고리:
#   카드(개별 카드): categoryId=25
#   박스(언오픈 box): categoryId=14
TARGETS = {
    "pokemon-card":   "https://snkrdunk.com/jp/brands/pokemon/trading-cards?categoryId=25&slide=right",
    "onepiece-card":  "https://snkrdunk.com/jp/brands/onepiece/trading-cards?categoryId=25&slide=right",
    "pokemon-box":    "https://snkrdunk.com/jp/brands/pokemon/trading-cards?categoryId=14",
    "onepiece-box":   "https://snkrdunk.com/jp/brands/onepiece/trading-cards?categoryId=14",
}


def make_driver():
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_argument("--window-size=1280,3000")
    opts.add_argument(f"--user-agent={UA}")
    opts.add_argument("--lang=ja-JP")
    return webdriver.Chrome(options=opts)


def scroll_to_end(driver, label="", max_idle_rounds=15, pause=1.6, max_rounds=3000):
    """무한 스크롤 — N번 연속 새 컨텐츠 안 나오면 종료"""
    last_count = 0
    idle = 0
    rounds = 0
    print(f"    스크롤 시작...")
    while idle < max_idle_rounds and rounds < max_rounds:
        rounds += 1
        driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
        time.sleep(pause)
        # 현재까지 발견된 product 링크 수
        try:
            count = driver.execute_script("""
                return new Set(
                    Array.from(document.querySelectorAll('a[href*="/apparels/"]'))
                      .map(a => {
                        const m = a.href.match(/\\/apparels\\/(\\d+)/);
                        return m ? m[1] : null;
                      })
                      .filter(x => x)
                ).size;
            """)
        except Exception:
            count = last_count
        if count > last_count:
            if rounds % 5 == 0 or count - last_count > 50:
                print(f"      [round {rounds}] {label} 누적 {count}개")
            last_count = count
            idle = 0
        else:
            idle += 1
            if idle == max_idle_rounds // 2:
                print(f"      ... idle {idle}/{max_idle_rounds}")
    print(f"    ✓ 스크롤 종료 ({rounds}라운드, 총 {last_count}개 발견)")
    return last_count


def extract_ids(driver):
    """현재 페이지에서 모든 /apparels/{id} 링크 추출"""
    ids = driver.execute_script("""
        return Array.from(new Set(
            Array.from(document.querySelectorAll('a[href*="/apparels/"]'))
              .map(a => {
                const m = a.href.match(/\\/apparels\\/(\\d+)/);
                return m ? m[1] : null;
              })
              .filter(x => x)
        ));
    """)
    return ids or []


def discover(driver, key, url):
    print(f"\n[{key}] {url}")
    try:
        driver.get(url)
    except Exception as e:
        print(f"    ⚠ 페이지 로드 실패: {e}")
        return []
    time.sleep(3)
    # 스크롤 무한
    scroll_to_end(driver, label=key)
    ids = extract_ids(driver)
    print(f"    → 최종 {len(ids)}개 ID 추출")
    return ids


def main():
    args = sys.argv[1:]
    include_box = "--include-box" in args
    pos_args = [a for a in args if not a.startswith("--")]

    selected_brands = None
    if pos_args:
        b = pos_args[0].lower()
        if b in ("pokemon", "포켓몬"):
            selected_brands = ["pokemon"]
        elif b in ("onepiece", "원피스"):
            selected_brands = ["onepiece"]

    targets = {}
    for k, v in TARGETS.items():
        brand, kind = k.split("-")
        if selected_brands and brand not in selected_brands:
            continue
        if kind == "box" and not include_box:
            continue
        targets[k] = v

    print(f"================================================")
    print(f"SNKRDUNK 카탈로그 전수 수집")
    print(f"대상: {list(targets.keys())}")
    print(f"================================================")

    by_target = {}
    driver = make_driver()
    try:
        for k, url in targets.items():
            try:
                ids = discover(driver, k, url)
                by_target[k] = ids
            except Exception as e:
                print(f"⚠ {k} 실패: {e}")
                by_target[k] = []
    finally:
        driver.quit()

    # 종합
    by_brand = {"pokemon": set(), "onepiece": set()}
    only_cards = set()
    only_boxes = set()
    for k, ids in by_target.items():
        brand, kind = k.split("-")
        if brand in by_brand:
            by_brand[brand].update(ids)
        if kind == "card":
            only_cards.update(ids)
        else:
            only_boxes.update(ids)

    out = {
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "byTarget": {k: ids for k, ids in by_target.items()},
        "byBrand": {b: sorted(ids) for b, ids in by_brand.items() if ids},
        "cards": sorted(only_cards),
        "boxes": sorted(only_boxes) if include_box else [],
        "all": sorted(only_cards | only_boxes),
    }
    out_path = DATA_DIR / "all-cards.json"
    out_path.write_bytes(json.dumps(out, ensure_ascii=False, indent=2).encode("utf-8"))

    total_cards = len(only_cards)
    total_boxes = len(only_boxes)
    print(f"\n================================================")
    print(f"✓ data/all-cards.json 저장")
    print(f"   카드: {total_cards}개")
    if include_box:
        print(f"   박스: {total_boxes}개")
    for brand, ids in by_brand.items():
        if ids:
            print(f"   {brand}: {len(ids)}개")
    print(f"================================================")
    print(f"\n다음 단계 — 전체 백필:")
    print(f"  python scripts/backfill_history.py --resume --no-volume")
    print(f"   → 가격 라인만 빠르게 (예상 {int(total_cards*3/60)}분)")
    print(f"")
    print(f"  python scripts/backfill_history.py --resume")
    print(f"   → 가격 + 거래량 정밀 (예상 {int(total_cards*60/60)}시간)")


if __name__ == "__main__":
    main()
