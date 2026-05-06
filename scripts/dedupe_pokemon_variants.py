"""
dedupe_pokemon_variants.py — 포켓몬 박스 카드 variant 통합 (일판 base 만)

문제:
  tcgcollector 가 같은 카드 번호의 variant (Master Ball Mirror, Monster Ball Mirror 등) 를
  별도 카드로 카운트해서 카운트 부풀려짐 (예: SV2a 165 → 518장).

해결:
  같은 [세트코드 번호] (예: [SV2a 001/165]) 의 카드는 1장으로 통합.
  - base 우선 (": " 없는 카드, 예: "Bulbasaur C[SV2a 001/165]")
  - base 없으면 첫 variant
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIR = ROOT / "data" / "cards-by-set"

# 사용자가 알려준 정상 카운트 (검증용)
EXPECTED = {
    'SV5K': 100, 'SV4a': 360, 'SV4M': 95, 'SV4K': 95, 'SV3a': 92, 'SV3': 141,
    'SV2a': 210, 'SV2D': 99, 'SV2P': 99, 'SV1a': 103,
    'S12a': 262, 'S12': 125, 'S11a': 94, 'S11': 127, 'S10b': 101, 'S10a': 99,
    'S9a': 93, 'S9': 127, 'S8b': 293, 'S8': 129, 'S7R': 90, 'S7D': 90, 'S6a': 101,
}

NUM_RE = re.compile(r'\[(\w+)\s+(\d+)/\d+\]')


def is_base_card(name):
    """variant 가 아닌 base 카드인지 — '[' 앞 부분에 ':' 없으면 base"""
    head = name.split('[')[0] if '[' in name else name
    # ":" 가 head 에 있으면 variant (예: "Bulbasaur C: Master Ball Mirror[...")
    return ':' not in head


def dedupe(cards):
    """같은 [SET-NUM] 키로 통합. base 우선."""
    by_key = {}
    for c in cards:
        name = c.get('name', '')
        m = NUM_RE.search(name)
        if not m:
            # number 없는 카드 — 그냥 keep (희귀 케이스)
            by_key[name] = c
            continue
        key = f"{m.group(1).upper()}-{m.group(2)}"
        if key not in by_key:
            by_key[key] = c
        else:
            existing_name = by_key[key].get('name', '')
            # 현재 카드가 base 인데 기존이 variant 면 교체
            if is_base_card(name) and not is_base_card(existing_name):
                by_key[key] = c
    return list(by_key.values())


def process_set(code):
    p = DIR / f"{code}.json"
    if not p.exists():
        return None
    raw = p.read_bytes().rstrip(b'\x00').rstrip()
    try:
        d = json.loads(raw)
    except json.JSONDecodeError:
        # 깨진 JSON 복구
        last = raw.rfind(b'}')
        if last > 0:
            d = json.loads(raw[:last + 1] + b'\n  ]\n}')
        else:
            return None
    before = len(d.get('cards', []))
    deduped = dedupe(d.get('cards', []))
    after = len(deduped)
    d['cards'] = deduped
    d['cardCount'] = after
    # truncate 보장
    try: p.unlink()
    except Exception: pass
    p.write_bytes(json.dumps(d, ensure_ascii=False, indent=2).encode('utf-8'))
    return before, after


def main():
    args = sys.argv[1:]
    targets = args if args else list(EXPECTED.keys())

    print("=" * 60)
    print("포켓몬 박스 variant 통합 (같은 번호 = 1장)")
    print("=" * 60)
    print(f"{'CODE':<6} {'BEFORE':>7} {'AFTER':>6} {'EXP':>5} {'DIFF':>6}")
    print("-" * 50)

    total_before = total_after = 0
    for code in targets:
        result = process_set(code)
        if result is None:
            print(f"{code:<6} (JSON 없음)")
            continue
        before, after = result
        total_before += before
        total_after += after
        exp = EXPECTED.get(code, '?')
        diff = (after - exp) if isinstance(exp, int) else '?'
        diff_str = f"{diff:+d}" if isinstance(diff, int) else '?'
        match = '✓' if isinstance(diff, int) and diff == 0 else ('≈' if isinstance(diff, int) and abs(diff) <= 3 else '')
        print(f"{code:<6} {before:>7} {after:>6} {exp:>5} {diff_str:>6} {match}")
    print("-" * 50)
    print(f"{'TOTAL':<6} {total_before:>7} {total_after:>6}")


if __name__ == '__main__':
    main()
