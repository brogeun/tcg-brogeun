"""
SNKRDUNK 의 BGS10 (그리고 다른 등급들) 의 salesChartOptionId 찾기

사용법:
  python scripts/find_bgs_option_id.py

→ 인기 카드 몇 개로 opt_id 15~50 까지 다 호출
→ 어떤 ID 가 어떤 등급인지 추정
"""
import json
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# 인기 카드들 — PSA10/PSA9 거래 활성 있을 만한 ID
# 671486 = 형이 확인한 BGS10/BGS9.5 활성 카드 (최우선)
KNOWN_ACTIVE_CIDS = [
    671486,  # ⭐ BGS10/BGS9.5 거래 확인됨
    100063, 100073, 234190, 234185, 305749,
    289056, 234234, 100068, 100070,
]

# 잘 알려진 등급 매핑 (검증용)
KNOWN_OPTS = {18: "raw (미개봉)", 22: "PSA10", 23: "PSA9"}


def fetch_chart(cid: int, opt_id: int):
    """sales-chart/used?salesChartOptionId={opt_id} 호출"""
    url = (f"https://snkrdunk.com/v1/apparels/{cid}/sales-chart/used"
           f"?range=all&salesChartOptionId={opt_id}")
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json",
        "Referer": "https://snkrdunk.com/",
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return {"_error": f"HTTP {e.code}"}
    except Exception as e:
        return {"_error": str(e)[:80]}


def main():
    # 1) 활성 cid 찾기 (PSA10 데이터 있는)
    print("=== 1단계: 활성 카드 찾기 (PSA10 = opt_id 22) ===")
    active_cid = None
    for cid in KNOWN_ACTIVE_CIDS:
        d = fetch_chart(cid, 22)  # PSA10
        if isinstance(d, dict) and not d.get("_error"):
            pts = d.get("points") or []
            print(f"  cid={cid}: PSA10 points={len(pts)}")
            if len(pts) >= 5:
                active_cid = cid
                break
    if not active_cid:
        print("\n❌ PSA10 데이터 있는 카드 못 찾음. 수동으로 cid 추가 필요.")
        return

    print(f"\n✅ 활성 카드 찾음: cid={active_cid}\n")

    # 2) 모든 opt_id 시도 (15~50)
    print(f"=== 2단계: cid={active_cid} 에서 opt_id 15~50 시도 ===\n")
    results = {}
    for opt_id in range(15, 51):
        d = fetch_chart(active_cid, opt_id)
        if isinstance(d, dict) and not d.get("_error"):
            pts = d.get("points") or []
            if len(pts) > 0:
                last = pts[-1] if isinstance(pts[-1], list) and len(pts[-1]) >= 2 else None
                last_price = last[1] if last else None
                results[opt_id] = {"points": len(pts), "last_price": last_price}
                label = KNOWN_OPTS.get(opt_id, "?")
                marker = "  ⭐" if opt_id not in KNOWN_OPTS else ""
                print(f"  opt_id={opt_id:3d}: {len(pts):4d} points, last_price={last_price} ({label}){marker}")
        time.sleep(0.5)  # rate limit 회피

    # 3) 결과 요약 — 알 수 없는 opt_id 가 BGS10 후보
    unknown_opts = [oid for oid in results if oid not in KNOWN_OPTS]
    print(f"\n=== 3단계: 알려지지 않은 opt_id (BGS10 후보) ===")
    for oid in unknown_opts:
        print(f"  opt_id={oid}: {results[oid]['points']} points, last_price={results[oid]['last_price']}")

    if not unknown_opts:
        print("\n  → 새 opt_id 없음. 이 카드에는 BGS 등급 데이터 없음.")
        print("  → 다른 카드로 시도 필요. (인기 카드 ID 확인 후 KNOWN_ACTIVE_CIDS 에 추가)")

    # 결과 저장
    out_path = Path(__file__).resolve().parent.parent / "data" / "_bgs_opt_search_result.json"
    out_path.write_text(json.dumps({
        "tested_cid": active_cid,
        "results": results,
        "unknown_opt_candidates": unknown_opts,
    }, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\n결과 저장: {out_path}")


if __name__ == "__main__":
    main()
