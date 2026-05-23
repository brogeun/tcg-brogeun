"""
backfill_card_history.py — 카드 등급별 가격 + 통합 거래량 풀백필 (v2)

SNKRDUNK API 분석 (검증 완료):
- /v1/apparels/{cid}/sales-chart/used?range=all&salesChartOptionId={ID}
  → 등급별 일별 단가 점들. PSA10=22, PSA9=23, raw(D, 미개봉)=18
- /v1/apparels/{cid}/sales-history?page=N&per_page=100
  → 모든 거래. salesChartOptionId 무시함 → 등급 통합. 일별 거래량 + outlier-median 단가.

저장 형식 (entries):
  {date, psa10_price, psa9_price, raw_price, total_vol, total_price}
  - psa10/psa9/raw_price = SNKRDUNK 차트 점 (등급별)
  - total_vol = 등급 통합 일별 거래 건수
  - total_price = 등급 통합 일별 단가 (outlier 제거 + median)

사용:
  python scripts/backfill_card_history.py            # 모든 카드 풀백필
  python scripts/backfill_card_history.py 289056     # 특정 ID
  python scripts/backfill_card_history.py --fresh    # 처음부터 재작성
  python scripts/backfill_card_history.py --days 90  # 최근 90일치만
"""
import json
import re
import sys
import time
import urllib.request
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HISTORY_DIR = ROOT / "data" / "history"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# SNKRDUNK 의 sales-chart/used?salesChartOptionId={ID} 등급 매핑
# 옛 코드 기준: 18=raw(D, 미개봉), 22=PSA10, 23=PSA9
# 검증: 풀백필 후 PSA10 > PSA9 > raw 순서 자연스러운지 가격 갭 보면 됨
GRADE_OPTION_IDS = {"psa10": 22, "psa9": 23, "raw": 18}


def fetch_chart_grade(cid, opt_id):
    """sales-chart/used + 옵션 ID → {date: price} (일별 단가, SNKRDUNK 자체 산출)"""
    url = (f"https://snkrdunk.com/v1/apparels/{cid}/sales-chart/used"
           f"?range=all&salesChartOptionId={opt_id}")
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Accept": "application/json",
        "Referer": "https://snkrdunk.com/",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            d = json.loads(r.read().decode("utf-8"))
    except Exception:
        return {}
    points = d.get("points") or []
    by_date = {}
    for p in points:
        if isinstance(p, list) and len(p) >= 2:
            ts_ms, price = p[0], p[1]
            try:
                date = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
                # 같은 날에 여러 점 → 마지막으로 덮음 (또는 median 가능, 일단 마지막)
                by_date[date] = int(price)
            except Exception:
                pass
    return by_date


def fetch_volume(cid, days_limit=None, max_pages=9999):
    """sales-history 페이지네이션 (등급 통합) → 일별 거래량 + outlier 제거된 일별 median 단가
    return: (counts dict, prices dict)"""
    counts = defaultdict(int)
    prices = defaultdict(list)
    today = datetime.now()
    cutoff = (today - timedelta(days=days_limit)).strftime("%Y-%m-%d") if days_limit else "0000-00-00"
    stopped_early = False
    for page in range(1, max_pages + 1):
        url = f"https://snkrdunk.com/v1/apparels/{cid}/sales-history?page={page}&per_page=100"
        req = urllib.request.Request(url, headers={
            "User-Agent": UA, "Accept": "application/json",
            "Referer": "https://snkrdunk.com/",
        })
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                d = json.loads(r.read().decode("utf-8"))
        except Exception:
            break
        items = d.get("history") or []
        if not items:
            break
        for it in items:
            date_str = (it.get("date") or "").strip()
            m = re.match(r"(\d{4})[/-](\d{2})[/-](\d{2})", date_str)
            if m:
                d2 = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
            else:
                m2 = re.match(r"(\d+)\s*(日|day|時間|分|秒|hour|min)", date_str)
                if m2 and m2.group(2) in ("日", "day"):
                    d2 = (today - timedelta(days=int(m2.group(1)))).strftime("%Y-%m-%d")
                else:
                    d2 = today.strftime("%Y-%m-%d")
            if d2 < cutoff:
                stopped_early = True
                continue
            pr_raw = it.get("price")
            if isinstance(pr_raw, str):
                pm = re.search(r"([\d,]+)", pr_raw.replace("¥", ""))
                pr = int(pm.group(1).replace(",", "")) if pm else None
            elif isinstance(pr_raw, (int, float)):
                pr = int(pr_raw)
            else:
                pr = None
            if pr is None:
                continue
            counts[d2] += 1
            prices[d2].append(pr)
        if stopped_early:
            break
        # SNKRDUNK 가 per_page 무시하고 ~20건씩 줘 — items 비어야 진짜 끝
        time.sleep(0.25)
    # 일별 outlier 제거 + median (다수 매수로 인한 가격 spike 제거)
    avg_prices = {}
    for dt, p in prices.items():
        if not p:
            continue
        s = sorted(p)
        init = s[len(s) // 2]
        clean = [pp for pp in p if 0.5 * init <= pp <= 2.0 * init]
        if not clean:
            clean = p
        sc = sorted(clean)
        avg_prices[dt] = sc[len(sc) // 2]
    return dict(counts), avg_prices


def is_card_history(history):
    """카드인지 (psa10/psa9/raw 키 있음) 판별"""
    for r in history:
        if any(k in r for k in ("psa10_price", "psa9_price", "raw_price")):
            return True
    return False


def main():
    args = sys.argv[1:]
    days_limit = None
    only_ids = []
    fresh = "--fresh" in args
    # NEW: --ids-file=PATH  텍스트 파일에서 ID 리스트 읽음 (한 줄당 하나)
    # NEW: --resume  이미 valid JSON 인 파일 skip
    ids_file = None
    resume = "--resume" in args
    for i, a in enumerate(args):
        if a == "--days" and i + 1 < len(args):
            days_limit = int(args[i + 1])
        elif a.startswith("--ids-file="):
            ids_file = a.split("=", 1)[1]
        elif a.isdigit():
            only_ids.append(a)

    if ids_file:
        try:
            with open(ids_file, "r", encoding="utf-8") as fp:
                only_ids = [line.strip() for line in fp if line.strip() and not line.startswith("#")]
            print(f"[--ids-file] {ids_file} 에서 {len(only_ids)} ID 로드")
        except Exception as e:
            print(f"⚠ ids-file 읽기 실패: {e}")
            return

    print("=" * 60)
    print("카드 백필 v2 — sales-chart/used (등급별) + sales-history (통합 거래량)")
    print(f"days_limit: {days_limit or 'ALL'}, target: {len(only_ids) if only_ids else 'ALL CARDS'}, fresh: {fresh}, resume: {resume}")
    print("=" * 60)

    # 카드 ID 추출 — history 폴더에서 카드 history 만
    targets = []
    only_ids_set = set(only_ids) if only_ids else None
    for f in sorted(HISTORY_DIR.glob("*.json")):
        cid = f.stem
        if only_ids_set and cid not in only_ids_set:
            continue
        try:
            raw = f.read_bytes().replace(b"\x00", b"").rstrip()
            try:
                d = json.loads(raw)
                valid_json = True
            except json.JSONDecodeError:
                last = raw.rfind(b"}")
                if last > 0:
                    try:
                        d = json.loads(raw[:last + 1] + b"\n  ]\n}")
                        valid_json = False
                    except Exception:
                        continue
                else:
                    continue
            history = d.get("history", [])
            # only_ids 명시 시 카드/박스 가리지 않고 처리 (강제 카드로 재백필)
            if only_ids_set or is_card_history(history):
                # resume 모드 — 이미 valid 한 JSON 이면 skip (only_ids 없을 때만 의미)
                if resume and valid_json and not only_ids_set:
                    continue
                targets.append((cid, f, d))
        except Exception as e:
            print(f"  [{cid}] read fail: {e}")
            continue

    print(f"카드 history 파일: {len(targets)} 개\n")
    success = 0
    fail = 0
    for i_t, (cid, path, existing) in enumerate(targets, 1):
        print(f"[{i_t}/{len(targets)}] {cid}", end=" ", flush=True)
        existing_by_date = {h["date"]: dict(h) for h in existing.get("history", []) if h.get("date")}
        by_date = {} if fresh else dict(existing_by_date)
        any_new = False
        # 1. 등급별 가격 (sales-chart/used + 옵션 ID 별 호출)
        grade_counts = {}
        for grade, opt_id in GRADE_OPTION_IDS.items():
            chart = fetch_chart_grade(cid, opt_id)
            grade_counts[grade] = len(chart)
            for date, price in chart.items():
                if date not in by_date:
                    by_date[date] = {"date": date}
                by_date[date][f"{grade}_price"] = price
                any_new = True
            time.sleep(0.2)
        # 2. 통합 거래량 + 통합 단가 (sales-history 페이지네이션)
        vols, sh_prices = fetch_volume(cid, days_limit=days_limit)
        for date, count in vols.items():
            if date not in by_date:
                by_date[date] = {"date": date}
            by_date[date]["total_vol"] = count
            any_new = True
        for date, price in sh_prices.items():
            if date not in by_date:
                by_date[date] = {"date": date}
            by_date[date]["total_price"] = price
        if not any_new:
            print("(no data — keep existing)")
            fail += 1
            continue
        new_history = sorted(by_date.values(), key=lambda h: h.get("date", ""))
        out = {
            "id": str(cid),
            "updatedAt": datetime.now(timezone.utc).isoformat(),
            "source": "backfill v2 (sales-chart/used per grade + sales-history vol)",
            "history": new_history,
        }
        # Atomic write — tmp 파일에 쓰고 JSON 검증 후 os.replace
        # (이전 path.unlink() + write_bytes() 는 atomic 아니라 중단 시 partial-write 발생)
        import os as _os
        tmp_path = path.with_suffix(".tmp")
        json_bytes = json.dumps(out, ensure_ascii=False, indent=2).encode('utf-8')
        try:
            # 1. 임시 파일에 쓰기
            tmp_path.write_bytes(json_bytes)
            # 2. JSON 유효성 검증 (write 후 다시 읽어서 parse 시도)
            json.loads(tmp_path.read_text(encoding='utf-8'))
            # 3. 원자적 교체 (Windows/Unix 둘 다 atomic)
            _os.replace(str(tmp_path), str(path))
        except Exception as e:
            # 검증 실패 — 임시파일 삭제, 원본 보존
            try:
                tmp_path.unlink()
            except Exception:
                pass
            print(f"⚠ atomic-write fail (원본 유지): {e}")
            fail += 1
            continue
        # 통계 — 등급별 days + 통합 거래량
        vol_total = sum(h.get("total_vol", 0) for h in new_history)
        print(f"OK psa10={grade_counts['psa10']}d psa9={grade_counts['psa9']}d "
              f"raw={grade_counts['raw']}d vol={vol_total}")
        success += 1
        time.sleep(0.3)

    print(f"\nDone: OK {success} / Fail {fail}")


if __name__ == "__main__":
    main()
