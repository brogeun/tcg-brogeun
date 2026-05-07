"""
backfill_box_history.py — 박스만 history 백필 (전체 기간)

scrape_snkrdunk.py 의 박스 history 부분만 분리. range=all 로 발매부터 전체.

사용:
  python scripts/backfill_box_history.py            # 모든 박스
  python scripts/backfill_box_history.py --only 743533  # 특정 박스 1개 (테스트)
  python scripts/backfill_box_history.py --limit 5      # 5개만
"""
import argparse
import json
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
HIST = DATA / "history"
HIST.mkdir(exist_ok=True)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def load_json(p):
    return json.loads(Path(p).read_bytes().rstrip(b'\x00').rstrip().decode('utf-8'))


def fetch_volume_box(cid, days_limit=None, max_pages=9999):
    """박스 sales-history 페이지네이션 (1박스 단가 + 일 거래수)
    return: (counts dict, prices dict — date → 평균 단가)"""
    from collections import defaultdict
    from datetime import datetime, timedelta
    import re as _re
    counts = defaultdict(int)
    prices = defaultdict(list)
    today = datetime.now()
    cutoff = (today - timedelta(days=days_limit)).strftime("%Y-%m-%d") if days_limit else "0000-00-00"
    stopped_early = False
    for page in range(1, max_pages + 1):
        # per_page=100 으로 한 번에 더 많이 (4000건 cap 풀기 시도)
        url = f"https://snkrdunk.com/v1/apparels/{cid}/sales-history?page={page}&per_page=100"
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept": "application/json",
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
    return dict(counts), avg_prices


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
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept": "application/json",
            "Referer": "https://snkrdunk.com/",
        })
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                raw = r.read().decode("utf-8")
                d = json.loads(raw)
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
                        date = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
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
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--range", default="all", help="oneMonth / threeMonths / sixMonths / oneYear / all")
    parser.add_argument("--debug", action="store_true", help="다양한 URL 시도 로그")
    parser.add_argument("--fresh", action="store_true",
                        help="기존 history 무시하고 처음부터 (지금 기준으로 풀 백필)")
    args = parser.parse_args()

    print("=" * 60)
    print(f"박스 history 백필 (range={args.range})")
    print("=" * 60)

    # 박스 ID 모음 — price-{brand}-box.json 에서
    box_ids = []
    for brand in ['pokemon', 'onepiece']:
        f = DATA / f"price-{brand}-box.json"
        if not f.exists():
            continue
        d = load_json(f)
        for p in d.get('products', []):
            box_ids.append({'id': str(p['id']), 'name': p.get('name', '')})

    print(f"  총 박스: {len(box_ids)}")

    if args.only:
        only_set = set(args.only)
        box_ids = [b for b in box_ids if b['id'] in only_set]
    elif args.new_only:
        # find_new_box_ids.py 가 추가한 박스 (code 필드 있음) 만
        new_box_codes = set()
        for brand in ['pokemon', 'onepiece']:
            try:
                d = load_json(DATA / f"price-{brand}-box.json")
                for p in d.get('products', []):
                    if p.get('code'):  # find_new_box_ids 가 추가한 항목
                        new_box_codes.add(str(p['id']))
            except Exception: pass
        box_ids = [b for b in box_ids if b['id'] in new_box_codes]
        print(f"  --new-only: 신규 박스 {len(box_ids)} 개")
    elif args.limit > 0:
        box_ids = box_ids[:args.limit]

    print(f"  처리 대상: {len(box_ids)}\n")

    fetched_at = datetime.now(timezone.utc).isoformat()
    success = 0
    for i, b in enumerate(box_ids, 1):
        cid = b['id']
        print(f"  [{i}/{len(box_ids)}] {cid} {b['name'][:40]}")
        points = fetch_chart(cid, args.range, debug=args.debug)
        if not points:
            print(f"      ⊘ 0 points")
            continue
        # 기존 history 와 merge (--fresh 면 무시. 단 fetch 0건이면 기존 keep 안전장치)
        hp = HIST / f"{cid}.json"
        try:
            existing = load_json(hp) if hp.exists() else {"id": cid, "history": []}
        except Exception:
            existing = {"id": cid, "history": []}
        existing_by_date = {h["date"]: dict(h) for h in existing.get("history", []) if h.get("date")}
        by_date = {} if args.fresh else dict(existing_by_date)

        # sales-history → 1박스 단가 + 거래량 (전체 발매부터, 끝까지)
        vols, sh_prices = fetch_volume_box(cid, days_limit=None, max_pages=9999)
        # 안전장치 — fetch 실패 시 기존 history 유지
        if not vols and not sh_prices and not points:
            print(f"      ⊘ all fetch failed — keep existing")
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

        new_hist = sorted(by_date.values(), key=lambda h: h.get("date", ""))
        out = {
            "id": cid,
            "updatedAt": fetched_at,
            "source": f"box backfill (range={args.range})",
            "history": new_hist,
        }
        if hp.exists():
            try: hp.unlink()
            except: pass
        with open(hp, "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(out, ensure_ascii=False, indent=2))
        success += 1
        total_vol = sum(h.get('box_vol', 0) for h in new_hist)
        print(f"      ✓ {len(points)} 차트 / {len(vols)} 거래일 (전체 거래량 {total_vol}건) / 누적 {len(new_hist)} dates")
        if new_hist:
            print(f"        {new_hist[0]['date']} ~ {new_hist[-1]['date']}")
            print(f"        valid {sum(1 for h in new_hist if h.get('box_vol', 0) > 0)} days")
        time.sleep(0.5)

    print(f"\nBox backfill complete - {len(box_ids)} processed")


if __name__ == "__main__":
    main()
