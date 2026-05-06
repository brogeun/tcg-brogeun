"""
build_card_to_box.py — 카드 → 박스 reverse map 빌드

cards-by-set/*.json 의 모든 카드를 순회하면서
각 카드가 어떤 박스(들)에 들어있는지 매핑.

키: SNKRDUNK card ID (override 우선) 또는 productNumber+variant
값: [{"setCode": "OP15", "setName": "Adventure on KAMI's Island", "variant": "p1"}, ...]

출력: data/card-to-box.json

사용:
  python scripts/build_card_to_box.py
"""

import json
import re
from pathlib import Path
from collections import defaultdict

ROOT = Path(__file__).resolve().parent.parent
JSON_DIR = ROOT / "data" / "cards-by-set"
ALL_CARDS = ROOT / "data" / "all-cards.json"
OVERRIDES = ROOT / "data" / "onepiece-card-overrides.json"
OUT = ROOT / "data" / "card-to-box.json"


def load_json(p):
    return json.loads(Path(p).read_bytes().rstrip(b'\x00').rstrip().decode('utf-8'))


# 박스 한글 이름 (index.html CARDINFO 와 동일)
BOX_LABELS = {
    'OP01': 'OP-01 ROMANCE DAWN',
    'OP02': 'OP-02 頂上決戦',
    'OP03': 'OP-03 強大な敵',
    'OP04': 'OP-04 謀略の王国',
    'OP05': 'OP-05 新時代の主役',
    'OP06': 'OP-06 双璧の覇者',
    'OP07': 'OP-07 500年後の未来',
    'OP08': 'OP-08 二つの伝説',
    'OP09': 'OP-09 新たなる皇帝',
    'OP10': 'OP-10 王族の血統',
    'OP11': 'OP-11 神速の拳',
    'OP12': 'OP-12 師弟の絆',
    'OP13': 'OP-13 受け継がれる意志',
    'OP14': 'OP-14 蒼海の七傑',
    'OP15': 'OP-15 神の島の冒険',
    'EB01': 'EB-01 メモリアルコレクション',
    'EB02': 'EB-02 Anime 25th Collection',
    'EB03': 'EB-03 ONE PIECE Heroines edition',
    'EB04': 'EB-04 EGGHEAD CRISIS',
}


def main():
    print("=" * 60)
    print("카드 → 박스 reverse map 빌드")
    print("=" * 60)

    # SNKRDUNK ID 매핑 (productNumber+variant → snkrdunkId 추정)
    # variant 매칭 priority 와 image hash override 로 1차 매칭
    overrides = {}
    if OVERRIDES.exists():
        try:
            overrides = {k: v for k, v in load_json(OVERRIDES).items() if not k.startswith('_')}
        except Exception:
            pass

    allcards = load_json(ALL_CARDS)
    sn_cards = allcards.get('details') or allcards.get('cards') or []
    sn_by_pn = {}
    for c in sn_cards:
        pn = (c.get('productNumber') or '').upper()
        if pn:
            sn_by_pn.setdefault(pn, []).append(c)

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
        return bool(re.search(r'Champion|Wanted|Aisa|Tournament|Prize|Flagship|Promotion\s*Card\s*Set',
                              name or '', re.I))

    VPRIO = {
        '': ['base'],
        'p1': ['p', 'rp', 'premium', 'sp', 'spc', 'base'],
        'p2': ['sp', 'spc', 'rp', 'gsp', 'premium', 'p', 'base'],
        'p3': ['spc', 'gsp', 'premium', 'sp', 'rp', 'p', 'base'],
    }

    def find_match(card_set, base, variant):
        # override 우선
        v_upper = variant.upper() if variant else ''
        key = f"{card_set.upper()}-{base}_{v_upper}" if v_upper else f"{card_set.upper()}-{base}"
        if overrides.get(key):
            return overrides[key]

        target_pn = f"{card_set.upper()}-{base}"
        cands = sn_by_pn.get(target_pn, [])
        jp = [c for c in cands if not re.search(r'\[(EN|CHN)\]', c.get('name') or '')]
        pool = jp if jp else cands
        main_pool = [c for c in pool if not is_promo(c.get('name', ''))]
        pool = main_pool if main_pool else pool
        pool = sorted(pool, key=lambda c: int(c.get('id', 0)))

        priority = VPRIO.get(variant, ['base'])
        for target in priority:
            for c in pool:
                if classify(c.get('name', '')) == target:
                    return str(c.get('id'))
        return str(pool[0].get('id')) if pool else None

    # 각 box 의 카드 → SNKRDUNK ID 매핑 후 reverse
    card_to_box = defaultdict(list)
    total_cards = 0
    matched_cards = 0

    OP_SETS = list(BOX_LABELS.keys())

    for code in OP_SETS:
        p = JSON_DIR / f"{code}.json"
        if not p.exists():
            continue
        d = load_json(p)
        for c in d.get('cards', []):
            total_cards += 1
            full = c.get('fullId', '')
            card_set = c.get('setCode', code)
            # 박스 카드는 그 박스 코드와 같은 카드만 (재록 X)
            if card_set.upper() != code.upper():
                continue
            base = c.get('baseNumber') or ''
            variant = full.split('_')[1].lower() if '_' in full else ''

            snk_id = find_match(card_set, base, variant)
            if not snk_id:
                continue
            matched_cards += 1

            # box 정보 추가 (중복 제거)
            box_info = {
                'setCode': code,
                'setName': BOX_LABELS.get(code, code),
                'cardSetCode': card_set,
                'variant': variant or 'base',
                'cardName': c.get('name', ''),
                'cardImage': c.get('image', ''),
            }
            # 같은 박스 내 한 entry 만 (base + p1 이 같은 SNKRDUNK ID 매핑된 경우 base 유지)
            existing = card_to_box[snk_id]
            same_box = next((b for b in existing if b['setCode'] == code), None)
            if same_box:
                # base 가 우선 (base 가 들어와 있으면 유지, p1/p2 가 있으면 base 로 교체)
                if same_box['variant'] != 'base' and box_info['variant'] == 'base':
                    same_box.update(box_info)
                # 둘 다 variant 거나 둘 다 base 면 추가 안 함
                continue
            existing.append(box_info)

    # 정렬 + 출력
    output = {
        '_comment': '카드 → 박스 매핑. key=SNKRDUNK ID, value=[{setCode, setName, variant, ...}]',
        'cards': dict(card_to_box),
    }
    # truncate 보장 — 기존 파일 unlink 후 새로 작성
    if OUT.exists():
        try:
            OUT.unlink()
        except Exception:
            pass
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(json.dumps(output, ensure_ascii=False, indent=2))
        f.flush()
        try:
            import os
            os.fsync(f.fileno())
        except Exception:
            pass

    # 통계
    multi_box = [(k, v) for k, v in card_to_box.items() if len(v) > 1]
    print(f"\n  총 카드 (cards-by-set 안): {total_cards}")
    print(f"  SNKRDUNK ID 매칭: {matched_cards}")
    print(f"  유니크 SNKRDUNK ID: {len(card_to_box)}")
    print(f"  여러 박스에 등장: {len(multi_box)}")

    # 다른 박스에 같은 SNKRDUNK ID 매핑 — 진단용
    if multi_box:
        print(f"\n  ⚠ 진단 — 여러 박스 등장 케이스 5건 샘플:")
        for k, v in multi_box[:5]:
            print(f"    SNKRDUNK ID {k}:")
            for b in v:
                print(f"      {b['setCode']} ({b['variant']}) — {b.get('cardName','')[:25]}")
    print(f"\n  → {OUT.relative_to(ROOT)} 저장")


if __name__ == '__main__':
    main()
