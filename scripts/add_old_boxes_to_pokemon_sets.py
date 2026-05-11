"""
add_old_boxes_to_pokemon_sets.py — extract_jp_box_urls.py 결과를
fetch_set_cards.py 의 POKEMON_SETS 리스트에 자동 추가

규칙:
1. 기존 POKEMON_SETS 절대 안 건드림 (S6a 라인 다음에 append)
2. 멱등 — 이미 추가된 박스는 skip
3. 매칭 안된 박스는 skip + 경고 출력

사용:
  python scripts/add_old_boxes_to_pokemon_sets.py
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "data" / "_tcgcollector-jp-box-urls.json"
TARGET = ROOT / "scripts" / "fetch_set_cards.py"

ANCHOR_LINE = '("S6a", "이브이 히어로즈", "https://www.tcgcollector.com/sets/11424/eevee-heroes"),'
DUPLICATE_CHECK = '("S6H",'


def main():
    if not SOURCE.exists():
        print(f"[ERROR] {SOURCE} 없음. 먼저 extract_jp_box_urls.py 실행하세요.")
        return

    # 1. 매칭 결과 로드
    with SOURCE.open(encoding="utf-8") as f:
        data = json.load(f)
    matched = data["matched"]
    print(f"[source] 매칭 박스 {len(matched)}개")

    # 2. fetch_set_cards.py 읽기
    text = TARGET.read_text(encoding="utf-8")

    # 3. 멱등 체크
    if DUPLICATE_CHECK in text:
        print(f"[skip] '{DUPLICATE_CHECK}' 이미 존재 — 중복 삽입 방지")
        return

    # 4. anchor 라인 검증
    if ANCHOR_LINE not in text:
        print(f"[ERROR] anchor 라인 못 찾음:\n  {ANCHOR_LINE}")
        return

    # 5. 신규 라인 생성 (사용자 매핑 시간순 — _pending JSON 순서대로)
    pending = json.load(open(ROOT / "data" / "_pending-pokemon-boxes.json", encoding="utf-8"))["boxes"]

    new_lines = ["    # ─── S6a 이전 옛날 박스 (S6H ~ Base Set 1996) — extract_jp_box_urls.py 자동 생성 ───"]
    for box in pending:
        code = box["code"]
        if code not in matched:
            continue  # 미매칭 박스 skip
        info = matched[code]
        kr = box.get("kr_name", "").replace('"', '\\"')
        url = info["url"]
        new_lines.append(f'    ("{code}", "{kr}", "{url}"),')

    if len(new_lines) == 1:
        print("[ERROR] 추가할 박스 없음")
        return

    insertion = "\n".join(new_lines) + "\n"

    # 6. anchor 다음에 삽입
    pattern = re.compile(re.escape(ANCHOR_LINE) + r'\s*\n')
    m = pattern.search(text)
    if not m:
        print(f"[ERROR] anchor 패턴 매칭 실패")
        return
    insert_pos = m.end()
    new_text = text[:insert_pos] + insertion + text[insert_pos:]

    # 7. 저장
    TARGET.write_text(new_text, encoding="utf-8")
    added_count = len(new_lines) - 1
    print(f"\n[저장] {TARGET}")
    print(f"[추가] {added_count}개 박스 → POKEMON_SETS 끝에 append")


if __name__ == "__main__":
    main()
