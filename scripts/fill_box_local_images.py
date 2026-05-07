"""
fill_box_local_images.py — 박스 image 필드를 로컬 파일 경로로 채움

우선순위:
  1. images/box/{code}.webp
  2. images/box/{code}.jpg
  3. images/box/{code 소문자}.webp/.jpg
  4. images/sets/{code}.jpg
  5. images/sets/{code 대문자}.jpg

이미 SNKRDUNK CDN URL 들어있는 박스는 그대로 둠 (잘 보이는 거).
사용:
  python scripts/fill_box_local_images.py
"""
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
IMG_BOX = ROOT / 'images' / 'box'
IMG_SETS = ROOT / 'images' / 'sets'


def find_local_image(code):
    """code 로 로컬 이미지 검색 — 발견 시 web URL 경로 반환"""
    if not code:
        return None
    # box/ 우선 (jpg 보다 webp)
    for variant in (code, code.upper(), code.lower()):
        for ext in ('.webp', '.jpg'):
            p = IMG_BOX / f'{variant}{ext}'
            if p.exists():
                return f'/images/box/{p.name}'
    # sets/ fallback (jpg 만)
    for variant in (code, code.upper(), code.lower()):
        p = IMG_SETS / f'{variant}.jpg'
        if p.exists():
            return f'/images/sets/{p.name}'
    return None


def main():
    print("=" * 60)
    print("박스 image 필드 → 로컬 경로 채우기")
    print("=" * 60)
    for brand in ['pokemon', 'onepiece']:
        f = ROOT / 'data' / f'price-{brand}-box.json'
        d = json.loads(f.read_bytes().rstrip(b'\x00').rstrip())
        products = d.get('products', [])
        updated = 0
        skipped_existing = 0
        not_found = []
        print(f"\n=== {brand} (총 {len(products)}개) ===")
        for p in products:
            existing = p.get('image', '')
            # 이미 로컬 경로면 그대로
            if existing.startswith('/images/'):
                skipped_existing += 1
                continue
            # 이미 SNKRDUNK CDN URL 면 그대로 (잘 보이는 박스)
            if existing.startswith('http'):
                skipped_existing += 1
                continue
            code = p.get('code')
            img = find_local_image(code)
            if img:
                p['image'] = img
                updated += 1
                print(f"  ✓ {p['id']:<8} ({code or '-':6}): {img}")
            else:
                not_found.append((p['id'], code, p.get('name', '')[:40]))
        if updated > 0:
            d['count'] = len(products)
            f.write_bytes(json.dumps(d, ensure_ascii=False, indent=2)
                          .encode('utf-8'))
            print(f"\n  → {updated}개 image 추가, 저장 완료")
            print(f"  (이미 image 있던 거 {skipped_existing}개 skip)")
        else:
            print(f"\n  → 추가 없음")
        if not_found:
            print(f"\n  ❌ 이미지 못 찾음 ({len(not_found)}개):")
            for pid, code, name in not_found:
                print(f"    {pid} ({code or '-':6}): {name}")
    print("\n완료.")


if __name__ == "__main__":
    main()
