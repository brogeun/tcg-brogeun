"""
SNKRDUNK 가격·거래량 히스토리 백필 (로컬 PC 실행 전용)

엔드포인트 2개 사용:
  1. /v1/apparels/{id}/sales-chart/used?range=all&salesChartOptionId={N}
     → 일자별 거래 가격 points (전체 히스토리)
  2. /v1/apparels/{id}/sales-history?page=N&per_page=20&condition_id={N}
     → raw 거래 기록 (거래량 집계용, 페이지네이션)

결과는 data/history/{cardId}.json 으로 저장.
이후 매일 GitHub Actions 가 새 데이터만 incremental 로 추가.

사용법:
  python scripts/backfill_history.py
      → 모든 카드 백필 (cards-detail/top10/price 에서 카드 ID 자동 추출)

  python scripts/backfill_history.py --card-ids=704407,123456
      → 특정 카드만

  python scripts/backfill_history.py 704407
      → 단일 카드 (테스트용)

  python scripts/backfill_history.py --resume
      → 이미 30일+ 데이터 있는 카드는 skip

  python scripts/backfill_history.py --no-volume
      → 가격만 (빠름, 카드당 ~3초). 거래량 생략

  python scripts/backfill_history.py --max-pages=20
      → 거래량 수집 시 페이지 상한 (기본 50)
"""

import json
import re
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime, timezone, timedelta
from collections import defaultdict

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
HISTORY_DIR = DATA_DIR / "history"
HISTORY_DIR.mkdir(exist_ok=True, parents=True)
COOKIES_FILE = ROOT / "cookies.json"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# salesChartOptionId / condition_id 매핑
GRADE_IDS = {
    "psa10": 22,
    "psa9": 23,
    "raw": 18,
}


def load_cookie_header():
    if not COOKIES_FILE.exists():
        return ""
    try:
        cookies = json.loads(COOKIES_FILE.read_text("utf-8"))
        return "; ".join(f"{c['name']}={c['value']}" for c in cookies if c.get("name"))
    except Exception:
        return ""


COOKIE_HEADER = load_cookie_header()


def fetch_json(url, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "ja-JP,ja;q=0.9",
                "Cookie": COOKIE_HEADER,
                "Referer": "https://snkrdunk.com/",
            })
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = 2 ** attempt + 5
                print(f"      [429] rate limit — {wait}s 대기")
                time.sleep(wait)
                continue
            if e.code == 404:
                return None
            if attempt == retries - 1:
                raise
            time.sleep(1.5)
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt == retries - 1:
                raise
            time.sleep(1.5)
    return None


def fetch_sales_chart(product_id, option_id, days_limit=None):
    """sales-chart/used 호출 — 일자별 가격 points 반환 [(date_str, price_jpy), ...]
    days_limit 가 주어지면 그 일수보다 오래된 데이터는 제외.
    """
    url = f"https://snkrdunk.com/v1/apparels/{product_id}/sales-chart/used?range=all&salesChartOptionId={option_id}"
    d = fetch_json(url)
    if not d or "points" not in d:
        return []
    cutoff_ms = None
    if days_limit:
        cutoff_ms = (datetime.now(timezone.utc) - timedelta(days=days_limit)).timestamp() * 1000
    out = []
    for p in d.get("points", []):
        if not isinstance(p, list) or len(p) < 2:
            continue
        ts_ms, price = p[0], p[1]
        if cutoff_ms and ts_ms < cutoff_ms:
            continue
        try:
            # SNKRDUNK timestamp 는 JST 기준 — UTC 로 변환
            date = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
            out.append((date, int(price)))
        except Exception:
            pass
    return out


def parse_jp_date(date_str, today=None):
    """일본어 상대시간 / 절대 날짜 → YYYY-MM-DD 변환"""
    if today is None:
        today = datetime.now()
    s = (date_str or "").strip()
    if not s:
        return None
    # YYYY/MM/DD
    m = re.match(r'(\d{4})/(\d{1,2})/(\d{1,2})', s)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    # 시간/분 단위 → 오늘
    if "時間前" in s or "分前" in s or "秒前" in s:
        return today.strftime("%Y-%m-%d")
    # X日前
    m = re.match(r'(\d+)日前', s)
    if m:
        return (today - timedelta(days=int(m.group(1)))).strftime("%Y-%m-%d")
    # X週間前
    m = re.match(r'(\d+)週間前', s)
    if m:
        return (today - timedelta(days=int(m.group(1)) * 7)).strftime("%Y-%m-%d")
    # Xヶ月前
    m = re.match(r'(\d+)ヶ月前', s)
    if m:
        return (today - timedelta(days=int(m.group(1)) * 30)).strftime("%Y-%m-%d")
    # X年前
    m = re.match(r'(\d+)年前', s)
    if m:
        return (today - timedelta(days=int(m.group(1)) * 365)).strftime("%Y-%m-%d")
    return None


def fetch_volume_by_date(product_id, condition_id, max_pages=50, days_limit=None):
    """sales-history 페이지네이션 — 일자별 거래수 집계
    days_limit 가 주어지면 그 일수보다 오래된 거래가 나오면 페이지네이션 즉시 중단.
    (sales-history 는 최신순이라 cutoff 만나면 그 뒤는 다 옛날 데이터)
    """
    counts = defaultdict(int)
    today = datetime.now()
    cutoff_date = None
    if days_limit:
        cutoff_date = (today - timedelta(days=days_limit)).strftime("%Y-%m-%d")
    stopped_early = False
    for page in range(1, max_pages + 1):
        url = (f"https://snkrdunk.com/v1/apparels/{product_id}/sales-history"
               f"?page={page}&per_page=20&condition_id={condition_id}")
        try:
            d = fetch_json(url)
        except Exception as e:
            print(f"      [{condition_id}] page {page} 에러: {e}")
            break
        if not d:
            break
        items = d.get("history") or []
        if not items:
            break
        for item in items:
            d2 = parse_jp_date(item.get("date", ""), today)
            if not d2:
                continue
            if cutoff_date and d2 < cutoff_date:
                # 컷오프 이전 거래 등장 → 이번 페이지까지만 처리하고 종료
                stopped_early = True
                continue  # 이 항목은 카운트 안 함
            counts[d2] += 1
        if stopped_early:
            break
        if len(items) < 20:
            break  # 마지막 페이지
        time.sleep(0.35)
    return dict(counts)


def collect_card_ids():
    """카드 ID 풀 수집 — 우선순위:
    1) data/all-cards.json (discover_cards.py 결과)  ← 전수 풀
    2) cards-detail / top10 / price-card             ← 좁은 풀 (~70개)
    """
    # 1순위: discover_cards 결과
    all_path = DATA_DIR / "all-cards.json"
    if all_path.exists():
        try:
            d = json.loads(all_path.read_text("utf-8"))
            cards = d.get("cards") or d.get("all") or []
            if cards:
                print(f"✓ data/all-cards.json 사용 — {len(cards)}개 카드")
                return [str(c) for c in cards]
        except Exception as e:
            print(f"⚠ all-cards.json 파싱 실패: {e}")

    # 2순위: 좁은 풀
    print("ℹ data/all-cards.json 없음 — 좁은 풀(top10+price) 사용")
    print("  전수 백필을 원하면 먼저: python scripts/discover_cards.py")
    ids = set()
    # cards-detail
    cd = DATA_DIR / "cards-detail.json"
    if cd.exists():
        try:
            d = json.loads(cd.read_text("utf-8"))
            for cid, c in (d.get("cards") or {}).items():
                if c.get("grades"):  # 박스 placeholder 제외
                    ids.add(str(cid))
        except Exception as e:
            print(f"⚠ cards-detail.json 파싱 실패: {e}")
    # top10 / price-card
    for fname in [
        "top10-pokemon.json", "top10-onepiece.json",
        "price-pokemon-card.json", "price-onepiece-card.json",
    ]:
        f = DATA_DIR / fname
        if not f.exists():
            continue
        try:
            d = json.loads(f.read_text("utf-8"))
            for p in d.get("products", []):
                pid = str(p.get("id", ""))
                name = p.get("name", "")
                # 카드만 — 이름에 [세트코드 번호] 패턴
                if pid and re.search(r'\[[^\]]*\d+[^\]]*\]', name):
                    ids.add(pid)
        except Exception as e:
            print(f"⚠ {fname} 파싱 실패: {e}")
    return sorted(ids)


def backfill_card(product_id, with_volume=True, max_pages=50, days_limit=None):
    """카드 1개 백필 — 가격 + 거래량 병합 → history 파일 저장
    days_limit 가 주어지면 최근 N일치만 (이전 데이터는 daily scraper 가 누적해 채움)
    """
    daily = defaultdict(dict)  # date -> {psa10_price, psa10_vol, ...}

    for grade, opt_id in GRADE_IDS.items():
        # 1) sales-chart 으로 일자별 가격
        try:
            points = fetch_sales_chart(product_id, opt_id, days_limit=days_limit)
        except Exception as e:
            print(f"      [{grade}] chart 에러: {e}")
            points = []
        if points:
            print(f"      [{grade}] 가격 {len(points)}일치")
            for date, price in points:
                key = f"{grade}_price"
                if key in daily[date]:
                    daily[date][key] = (daily[date][key] + price) // 2
                else:
                    daily[date][key] = price

        # 2) sales-history 로 거래량 집계
        if with_volume:
            try:
                vols = fetch_volume_by_date(product_id, opt_id, max_pages=max_pages, days_limit=days_limit)
            except Exception as e:
                print(f"      [{grade}] volume 에러: {e}")
                vols = {}
            if vols:
                print(f"      [{grade}] 거래량 {len(vols)}일치 (총 {sum(vols.values())}건)")
                for date, count in vols.items():
                    daily[date][f"{grade}_vol"] = count

        time.sleep(0.5)

    if not daily:
        return 0

    history = [{"date": d, **vals} for d, vals in sorted(daily.items())]
    out = {
        "id": str(product_id),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "source": "backfill (sales-chart + sales-history)",
        "history": history,
    }
    out_path = HISTORY_DIR / f"{product_id}.json"
    txt = json.dumps(out, ensure_ascii=False, indent=2)
    out_path.write_bytes(txt.encode("utf-8"))
    return len(history)


def main():
    args = sys.argv[1:]
    with_volume = "--no-volume" not in args
    resume = "--resume" in args

    max_pages = 50
    days_limit = None
    for a in args:
        if a.startswith("--max-pages="):
            try:
                max_pages = int(a.split("=", 1)[1])
            except Exception:
                pass
        elif a.startswith("--days="):
            try:
                days_limit = int(a.split("=", 1)[1])
            except Exception:
                pass

    custom = None
    for a in args:
        if a.startswith("--card-ids="):
            custom = [x.strip() for x in a.split("=", 1)[1].split(",") if x.strip()]
            break
    if custom is None:
        # 단일 숫자 인자
        for a in args:
            if a.isdigit():
                custom = [a]
                break

    card_ids = custom if custom else collect_card_ids()
    if not card_ids:
        print("⚠ 백필할 카드 ID 가 없습니다. data/cards-detail.json 또는 top10-*.json 이 있는지 확인하세요.")
        print("  GitHub Actions scrape 를 한 번 돌리면 ID 가 채워집니다.")
        return

    print(f"================================================")
    print(f"백필 대상: {len(card_ids)} 카드")
    print(f"거래량 수집: {'ON (--no-volume 으로 끔)' if with_volume else 'OFF'}")
    print(f"Resume 모드: {'ON' if resume else 'OFF'}")
    print(f"max-pages (sales-history): {max_pages}")
    print(f"days 컷오프: {f'최근 {days_limit}일' if days_limit else '전체 (제한 없음)'}")
    print(f"쿠키: {'있음' if COOKIE_HEADER else '없음 (anonymous)'}")
    print(f"================================================\n")

    success, fail, skipped = 0, 0, 0
    t0 = time.time()
    for i, cid in enumerate(card_ids, 1):
        out_path = HISTORY_DIR / f"{cid}.json"
        if resume and out_path.exists():
            try:
                existing = json.loads(out_path.read_text("utf-8"))
                if len(existing.get("history", [])) >= 30:
                    print(f"[{i}/{len(card_ids)}] {cid} → skip (이미 {len(existing['history'])}일치)")
                    skipped += 1
                    continue
            except Exception:
                pass
        eta = ""
        if i > 1:
            avg = (time.time() - t0) / (i - 1)
            remaining = avg * (len(card_ids) - i + 1)
            eta = f" (ETA {int(remaining/60)}분)"
        print(f"[{i}/{len(card_ids)}] {cid}{eta}")
        try:
            n = backfill_card(cid, with_volume=with_volume, max_pages=max_pages, days_limit=days_limit)
            if n:
                print(f"    ✓ {n}일치 저장 → data/history/{cid}.json\n")
                success += 1
            else:
                print(f"    ⚠ 데이터 없음 (생애 거래 0건)\n")
                fail += 1
        except Exception as e:
            print(f"    ✗ 실패: {e}\n")
            fail += 1

    elapsed = time.time() - t0
    print(f"\n================================================")
    print(f"완료: 성공 {success} / 실패 {fail} / 스킵 {skipped}")
    print(f"소요 시간: {int(elapsed/60)}분 {int(elapsed%60)}초")
    print(f"data/history/ 안의 .json 파일들을 git 에 commit & push 하세요:")
    print(f"  git add data/history/")
    print(f"  git commit -m 'history backfill (SNKRDUNK sales-chart)'")
    print(f"  git push")
    print(f"================================================")


if __name__ == "__main__":
    main()
