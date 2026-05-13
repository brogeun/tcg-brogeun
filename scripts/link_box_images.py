"""
link_box_images.py — images/box2/*.webp 를 121 옛 박스에 연결

1. images/box2/*.webp 파일과 _pending 121 박스 code 매칭
2. 매칭 성공 박스의 manual-boxes-pokemon.json 의 image 경로를 /images/box2/{code}.webp 로 변경
3. 매칭 실패 박스 (파일 없음) 리포트
4. 폴더에 있지만 박스 list 에 없는 잉여 파일 리포트
"""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PENDING = ROOT / "data" / "_pending-pokemon-boxes.json"
MANUAL = ROOT / "data" / "manual-boxes-pokemon.json"
BOX2 = ROOT / "images" / "box2"


def atomic_write(path: Path, content: str):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    json.loads(tmp.read_text(encoding="utf-8"))
    os.replace(tmp, path)


def main():
    pending = json.loads(PENDING.read_text(encoding="utf-8"))
    legacy_codes = {b["code"] for b in pending["boxes"]}
    print(f"_pending 121 옛 박스: {len(legacy_codes)}개")

    # images/box2 파일 list
    files = sorted(BOX2.glob("*.*"))
    file_codes = {p.stem: p.name for p in files}
    print(f"images/box2 파일: {len(file_codes)}개\n")

    # 매칭
    matched = legacy_codes & set(file_codes)
    missing = sorted(legacy_codes - set(file_codes))
    extra = sorted(set(file_codes) - legacy_codes)

    print(f"✓ 매칭 성공: {len(matched)}개")
    print(f"❌ 파일 없는 박스: {len(missing)}개")
    if missing:
        for c in missing:
            print(f"  {c}")
    print(f"\n⚠ 박스에 없는 잉여 파일: {len(extra)}개")
    if extra:
        for c in extra[:10]:
            print(f"  {c} ({file_codes[c]})")

    # manual-boxes-pokemon.json 의 image 경로 업데이트
    manual = json.loads(MANUAL.read_text(encoding="utf-8"))
    updated = 0
    for prod in manual["products"]:
        code = prod.get("code")
        if code in matched:
            fname = file_codes[code]
            new_path = f"/images/box2/{fname}"
            if prod.get("image") != new_path:
                prod["image"] = new_path
                updated += 1

    atomic_write(MANUAL, json.dumps(manual, ensure_ascii=False, indent=2))
    print(f"\n[저장] manual-boxes-pokemon.json — image 경로 {updated}개 변경")
    print(f"  새 경로 형식: /images/box2/{{code}}.webp")


if __name__ == "__main__":
    main()
