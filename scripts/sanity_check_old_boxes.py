"""
sanity_check_old_boxes.py — 121개 옛 박스가 fetch 실행 전에
오류 없이 다 가져올 수 있는 상태인지 사전 검증.

체크 항목:
  ① URL의 internal_id 가 _tcg-debug-all-links.txt (tcgcollector master) 에 있는지
  ② URL slug 가 _pending 의 영문명과 모순되는 박스가 있는지
  ③ internal_id 가 기존 42개 박스(S6a 이후)와 중복되는지
  ④ URL 끝에 / 빠지거나 query 잘못 붙은 박스
  ⑤ cards-by-set/{code}.json 의 source 분포 (어떤 박스가 selenium 한 번도 안 돌았는지)
  ⑥ 코드에 '/' 같은 파일명 위험 문자 있는지
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PENDING = ROOT / "data" / "_pending-pokemon-boxes.json"
LINKS = ROOT / "data" / "_tcg-debug-all-links.txt"
CARDS_DIR = ROOT / "data" / "cards-by-set"
FETCH_SCRIPT = ROOT / "scripts" / "fetch_set_cards.py"


def parse_pokemon_sets():
    """fetch_set_cards.py 의 POKEMON_SETS 파싱"""
    text = FETCH_SCRIPT.read_text(encoding="utf-8")
    block = re.search(r"POKEMON_SETS\s*=\s*\[(.*?)^\]", text, re.DOTALL | re.MULTILINE)
    sets = []
    for m in re.finditer(r'\(\s*"([^"]+)"\s*,\s*"([^"]+)"\s*,\s*"([^"]+)"\s*\)',
                         block.group(1)):
        sets.append((m.group(1), m.group(2), m.group(3)))
    return sets


def main():
    print("=" * 75)
    print("  121 옛 박스 fetch 사전 sanity check")
    print("=" * 75)

    pending = json.loads(PENDING.read_text(encoding="utf-8"))["boxes"]
    pending_codes = {b["code"] for b in pending}
    pending_map = {b["code"]: b for b in pending}
    print(f"\n[input] _pending 박스: {len(pending)}개")

    sets = parse_pokemon_sets()
    print(f"[input] POKEMON_SETS 박스: {len(sets)}개")

    # 옛 박스만 골라내기 (= _pending 에 있는 코드)
    old_sets = [(c, n, u) for (c, n, u) in sets if c in pending_codes]
    print(f"[input] 121 옛 박스 (교집합): {len(old_sets)}개")
    if len(old_sets) != 121:
        print(f"  ⚠ 121 아님 — POKEMON_SETS 에 빠진 박스 있을 수 있음")

    # tcgcollector master list (selenium 추출 결과)
    links = LINKS.read_text(encoding="utf-8").strip().split("\n")
    master_ids = set()
    master_slugs = {}  # id -> slug
    for link in links:
        m = re.match(r'/sets/(\d+)/([a-z0-9\-]+)', link)
        if m:
            iid, slug = m.groups()
            master_ids.add(iid)
            master_slugs[iid] = slug
    print(f"[input] tcgcollector master link: {len(master_ids)}개\n")

    issues = []

    # ── 체크 ① URL internal_id 가 master 에 있는지
    print("[check ①] URL internal_id 가 master link 에 있는지")
    missing = []
    for code, name, url in old_sets:
        m = re.match(r'https://www\.tcgcollector\.com/sets/(\d+)/([a-z0-9\-]+)', url)
        if not m:
            issues.append(f"{code}: URL 형식 오류 - {url}")
            continue
        iid, slug = m.groups()
        if iid not in master_ids:
            missing.append((code, iid, slug, url))
    if missing:
        for code, iid, slug, url in missing:
            print(f"  ❌ {code:10s} id={iid:6s} slug={slug:35s} ← master 에 없음!")
        issues.extend(f"{c}: master 에 없는 id={i}" for c, i, _, _ in missing)
    else:
        print(f"  ✓ 121개 전부 master 에 존재")

    # ── 체크 ② slug 가 master 와 다른 박스 (URL 의 slug != master 의 slug)
    print(f"\n[check ②] URL slug 가 master slug 와 일치하는지")
    slug_mismatch = []
    for code, name, url in old_sets:
        m = re.match(r'https://www\.tcgcollector\.com/sets/(\d+)/([a-z0-9\-]+)', url)
        if not m: continue
        iid, our_slug = m.groups()
        master_slug = master_slugs.get(iid)
        if master_slug and master_slug != our_slug:
            slug_mismatch.append((code, iid, our_slug, master_slug))
    if slug_mismatch:
        for code, iid, ours, master in slug_mismatch:
            print(f"  ❌ {code:10s} our={ours:35s} master={master}")
        issues.extend(f"{c}: slug 불일치" for c, _, _, _ in slug_mismatch)
    else:
        print(f"  ✓ slug 전부 master 와 일치")

    # ── 체크 ③ internal_id 가 기존 박스와 중복되는지
    print(f"\n[check ③] internal_id 중복 (기존 42개 박스와 충돌)")
    new_sets = [(c, n, u) for (c, n, u) in sets if c not in pending_codes]
    new_ids = {}
    for c, n, u in new_sets:
        m = re.match(r'.*/sets/(\d+)/', u)
        if m: new_ids[m.group(1)] = c
    old_ids = {}
    for c, n, u in old_sets:
        m = re.match(r'.*/sets/(\d+)/', u)
        if m: old_ids[m.group(1)] = c
    overlaps = set(new_ids) & set(old_ids)
    if overlaps:
        for iid in overlaps:
            print(f"  ❌ id={iid}: 신규={new_ids[iid]} ↔ 옛={old_ids[iid]}")
        issues.extend(f"id 충돌 {i}" for i in overlaps)
    else:
        print(f"  ✓ id 충돌 없음")

    # ── 체크 ④ 옛 박스 121개 안에서도 id 중복 (DP4 split 같은 케이스)
    print(f"\n[check ④] 옛 박스 121개 내부 id 중복 (split 매칭 오류 의심)")
    from collections import Counter
    id_count = Counter()
    id_to_codes = {}
    for code, _, url in old_sets:
        m = re.match(r'.*/sets/(\d+)/', url)
        if m:
            iid = m.group(1)
            id_count[iid] += 1
            id_to_codes.setdefault(iid, []).append(code)
    dup = [(iid, cnt) for iid, cnt in id_count.items() if cnt > 1]
    if dup:
        for iid, cnt in dup:
            codes = id_to_codes[iid]
            print(f"  ⚠ id={iid} 중복 {cnt}회 — codes: {codes}")
        issues.extend(f"id={i} 중복" for i, _ in dup)
    else:
        print(f"  ✓ 옛 박스끼리 id 중복 없음")

    # ── 체크 ⑤ cards-by-set 현재 상태 (selenium 안 돈 박스 식별)
    print(f"\n[check ⑤] 현재 cards-by-set/{{code}}.json 의 source 분포")
    src_count = Counter()
    legacy_data_codes = []  # selenium 안 돈 박스
    for code, _, _ in old_sets:
        safe = code.replace("/", "-")
        p = CARDS_DIR / f"{safe}.json"
        if not p.exists():
            src_count["NO_FILE"] += 1
            legacy_data_codes.append(code)
            continue
        d = json.loads(p.read_text(encoding="utf-8"))
        src = d.get("source") or "None"
        src_count[src] += 1
        if src != "tcgcollector.com":
            legacy_data_codes.append(code)
    for src, cnt in src_count.most_common():
        print(f"  {src or '(없음)':25s}: {cnt}")
    print(f"  → selenium 재fetch 필요 박스: {len(legacy_data_codes)}개")

    # ── 체크 ⑥ 파일명 안전성 (코드에 / 들어가나)
    print(f"\n[check ⑥] 코드 안전성 (파일명 위험문자)")
    bad = [c for c, _, _ in old_sets if any(x in c for x in ['/', '\\', '*', '?'])]
    if bad:
        for c in bad:
            print(f"  ⚠ {c} - 파일명 위험")
        issues.extend(f"{c}: 코드에 위험문자" for c in bad)
    else:
        print(f"  ✓ 코드 안전")

    # ── 체크 ⑦ _pending 의 expected card_count vs URL의 slug 정합성 spot
    print(f"\n[check ⑦] split 박스 expected 합 검증")
    splits = {
        "DP4": ["DP4-Bd", "DP4-Bm"],
        "BW1": ["BW1-Bb", "BW1-Bw"],
        "BW3": ["BW3-Bh", "BW3-Bp"],
        "BW5": ["BW5-Brn", "BW5-Brz"],
        "BW6": ["BW6-Bc", "BW6-Bf"],
        "BW8": ["BW8-Brf", "BW8-Brn"],
        "XY1": ["XY1-Bx", "XY1-By"],
        "XY5": ["XY5-Bg", "XY5-Bt"],
        "XY8": ["XY8-Bb", "XY8-Br"],
        "XY11": ["XY11-Bb", "XY11-Br"],
        "L1":  ["L1-Bhg", "L1-Bss"],
    }
    for parent, codes in splits.items():
        rows = []
        for c in codes:
            b = pending_map.get(c)
            if not b:
                rows.append(f"{c}=??")
                continue
            cc = b.get("card_count", 0)
            rows.append(f"{c}={cc}")
        # tcgcollector 의 split URL 의 internal_id 추출
        ids_for_codes = []
        for c in codes:
            for sc, _, su in old_sets:
                if sc == c:
                    m = re.match(r'.*/sets/(\d+)/', su)
                    if m: ids_for_codes.append((c, m.group(1)))
        if len(set(i for _, i in ids_for_codes)) == 1:
            note = "  ⚠ 같은 internal_id → split 매칭 의심"
        else:
            note = ""
        print(f"  {parent}: {', '.join(rows)}{note}")

    # ── 결과
    print(f"\n{'='*75}")
    if issues:
        print(f"  ❌ 발견된 이슈: {len(issues)}개")
        for i in issues:
            print(f"    - {i}")
        print(f"\n  ⚠ fetch 전 위 이슈 해결 필요")
    else:
        print(f"  ✓ 모든 sanity 체크 통과 — 안전하게 selenium 재fetch 가능")
    print(f"{'='*75}")

    # 재fetch 필요 코드 파일로 저장
    out = ROOT / "data" / "_old-boxes-need-refetch.json"
    out.write_text(json.dumps(legacy_data_codes, ensure_ascii=False, indent=2),
                   encoding="utf-8")
    print(f"\n[저장] {out.relative_to(ROOT)} — selenium 재fetch 대상 {len(legacy_data_codes)}개")


if __name__ == "__main__":
    main()
