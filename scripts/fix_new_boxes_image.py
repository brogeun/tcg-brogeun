"""
fix_new_boxes_image.py — 신규 5박스의 image 필드를 로컬 경로로 변경
SNKRDUNK CDN URL → /images/sets/{code}.jpg
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANUAL_FILE = ROOT / "data" / "manual-boxes-pokemon.json"

# id → 로컬 이미지 경로
IMAGE_MAP = {
    "743533": "/images/sets/M3.jpg",
    "628148": "/images/sets/M1S.jpg",
    "518728": "/images/sets/SV9a.jpg",
    "283206": "/images/sets/SV7.jpg",
    "127743": "/images/sets/SV3.jpg",
}


def main():
    with open(MANUAL_FILE, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    fixed = 0
    for p in data.get("products", []):
        bid = p.get("id")
        if bid in IMAGE_MAP:
            old = p.get("image", "")
            new = IMAGE_MAP[bid]
            p["image"] = new
            fixed += 1
            print(f"  ✓ {bid} ({p.get('code')}) — {old[:50]}... → {new}")
    with open(MANUAL_FILE, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)
    print(f"\n✓ Done. {fixed}개 박스 image 경로 수정 완료.")


if __name__ == "__main__":
    main()
