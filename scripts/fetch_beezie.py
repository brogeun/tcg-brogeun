"""
fetch_beezie.py — Beezie 4개 클로머신 가격 fetch (비공개 API 직접 호출)

Beezie 의 내부 API 엔드포인트 사용 — HTML 스크래핑 불필요, 매우 빠름:
  GET https://api.beezie.com/claw/by-id/{machineId}
  → JSON { ... clawPrice / averageValue ... }

GitHub Actions cron 에서 30 분마다 실행 → data/beezie-prices.json 저장.
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "beezie-prices.json"

MACHINES = [
    {"tier": "Platinum TCG", "id": 92},
    {"tier": "Gold TCG",     "id": 91},
    {"tier": "Silver TCG",   "id": 90},
    {"tier": "Wildcard",     "id": 89},
]

# 가격/평균값 후보 키 — Beezie API 실제 키 이름은 응답 보고 확인
PRICE_KEYS = [
    "clawPrice", "claw_price", "pullPrice", "pull_price",
    "price", "unitPrice", "cost", "priceUsd", "priceUSD",
    "entryPrice", "entry_price", "pricePerPull", "pullCost",
    "amount", "amountUsd",
]
AVG_KEYS = [
    "averageValue", "avgValue", "average_value", "average", "avg",
    "expectedValue", "expected_value", "ev", "evValue",
    "totalValue", "total_value", "fmv", "fairMarketValue",
    "estimatedValue", "estimated_value", "estValue",
    "meanValue", "mean_value", "expectedReturn",
    "payout", "payoutValue", "payout_value",
]

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def to_num(v):
    if v is None:
        return None
    try:
        n = float(str(v).replace("$", "").replace(",", "").strip())
        if 0.01 < n < 100000:
            return n
    except (TypeError, ValueError):
        pass
    return None


def find_deep(obj, keys, depth=0):
    """JSON 트리에서 keys 중 하나에 매칭되는 첫 숫자 값 반환 (재귀)"""
    if obj is None or depth > 18:
        return None
    if isinstance(obj, dict):
        for k in keys:
            if k in obj:
                n = to_num(obj[k])
                if n is not None:
                    return n
        for v in obj.values():
            r = find_deep(v, keys, depth + 1)
            if r is not None:
                return r
    elif isinstance(obj, list):
        for v in obj:
            r = find_deep(v, keys, depth + 1)
            if r is not None:
                return r
    return None


def collect_all_keys(obj, prefix="", out=None, depth=0):
    """JSON 트리의 모든 키:값 수집 (요약) — 디버그 전용"""
    if out is None:
        out = {}
    if depth > 6:
        return out
    if isinstance(obj, dict):
        for k, v in obj.items():
            full = f"{prefix}.{k}" if prefix else k
            if isinstance(v, (int, float)):
                out[full] = v
            elif isinstance(v, str) and len(v) < 60:
                out[full] = v
            elif isinstance(v, (dict, list)):
                collect_all_keys(v, full, out, depth + 1)
            else:
                out[full] = f"<{type(v).__name__}>"
    elif isinstance(obj, list) and obj:
        # 리스트는 첫 원소만 (구조만 보기)
        collect_all_keys(obj[0], f"{prefix}[0]", out, depth + 1)
    return out


def fetch_one(machine):
    url = f"https://api.beezie.com/claw/by-id/{machine['id']}"
    t0 = time.time()
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept": "application/json",
            "Origin": "https://beezie.com",
            "Referer": "https://beezie.com/",
        })
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8"))
        price = find_deep(data, PRICE_KEYS)
        avg = find_deep(data, AVG_KEYS)
        ev = (avg / price - 1) * 100 if (price and avg) else None
        ok = price is not None and avg is not None
        result = {
            "tier": machine["tier"],
            "url": url,
            "price": price,
            "avg": avg,
            "ev": round(ev, 2) if ev is not None else None,
            "ok": ok,
            "ms": int((time.time() - t0) * 1000),
        }
        # 디버그 — price/avg 못 찾았을 때 전체 키 구조 + raw 첨부
        if not ok:
            result["all_keys"] = collect_all_keys(data)
            raw_str = json.dumps(data, ensure_ascii=False)
            result["raw"] = raw_str[:8000] if len(raw_str) > 8000 else raw_str
        return result
    except Exception as e:
        return {
            "tier": machine["tier"],
            "url": url,
            "price": None, "avg": None, "ev": None, "ok": False,
            "error": str(e),
            "ms": int((time.time() - t0) * 1000),
        }


def main():
    print(f"[beezie API] fetch start — {len(MACHINES)} machines")
    results = [fetch_one(m) for m in MACHINES]
    ok = sum(1 for r in results if r["ok"])
    print(f"[beezie API] {ok}/{len(results)} OK")
    for r in results:
        flag = "✓" if r["ok"] else "✗"
        kdesc = ""
        if not r["ok"] and r.get("all_keys"):
            # 숫자 값만 추려 출력 (price/avg 후보 찾기 쉽게)
            nums = {k: v for k, v in r["all_keys"].items() if isinstance(v, (int, float))}
            kdesc = f"nums={nums}"
        print(f"  {flag} {r['tier']:14s} price=${r.get('price')} avg=${r.get('avg')} ev={r.get('ev')}% ({r.get('ms')}ms) {kdesc}")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "ok": True,
        "fetchedAt": int(time.time() * 1000),
        "source": "api.beezie.com/claw/by-id",
        "results": results,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[beezie API] saved → {OUT}")
    return 0 if ok > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
