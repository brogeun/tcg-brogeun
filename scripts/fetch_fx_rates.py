"""
fetch_fx_rates.py — Naver 금융에서 USD/KRW, JPY/KRW 환율 수집

출처:
  - https://m.stock.naver.com/marketindex/exchange/FX_USDKRW
  - https://m.stock.naver.com/marketindex/exchange/FX_JPYKRW

출력: data/fx-rates.json
포맷:
{
  "updated": "2026-05-05T04:00:00+09:00",
  "rates": {
    "USD": 1370.50,    # 1 USD = 1370.50 KRW
    "JPY": 9.12,       # 1 JPY = 9.12 KRW (Naver 는 100엔당으로 표시 → /100)
    "JPY_PER_100": 912.45  # 100 JPY 기준
  },
  "source": "naver-finance"
}

매일 cron 으로 실행 권장 (04:00 KST scrape.yml 에 통합).
"""
import json
import re
import urllib.request
import urllib.error
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUT_FILE = DATA_DIR / "fx-rates.json"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# Naver 모바일 금융 페이지 — 환율
URLS = {
    "USD": "https://m.stock.naver.com/marketindex/exchange/FX_USDKRW",
    "JPY": "https://m.stock.naver.com/marketindex/exchange/FX_JPYKRW",
}

# Naver API (JSON) — 더 안정적
API_URLS = {
    "USD": "https://api.stock.naver.com/marketindex/exchange/FX_USDKRW",
    "JPY": "https://api.stock.naver.com/marketindex/exchange/FX_JPYKRW",
}


def fetch_rate(currency):
    """Naver API 에서 환율 fetch"""
    api_url = API_URLS[currency]
    req = urllib.request.Request(api_url, headers={
        "User-Agent": UA,
        "Accept": "application/json",
        "Referer": "https://m.stock.naver.com/",
    })
    with urllib.request.urlopen(req, timeout=15) as r:
        data = json.loads(r.read().decode("utf-8"))

    # API 응답 구조 (예상): { "calcPrice": "1370.50", ... }
    # 또는 { "closePrice": "1,370.50" }
    candidates = ["calcPrice", "closePrice", "price", "currentPrice", "tradePrice"]
    for key in candidates:
        if key in data:
            v = data[key]
            if isinstance(v, str):
                v = v.replace(",", "")
            return float(v)

    # 한 번 더 — nested
    if "exchange" in data and isinstance(data["exchange"], dict):
        for key in candidates:
            v = data["exchange"].get(key)
            if v is not None:
                if isinstance(v, str):
                    v = v.replace(",", "")
                return float(v)
    return None


def fetch_rate_html_fallback(currency):
    """API 실패 시 HTML 페이지 파싱"""
    url = URLS[currency]
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=15) as r:
        html = r.read().decode("utf-8")
    # 정규식으로 환율 추출 (페이지 구조 변경에 약함)
    m = re.search(r'"calcPrice"\s*:\s*"?([\d,]+\.?\d*)"?', html)
    if m:
        return float(m.group(1).replace(",", ""))
    m = re.search(r'(\d{1,4},?\d{3}\.\d{2})\s*원', html)
    if m:
        return float(m.group(1).replace(",", ""))
    return None


def main():
    DATA_DIR.mkdir(exist_ok=True)
    rates = {}
    for currency in ("USD", "JPY"):
        v = None
        try:
            v = fetch_rate(currency)
        except Exception as e:
            print(f"  [{currency}] API 실패: {e}, HTML fallback 시도")
        if v is None:
            try:
                v = fetch_rate_html_fallback(currency)
            except Exception as e:
                print(f"  [{currency}] HTML 도 실패: {e}")
        if v is None:
            print(f"  ⚠ [{currency}] 환율 fetch 실패")
            continue
        # JPY 는 Naver 가 보통 "100엔당" 으로 표시 (예: 912.45 = 100엔당 912원)
        # 즉 1 JPY = 9.1245 원
        if currency == "JPY":
            rates["JPY"] = round(v / 100, 4)
            rates["JPY_PER_100"] = round(v, 2)
        else:
            rates["USD"] = round(v, 2)
        print(f"  ✓ [{currency}] {v}")

    if not rates:
        print("⚠ 환율 fetch 실패 — 기존 파일 유지")
        return

    # KST 기준 시간
    kst = timezone(timedelta(hours=9))
    out = {
        "updated": datetime.now(kst).isoformat(),
        "rates": rates,
        "source": "naver-finance",
    }
    OUT_FILE.write_text(
        json.dumps(out, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    print(f"\n✓ 저장: {OUT_FILE}")
    print(f"  USD/KRW: {rates.get('USD')}")
    print(f"  JPY/KRW: {rates.get('JPY')} (100엔당 {rates.get('JPY_PER_100')})")


if __name__ == "__main__":
    main()
