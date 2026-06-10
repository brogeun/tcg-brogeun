"""고흐츄 등 카드의 실제 저장된 history range 확인"""
import json
import sys

card_ids = sys.argv[1:] if len(sys.argv) > 1 else ["146897", "289056"]

for cid in card_ids:
    try:
        d = json.load(open(f"data/history/{cid}.json", encoding="utf-8"))
        h = d.get("history", [])
        if not h:
            print(f"[{cid}] 빈 history")
            continue
        print(f"[{cid}] 저장된 점: {len(h)}")
        print(f"  range: {h[0].get('date')} ~ {h[-1].get('date')}")
        # 등급별 점 개수
        psa10 = sum(1 for p in h if p.get("psa10_price"))
        psa9 = sum(1 for p in h if p.get("psa9_price"))
        raw = sum(1 for p in h if p.get("raw_price"))
        vol = sum(1 for p in h if p.get("total_vol"))
        print(f"  PSA10: {psa10}점, PSA9: {psa9}점, RAW: {raw}점, vol(거래량): {vol}점")
    except FileNotFoundError:
        print(f"[{cid}] 파일 없음")
    except Exception as e:
        print(f"[{cid}] 에러: {e}")
