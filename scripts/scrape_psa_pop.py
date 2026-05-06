"""
scrape_psa_pop.py — PSA10 Pop 매일 도박 스크래핑

PSA 사이트는 Cloudflare 보호 강함. selenium 으로 정상 브라우저 흉내내고,
하루에 통과하는 카드만 누적. 실패해도 다음날 재시도.

데이터: data/psa-pop.json
{
  "fetchedAt": "...",
  "pops": {
    "snkrdunkId123": {"psa10": 234, "psa9": 145, "total": 1234, "updatedAt": "2026-05-05"}
  }
}

사용:
  python scripts/scrape_psa_pop.py              # 매일 모든 카드 시도
  python scripts/scrape_psa_pop.py --limit 20   # N 개만 (테스트)
  python scripts/scrape_psa_pop.py --only 12345 # 특정 카드만

요구:
  pip install selenium

PSA URL 구조 (조사):
  https://www.psacard.com/pop/japanese-pokemon-cards/{설명}-{ID}
  https://www.psacard.com/pop/japanese-pokemon-cards/2025-pokemon-card-game-japanese/...
  검색이 어려워서 카드별 URL 매핑 필요. 일단 인기 카드 위주.
"""

import argparse
import json
import re
import sys
import time
import random
from pathlib import Path
from datetime import datetime, timezone

try:
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
except ImportError:
    print("❌ pip install selenium")
    sys.exit(1)

# undetected-chromedriver — Cloudflare 통과율 향상 (있으면 사용)
try:
    import undetected_chromedriver as uc
    HAS_UC = True
except ImportError:
    HAS_UC = False
    print("ℹ undetected-chromedriver 없음. pip install undetected-chromedriver 추천 (Cloudflare 통과율 향상)")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "psa-pop.json"
TOP10_FILES = [ROOT / "data" / "top10-pokemon.json", ROOT / "data" / "top10-onepiece.json"]
ALL_CARDS = ROOT / "data" / "all-cards.json"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def load_json(p):
    return json.loads(Path(p).read_bytes().rstrip(b'\x00').rstrip().decode('utf-8'))


def get_chrome_major_version():
    """Windows 의 Chrome version 감지 → major (예: 147)"""
    import subprocess as _sp
    candidates = [
        r'reg query "HKEY_CURRENT_USER\Software\Google\Chrome\BLBeacon" /v version',
        r'reg query "HKEY_LOCAL_MACHINE\Software\Google\Chrome\BLBeacon" /v version',
    ]
    for cmd in candidates:
        try:
            out = _sp.check_output(cmd, shell=True, stderr=_sp.DEVNULL).decode("utf-8", errors="ignore")
            m = re.search(r'(\d+)\.\d+\.\d+\.\d+', out)
            if m:
                return int(m.group(1))
        except Exception:
            continue
    return None


def make_driver(headless=True):
    if HAS_UC:
        # undetected-chromedriver — Cloudflare 통과율 90%+
        opts = uc.ChromeOptions()
        if headless:
            opts.add_argument("--headless=new")
        opts.add_argument("--no-sandbox")
        opts.add_argument("--disable-dev-shm-usage")
        opts.add_argument("--window-size=1280,900")
        opts.add_argument("--lang=en-US")
        # Chrome version 자동 감지 → chromedriver 매칭
        chrome_v = get_chrome_major_version()
        if chrome_v:
            print(f"  Chrome v{chrome_v} 감지 → chromedriver 매칭")
        drv = uc.Chrome(options=opts, version_main=chrome_v)
        drv.set_page_load_timeout(45)
        return drv
    # fallback — 일반 selenium (Cloudflare 차단 자주)
    opts = Options()
    if headless:
        opts.add_argument("--headless=new")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument(f"user-agent={UA}")
    opts.add_argument("--window-size=1280,900")
    opts.add_argument("--lang=en-US")
    drv = webdriver.Chrome(options=opts)
    drv.set_page_load_timeout(45)
    drv.execute_cdp_cmd("Page.addScriptToEvaluateOnNewDocument", {
        "source": "Object.defineProperty(navigator, 'webdriver', {get: () => undefined})"
    })
    return drv


def try_psa_search(driver, card_name, set_code, number, brand='pokemon'):
    """
    PSA 일본 카테고리 (japanese-pokemon-cards / japanese-one-piece) 에서 검색.
    set_code-number 로 검색 (예: M2-013, OP15-001).
    """
    # 일본 카테고리 search
    if brand == 'onepiece':
        category = 'one-piece-card-game'
        # 원피스는 일본/영문 통합 카테고리
        search_url = f"https://www.psacard.com/pop/{category}/?searchTerm={set_code}-{number}"
    else:
        category = 'japanese-pokemon-cards'
        # set 코드 + 카드 번호로 검색 (PSA 의 검색 query)
        search_url = f"https://www.psacard.com/pop/{category}/?searchTerm={set_code}-{number}"
    try:
        driver.get(search_url)
        # Cloudflare challenge 대기 (최대 10초)
        time.sleep(random.uniform(3, 6))
        # 검색 결과 페이지 확인
        title = (driver.title or '').lower()
        if 'just a moment' in title or 'cloudflare' in title or 'attention required' in title:
            return None  # Cloudflare 차단
        # 검색 결과 첫 카드 링크
        try:
            link = driver.find_element(By.CSS_SELECTOR, "a[href*='/pop/']")
            link_url = link.get_attribute('href')
            driver.get(link_url)
            time.sleep(random.uniform(2, 4))
        except Exception:
            return None  # 결과 없음
        # Pop 데이터 추출 — PSA 페이지의 grade 별 count 테이블
        pops = {}
        # 테이블 구조 — <td>10</td><td>234</td> 같은 패턴
        for row in driver.find_elements(By.CSS_SELECTOR, "tr"):
            cells = row.find_elements(By.TAG_NAME, "td")
            if len(cells) >= 2:
                grade_text = cells[0].text.strip()
                count_text = cells[1].text.strip().replace(',', '')
                if grade_text.isdigit() and count_text.isdigit():
                    pops[f"psa{grade_text}"] = int(count_text)
        if pops.get("psa10") is None:
            return None
        # total
        total = sum(pops.values())
        return {**pops, "total": total}
    except Exception as e:
        print(f"        FAIL: {e}")
        return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=30, help="시도할 카드 수")
    parser.add_argument("--only", type=str, help="특정 SNKRDUNK ID 만")
    parser.add_argument("--no-headless", action="store_true")
    args = parser.parse_args()

    print("=" * 60)
    print(f"PSA10 Pop 매일 도박 스크래핑 (limit={args.limit})")
    print("=" * 60)

    # 기존 누적 데이터
    existing = {"fetchedAt": "", "pops": {}}
    if OUT.exists():
        try:
            existing = load_json(OUT)
        except Exception:
            pass
    pops = existing.get("pops", {}) or {}

    # 시도할 카드 — top10 우선 (brand 정보 포함)
    candidates = []
    for f in TOP10_FILES:
        if f.exists():
            try:
                brand = 'onepiece' if 'onepiece' in f.name else 'pokemon'
                d = load_json(f)
                for p in d.get("products", []):
                    candidates.append({
                        "id": str(p.get("id")),
                        "name": p.get("name", ""),
                        "brand": brand,
                    })
            except Exception:
                pass

    # all-cards 의 minPrice 높은 순 추가 (인기 카드)
    if ALL_CARDS.exists():
        try:
            ac = load_json(ALL_CARDS)
            cards = ac.get("details") or ac.get("cards") or []
            cards = sorted(cards, key=lambda c: -(c.get("minPrice") or 0))
            for c in cards[:200]:
                cid = str(c.get("id"))
                if not any(cc["id"] == cid for cc in candidates):
                    candidates.append({
                        "id": cid,
                        "name": c.get("name", ""),
                        "brand": c.get("brand", "pokemon"),
                    })
        except Exception:
            pass

    if args.only:
        candidates = [c for c in candidates if c["id"] == args.only]

    # 이미 최근에 받은 (1일 이내) 건너뜀
    today = datetime.now().strftime("%Y-%m-%d")
    candidates = [c for c in candidates if pops.get(c["id"], {}).get("updatedAt") != today]
    candidates = candidates[:args.limit]

    print(f"\n시도 대상: {len(candidates)} 카드 (오늘 미수집)")
    if not candidates:
        print("✓ 오늘 다 받았음. 종료.")
        return

    driver = make_driver()
    success, fail, blocked = 0, 0, 0
    try:
        for i, c in enumerate(candidates, 1):
            cid = c["id"]
            name = c["name"]
            # 박스는 PSA Pop 의미 없음 → skip
            if re.search(r'\b(Box|ボックス|BOX|Booster|パック|박스|ポケモンカードゲーム.*?(?:スタート|拡張|ハイクラス))', name, re.I):
                # 카드는 [코드 번호] 있음 — 박스/팩은 보통 없음. 추가 휴리스틱
                if not re.search(r'\[[A-Z]', name):
                    print(f"  [{i}/{len(candidates)}] {cid} skip (box/pack): {name[:35]}")
                    fail += 1
                    continue
            # set + number 추출 — 다양한 패턴 (대소문자 모두)
            # [OP15-001], [M2 013/080], [M-P 020], [SV-P 120], [s12a 212/172], [SV2a 173/165]
            m = (re.search(r'\[([A-Za-z]+\d+[A-Za-z]?)[\-_\s]+(\d+)', name) or
                 re.search(r'\[([A-Za-z]+-?[A-Za-z]?)\s+(\d+)', name))
            if not m:
                print(f"  [{i}/{len(candidates)}] {cid} — set/number 추출 실패: {name[:35]}")
                fail += 1
                continue
            set_code, number = m.group(1), m.group(2)
            brand = c.get("brand", "pokemon")
            print(f"  [{i}/{len(candidates)}] {cid} [{brand}] {set_code}-{number} {name[:30]}")

            result = try_psa_search(driver, name, set_code, number, brand)
            if result is None:
                # Cloudflare 차단 또는 결과 없음
                blocked += 1
                print(f"        ⊘ blocked or no result")
                # 너무 많이 막히면 break (오늘은 포기)
                if blocked >= 3:
                    print(f"\n  ⚠ 3회 연속 차단 — 오늘 도박 종료. 내일 다시 시도.")
                    break
                continue

            pops[cid] = {**result, "updatedAt": today}
            success += 1
            print(f"        ✓ PSA10={result.get('psa10')} PSA9={result.get('psa9')} Total={result.get('total')}")
            time.sleep(random.uniform(2, 5))  # rate limit
    finally:
        try: driver.quit()
        except: pass

    # 저장
    out = {
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "pops": pops,
        "lastRun": today,
    }
    if OUT.exists():
        try: OUT.unlink()
        except: pass
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(out, ensure_ascii=False, indent=2))

    print(f"\n━━━ 완료 ━━━")
    print(f"  성공: {success}")
    print(f"  실패: {fail}")
    print(f"  차단: {blocked}")
    print(f"  → 누적: {len(pops)} 카드 ({OUT.relative_to(ROOT)})")


if __name__ == "__main__":
    main()
