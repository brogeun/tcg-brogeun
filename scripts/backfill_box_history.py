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
    parser.add_argument("--only", type=str, help="박스 ID 1개만 (테스트)")
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--range", default="all", help="oneMonth / threeMonths / sixMonths / oneYear / all")
    parser.add_argument("--debug", action="store_true", help="다양한 URL 시도 로그")
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
        box_ids = [b for b in box_ids if b['id'] == args.only]
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
        # 기존 history 와 merge
        hp = HIST / f"{cid}.json"
        try:
            existing = load_json(hp) if hp.exists() else {"id": cid, "history": []}
        except Exception:
            existing = {"id": cid, "history": []}
        by_date = {h["date"]: dict(h) for h in existing.get("history", []) if h.get("date")}
        for date, price in points:
            if date not in by_date:
                by_date[date] = {"date": date}
            by_date[date]["box_price"] = price
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
        print(f"      ✓ {len(points)} points / 누적 {len(new_hist)} dates")
        # 첫 / 마지막 date
        if new_hist:
            print(f"        {new_hist[0]['date']} ~ {new_hist[-1]['date']}")
        time.sleep(0.5)

    print(f"\n━━━ 완료: {success}/{len(box_ids)} 박스 ━━━")


if __name__ == "__main__":
    main()
