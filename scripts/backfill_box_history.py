"""
backfill_box_history.py — 박스만 history 백필 (전체 기간)

scrape_snkrdunk.py 의 박스 history 부분만 분리. range=all 로 발매부터 전체.

사용:
  python scripts/backfill_box_history.py                 # 모든 박스 전체 기간
  python scripts/backfill_box_history.py --days 14       # 모든 박스 최근 14일 (일일 갱신)
  python scripts/backfill_box_history.py --only 743533   # 특정 박스 1개 (테스트)
  python scripts/backfill_box_history.py --limit 5       # 5개만
  python scripts/backfill_box_history.py --empty-only    # 파일 없음/빈 박스만 전체 재확인
  python scripts/backfill_box_history.py --batch 0 --of 4  # 병렬 실행용 1/4 묶음
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
HIST = DATA / "history"
HIST.mkdir(exist_ok=True)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")
JST = timezone(timedelta(hours=9))  # SNKRDUNK 표시 날짜 기준 (한국/일본 동일 UTC+9)

# Windows 작업 스케줄러/PowerShell의 기본 CP949에서도 한글·기호 로그로 중단되지 않게 함.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")


def load_json(p):
    return json.loads(Path(p).read_bytes().rstrip(b'\x00').rstrip().decode('utf-8'))


def fetch_json(url, timeout=20, retries=3):
    """일시적인 429/5xx/네트워크 오류를 재시도한 뒤 JSON 반환."""
    last_error = None
    for attempt in range(retries):
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept": "application/json",
            "Referer": "https://snkrdunk.com/",
        })
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            last_error = exc
            # 지원하지 않는 endpoint 패턴은 재시도해도 결과가 같으므로 다음 후보로 진행.
            if exc.code in (400, 404):
                break
        except Exception as exc:
            last_error = exc
        if attempt + 1 < retries:
            time.sleep(1.5 * (attempt + 1))
    raise last_error


def fetch_volume_box(cid, days_limit=None, max_pages=9999):
    """박스 sales-history 페이지네이션 (1박스 단가 + 일 거래수)
    return: (counts dict, prices dict, completed)

    completed=False 면 중간 API 실패/페이지 상한 도달이므로 호출자는 기존 거래량을
    보존해야 한다. 빈 거래내역의 정상 응답은 completed=True 로 구분한다.
    """
    from collections import defaultdict
    import re as _re
    counts = defaultdict(int)
    prices = defaultdict(list)
    today = datetime.now(JST)
    cutoff = (today - timedelta(days=days_limit)).strftime("%Y-%m-%d") if days_limit else "0000-00-00"
    stopped_early = False
    completed = False
    for page in range(1, max_pages + 1):
        # per_page=100 으로 한 번에 더 많이 (4000건 cap 풀기 시도)
        url = f"https://snkrdunk.com/v1/apparels/{cid}/sales-history?page={page}&per_page=100"
        try:
            d = fetch_json(url, timeout=20)
        except Exception as exc:
            print(f"      sales-history page {page} 실패: {exc}")
            return {}, {}, False
        items = d.get("history") or []
        if not items:
            completed = True
            break
        for it in items:
            date_str = (it.get("date") or "").strip()
            m = _re.match(r"(\d{4})[/-](\d{2})[/-](\d{2})", date_str)
            if m:
                d2 = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
            else:
                m2 = _re.match(r"(\d+)\s*(日|時間|分|秒|hour|day|min)", date_str)
                if m2 and m2.group(2) in ("日", "day"):
                    d2 = (today - timedelta(days=int(m2.group(1)))).strftime("%Y-%m-%d")
                else:
                    d2 = today.strftime("%Y-%m-%d")
            if d2 < cutoff:
                stopped_early = True
                continue
            # 가격 추출 — "30,499" / "¥30,499" / 정수 / 객체
            price_raw = it.get("price")
            if isinstance(price_raw, dict):
                price_raw = price_raw.get("amount") or price_raw.get("price")
            price = None
            if isinstance(price_raw, (int, float)):
                price = int(price_raw)
            elif isinstance(price_raw, str):
                pm = _re.search(r"([\d,]+)", price_raw.replace("¥", ""))
                if pm:
                    price = int(pm.group(1).replace(",", ""))
            if price is None:
                continue
            # 모든 거래 수집 (size 검사 X) — 일별 outlier 처리는 산출 단계에서
            counts[d2] += 1
            prices[d2].append(price)
        if stopped_early:
            completed = True
            break
        # SNKRDUNK API 가 per_page 무시하고 ~20건씩 줘 — items 가 비어야 진짜 끝
        # (옛날 if len(items) < 100: break 로직 = 1페이지 끊김 = 20건 cap 버그)
        time.sleep(0.3)
    # 일별 outlier 제거 후 median
    #   1) 초기 median
    #   2) median × [0.5, 2.0] 범위 외 제거 (튀는 가격 cut)
    #   3) 남은 거래로 다시 median = 일별 단가
    def _clean_median(arr):
        s = sorted(arr)
        init = s[len(s) // 2]
        clean = [p for p in arr if 0.5 * init <= p <= 2.0 * init]
        if not clean: clean = arr
        sc = sorted(clean)
        return sc[len(sc) // 2]
    avg_prices = {d: _clean_median(p) for d, p in prices.items() if p}
    return dict(counts), avg_prices, completed


def fetch_chart(cid, range_arg="all", debug=False):
    """박스 sales-chart 시도 — 여러 URL 패턴 + range 옵션"""
    urls = [
        # used (실거래) — 카드/박스 공용
        f"https://snkrdunk.com/v1/apparels/{cid}/sales-chart/used?range={range_arg}",
        # new (신품) — 박스는 신품도 거래
        f"https://snkrdunk.com/v1/apparels/{cid}/sales-chart/new?range={range_arg}",
        # 기본 (옵션 없음)
        f"https://snkrdunk.com/v1/apparels/{cid}/sales-chart?range={range_arg}",
    ]
    for url in urls:
        try:
            d = fetch_json(url, timeout=20)
            if debug:
                print(f"      [debug] {url.split('/')[-2:]}: keys={list(d.keys())[:5]} pointsLen={len(d.get('points', []))}")
            points = d.get("points", []) or []
            if not points:
                continue  # 다음 URL 시도
            out = []
            for p in points:
                if isinstance(p, list) and len(p) >= 2:
                    ts_ms, price = p[0], p[1]
                    try:
                        date = datetime.fromtimestamp(ts_ms / 1000, tz=JST).strftime("%Y-%m-%d")
                        out.append((date, int(price)))
                    except Exception:
                        pass
            if out:
                if debug:
                    print(f"      ✓ {url.split('/')[-1]} → {len(out)} points")
                return out
        except Exception as e:
            if debug:
                print(f"      ❌ {url}: {e}")
            continue
    return []


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", type=str, nargs='+', help="특정 박스 ID 들만 (공백 구분, 여러 개)")
    parser.add_argument("--new-only", action="store_true",
                        help="price-pokemon-box.json 의 'code' 필드 있는 신규 박스만 (find_new_box_ids.py 추가분)")
    parser.add_argument("--empty-only", action="store_true",
                        help="history 파일이 없거나 entries가 비어 있는 박스만 처리")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--range", default="all", help="oneMonth / threeMonths / sixMonths / oneYear / all")
    parser.add_argument("--days", type=int, default=None,
                        help="sales-history 최근 N일만 갱신 (일일 실행 권장: 14, 생략 시 전체 기간)")
    parser.add_argument("--max-pages", type=int, default=9999,
                        help="박스당 sales-history 최대 페이지 (기본: 끝까지)")
    parser.add_argument("--batch", type=int, default=0,
                        help="--of 로 나눈 0부터 시작하는 묶음 번호")
    parser.add_argument("--of", type=int, default=1,
                        help="전체 대상을 N개 묶음으로 분할 (기본: 1)")
    parser.add_argument("--debug", action="store_true", help="다양한 URL 시도 로그")
    parser.add_argument("--fresh", action="store_true",
                        help="기존 history 무시하고 처음부터 (지금 기준으로 풀 백필)")
    args = parser.parse_args()

    print("=" * 60)
    print(f"박스 history 백필 (range={args.range}, days={args.days or 'ALL'})")
    print("=" * 60)

    # 박스 ID 모음 — price-{brand}-box.json 에서
    box_ids = []
    seen_ids = set()  # 중복 방지 (price-*-box + manual-boxes 합치므로)
    # 1) cron 갱신되는 카탈로그 (인기 30개)
    for brand in ['pokemon', 'onepiece']:
        f = DATA / f"price-{brand}-box.json"
        if not f.exists():
            continue
        d = load_json(f)
        for p in d.get('products', []):
            pid = str(p['id'])
            if pid in seen_ids:
                continue
            seen_ids.add(pid)
            box_ids.append({'id': pid, 'name': p.get('name', ''), 'code': p.get('code')})
    # 2) 사용자 수동 추가 박스 (manual-boxes-{brand}.json)
    for brand in ['pokemon', 'onepiece']:
        f = DATA / f"manual-boxes-{brand}.json"
        if not f.exists():
            continue
        d = load_json(f)
        for p in d.get('products', []):
            pid = str(p['id'])
            if pid in seen_ids:
                continue
            seen_ids.add(pid)
            box_ids.append({'id': pid, 'name': p.get('name', ''), 'code': p.get('code')})

    print(f"  총 박스: {len(box_ids)} (price-*-box + manual-boxes 합산, 중복 제거)")

    if args.only:
        only_set = set(args.only)
        box_ids = [b for b in box_ids if b['id'] in only_set]
    elif args.new_only:
        # code 필드 있는 박스 = manual 추가분
        box_ids = [b for b in box_ids if b.get('code')]
        print(f"  --new-only: code 있는 박스 {len(box_ids)} 개")
    elif args.empty_only:
        def _history_is_empty(box):
            hp = HIST / f"{box['id']}.json"
            if not hp.exists():
                return True
            try:
                return not (load_json(hp).get("history") or [])
            except Exception:
                return True
        box_ids = [b for b in box_ids if _history_is_empty(b)]
        print(f"  --empty-only: history 없음/빈 박스 {len(box_ids)} 개")
    elif args.limit > 0:
        box_ids = box_ids[:args.limit]

    if args.of > 1:
        if args.batch < 0 or args.batch >= args.of:
            parser.error("--batch 는 0 이상 --of 미만이어야 합니다")
        box_ids = box_ids[args.batch::args.of]
        print(f"  병렬 묶음: {args.batch + 1}/{args.of}")

    print(f"  처리 대상: {len(box_ids)}\n")

    fetched_at = datetime.now(timezone.utc).isoformat()
    success = 0
    for i, b in enumerate(box_ids, 1):
        cid = b['id']
        print(f"  [{i}/{len(box_ids)}] {cid} {b['name'][:40]}")
        points = fetch_chart(cid, args.range, debug=args.debug)
        if not points:
            print("      가격 차트 0 points — 거래내역은 계속 수집")
        # 기존 history 와 merge (--fresh 면 무시. 단 fetch 0건이면 기존 keep 안전장치)
        hp = HIST / f"{cid}.json"
        try:
            existing = load_json(hp) if hp.exists() else {"id": cid, "history": []}
        except Exception:
            existing = {"id": cid, "history": []}
        # 예전 daily scraper가 일부 박스를 카드로 오인해 total_* 필드로 저장한
        # 이력이 있다. 박스 전용 필드로 정규화해야 이후 갱신 때 과거 데이터가
        # 빈 행으로 판정되어 사라지지 않는다.
        existing_by_date = {}
        for history_row in existing.get("history", []):
            if not history_row.get("date"):
                continue
            row = dict(history_row)
            if row.get("box_vol") is None and row.get("total_vol") is not None:
                row["box_vol"] = row.pop("total_vol")
            if row.get("box_price") is None and row.get("total_price") is not None:
                row["box_price"] = row.pop("total_price")
            existing_by_date[row["date"]] = row
        by_date = {} if args.fresh else dict(existing_by_date)

        # sales-history → 1박스 단가 + 거래량 (일일은 최근 기간, 주간은 전체)
        vols, sh_prices, volume_completed = fetch_volume_box(
            cid, days_limit=args.days, max_pages=args.max_pages
        )
        # 안전장치 — 중간 fetch 실패 시 불완전한 거래량으로 기존 값을 덮어쓰지 않음
        if not volume_completed:
            print("      거래량 수집 미완료 — 기존 history 유지")
            continue
        for date, count in vols.items():
            if date not in by_date:
                by_date[date] = {"date": date}
            by_date[date]["box_vol"] = count
        for date, price in sh_prices.items():
            if date not in by_date:
                by_date[date] = {"date": date}
            by_date[date]["box_price"] = price

        # sales-chart → fallback (sales-history 가 비는 옛날 날짜만)
        for date, _price in points:
            if date not in by_date:
                by_date[date] = {"date": date}
            # sales-chart 의 _price 는 일 매출합 → 거래량으로 나눠 단가 추정
            if "box_price" not in by_date[date]:
                vol = by_date[date].get("box_vol", 0)
                if vol > 0:
                    by_date[date]["box_price"] = _price // vol
                # vol 정보 없는 옛날 데이터는 단가 X (chart 누락)

        # chart/volume 어느 쪽에도 실제 값이 없는 날짜 껍데기는 제거.
        new_hist = sorted(
            (
                h for h in by_date.values()
                if h.get("box_vol") is not None or h.get("box_price") is not None
            ),
            key=lambda h: h.get("date", ""),
        )
        out = {
            "id": cid,
            "updatedAt": fetched_at,
            "source": f"box backfill (range={args.range}, days={args.days or 'all'})",
            "history": new_hist,
        }
        # 원자적 저장: 실행 중단/디스크 오류가 나도 기존 JSON 보존
        tmp = hp.with_suffix(".tmp")
        tmp.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8", newline="\n")
        load_json(tmp)  # 저장 결과 검증
        os.replace(tmp, hp)
        success += 1
        total_vol = sum(h.get('box_vol', 0) for h in new_hist)
        print(f"      ✓ {len(points)} 차트 / {len(vols)} 거래일 (전체 거래량 {total_vol}건) / 누적 {len(new_hist)} dates")
        if new_hist:
            print(f"        {new_hist[0]['date']} ~ {new_hist[-1]['date']}")
            print(f"        valid {sum(1 for h in new_hist if h.get('box_vol', 0) > 0)} days")
        time.sleep(0.35)

    print(f"\nBox backfill complete - {success}/{len(box_ids)} updated")


if __name__ == "__main__":
    main()
