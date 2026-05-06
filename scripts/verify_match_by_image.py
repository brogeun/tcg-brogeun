"""
verify_match_by_image.py — 카드 매칭 자동 검증 (이미지 hash 비교)

각 일판 공식 카드의 로컬 이미지 (images/onepiece/) 와
자동 매칭된 SNKRDUNK 카드의 thumbnailUrl 을 fetch → perceptual hash 비교.
다르면 mismatch 의심 → suspicious.json 에 리스트.

사용:
  python scripts/verify_match_by_image.py
  python scripts/verify_match_by_image.py --variants p1 p2 p3   # variant 만 (base 제외, 빠름)

요구:
  pip install imagehash pillow
"""

import argparse
import io
import json
import re
import sys
import time
import urllib.request
from pathlib import Path
from collections import defaultdict

try:
    from PIL import Image
    import imagehash
except ImportError:
    print("❌ pip install imagehash pillow 필요")
    sys.exit(1)

ROOT = Path(__file__).resolve().parent.parent
JSON_DIR = ROOT / "data" / "cards-by-set"
IMG_DIR = ROOT / "images" / "onepiece"
ALL_CARDS = ROOT / "data" / "all-cards.json"

OP_SETS = ['OP01','OP02','OP03','OP04','OP05','OP06','OP07','OP08','OP09','OP10',
           'OP11','OP12','OP13','OP14','OP15','EB01','EB02','EB03','EB04']

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

HASH_THRESHOLD = 14  # hamming distance — 14 이상이면 다른 카드


def load_json(p):
    return json.loads(Path(p).read_bytes().rstrip(b'\x00').rstrip().decode('utf-8'))


def fetch_image(url, timeout=15):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def classify(name):
    n = name or ''
    if re.search(r'-SPC[\s\[\(]', n): return 'spc'
    if re.search(r'-SP[\s\(]|\(Comic\s+Parallel\)', n, re.I): return 'sp'
    if re.search(r'-GSP[\s\[\(]', n): return 'gsp'
    if re.search(r'-RP[\s\[\(]', n): return 'rp'
    if re.search(r'Premium\s*Card\s*Collection|25th\s*Anniversary|Memorial\s*Collection', n, re.I): return 'premium'
    if re.search(r'-P[\s\[\(]|\sParallel\s*\[', n, re.I): return 'p'
    return 'base'


def is_promo(name):
    return bool(re.search(r'Champion|Wanted|Aisa|Tournament|Prize|Flagship|Promotion\s*Card\s*Set', name or '', re.I))


VPRIO = {
    '':   ['base'],
    'p1': ['p', 'rp', 'premium', 'sp', 'spc', 'base'],
    'p2': ['sp', 'spc', 'rp', 'gsp', 'premium', 'p', 'base'],
    'p3': ['spc', 'gsp', 'premium', 'sp', 'rp', 'p', 'base'],
}


def find_match(card_set, base, variant, sn_by_pn):
    target_pn = f"{card_set.upper()}-{base}"
    cands = sn_by_pn.get(target_pn, [])
    jp = [c2 for c2 in cands if not re.search(r'\[(EN|CHN)\]', c2.get('name') or '')]
    pool = jp if jp else cands
    main = [c2 for c2 in pool if not is_promo(c2.get('name', ''))]
    pool = main if main else pool
    pool = sorted(pool, key=lambda c2: int(c2.get('id', 0)))

    priority = VPRIO.get(variant, ['base'])
    for target in priority:
        for c2 in pool:
            if classify(c2.get('name', '')) == target:
                return c2
    return pool[0] if pool else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--variants', nargs='*', default=['p1', 'p2', 'p3'],
                        help='검증할 variant (기본: p1 p2 p3, base 는 제외)')
    parser.add_argument('--sets', nargs='*', help='검증할 세트 (기본: 전체 19세트)')
    parser.add_argument('--threshold', type=int, default=HASH_THRESHOLD)
    args = parser.parse_args()

    print("=" * 60)
    print(f"카드 매칭 이미지 검증 — variants={args.variants}")
    print(f"  threshold={args.threshold} (이상 차이 → 의심)")
    print("=" * 60)

    allcards = load_json(ALL_CARDS)
    sn_cards = allcards.get('details') or allcards.get('cards') or []
    sn_by_pn = {}
    for c in sn_cards:
        pn = (c.get('productNumber') or '').upper()
        if pn:
            sn_by_pn.setdefault(pn, []).append(c)
    sn_by_id = {str(c.get('id', '')): c for c in sn_cards}

    targets = args.sets or OP_SETS

    suspicious = []
    ok = 0
    skip = 0
    fail = 0

    for code in targets:
        p = JSON_DIR / f"{code}.json"
        if not p.exists():
            continue
        d = load_json(p)
        cards = d.get('cards', [])
        target_cards = []
        for c in cards:
            full = c.get('fullId', '')
            variant = full.split('_')[1].lower() if '_' in full else ''
            if variant not in args.variants:
                continue
            target_cards.append(c)

        if not target_cards:
            continue

        print(f"\n  {code}: {len(target_cards)} 카드 검증")

        for c in target_cards:
            full_id = c.get('fullId', '')
            local_img = IMG_DIR / f"{full_id}.png"
            if not local_img.exists():
                skip += 1
                continue

            card_set = c.get('setCode', code)
            base = c.get('baseNumber') or ''
            variant = full_id.split('_')[1].lower() if '_' in full_id else ''

            match = find_match(card_set, base, variant, sn_by_pn)
            if not match:
                continue

            snk_url = match.get('thumbnailUrl') or match.get('imageUrl')
            if not snk_url:
                fail += 1
                continue

            try:
                local_hash = imagehash.phash(Image.open(local_img))
                data = fetch_image(snk_url, timeout=10)
                snk_hash = imagehash.phash(Image.open(io.BytesIO(data)))
                diff = local_hash - snk_hash
                if diff > args.threshold:
                    suspicious.append({
                        'fullId': full_id,
                        'name': c.get('name', '')[:30],
                        'matchedId': str(match.get('id')),
                        'matchedName': (match.get('name') or '')[:80],
                        'hashDiff': int(diff),
                        'snkrdunkUrl': f"https://snkrdunk.com/products/{match.get('id')}",
                    })
                    print(f"    ⚠ {full_id}: diff={diff}  → {(match.get('name') or '')[:50]}")
                else:
                    ok += 1
            except Exception as e:
                fail += 1
            time.sleep(0.1)  # rate limit

    print(f"\n━━━ 완료 ━━━")
    print(f"  매칭 OK: {ok}")
    print(f"  의심 (mismatch): {len(suspicious)}")
    print(f"  스킵 (이미지 없음): {skip}")
    print(f"  fetch 실패: {fail}")

    out = ROOT / "data" / "_suspicious_matches.json"
    out.write_text(json.dumps(suspicious, ensure_ascii=False, indent=2), encoding='utf-8')
    print(f"\n→ {out.relative_to(ROOT)} 저장 ({len(suspicious)}건)")
    print(f"  사용자가 이 리스트만 확인하면 됨. 잘못된 매칭은 onepiece-card-overrides.json 에 추가.")


if __name__ == '__main__':
    main()
