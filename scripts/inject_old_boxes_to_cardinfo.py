"""
inject_old_boxes_to_cardinfo.py
— _pending-pokemon-boxes.json 의 121개 박스를
   index.html 의 CARDINFO.pokemon 배열 끝 (S6a 라인 다음) 에 자동 삽입

규칙:
1. 기존 박스 라인은 절대 안 건드림
2. S6a 라인을 anchor 로 찾아서 그 다음에 신규 박스 121줄 삽입
3. 신규 박스 형식: {code:"S6H", name:"백은의 랜스 (Silver Lance)", release:"2021.04.23", url:""}
4. 멱등 (이미 삽입됐으면 skip — S6H 코드 검색)
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PENDING = ROOT / "data" / "_pending-pokemon-boxes.json"
INDEX_HTML = ROOT / "index.html"

ANCHOR_LINE = '{code:"S6a", name:"이브이 히어로즈 (Eevee Heroes)", release:"2021.05.28"'
DUPLICATE_CHECK = 'code:"S6H"'  # 이미 삽입된 경우 멱등

def main():
    # 1. pending 박스 로드
    with PENDING.open("r", encoding="utf-8") as f:
        pending = json.load(f)
    boxes = pending["boxes"]
    print(f"[pending] {len(boxes)}개 박스 로드")

    # 2. index.html 읽기
    text = INDEX_HTML.read_text(encoding="utf-8")

    # 3. 멱등 체크
    if DUPLICATE_CHECK in text:
        print(f"[skip] '{DUPLICATE_CHECK}' 이미 존재 — 중복 삽입 방지")
        return

    # 4. anchor 라인 찾기
    if ANCHOR_LINE not in text:
        print(f"[ERROR] anchor 라인 못 찾음:\n  {ANCHOR_LINE}")
        return

    # 5. 신규 박스 라인 생성
    new_lines = []
    new_lines.append("    // ─── S6a 이전 박스 (S6H ~ Base Set 1996) — _pending-pokemon-boxes.json 에서 자동 생성 ───")
    for box in boxes:
        code = box["code"]
        kr = box.get("kr_name", "")
        en = box.get("en_name", "")
        release = box.get("release_date", "").replace("-", ".")
        # 이름 형식: "한글 (English)" — 영문 없으면 한글만
        name = f"{kr} ({en})" if en else kr
        # JS 객체 안 따옴표 escape — name 안에 " 없을 거지만 안전 위해
        name_esc = name.replace('"', '\\"')
        new_lines.append(f'    {{code:"{code}", name:"{name_esc}", release:"{release}", url:""}},')

    insertion = "\n".join(new_lines) + "\n"

    # 6. anchor 라인 다음에 삽입
    # 정확히는 S6a 의 줄 끝 (}, 다음 줄) 에 insertion 추가
    s6a_pattern = r'(\{code:"S6a"[^\n]+\},?\n)'
    m = re.search(s6a_pattern, text)
    if not m:
        print(f"[ERROR] S6a 라인 패턴 매칭 실패")
        return
    insert_pos = m.end()
    new_text = text[:insert_pos] + insertion + text[insert_pos:]

    # 7. 저장
    INDEX_HTML.write_text(new_text, encoding="utf-8")
    print(f"[저장] {INDEX_HTML}")
    print(f"[삽입] {len(boxes)}개 박스 → CARDINFO.pokemon 끝에 추가")
    print(f"[총 줄 변경] +{len(new_lines)}줄")

if __name__ == "__main__":
    main()
