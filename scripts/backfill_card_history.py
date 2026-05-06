"""
backfill_card_history.py — 카드 sales-history 풀 백필 (1個 거래만, 등급별)

박스 백필과 동일한 정책 — sales-chart 는 묶음 거래 영향 받아서 SNKRDUNK 사이트 차트와
다를 수 있음. sales-history 페이지네이션해서 size==1 거래만 수집해서 등급별 일평균 단가 산출.

사용:
  python scripts/backfill_card_history.py            # 모든 카드 (data/history/*.json 중 카드만)
  python scripts/backfill_card_history.py 289056     # 특정 ID 만
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

GRADE_OPTION_IDS = {"psa10": 22, "psa9": 23, "raw": 18}


def fetch_card_history_1ea(cid, opt_id, days_limit=None, max_pages=200):
    """카드 sales-history — size==1 거래만 → date별 단가 list"""
    today = datetime.now()
    cutoff = (today - timedelta(days=days_limit)).strftime("%Y-%m-%d") if days_limit else "0000-00-00"
    prices_by_date = defaultdict(list)
    stopped_early = False
    for page in range(1, max_pages + 1):
        url = (f"https://snkrdunk.com/v1/apparels/{cid}/sales-history"
               f"?page={page}&per_page=20&salesChartOptionId={opt_id}")
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA, "Accept": "application/json",
                "Referer": "https://snkrdunk.com/",
            })
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
                m2 = re.match(r"(\d+)\s*(日|day)", date_str)
                d2 = (today - timedelta(days=int(m2.group(1)))).strftime("%Y-%m-%d") if m2 else today.strftime("%Y-%m-%d")
            if d2 < cutoff:
                stopped_early = True
                continue
            pr = it.get("price")
            if isinstance(pr, str):
                pm = re.search(r"([\d,]+)", pr.replace("¥", ""))
                pr = int(pm.group(1).replace(",", "")) if pm else None
            if pr is None:
                continue
            # 1個 만 — size 키 모두 검사
            sz_val = None
            for sk in ("quantity", "count", "qty", "size", "amount", "num",
                       "size_text", "sizeText", "lot_size", "set_size",
                       "boxes", "set", "lot", "pieces", "個数"):
                sv = it.get(sk)
                if sv is None: continue
                if isinstance(sv, dict):
                    sv = sv.get("count") or sv.get("size") or sv.get("amount") or sv.get("text")
                if isinstance(sv, (int, float)):
                    sz_val = int(sv); break
                if isinstance(sv, str):
                    sm = re.search(r"(\d+)", sv)
                    if sm: sz_val = int(sm.group(1)); break
            if sz_val is None:
                nm = re.search(r"(\d+)\s*(個|箱|本|点|セット|set|×|x)",
                               (it.get("name") or it.get("title") or ""), re.I)
                if nm: sz_val = int(nm.group(1))
            if sz_val != 1:
                continue
            prices_by_date[d2].append(pr)
        if stopped_early:
            break
        if len(items) < 20:
            break
        time.sleep(0.25)
    return dict(prices_by_date)


def is_card_history(history):
    """history 가 카드인지 (psa10/psa9/raw 키 있음) 박스인지 판별"""
    for r in history:
        if any(k in r for k in ("psa10_price", "psa9_price", "raw_price")):
            return True
    return False


def main():
    args = sys.argv[1:]
    days_limit = None
    only_ids = []
    for i, a in enumerate(args):
        if a == "--days" and i + 1 < len(args):
            days_limit = int(args[i + 1])
        elif a.isdigit():
            only_ids.append(a)

    print("=" * 60)
    print("카드 sales-history 백필 — 1個 거래만 수집 (등급별)")
    print(f"days_limit: {days_limit or 'ALL'}, target: {only_ids or 'ALL CARDS'}")
    print("=" * 60)

    # 카드 ID 만 추출
    targets = []
    for f in sorted(HISTORY_DIR.glob("*.json")):
        cid = f.stem
        if only_ids and cid not in only_ids:
            continue
        try:
            raw = f.read_bytes().replace(b"\x00", b"").rstrip()
            # 깨진 JSON 복구 (마지막 } 까지만)
            try:
                d = json.loads(raw)
            except json.JSONDecodeError:
                last = raw.rfind(b"}")
                if last > 0:
                    d = json.loads(raw[:last + 1] + b"\n  ]\n}")
                else:
                    continue
            history = d.get("history", [])
            if is_card_history(history):
                targets.append((cid, f, d))
        except Exception as e:
            print(f"  [{cid}] read fail: {e}")
            continue

    print(f"카드 history 파일: {len(targets)} 개\n")
    success = 0
    fail = 0
    for cid, path, existing in targets:
        print(f"[{cid}] fetching 3 grades...", end=" ", flush=True)
        by_date = {h["date"]: dict(h) for h in existing.get("history", []) if h.get("date")}
        any_new = False
        for grade, opt_id in GRADE_OPTION_IDS.items():
            try:
                prices_by_date = fetch_card_history_1ea(cid, opt_id, days_limit=days_limit)
            except Exception as e:
                print(f"\n  {grade} fail: {e}")
                continue
            for date, prs in prices_by_date.items():
                if not prs: continue
                avg = sum(prs) // len(prs)
                if date not in by_date:
                    by_date[date] = {"date": date}
                by_date[date][f"{grade}_price"] = avg
                by_date[date][f"{grade}_vol"] = len(prs)
                any_new = True
        if not any_new:
            print("(no data)")
            fail += 1
            continue
        new_history = sorted(by_date.values(), key=lambda h: h.get("date", ""))
        out = {
            "id": str(cid),
            "updatedAt": datetime.now(timezone.utc).isoformat(),
            "source": "backfill (sales-history 1ea per grade)",
            "history": new_history,
        }
        # truncate 보장 — unlink 후 재작성
        try:
            path.unlink()
        except Exception:
            pass
        path.write_bytes(json.dumps(out, ensure_ascii=False, indent=2).encode("utf-8"))
        print(f"✓ {len(new_history)} entries")
        success += 1
        time.sleep(0.3)

    print(f"\n완료: ✓ {success} / ❌ {fail}")


if __name__ == "__main__":
    main()
