"""
fill_box_metadata.py — 박스 list 의 비어있는 image / lastPrice 자동 채우기

SNKRDUNK product API 호출 → 누락된 image URL + 가격 받기
사용자가 1회 실행 → 결과 push 하면 끝

사용:
  python scripts/fill_box_metadata.py
"""
import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def fetch_product_detail(pid):
    """SNKRDUNK product detail — 여러 endpoint 시도"""
    urls = [
        f"https://snkrdunk.com/v1/apparels/{pid}",
        f"https://snkrdunk.com/v1/apparels/{pid}/detail",
    ]
    for url in urls:
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": UA,
                "Accept": "application/json",
                "Referer": "https://snkrdunk.com/",
            })
            with urllib.request.urlopen(req, timeout=15) as r:
                d = json.loads(r.read().decode("utf-8"))
            if d:
                return d
        except Exception:
            continue
    return None


def _extract_url_from_media(m):
    """미디어 객체 (dict/str/list) 에서 image URL 뽑기"""
    if isinstance(m, str) and m.startswith('http'):
        return m
    if isinstance(m, dict):
        for sk in ('url', 'src', 'imageUrl', 'large', 'medium', 'small',
                   'origin', 'thumbnail', 'thumbnailUrl', 'path'):
            sv = m.get(sk)
            if isinstance(sv, str) and sv.startswith('http'):
                return sv
            if isinstance(sv, dict):
                got = _extract_url_from_media(sv)
                if got:
                    return got
    if isinstance(m, list) and m:
        return _extract_url_from_media(m[0])
    return None


def extract_image(detail):
    """응답에서 image URL 추출 — primaryMedia / medias 우선"""
    # primaryMedia (실제 SNKRDUNK 응답 키)
    pm = detail.get('primaryMedia')
    got = _extract_url_from_media(pm)
    if got:
        return got
    # medias 배열
    got = _extract_url_from_media(detail.get('medias'))
    if got:
        return got
    # 기존 fallback
    for key in ('image', 'imageUrl', 'thumbnailUrl', 'thumbnail', 'mainImage',
                'images', 'imageList'):
        got = _extract_url_from_media(detail.get(key))
        if got:
            return got
    return None


def extract_price(detail):
    """응답에서 가격 추출 (USD 기준)"""
    for key in ('lastPrice', 'lowestAsk', 'latestPrice', 'price', 'minPrice'):
        v = detail.get(key)
        if isinstance(v, (int, float)) and v > 0:
            return float(v)
        if isinstance(v, dict):
            for sk in ('amount', 'value', 'price'):
                sv = v.get(sk)
                if isinstance(sv, (int, float)) and sv > 0:
                    return float(sv)
    return None


def main():
    print("=" * 60)
    print("박스 이미지/가격 자동 채우기")
    print("=" * 60)
    debug_printed = False
    for brand in ['pokemon', 'onepiece']:
        f = ROOT / 'data' / f'price-{brand}-box.json'
        d = json.loads(f.read_bytes().rstrip(b'\x00').rstrip())
        products = d.get('products', [])
        missing = [p for p in products
                   if not (p.get('image') and p.get('lastPrice'))]
        print(f"\n=== {brand} (총 {len(products)}개, 누락 {len(missing)}개) ===")
        if not missing:
            print("  → 모두 채워져 있음")
            continue
        updated = 0
        for p in missing:
            pid = str(p['id'])
            try:
                detail = fetch_product_detail(pid)
                if detail is None:
                    print(f"  ❌ {pid}: API 응답 없음")
                    continue
                # 첫 1개 응답 키 출력 (디버그)
                if not debug_printed:
                    print(f"  [debug] {pid} 응답 keys: {list(detail.keys())[:15]}")
                    debug_printed = True
                img = extract_image(detail)
                price = extract_price(detail)
                changed = False
                if img and not p.get('image'):
                    p['image'] = img
                    changed = True
                if price and not p.get('lastPrice'):
                    p['lastPrice'] = price
                    changed = True
                if not p.get('currency'):
                    p['currency'] = 'USD'
                if changed:
                    updated += 1
                    print(f"  ✓ {pid} ({p.get('code', '-'):6}): "
                          f"image={'O' if p.get('image') else 'X'} "
                          f"price={p.get('lastPrice', '-')}")
                else:
                    print(f"  ⊘ {pid}: image={'O' if img else 'X'} "
                          f"price={'O' if price else 'X'} 추출 실패")
                time.sleep(0.4)
            except Exception as e:
                print(f"  ❌ {pid}: {e}")
        if updated > 0:
            d['count'] = len(products)
            f.write_bytes(json.dumps(d, ensure_ascii=False, indent=2)
                          .encode('utf-8'))
            print(f"\n  → {updated}개 업데이트, 저장 완료")
        else:
            print(f"\n  → 업데이트 없음 (응답 키 확인 필요)")
    print("\n완료.")


if __name__ == "__main__":
    main()
