"""
import_old_boxes.py — S6a 이전 포켓몬 박스 121개를 manual-boxes-pokemon.json 에 안전 append

규칙:
1. 기존 박스 (34개) 절대 건드리지 않음 — 동일 code 가 이미 있으면 SKIP
2. 새 박스는 manual-boxes-pokemon.json 의 products 배열 끝에 append
3. SNKRDUNK 등록 안 된 박스는 id="", url="", lastPrice=null 로 빈 값 처리
4. 시세 데이터 없는 박스는 legacy:true 플래그 (UI 에서 "거래량 없음" 안내 표시용)
5. 이미지 경로: /images/box/{CODE}.jpg (없으면 onerror 로 처리)
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PENDING = ROOT / "data" / "_pending-pokemon-boxes.json"
TARGET = ROOT / "data" / "manual-boxes-pokemon.json"

# 시세 데이터 가능 박스 (대략 — SNKRDUNK 거래량 있을 가능성 ↑)
# S 시리즈 + SM10 이후 = 시세 가능, 그 외 = legacy
MODERN_CODES_PREFIXES = ("S",)  # S1~S6, SM10~SM12 등 일부
def is_modern(code: str) -> bool:
    """시세 데이터 가능성 있는 박스 (2018년 이후)"""
    if code.startswith("S") and not code.startswith("SM") and not code.startswith("SV"):
        return True  # S1~S6
    if code.startswith("SM12") or code.startswith("SM11") or code.startswith("SM10"):
        return True  # SM10~SM12
    return False

def main():
    # 1. 기존 박스 로드
    with TARGET.open("r", encoding="utf-8") as f:
        current = json.load(f)
    existing_codes = {p["code"] for p in current["products"]}
    print(f"[기존] {len(existing_codes)}개 박스: {sorted(existing_codes)}")

    # 2. pending 박스 로드
    with PENDING.open("r", encoding="utf-8") as f:
        pending = json.load(f)
    new_boxes = pending["boxes"]
    print(f"[pending] {len(new_boxes)}개 박스 import 시도")

    # 3. 변환 + append (중복은 skip)
    added = []
    skipped = []
    for box in new_boxes:
        code = box["code"]
        if code in existing_codes:
            skipped.append(code)
            continue
        # manual-boxes-pokemon.json 의 기존 스키마 그대로 + 신규 필드 추가
        legacy = not is_modern(code)
        record = {
            "id": "",                                # SNKRDUNK product ID (미등록)
            "name": box.get("en_name", ""),          # 영문 박스 이름
            "code": code,
            "jp_name": box.get("jp_name", ""),
            "kr_name": box.get("kr_name", ""),       # 한글 박스 이름 (신규)
            "release_date": box.get("release_date", ""),
            "card_count": box.get("card_count", 0),
            "currency": "JPY",
            "url": "",                               # SNKRDUNK URL (미등록)
            "lastPrice": None,                       # 시세 (미수집)
            "image": f"/images/box/{code}.jpg",
            "legacy": legacy,                        # 시세 데이터 없는 옛날 박스 플래그
        }
        current["products"].append(record)
        added.append(code)

    # 4. count 업데이트 + 저장
    current["count"] = len(current["products"])
    with TARGET.open("w", encoding="utf-8") as f:
        json.dump(current, f, ensure_ascii=False, indent=2)

    print(f"\n[결과]")
    print(f"  추가: {len(added)}개")
    print(f"  중복 skip: {len(skipped)}개 — {skipped}")
    print(f"  최종 총 박스: {current['count']}개")
    print(f"\n[저장] {TARGET}")

if __name__ == "__main__":
    main()
