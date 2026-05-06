"""
auto_match_overrides.py — 이미지 hash 상대비교로 정확한 매칭 자동 생성

각 일판 공식 카드에 대해:
1. 같은 productNumber 의 SNKRDUNK 일판 카드들 (candidate) 모음
2. 우리 로컬 이미지 vs 각 candidate 이미지 hash 비교
3. 가장 가까운 (lowest hash distance) candidate 를 매칭으로 선택
4. 현재 자동 매칭 결과와 다르면 → onepiece-card-overrides.json 에 추가

SAMPLE 워터마크 영향은 모든 candidate 에 동일하게 적용되므로 상대 비교는 정확.

사용:
  python scripts/auto_match_overrides.py
  python scripts/auto_match_overrides.py --variants p2 p3   # 특정 variant 만

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
OVERRIDES = ROOT / "data" / "onepiece-card-overrides.json"
SNKRDUNK_CACHE = ROOT / "data" / "_snkrdunk_image_cache"
SNKRDUNK_CACHE.mkdir(parents=True, exist_ok=True)

OP_SETS = ['OP01','OP02','OP03','OP04','OP05','OP06','OP07','OP08','OP09','OP10',
           'OP11','OP12','OP13','OP14','OP15','EB01','EB02','EB03','EB04']

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def load_json(p):
    return json.loads(Path(p).read_bytes().rstrip(b'\x00').rstrip().decode('utf-8'))


def fetch_image_cached(snk_id: str, url: str):
    cache = SNKRDUNK_CACHE / f"{snk_id}.bin"
    if cache.exists() and cache.stat().st_size > 500:
        return cache.read_bytes()
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=15) as r:
        data = r.read()
    if len(data) > 500:
        cache.write_bytes(data)
    return data


def is_promo(name):
    return bool(re.search(r'Champion|Wanted|Aisa|Tournament|Prize|Flagship|Promotion\s*Card\s*Set',
                          name or '', re.I))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--variants', nargs='*', default=['p1', 'p2', 'p3'])
    parser.add_argument('--sets', nargs='*', help='검증할 세트 (기본: 전체 19세트)')
    parser.add_argument('--include-base', action='store_true', help='base 도 검증')
    args = parser.parse_args()

    variants = list(args.variants)
    if args.include_base:
        variants.append('')

    print("=" * 60)
    print(f"이미지 hash 자동 매칭 → onepiece-card-overrides.json 갱신")
    print(f"  variants: {variants}")
    print("=" * 60)

    allcards = load_json(ALL_CARDS)
    sn_cards = allcards.get('details') or allcards.get('cards') or []
    sn_by_pn = {}
    for c in sn_cards:
        pn = (c.get('productNumber') or '').upper()
        if pn:
            sn_by_pn.setdefault(pn, []).append(c)

    # 기존 overrides 로드
    overrides = {}
    if OVERRIDES.exists():
        try:
            existing = json.loads(OVERRIDES.read_text('utf-8'))
            overrides = {k: v for k, v in existing.items() if not k.startswith('_')}
        except Exception:
            overrides = {}

    targets = args.sets or OP_SETS

    new_count = 0
    same_count = 0
    skip_count = 0
    fail_count = 0
    total_to_check = 0

    # 1차: 카운트
    for code in targets:
        p = JSON_DIR / f"{code}.json"
        if not p.exists():
            continue
        d = load_json(p)
        for c in d.get('cards', []):
            full = c.get('fullId', '')
            v = full.split('_')[1].lower() if '_' in full else ''
            if v in variants:
                total_to_check += 1

    print(f"\n검증 대상: {total_to_check} 카드")

    processed = 0
    for code in targets:
        p = JSON_DIR / f"{code}.json"
        if not p.exists():
            continue
        d = load_json(p)
        cards = d.get('cards', [])
        target_cards = [c for c in cards
                        if (c.get('fullId','').split('_')[1].lower()
                            if '_' in c.get('fullId','') else '') in variants]
        if not target_cards:
            continue

        for c in target_cards:
            processed += 1
            full_id = c.get('fullId', '')
            local_img_path = IMG_DIR / f"{full_id}.png"
            if not local_img_path.exists():
                skip_count += 1
                continue

            card_set = c.get('setCode', code)
            base = c.get('baseNumber') or ''
            target_pn = f"{card_set.upper()}-{base}"

            # candidates: 일판 + non-promo
            candidates = sn_by_pn.get(target_pn, [])
            jp = [c2 for c2 in candidates if not re.search(r'\[(EN|CHN)\]', c2.get('name') or '')]
            pool = jp if jp else candidates
            main_pool = [c2 for c2 in pool if not is_promo(c2.get('name', ''))]
            pool = main_pool if main_pool else pool

            if len(pool) <= 1:
                # 후보 1개 이하 → 비교 의미 없음
                same_count += 1
                continue

            try:
                local_hash = imagehash.phash(Image.open(local_img_path))
            except Exception:
                fail_count += 1
                continue

            # 각 candidate 의 hash 계산
            best_card = None
            best_diff = 999
            for cand in pool:
                snk_url = cand.get('thumbnailUrl') or cand.get('imageUrl')
                if not snk_url:
                    continue
                snk_id = str(cand.get('id', ''))
                try:
                    data = fetch_image_cached(snk_id, snk_url)
                    cand_hash = imagehash.phash(Image.open(io.BytesIO(data)))
                    diff = local_hash - cand_hash
                    if diff < best_diff:
                        best_diff = diff
                        best_card = cand
                except Exception:
                    continue
                time.sleep(0.05)

            if not best_card:
                fail_count += 1
                continue

            # 우리의 자동 매칭 결과와 비교 (앞에서 priority 로 매칭한 결과)
            # 우리는 이미지 비교 결과를 무조건 trust → override 추가
            override_key = full_id.replace('_p1', '_P1').replace('_p2', '_P2').replace('_p3', '_P3')
            new_id = str(best_card.get('id'))

            if overrides.get(override_key) == new_id:
                same_count += 1
            else:
                overrides[override_key] = new_id
                new_count += 1
                if new_count <= 30:
                    print(f"  [{processed}/{total_to_check}] + {override_key} → {new_id} ({(best_card.get('name') or '')[:50]}) diff={best_diff}")

            if processed % 50 == 0:
                # 중간 저장
                OVERRIDES.write_text(
                    json.dumps(overrides, ensure_ascii=False, indent=2),
                    encoding='utf-8'
                )
                print(f"    ... 진행 {processed}/{total_to_check} (overrides 저장: {len(overrides)}개)")

    # 최종 저장
    OVERRIDES.write_text(
        json.dumps(overrides, ensure_ascii=False, indent=2),
        encoding='utf-8'
    )

    print(f"\n━━━ 완료 ━━━")
    print(f"  처리: {processed}")
    print(f"  override 추가: {new_count}")
    print(f"  변경 없음: {same_count}")
    print(f"  스킵 (이미지 없음 또는 단일 후보): {skip_count}")
    print(f"  실패: {fail_count}")
    print(f"\n  → {OVERRIDES.relative_to(ROOT)}: 총 {len(overrides)}개 override")
    print(f"  이제 사이트 다시 배포하면 매칭 정확도 향상.")


if __name__ == '__main__':
    main()
