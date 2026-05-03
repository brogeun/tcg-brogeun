"""
extend_chart_history.py — 기존 6개월 백필을 1년으로 확장

작동 방식:
- 기존 data/history/{cardId}.json 읽음
- 등급별 sales-chart API 호출 (전체 데이터 받아 1년 cutoff 적용)
- 새로 받은 데이터 중 기존 데이터에 없는 날짜만 추가
- 기존 6개월 데이터 (가격 + 거래량) 그대로 유지
- 7~12개월 영역에 가격 정보만 추가됨

사용법:
  python scripts/extend_chart_history.py
      → 모든 history 파일을 1년치로 확장 (기본)

  python scripts/extend_chart_history.py --days=730
      → 2년치로 확장

  python scripts/extend_chart_history.py --resume
      → 이미 1년 이상 있는 카드는 skip

소요 시간: 약 10~13시간 (23,000장 기준)
"""

import json
import re
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime, timezone, timedelta

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
HISTORY_DIR = DATA_DIR / "history"
COOKIES_FILE = ROOT / "cookies.json"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# 등급 → SNKRDUNK salesChartOptionId
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
                "Accept": "application/json",
                "Accept-Language": "ja-JP,ja;q=0.9",
                "Cookie": COOKIE_HEADER,
                "Referer": "https://snkrdunk.com/",
            })
            with urllib.request.urlopen(req, timeout=20) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429:
                wait = 2 ** attempt + 5
                time.sleep(wait)
                continue
            if e.code == 404:
                return None
            if attempt == retries - 1:
                raise
            time.sleep(1.5)
        except Exception:
            if attempt == retries - 1:
                raise
            time.sleep(1.5)
    return None


def fetch_sales_chart_full(product_id, option_id):
    """sales-chart range=all — 전체 history points 반환 [(date_str, price), ...]"""
    url = (f"https://snkrdunk.com/v1/apparels/{product_id}/sales-chart/used"
           f"?range=all&salesChartOptionId={option_id}")
    d = fetch_json(url)
    if not d or "points" not in d:
        return []
    out = []
    for p in d.get("points", []) or []:
        if not isinstance(p, list) or len(p) < 2:
            continue
        ts_ms, price = p[0], p[1]
        try:
            date = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
            out.append((date, int(price)))
        except Exception:
            pass
    return out


def extend_card(card_id, days_limit=365, resume=False):
    """1개 카드 extend — 기존 데이터 보존 + 빈 영역만 추가"""
    hist_path = HISTORY_DIR / f"{card_id}.json"
    if not hist_path.exists():
        return None  # 백필 안 된 카드

    try:
        existing = json.loads(hist_path.read_text("utf-8"))
    except Exception:
        return None

    history = existing.get("history", []) or []
    if not history:
        return None

    cutoff_date = (datetime.now(timezone.utc) - timedelta(days=days_limit)).strftime("%Y-%m-%d")

    # resume — 이미 cutoff 이전 데이터 있으면 skip
    if resume:
        oldest_date = min((h.get("date", "9999-12-31") for h in history), default="9999-12-31")
        if oldest_date < cutoff_date:
            return 0  # 이미 1년 이상 있음

    # 일자별 dict 로 변환 (기존 보존)
    by_date = {}
    for h in history:
        d = h.get("date")
        if d:
            by_date[d] = dict(h)

    added_dates = 0
    for grade, opt_id in GRADE_IDS.items():
        try:
            points = fetch_sales_chart_full(card_id, opt_id)
        except Exception as e:
            print(f"      [{grade}] error: {e}")
            continue

        for date, price in points:
            if date < cutoff_date:
                continue  # 1년 cutoff 외

            key = f"{grade}_price"
            if date not in by_date:
                # 새 날짜 추가 (기존 6개월 외 영역)
                by_date[date] = {"date": date, key: price}
                added_dates += 1
            elif key not in by_date[date]:
                # 기존 날짜에 이 등급 가격 없으면 보충
                by_date[date][key] = price

        time.sleep(0.3)  # 등급 간 sleep

    # 변화 없으면 파일 안 건드림
    if added_dates == 0:
        return 0

    new_history = sorted(by_date.values(), key=lambda h: h.get("date", ""))
    out = {
        "id": str(card_id),
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "source": f"extended (sales-chart {days_limit}일)",
        "history": new_history,
    }
    txt = json.dumps(out, ensure_ascii=False, indent=2)
    hist_path.write_bytes(txt.encode("utf-8"))
    return added_dates


def main():
    args = sys.argv[1:]
    days_limit = 365
    resume = "--resume" in args
    for a in args:
        if a.startswith("--days="):
            try:
                days_limit = int(a.split("=", 1)[1])
            except Exception:
                pass

    files = sorted(HISTORY_DIR.glob("*.json"))
    if not files:
        print("⚠ data/history/ 가 비어있습니다. 먼저 backfill_history.py 를 실행하세요.")
        return

    print("================================================")
    print(f"확장 대상: {len(files)} 카드")
    print(f"목표: 최근 {days_limit}일치 (가격선만, 거래량은 기존 유지)")
    print(f"Resume 모드: {'ON' if resume else 'OFF'}")
    print(f"쿠키: {'있음' if COOKIE_HEADER else '없음 (anonymous)'}")
    print("================================================\n")

    success, no_change, skipped, fail = 0, 0, 0, 0
    t0 = time.time()

    for i, f in enumerate(files, 1):
        card_id = f.stem
        eta = ""
        if i > 10:
            avg = (time.time() - t0) / (i - 1)
            remaining = avg * (len(files) - i + 1)
            eta = f" (ETA {int(remaining/60)}분)"
        try:
            added = extend_card(card_id, days_limit, resume)
            if added is None:
                fail += 1
                print(f"[{i}/{len(files)}] {card_id} → 백필 안 됨{eta}")
            elif added == 0:
                if resume:
                    skipped += 1
                else:
                    no_change += 1
                if i % 200 == 0:
                    print(f"[{i}/{len(files)}] 진행 중 ... 변화없음 {no_change} / skip {skipped}{eta}")
            else:
                success += 1
                if i % 50 == 0 or added > 50:
                    print(f"[{i}/{len(files)}] {card_id} → +{added}일 추가{eta}")
        except Exception as e:
            print(f"[{i}/{len(files)}] {card_id} → 에러: {e}")
            fail += 1

    elapsed = int(time.time() - t0)
    print(f"\n================================================")
    print(f"완료: 확장 {success} / 변화없음 {no_change} / skip {skipped} / 실패 {fail}")
    print(f"소요 시간: {elapsed//3600}시간 {(elapsed%3600)//60}분")
    print(f"\n다음 단계 — git push:")
    print(f"  git add data/history/")
    print(f"  git commit -m '📈 1년 가격 차트 확장'")
    print(f"  git push")
    print(f"================================================")


if __name__ == "__main__":
    main()
