"""
fix_box_image_case.py — S 시리즈 박스 image 경로 소문자화
파일 시스템: s8b.webp, s9.webp (소문자)
manual-boxes: /images/box/S8b.webp (대문자) → 매칭 실패

S 시리즈 (S6a~S12a): 첫 글자 's' 소문자
SV 시리즈, 기타: 그대로 유지
"""
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANUAL_FILE = ROOT / "data" / "manual-boxes-pokemon.json"
BOX_DIR = ROOT / "images" / "box"


def fix_path(image_path):
    """
    /images/box/S8b.webp → /images/box/s8b.webp (S 시리즈만)
    /images/box/SV5K.webp → 그대로
    """
    if not image_path or "/images/box/" not in image_path:
        return image_path
    # 파일명만 추출
    m = re.match(r"^(.*)/images/box/(.+)$", image_path)
    if not m:
        return image_path
    prefix, fname = m.group(1), m.group(2)
    # S{숫자}로 시작하고 SV 가 아닌 경우 → 첫글자 소문자
    if re.match(r"^S\d", fname) and not fname.startswith("SV"):
        new_fname = fname[0].lower() + fname[1:]
        # 실제 파일 존재 확인
        actual = BOX_DIR / new_fname
        if actual.exists():
            return f"{prefix}/images/box/{new_fname}"
    return image_path


def main():
    with open(MANUAL_FILE, "r", encoding="utf-8") as fh:
        data = json.load(fh)

    fixed = 0
    for p in data.get("products", []):
        old = p.get("image", "")
        new = fix_path(old)
        if old != new:
            p["image"] = new
            fixed += 1
            print(f"  ✓ {p.get('code', '-'):6s} {old} → {new}")

    with open(MANUAL_FILE, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    print(f"\n✓ Done. {fixed}개 박스 image 경로 소문자화.")


if __name__ == "__main__":
    main()
