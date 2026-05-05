"""
fetch_onepiece_official.py — 원피스 일판 공식 카드 리스트 자체 호스팅

소스: https://www.onepiece-cardgame.com/cardlist/
- 시리즈 dropdown 자동 디스커버리 → OP01 ~ OP15, EB01 ~ EB04, ST*
- 각 세트의 전체 카드 (#001 ~ 마지막 SEC) 스크래핑
- 출력: data/cards-by-set/{code}.json (포켓몬 tcgcollector 와 동일 포맷)

사용:
  python scripts/fetch_onepiece_official.py            # 전체 받기 (기존 덮어씌움)
  python scripts/fetch_onepiece_official.py --only OP15  # 특정 세트만
  python scripts/fetch_onepiece_official.py --skip-existing  # 기존 파일은 건너뜀

요구:
  pip install selenium
  + Chrome browser 설치
"""

import argparse
import json
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

try:
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC
    from selenium.webdriver.support.ui import WebDriverWait
except ImportError:
    print("❌ selenium 미설치 — pip install selenium")
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "cards-by-set"
OUT_DIR.mkdir(parents=True, exist_ok=True)

BASE = "https://www.onepiece-cardgame.com"
LIST_URL = BASE + "/cardlist/"

# 우리가 보유한 세트 (index.html 의 CARDINFO ONEPIECE_SETS) — 일판 공식 series 명과 매칭
# series 명은 사이트 dropdown 에서 자동 디스커버리 시 매칭됨 (keyword 로)
OUR_SET_KEYWORDS = {
    "OP16": ["OP-16"],
    "OP15": ["OP-15", "Adventure on KAMI", "アドベンチャー オブ カミ"],
    "EB04": ["EB-04", "EGGHEAD CRISIS"],
    "OP14": ["OP-14"],
    "EB03": ["EB-03"],
    "OP13": ["OP-13"],
    "OP12": ["OP-12"],
    "OP11": ["OP-11"],
    "EB02": ["EB-02"],
    "OP10": ["OP-10"],
    "OP09": ["OP-09"],
    "OP08": ["OP-08"],
    "OP07": ["OP-07"],
    "EB01": ["EB-01"],
    "OP06": ["OP-06"],
    "OP05": ["OP-05"],
    "OP04": ["OP-04"],
    "OP03": ["OP-03"],
    "OP02": ["OP-02"],
    "OP01": ["OP-01"],
}


def make_driver(headless: bool = True):
    opts = Options()
    if headless:
        opts.add_argument("--headless=new")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--disable-gpu")
    opts.add_argument("--window-size=1400,2000")
    opts.add_argument("--lang=ja-JP")
    opts.add_argument(
        "user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    )
    drv = webdriver.Chrome(options=opts)
    drv.set_page_load_timeout(60)
    return drv


def discover_series(driver) -> list[tuple[str, str, str]]:
    """
    공식 사이트의 series dropdown 에서 (series_id, label, our_code) 목록 추출.
    매칭되지 않은 시리즈는 our_code 가 None.
    """
    print(f"  ↳ 시리즈 디스커버리: {LIST_URL}")
    driver.get(LIST_URL)
    time.sleep(2)

    # series 가 select element 또는 button 으로 노출. 둘 다 시도.
    series_options = []

    # 1. <select name="series"> 또는 id="series"
    try:
        sel = driver.find_element(By.CSS_SELECTOR, "select[name='series'], select#series")
        for opt in sel.find_elements(By.TAG_NAME, "option"):
            sid = opt.get_attribute("value") or ""
            label = opt.text.strip()
            if sid and label:
                series_options.append((sid, label))
    except Exception:
        pass

    # 2. fallback: 페이지 HTML 에서 정규식
    if not series_options:
        html = driver.page_source
        for m in re.finditer(r'<option\s+value=["\']?(\d{6,})["\']?[^>]*>([^<]+)</option>', html):
            sid, label = m.group(1), m.group(2).strip()
            series_options.append((sid, label))

    print(f"  ↳ {len(series_options)} 시리즈 발견")

    # 매칭
    result = []
    for sid, label in series_options:
        our_code = None
        for code, kws in OUR_SET_KEYWORDS.items():
            if any(kw.lower() in label.lower() for kw in kws):
                our_code = code
                break
        result.append((sid, label, our_code))

    matched = [r for r in result if r[2]]
    print(f"  ↳ 우리 코드 매칭: {len(matched)}/{len(OUR_SET_KEYWORDS)}")
    for sid, label, code in matched:
        print(f"      {code:<6} = {sid:<8} {label[:50]}")

    missing = [c for c in OUR_SET_KEYWORDS if not any(r[2] == c for r in result)]
    if missing:
        print(f"  ⚠ 매칭 안 됨: {missing}")

    return result


def fetch_set_cards(driver, series_id: str, label: str) -> list[dict]:
    """단일 시리즈 카드 리스트 스크래핑"""
    url = f"{LIST_URL}?series={series_id}"
    print(f"      → fetch {url}")
    driver.get(url)

    # 카드 요소 wait — div.modal-list-item 또는 .resultCol .resultColInner 패턴
    # 사이트 구조에 따라 selector 가 달라짐 — 다중 후보로 시도
    selectors = [
        "div.resultCol",        # 일판 사이트 일반 카드 그리드
        "div.modal-col",        # 모달용
        "li.cardlist__item",    # 옛 패턴
        "div.list-item",
        "ul.cardlist > li",
    ]

    cards_html = []
    found_sel = None
    for sel in selectors:
        try:
            WebDriverWait(driver, 8).until(
                EC.presence_of_all_elements_located((By.CSS_SELECTOR, sel))
            )
            cards_html = driver.find_elements(By.CSS_SELECTOR, sel)
            if len(cards_html) > 5:
                found_sel = sel
                break
        except Exception:
            continue

    if not cards_html:
        # last resort — 정규식으로 전체 HTML 파싱
        print(f"      ⚠ DOM selector 실패, HTML 정규식 fallback")
        return parse_cards_from_html(driver.page_source)

    print(f"      ✓ {len(cards_html)} 카드 ({found_sel})")

    out = []
    for el in cards_html:
        try:
            html = el.get_attribute("outerHTML") or ""
            card = parse_card_element(html)
            if card and card.get("number"):
                out.append(card)
        except Exception:
            continue
    return out


def parse_card_element(html: str) -> dict:
    """단일 카드 element 의 HTML 에서 정보 추출"""
    # 카드 번호 — 보통 [OP15-001] 형태
    num_match = re.search(r'(?:OP|EB|ST|P)[\-]?(\d+)[\-_](\d+)', html, re.IGNORECASE)
    number = ""
    if num_match:
        number = num_match.group(2)

    # 카드 이름 — h4, .cardName, span.name 등
    name = ""
    for pat in [
        r'<h4[^>]*>([^<]+)</h4>',
        r'class=["\']cardName["\'][^>]*>([^<]+)<',
        r'class=["\']name["\'][^>]*>([^<]+)<',
        r'data-name=["\']([^"\']+)["\']',
        r'<span[^>]+>\s*([^\s<][^<]{2,40}?)\s*</span>',
    ]:
        m = re.search(pat, html)
        if m:
            name = m.group(1).strip()
            break

    # 이미지 URL — img src 또는 data-src
    img = ""
    for pat in [
        r'src=["\']([^"\']+\.png)["\']',
        r'data-src=["\']([^"\']+\.png)["\']',
        r'src=["\']([^"\']+\.jpg)["\']',
    ]:
        m = re.search(pat, html)
        if m:
            img = m.group(1)
            if img.startswith("/"):
                img = BASE + img
            elif img.startswith("//"):
                img = "https:" + img
            break

    # 카드 코드 (예: OP15-001) → name 에 prefix 로 결합 안 함
    return {
        "number": number,
        "name": name,
        "image": img,
    }


def parse_cards_from_html(html: str) -> list[dict]:
    """HTML 전체에서 카드 정규식 파싱 (fallback)"""
    out = []
    # 카드 번호 패턴 — OP15-001, EB04-061, ST10-006 등
    for m in re.finditer(r'((?:OP|EB|ST)\d+)[\-_](\d+)', html):
        out.append({
            "number": m.group(2),
            "name": "",
            "image": "",
        })
    # dedupe
    seen = set()
    uniq = []
    for c in out:
        key = c["number"]
        if key not in seen:
            seen.add(key)
            uniq.append(c)
    return uniq


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--only", help="특정 세트만 (예: OP15)")
    p.add_argument("--skip-existing", action="store_true", help="기존 파일 있으면 건너뜀")
    p.add_argument("--no-headless", action="store_true", help="브라우저 보이게")
    args = p.parse_args()

    print("=" * 60)
    print(f"원피스 일판 공식 카드리스트 → {OUT_DIR.relative_to(ROOT)}/")
    print("=" * 60)

    driver = make_driver(headless=not args.no_headless)
    try:
        series_list = discover_series(driver)

        # 우리 코드별로만 처리
        targets = [(sid, label, code) for sid, label, code in series_list if code]
        if args.only:
            targets = [t for t in targets if t[2] == args.only]
            if not targets:
                print(f"❌ '{args.only}' 매칭 안 됨")
                return

        print(f"\n━━━ 처리 대상: {len(targets)}개 세트 ━━━")
        fetched_at = datetime.now(timezone.utc).isoformat()
        success = 0
        failed = []
        for sid, label, code in targets:
            out_path = OUT_DIR / f"{code}.json"
            if args.skip_existing and out_path.exists():
                print(f"  {code:<6} skip (exists)")
                continue
            print(f"\n  {code:<6} ← {label}")
            try:
                cards = fetch_set_cards(driver, sid, label)
                if not cards:
                    failed.append(code)
                    print(f"      ❌ 카드 0개")
                    continue
                # 정렬
                cards.sort(key=lambda c: int(c["number"]) if c["number"].isdigit() else 9999)
                # uniqueness — 같은 번호 여러 variant 면 첫 번째만
                seen = set()
                uniq = []
                for c in cards:
                    if c["number"] not in seen:
                        seen.add(c["number"])
                        uniq.append(c)

                payload = {
                    "code": code,
                    "label": label,
                    "fetchedAt": fetched_at,
                    "source": "onepiece-cardgame.com (일판 공식)",
                    "cardCount": len(uniq),
                    "cards": uniq,
                }
                out_path.write_text(
                    json.dumps(payload, ensure_ascii=False, indent=2),
                    encoding="utf-8"
                )
                print(f"      ✓ {len(uniq)} unique cards → {out_path.relative_to(ROOT)}")
                success += 1
                time.sleep(1.5)  # rate limit
            except Exception as e:
                print(f"      ❌ FAIL: {e}")
                failed.append(code)
                # driver 깨졌을 수 있음 — 재시작
                try:
                    driver.quit()
                except Exception:
                    pass
                driver = make_driver(headless=not args.no_headless)

        print(f"\n━━━ 완료 ━━━")
        print(f"  성공: {success}")
        print(f"  실패: {failed}")
    finally:
        try:
            driver.quit()
        except Exception:
            pass


if __name__ == "__main__":
    main()
