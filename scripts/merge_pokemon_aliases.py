"""
merge_pokemon_aliases.py — 한글↔영어 (사용자) + 영어↔일본어 (PokéAPI) 체인 매칭

핵심 로직:
1. 사용자 리스트: 한글 ↔ 영어  (100% 정확, 사용자 작성)
2. PokéAPI:      영어 ↔ 일본어 (100% 정확, 공식 도감)
3. 매칭 키:       영어 (= 양쪽이 모두 공식 영문명 사용 → 100% 일치 보장)
4. 결과:          한글 → 영어 → 일본어 체인으로 1,025마리 전체 커버

사용법:
  python scripts/merge_pokemon_aliases.py            # 리포트만 (dry-run)
  python scripts/merge_pokemon_aliases.py merge      # search-aliases.json 에 병합

입력:
  - data/pokemon-names-ko.txt              (사용자 한글 리스트)
  - data/pokemon-names-pokeapi.json        (fetch_pokemon_names.py 결과)

출력:
  - data/pokemon-aliases-report.txt        (cross-check 리포트)
  - data/search-aliases.json               (병합 결과 — 'merge' 인자 시)
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
ALIASES_FILE = DATA_DIR / "search-aliases.json"
POKEAPI_FILE = DATA_DIR / "pokemon-names-pokeapi.json"
USER_FILE = DATA_DIR / "pokemon-names-ko.txt"
REPORT_FILE = DATA_DIR / "pokemon-aliases-report.txt"


def load_user_list(path):
    """사용자 리스트 — 'English - Korean' 형태
    구분자는 반드시 공백+하이픈+공백 (Ho-Oh, Wo-Chien 등 영문 내 하이픈 보존)
    """
    text = path.read_text(encoding="utf-8")
    pairs = []
    # 알려진 사용자 리스트 영문 오타 자동 보정
    typos = {
        "Spathindra": "Espathra",  # E 빠진 오타
    }
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        # ' - ' 우선, 없으면 ' — ', 없으면 ' = '
        m = re.match(r"^(.+?)\s+[-—=]\s+(.+)$", line)
        if not m:
            continue
        en, ko = m.group(1).strip(), m.group(2).strip()
        if en in typos:
            print(f"  ⚠ 오타 보정: '{en}' → '{typos[en]}'")
            en = typos[en]
        pairs.append((en, ko))
    return pairs


def normalize_en(s):
    """영문 정규화 — 케이스/공백/특수문자 무시 (Mr. Mime ↔ mrmime)"""
    return re.sub(r"[^\w]", "", s.lower())


def main():
    if not USER_FILE.exists():
        print(f"⚠ {USER_FILE} 없음")
        return
    if not POKEAPI_FILE.exists():
        print(f"⚠ {POKEAPI_FILE} 없음 — 먼저 실행: python scripts/fetch_pokemon_names.py")
        return

    user_pairs = load_user_list(USER_FILE)
    pokeapi = json.loads(POKEAPI_FILE.read_text("utf-8"))
    api_by_en = {normalize_en(p["en"]): p for p in pokeapi if p.get("en")}

    print(f"=" * 60)
    print(f"체인 매칭: 한글 → 영어 → 일본어")
    print(f"=" * 60)
    print(f"사용자 리스트: {len(user_pairs):,} 항목")
    print(f"PokéAPI: {len(pokeapi):,} 항목")
    print(f"")

    matched = []        # 영어 매칭 성공 → 한글-일본어 체인 완성
    no_match = []       # 영어로도 PokéAPI 에서 못 찾음 (희소)
    extra_api = []      # PokéAPI 에만 있는 항목

    user_keys = set()
    for en, ko in user_pairs:
        key = normalize_en(en)
        user_keys.add(key)
        info = api_by_en.get(key)
        if not info:
            no_match.append({"en": en, "ko": ko})
            continue
        ja = info.get("ja") or ""
        api_ko = info.get("ko") or ""
        matched.append({
            "en": en,
            "ko": ko,
            "ja": ja,
            "api_ko": api_ko,
            "ko_match": ko == api_ko,  # 참고용 — 안 맞아도 OK
        })

    for p in pokeapi:
        if p.get("en") and normalize_en(p["en"]) not in user_keys:
            extra_api.append(p)

    # 한글이 PokéAPI 와 다른 케이스 (단순 참고용)
    ko_mismatch = [m for m in matched if not m["ko_match"]]

    # ─── 리포트 ───
    lines = []
    lines.append(f"=" * 60)
    lines.append(f"포켓몬 이름 체인 매칭 리포트")
    lines.append(f"=" * 60)
    lines.append(f"")
    lines.append(f"✅ 영어 매칭 성공 (한글→영어→일본어 체인 완성): {len(matched):,}")
    lines.append(f"   ├─ 한글도 PokéAPI 와 일치: {len(matched) - len(ko_mismatch):,}")
    lines.append(f"   └─ 한글이 다름 (사용자 한글 우선 사용): {len(ko_mismatch):,}")
    lines.append(f"❓ 영어 매칭 실패 (PokéAPI 에 없음): {len(no_match)}")
    lines.append(f"🔍 PokéAPI 에만 있는 항목: {len(extra_api)}")
    lines.append(f"")
    lines.append(f"📊 최종 커버리지: {len(matched)}/{len(user_pairs)} = "
                 f"{len(matched)/len(user_pairs)*100:.1f}%")
    lines.append(f"")

    if ko_mismatch:
        lines.append(f"=" * 60)
        lines.append(f"📝 한글 표기 차이 ({len(ko_mismatch)}개) — 사용자 한글 우선 사용")
        lines.append(f"=" * 60)
        lines.append(f"  {'영문':<22} {'PokéAPI':<14} {'사용자':<14} 일본어")
        for m in ko_mismatch[:30]:
            lines.append(f"  {m['en']:<22} {m['api_ko']:<14} {m['ko']:<14} {m['ja']}")
        if len(ko_mismatch) > 30:
            lines.append(f"  ... +{len(ko_mismatch)-30}개")
        lines.append(f"")

    if no_match:
        lines.append(f"=" * 60)
        lines.append(f"❓ 영어 매칭 실패 ({len(no_match)}개) — PokéAPI 에 없는 영문")
        lines.append(f"=" * 60)
        for m in no_match:
            lines.append(f"  {m['en']:<22} - {m['ko']}")
        lines.append(f"")

    if extra_api:
        lines.append(f"=" * 60)
        lines.append(f"🔍 PokéAPI 에만 있는 ({len(extra_api)}개)")
        lines.append(f"=" * 60)
        for p in extra_api[:20]:
            lines.append(f"  #{p.get('id'):>4}  {p.get('en'):<22} "
                         f"{p.get('ko', '?'):<14} {p.get('ja', '?')}")
        if len(extra_api) > 20:
            lines.append(f"  ... +{len(extra_api)-20}개")
        lines.append(f"")

    REPORT_FILE.write_text("\n".join(lines), encoding="utf-8")
    print("\n".join(lines))
    print(f"\n📄 리포트 저장: {REPORT_FILE}")
    print(f"")

    # ─── 병합 모드 ───
    if "merge" not in sys.argv:
        print(f"➡ 다음 단계 — search-aliases.json 에 병합:")
        print(f"   python scripts/merge_pokemon_aliases.py merge")
        print(f"")
        return

    # 기존 aliases 백업 + 로드
    existing = {}
    if ALIASES_FILE.exists():
        try:
            existing = json.loads(ALIASES_FILE.read_text("utf-8"))
            bak = ALIASES_FILE.with_suffix(".json.bak")
            bak.write_text(json.dumps(existing, ensure_ascii=False, indent=2),
                          encoding="utf-8")
            print(f"💾 기존 aliases 백업: {bak.name}")
        except Exception:
            existing = {}

    # 신규 alias 추가 — 한글 → 일본어 (1순위) + 영어 → 일본어 (2순위)
    added = 0
    overwrote = 0
    for m in matched:
        ko, en, ja = m["ko"], m["en"], m["ja"]
        if not ja:
            continue
        # 한글 → 일본어
        if ko:
            if ko not in existing:
                added += 1
            else:
                overwrote += 1
            existing[ko] = ja
        # 영어 (소문자) → 일본어
        en_lo = en.lower()
        if en_lo and en_lo != ja.lower():
            if en_lo not in existing:
                added += 1
            existing[en_lo] = ja
        # PokéAPI 의 한글도 alias 로 추가 (사용자 한글과 다를 때)
        api_ko = m.get("api_ko")
        if api_ko and api_ko != ko and api_ko not in existing:
            existing[api_ko] = ja
            added += 1

    # 알파벳 순 정렬해서 저장
    sorted_existing = dict(sorted(existing.items()))
    ALIASES_FILE.write_text(
        json.dumps(sorted_existing, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )
    print(f"✓ 병합 완료")
    print(f"  신규 추가: +{added}")
    print(f"  업데이트: {overwrote}")
    print(f"  총 alias: {len(sorted_existing):,}")
    print(f"  파일: {ALIASES_FILE}")


if __name__ == "__main__":
    main()
