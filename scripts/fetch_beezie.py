"""
fetch_beezie.py — Beezie 4개 클로머신 EV fetch (하이브리드)

- price : API (api.beezie.com/claw/by-id/{id}) — 정확
- avg   : 사이트 (beezie.com/claw/...) Playwright 렌더링 후 "Average Value: $XXX" 텍스트 추출
         → Beezie 가 표시하는 값과 100% 동일 (자체 계산식 모방 X)

GitHub Actions cron 30분마다 → data/beezie-prices.json (data-beezie 브랜치)
"""
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "beezie-prices.json"

MACHINES = [
    {"tier": "Platinum TCG", "id": 92, "slug": "Platinum-TCG-92"},
    {"tier": "Gold TCG",     "id": 91, "slug": "Gold-TCG-91"},
    {"tier": "Silver TCG",   "id": 90, "slug": "Silver-TCG-90"},
    {"tier": "Wildcard",     "id": 89, "slug": "Wildcard-89"},
]

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

USDC_DECIMAL = 1_000_000  # 6 decimals


def fetch_price_api(machine_id):
    """API 에서 priceUsdc 만 빠르게 가져옴 (USD 단위로 변환)"""
    url = f"https://api.beezie.com/claw/by-id/{machine_id}"
    try:
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept": "application/json",
            "Origin": "https://beezie.com",
            "Referer": "https://beezie.com/",
        })
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8"))
        claw = (data or {}).get("claw") or {}
        usdc = claw.get("priceUsdc")
        if usdc is None:
            return None, None
        price = float(usdc) / USDC_DECIMAL
        stock = claw.get("clawStockCount")
        return price, stock
    except Exception as e:
        print(f"  [api] error: {e}")
        return None, None


def fetch_avg_browser(slug, browser):
    """Playwright 로 페이지 렌더링 후 'Average Value' 텍스트 추출"""
    url = f"https://beezie.com/claw/{slug}"
    page = browser.new_page(user_agent=UA)
    try:
        page.goto(url, wait_until="domcontentloaded", timeout=30000)
        # "Average Value:" 텍스트가 나타날 때까지 대기 (최대 12초)
        try:
            page.wait_for_function(
                """() => /Average\\s*Value/i.test(document.body.innerText)""",
                timeout=12000,
            )
        except Exception:
            # 텍스트 안 나와도 일단 시도
            page.wait_for_timeout(3000)

        text = page.evaluate("() => document.body.innerText")
        # "Average Value:\n\n$555" 또는 "Average Value: $555" 등 다양한 형태
        patterns = [
            r"Average\s*Value\s*:?\s*\$\s*([\d,]+(?:\.\d+)?)",
            r"Average\s*Value[\s\S]{0,30}?\$\s*([\d,]+(?:\.\d+)?)",
        ]
        for pat in patterns:
            m = re.search(pat, text, re.I)
            if m:
                try:
                    return float(m.group(1).replace(",", "")), "page-text"
                except ValueError:
                    continue
        return None, "no-match"
    finally:
        page.close()


def fetch_one(machine, browser):
    t0 = time.time()
    price, stock = fetch_price_api(machine["id"])
    avg, method = (None, None)
    err = None
    try:
        avg, method = fetch_avg_browser(machine["slug"], browser)
    except Exception as e:
        err = str(e)
    ms = int((time.time() - t0) * 1000)
    ev = (avg / price - 1) * 100 if (price and avg) else None
    return {
        "tier": machine["tier"],
        "url": f"https://beezie.com/claw/{machine['slug']}",
        "price": round(price, 2) if price is not None else None,
        "avg": round(avg, 2) if avg is not None else None,
        "ev": round(ev, 2) if ev is not None else None,
        "ok": price is not None and avg is not None,
        "stockCount": stock,
        "method": method,
        "error": err,
        "ms": ms,
    }


def main():
    from playwright.sync_api import sync_playwright

    print(f"[beezie hybrid] start — {len(MACHINES)} machines")
    results = []
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-blink-features=AutomationControlled"],
        )
        try:
            for m in MACHINES:
                r = fetch_one(m, browser)
                results.append(r)
                flag = "v" if r["ok"] else "x"
                print(f"  [{flag}] {r['tier']:14s} price=${r.get('price')} avg=${r.get('avg')} ev={r.get('ev')}% ({r.get('ms')}ms) {r.get('method') or r.get('error') or ''}")
        finally:
            browser.close()

    ok = sum(1 for r in results if r["ok"])
    print(f"[beezie hybrid] {ok}/{len(results)} OK")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "ok": True,
        "fetchedAt": int(time.time() * 1000),
        "source": "api.beezie.com (price) + beezie.com page (avg)",
        "results": results,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[beezie hybrid] saved -> {OUT}")
    return 0 if ok > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
