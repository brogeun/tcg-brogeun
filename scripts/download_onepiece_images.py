"""
download_onepiece_images.py — 원피스 카드 이미지 자체 호스팅

JSON 의 image URL (https://www.onepiece-cardgame.com/...) 을
images/onepiece/{CODE}-{NUM}.png 로 다운받고, JSON 의 image 필드를
/images/onepiece/{CODE}-{NUM}.png 로 교체.

사용:
  python scripts/download_onepiece_images.py
  python scripts/download_onepiece_images.py --only OP17
"""

import argparse
import json
import time
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
JSON_DIR = ROOT / "data" / "cards-by-set"
IMG_DIR = ROOT / "images" / "onepiece"
IMG_DIR.mkdir(parents=True, exist_ok=True)

OP_SETS = ['OP01','OP02','OP03','OP04','OP05','OP06','OP07','OP08','OP09','OP10',
           'OP11','OP12','OP13','OP14','OP15','OP16','OP17','EB01','EB02','EB03','EB04']

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def download(url: str, dest: Path) -> bool:
    if dest.exists() and dest.stat().st_size > 1000:
        return True  # 이미 있음
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Referer": "https://www.onepiece-cardgame.com/",
    })
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = r.read()
        if len(data) < 500:
            return False  # 빈 응답
        dest.write_bytes(data)
        return True
    except Exception as e:
        print(f"        FAIL {url[-40:]}: {e}")
        return False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", help="특정 세트만 (예: OP17)")
    args = parser.parse_args()

    print("=" * 60)
    print(f"원피스 카드 이미지 다운로드 → images/onepiece/")
    print("=" * 60)

    total_ok, total_fail, total_skip = 0, 0, 0

    targets = [args.only] if args.only else OP_SETS
    for code in targets:
        p = JSON_DIR / f"{code}.json"
        if not p.exists():
            continue
        d = json.loads(p.read_bytes().rstrip(b'\x00').decode('utf-8'))
        cards = d.get('cards', [])
        ok, fail, skip = 0, 0, 0
        print(f"\n  {code} ({len(cards)} 카드)")

        for c in cards:
            url = c.get('image', '')
            if not url:
                continue
            # fullId 우선 사용 (variant 카드 OP15-001_p1 등 처리)
            full_id = c.get('fullId') or f"{c.get('setCode', code)}-{c.get('number', '')}"
            if not full_id:
                continue
            local_name = f"{full_id}.png"
            local_path = IMG_DIR / local_name
            if local_path.exists() and local_path.stat().st_size > 1000:
                # 이미 있음 → JSON URL 만 자체 경로로 교체
                c['image'] = f"/images/onepiece/{local_name}"
                skip += 1
                continue
            if download(url, local_path):
                c['image'] = f"/images/onepiece/{local_name}"
                ok += 1
            else:
                fail += 1
            time.sleep(0.05)  # rate limit 방지

        print(f"    ✓ {ok} 다운로드 / {skip} 스킵 / {fail} 실패")

        # JSON 갱신 (image 필드만 자체 경로로 교체된 상태)
        if p.exists():
            p.unlink()
        with open(p, 'w', encoding='utf-8', newline='\n') as f:
            f.write(json.dumps(d, ensure_ascii=False, indent=2))

        total_ok += ok
        total_fail += fail
        total_skip += skip

    print(f"\n━━━ 완료 ━━━")
    print(f"  총 다운로드: {total_ok}")
    print(f"  스킵 (이미 있음): {total_skip}")
    print(f"  실패: {total_fail}")
    print(f"  → images/onepiece/ 확인")


if __name__ == "__main__":
    main()
