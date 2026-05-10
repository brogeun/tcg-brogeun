"""
fetch_beezie.py — Beezie 4개 클로머신 가격 + EV fetch (비공개 API 직접 호출)

API: GET https://api.beezie.com/claw/by-id/{machineId}
EV 공식 (Beezie 사이트 "Average Value" 와 정확히 일치 — 역공학 검증):
  price = priceUsdc / 1_000_000              # USDC → USD
  avg   = Σ ( prob[tier] × mean_value[tier] ) over base/low/medium/high/grails
    - base / low                       → mean = √(fromX × toX) (기하평균)
    - medium / high / grails           → mean = arithmetic mean of grails.{tier} swapValue / 1M
    - 만약 grails.{tier} 비어있으면     → 폴백 = √(fromX × toX)

검증 — Platinum (id=92):
  base:   0.7605 × √(250×500)     = 268.87
  low:    0.2003 × √(501×1500)    = 173.60
  medium: 0.0348 × $2434.75 (24개) =  84.73
  high:   0.0029 × $5450 (2개)     =  15.81
  grails: 0.0015 × $8500 (1개)     =  12.75
  ─────────────────────────────────
  avg ≈ $555.76 → Beezie 실제 표시값 $555 와 정확히 일치 ✓

GitHub Actions cron 30분마다 → data/beezie-prices.json (data-beezie 브랜치)
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

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

USDC_DECIMAL = 1_000_000  # 6 decimals

TIERS = ["base", "low", "medium", "high", "grails"]
RANGE_TIERS_KEY = {  # priceRanges 키 매핑 (base → fromBase/toBase)
    "base":   ("fromBase",   "toBase"),
    "low":    ("fromLow",    "toLow"),
    "medium": ("fromMedium", "toMedium"),
    "high":   ("fromHigh",   "toHigh"),
    "grails": ("fromGrails", "toGrails"),
}


def to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def mean_swap_value(arr):
    """grails.{tier} 리스트의 swapValue 평균 (USD)"""
    if not isinstance(arr, list) or not arr:
        return None
    vals = []
    for item in arr:
        if isinstance(item, dict) and item.get("swapValue") is not None:
            v = to_float(item["swapValue"])
            if v is not None:
                vals.append(v / USDC_DECIMAL)
    if not vals:
        return None
    return sum(vals) / len(vals)


def geometric_mean(price_ranges, tier):
    """priceRanges 의 fromX × toX 기하평균 (Beezie 사이트와 동일 공식)"""
    from_k, to_k = RANGE_TIERS_KEY[tier]
    f, t = to_float(price_ranges.get(from_k)), to_float(price_ranges.get(to_k))
    if f is None or t is None or f <= 0 or t <= 0:
        return None
    return (f * t) ** 0.5


def compute_ev(claw):
    """price, avg, ev% 계산 — 실패시 None"""
    price_usdc = to_float(claw.get("priceUsdc"))
    price = price_usdc / USDC_DECIMAL if price_usdc else None

    odds = claw.get("odds") or {}
    price_ranges = claw.get("priceRanges") or {}
    grails = claw.get("grails") or {}

    avg = 0.0
    breakdown = {}
    have_any = False
    for tier in TIERS:
        prob_pct = to_float(odds.get(tier))
        if prob_pct is None:
            continue
        prob = prob_pct / 100.0

        # tier 별 mean_value 결정 (Beezie 사이트 공식과 동일):
        # 1순위: grails.{tier} 리스트의 swapValue 산술평균 (medium/high/grails)
        # 2순위: priceRanges 의 √(fromX × toX) 기하평균 (base/low — grails 데이터 없음)
        mv = mean_swap_value(grails.get(tier))
        if mv is None:
            mv = geometric_mean(price_ranges, tier)
        if mv is None:
            continue

        contrib = prob * mv
        avg += contrib
        breakdown[tier] = {
            "prob": round(prob_pct, 2),
            "mean_value": round(mv, 2),
            "contrib": round(contrib, 2),
        }
        have_any = True

    if not have_any or price is None:
        return None

    ev_pct = (avg / price - 1) * 100 if price > 0 else None
    return {
        "price": round(price, 2),
        "avg": round(avg, 2),
        "ev": round(ev_pct, 2) if ev_pct is not None else None,
        "breakdown": breakdown,
    }


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

        claw = data.get("claw") if isinstance(data, dict) else None
        if not isinstance(claw, dict):
            return {
                "tier": machine["tier"], "url": url,
                "price": None, "avg": None, "ev": None, "ok": False,
                "error": "no claw object",
                "ms": int((time.time() - t0) * 1000),
            }

        # Beezie web URL 도 같이 노출 (사용자가 클릭해서 사이트로 이동 가능)
        clawTag = claw.get("clawTag")
        name = claw.get("name", machine["tier"])
        web_url = f"https://beezie.com/claw/{name.replace(' ', '-')}-{machine['id']}"

        ev_data = compute_ev(claw)
        if ev_data is None:
            return {
                "tier": machine["tier"], "url": url, "web": web_url,
                "price": None, "avg": None, "ev": None, "ok": False,
                "error": "EV compute failed",
                "stockCount": claw.get("clawStockCount"),
                "ms": int((time.time() - t0) * 1000),
            }

        return {
            "tier": machine["tier"],
            "url": url,
            "web": web_url,
            "price": ev_data["price"],
            "avg": ev_data["avg"],
            "ev": ev_data["ev"],
            "ok": True,
            "stockCount": claw.get("clawStockCount"),
            "totalSwapValue": (claw.get("totalSwapValue") or 0) / USDC_DECIMAL,
            "breakdown": ev_data["breakdown"],
            "ms": int((time.time() - t0) * 1000),
        }
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
        flag = "v" if r["ok"] else "x"
        print(f"  [{flag}] {r['tier']:14s} price=${r.get('price')} avg=${r.get('avg')} ev={r.get('ev')}% stock={r.get('stockCount')} ({r.get('ms')}ms)")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "ok": True,
        "fetchedAt": int(time.time() * 1000),
        "source": "api.beezie.com/claw/by-id (computed EV)",
        "results": results,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[beezie API] saved -> {OUT}")
    return 0 if ok > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
