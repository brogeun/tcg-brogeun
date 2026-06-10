"""
check_snkrdunk_api_range.py — SNKRDUNK chart API 가 직접 주는 데이터 range 확인

사용:
  python scripts/check_snkrdunk_api_range.py            # 고흐츄 (146897) 등 인기 카드
  python scripts/check_snkrdunk_api_range.py 146897     # 특정 ID
"""
import urllib.request
import json
import sys
from datetime import datetime

CARD_IDS = sys.argv[1:] if len(sys.argv) > 1 else [
    ("146897", "고흐츄 (Van Gogh Pikachu)"),
    ("289056", "리자몽 ex SAR"),
    ("171882", "SV5K 와일드 포스"),
    ("85434", "CL1 Base Set"),
]

# 카드인 경우 hardcoded label 없으면 그냥 id 만
if isinstance(CARD_IDS[0], str):
    CARD_IDS = [(c, c) for c in CARD_IDS]

OPTIONS = {"PSA10": 22, "PSA9": 23, "RAW": 18}
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"


def fetch(cid, opt_id):
    url = f"https://snkrdunk.com/v1/apparels/{cid}/sales-chart/used?range=all&salesChartOptionId={opt_id}"
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json",
        "Referer": "https://snkrdunk.com/",
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read().decode("utf-8"))
    except Exception as e:
        return {"error": str(e)}


print("=" * 80)
print("  SNKRDUNK chart API 직접 호출 — 실제 응답 range 확인")
print("=" * 80)
for cid, name in CARD_IDS:
    print(f"\n[{cid}] {name}")
    for grade, opt in OPTIONS.items():
        d = fetch(cid, opt)
        if "error" in d:
            print(f"  {grade:6s}: ❌ {d['error']}")
            continue
        pts = d.get("points") or []
        if not pts:
            print(f"  {grade:6s}: 0 점 (해당 등급 거래 없음)")
            continue
        mn = min(p[0] for p in pts) / 1000
        mx = max(p[0] for p in pts) / 1000
        dmin = datetime.fromtimestamp(mn).strftime("%Y-%m-%d")
        dmax = datetime.fromtimestamp(mx).strftime("%Y-%m-%d")
        days = (mx - mn) / 86400
        print(f"  {grade:6s}: {len(pts):>4d} 점, {dmin} ~ {dmax} ({days:.0f}일)")

print(f"\n{'='*80}")
print("  해석: 만약 SNKRDUNK 가 2년치 주면 → 우리 저장이 자르는 것 (백필 수정)")
print("        1년치만 주면 → SNKRDUNK 정책 (카드별 다름, 인기 카드만 길게)")
print("=" * 80)
