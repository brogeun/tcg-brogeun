"""
fetch_beezie.py — Beezie 4개 클로머신 가격 fetch (Playwright 헤드리스 브라우저)

Beezie 는 Next.js 사이트 — 클라이언트 JavaScript 로 가격 렌더링하므로
일반 HTTP fetch 로는 빈 HTML 만 받음. Playwright 로 JS 실행 후 가격 추출.

GitHub Actions cron 에서 30 분마다 실행 → data/beezie-prices.json 저장.
"""
import json
import re
import sys
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "beezie-prices.json"

MACHINES = [
    {"tier": "Platinum TCG", "url": "https://beezie.com/claw/Platinum-TCG-92"},
    {"tier": "Gold TCG",     "url": "https://beezie.com/claw/Gold-TCG-91"},
    {"tier": "Silver TCG",   "url": "https://beezie.com/claw/Silver-TCG-90"},
    {"tier": "Wildcard",     "url": "https://beezie.com/claw/Wildcard-89"},
]

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def to_num(s):
    if s is None:
        return None
    try:
        return float(str(s).replace("$", "").replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def parse_html(html):
    """렌더된 HTML 에서 Claw Price + Average Value 추출"""
    if not html:
        return None, None
    price, avg = None, None

    # 1) "Claw Price ... $123.45" 패턴
    m = re.search(r"Claw\s*Price[^$0-9]*\$?\s*([\d,]+(?:\.\d+)?)", html, re.I)
    if m:
        price = to_num(m.group(1))

    # 2) "Average Value ... $456.78" 패턴
    m = re.search(r"Average\s*Value[^$0-9]*\$?\s*([\d,]+(?:\.\d+)?)", html, re.I)
    if m:
        avg = to_num(m.group(1))

    # 3) JSON 키 매칭 (Next.js 데이터)
    if price is None:
        m = re.search(r'"clawPrice"\s*:\s*"?\$?([\d.,]+)', html, re.I)
        if m:
            price = to_num(m.group(1))
    if avg is None:
        m = re.search(r'"averageValue"\s*:\s*"?\$?([\d.,]+)', html, re.I)
        if m:
            avg = to_num(m.group(1))

    # validity check
    if price is not None and (price < 0.01 or price > 100000):
        price = None
    if avg is not None and (avg < 0.01 or avg > 100000):
        avg = None

    return price, avg


def fetch_one(context, machine):
    """단일 머신 페이지 fetch + 가격 추출 (page.evaluate 로 JS 환경에서 직접 추출)"""
    t0 = time.time()
    page = context.new_page()
    try:
        page.goto(machine["url"], wait_until="domcontentloaded", timeout=20000)
        # 가격 텍스트 ("$") 가 화면에 나타날 때까지 최대 15초 대기
        try:
            page.wait_for_function(
                "() => document.body && document.body.innerText.includes('Claw Price') "
                "&& /\\$\\s*\\d/.test(document.body.innerText)",
                timeout=15000,
            )
        except Exception:
            pass  # timeout 나도 일단 진행
        page.wait_for_timeout(2000)  # 추가 안정화 대기

        # JS 환경에서 직접 추출 (정확도 ↑)
        data = page.evaluate("""
() => {
  const text = document.body ? document.body.innerText : '';
  const num = (s) => {
    if (!s) return null;
    const n = parseFloat(String(s).replace(/[$,\\s]/g, ''));
    return isFinite(n) && n > 0.01 && n < 100000 ? n : null;
  };
  // Price — Beezie 새 페이지는 "$NNN +NNN points" 형태 (Claw Price 라벨 없음)
  // 1차: "+NNN points" 패턴 (entry price), 2차: "Claw Price" 라벨 fallback
  let priceMatch = text.match(/\\$\\s*([\\d,]+(?:\\.\\d+)?)\\s*\\+\\s*\\d+\\s*points/i)
                || text.match(/Claw\\s*Price[^$\\d]{0,80}\\$?\\s*([\\d,]+(?:\\.\\d+)?)/i);
  // Avg — "Average Value" 라벨 뒤
  const avgMatch = text.match(/Average\\s*Value[^$\\d]{0,80}\\$?\\s*([\\d,]+(?:\\.\\d+)?)/i);
  return {
    price: priceMatch ? num(priceMatch[1]) : null,
    avg: avgMatch ? num(avgMatch[1]) : null,
    sample: text.slice(0, 200),
  };
}
        """)
        price = data.get("price")
        avg = data.get("avg")
        ev = (avg / price - 1) * 100 if (price and avg) else None
        return {
            "tier": machine["tier"],
            "url": machine["url"],
            "price": price,
            "avg": avg,
            "ev": round(ev, 2) if ev is not None else None,
            "ok": price is not None and avg is not None,
            "ms": int((time.time() - t0) * 1000),
            "sample": (data.get("sample") or "")[:120],  # 디버그
        }
    except Exception as e:
        return {
            "tier": machine["tier"],
            "url": machine["url"],
            "price": None, "avg": None, "ev": None, "ok": False,
            "error": str(e),
            "ms": int((time.time() - t0) * 1000),
        }
    finally:
        page.close()


def main():
    print(f"[beezie] fetch start — {len(MACHINES)} machines")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(user_agent=UA, viewport={"width": 1280, "height": 800})
        results = [fetch_one(context, m) for m in MACHINES]
        browser.close()

    ok_count = sum(1 for r in results if r["ok"])
    print(f"[beezie] {ok_count}/{len(results)} OK")
    for r in results:
        flag = "✓" if r["ok"] else "✗"
        print(f"  {flag} {r['tier']:14s} price=${r['price']} avg=${r['avg']} ev={r['ev']}% ({r['ms']}ms)")

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "ok": True,
        "fetchedAt": int(time.time() * 1000),
        "results": results,
    }, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[beezie] saved → {OUT}")
    return 0 if ok_count > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
