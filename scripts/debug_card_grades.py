"""
debug_card_grades.py — 카드 등급별 응답이 다른지 SNKRDUNK API 에 직접 확인

목적: 백필 데이터에서 PSA10/PSA9/raw 거래량+가격이 동일한 게 82.8% 라는 게
      (1) 우리 코드 버그 인지 (2) SNKRDUNK API 자체 특성 인지 판별

실행:
  python scripts/debug_card_grades.py
"""
import urllib.request, json

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

# 100063 = 모든 등급 동일값 (버그 의심)
# 485638 = 등급별 다른 값 (정상)
# 289056 = 인기 카드, 비교용
TARGETS = ["100063", "485638", "289056"]

for cid in TARGETS:
    print(f"\n{'='*60}")
    print(f"Card {cid}")
    print('='*60)
    for grade, opt in [("psa10", 22), ("psa9", 23), ("raw", 18)]:
        url = (f"https://snkrdunk.com/v1/apparels/{cid}/sales-history"
               f"?page=1&per_page=5&salesChartOptionId={opt}")
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept": "application/json",
            "Referer": "https://snkrdunk.com/",
        })
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                d = json.loads(r.read().decode("utf-8"))
            items = d.get("history") or []
            print(f"\n[{grade:5}] opt={opt} items={len(items)}")
            for it in items[:3]:
                print(f"  date={it.get('date')!r} price={it.get('price')!r} size={it.get('size')!r}")
        except Exception as e:
            print(f"[{grade:5}] FAIL: {e}")
