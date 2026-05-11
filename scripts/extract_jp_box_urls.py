"""
extract_jp_box_urls.py — tcgcollector 일본 박스 URL 매핑 (v3)

이미 추출된 link list (_tcg-debug-all-links.txt) 의 slug 와
사용자 _pending JSON 의 영문명을 slug 형식으로 변환해서 직접 매칭.

slug 변환 규칙:
  "Silver Lance" → "silver-lance"
  "Magma vs Aqua: Two Ambitions" → "magma-vs-aqua-two-ambitions"
  "Pokémon Jungle" → "pokemon-jungle"
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PENDING = ROOT / "data" / "_pending-pokemon-boxes.json"
LINKS_FILE = ROOT / "data" / "_tcg-debug-all-links.txt"
OUTPUT = ROOT / "data" / "_tcgcollector-jp-box-urls.json"

# tcgcollector slug 가 우리 영문명과 다른 박스 — 수동 매핑
SLUG_OVERRIDES = {
    "S5a":  "matchless-fighters",                     # 사용자 "Matchless Fighter" (단수) → 실제 복수
    "SM1+": "sun-and-moon-enhanced-expansion-pack",  # 사용자 "Sun & Moon Plus"
    "ADV1": "adv-expansion-pack",                     # 사용자 "Expansion Pack (Ruby & Sapphire)"
    "CL1":  "expansion-pack",                         # 사용자 "Base Set / Expansion Pack"
}


def to_slug(name: str) -> str:
    """영문명 → tcgcollector slug 형식
    예: "Silver Lance" → "silver-lance"
        "Magma vs Aqua: Two Ambitions" → "magma-vs-aqua-two-ambitions"
        "Pokémon Jungle" → "pokemon-jungle"
    """
    s = name.lower()
    # 액센트 제거 (é → e)
    s = (s.replace("é", "e").replace("è", "e").replace("á", "a")
          .replace("à", "a").replace("í", "i").replace("ó", "o")
          .replace("ú", "u").replace("ñ", "n"))
    # 괄호 안 텍스트 제거 — "Expansion Pack (Ruby & Sapphire)" → "Expansion Pack"
    s = re.sub(r'\s*\([^)]*\)', '', s)
    # 특수문자 제거 (콜론, 쉼표, apostrophe, &, /, etc)
    s = re.sub(r"[:'\",&/+]", '', s)
    # 다중 공백/대시 → 단일 대시
    s = re.sub(r'[\s\-]+', '-', s).strip('-')
    return s


def main():
    # 1. link list 로드
    if not LINKS_FILE.exists():
        print(f"[ERROR] {LINKS_FILE} 없음 — 먼저 extract_jp_box_urls.py (selenium 버전) 한 번 실행하세요.")
        return
    all_links = LINKS_FILE.read_text(encoding="utf-8").strip().split("\n")
    print(f"[links] {len(all_links)}개 tcgcollector 일본 박스 link 로드")

    # link → {slug: (internal_id, full_path)} 인덱스
    slug_to_link = {}
    for link in all_links:
        m = re.match(r'/sets/(\d+)/([a-z0-9\-]+)', link)
        if m:
            iid, slug = m.groups()
            slug_to_link[slug] = (iid, link)

    print(f"[index] {len(slug_to_link)}개 slug 인덱스 생성")

    # 2. pending 박스 로드
    with PENDING.open(encoding="utf-8") as f:
        pending_boxes = json.load(f)["boxes"]
    print(f"[pending] {len(pending_boxes)}개 박스 매칭 시도\n")

    # 3. 매칭
    matched = {}
    unmatched = []
    for box in pending_boxes:
        code = box["code"]
        en = box.get("en_name", "").strip()

        # override 우선
        if code in SLUG_OVERRIDES:
            target_slug = SLUG_OVERRIDES[code]
        else:
            target_slug = to_slug(en)

        if target_slug in slug_to_link:
            iid, path = slug_to_link[target_slug]
            matched[code] = {
                "url": f"https://www.tcgcollector.com{path}",
                "internal_id": iid,
                "slug": target_slug,
                "name_en_pending": en,
                "kr_name": box.get("kr_name", ""),
                "card_count_pending": box.get("card_count", 0),
            }
        else:
            unmatched.append({
                "code": code,
                "en_name": en,
                "kr_name": box.get("kr_name", ""),
                "tried_slug": target_slug,
            })

    # 4. 저장
    with OUTPUT.open("w", encoding="utf-8") as f:
        json.dump({
            "matched_count": len(matched),
            "unmatched_count": len(unmatched),
            "matched": matched,
            "unmatched": unmatched,
        }, f, indent=2, ensure_ascii=False)

    # 5. 리포트
    print(f"{'='*70}")
    print(f"  매칭 성공: {len(matched)}개 / {len(pending_boxes)}개")
    print(f"  매칭 실패: {len(unmatched)}개")
    print(f"{'='*70}\n")

    if matched:
        print(f"=== 매칭 성공 박스 (slug 기반) ===")
        for code in [b["code"] for b in pending_boxes if b["code"] in matched]:
            info = matched[code]
            print(f"  {code:12s} → {info['slug']:45s} ({info['internal_id']})")

    if unmatched:
        print(f"\n=== 매칭 실패 ({len(unmatched)}개) — SLUG_OVERRIDES 에 추가 필요 ===")
        for u in unmatched:
            print(f"  {u['code']:12s} en='{u['en_name']}' tried_slug='{u['tried_slug']}'")

    print(f"\n[저장] {OUTPUT}")
    print(f"\n다음 단계: python scripts/add_old_boxes_to_pokemon_sets.py")


if __name__ == "__main__":
    main()
