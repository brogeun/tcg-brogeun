"""
sync_onepiece.py — 일판 공식 사이트 신규 series 자동 감지 + 동기화

작동:
1. https://www.onepiece-cardgame.com/cardlist/ 에서 series dropdown 가져옴
2. fetch_onepiece_http.py 의 SERIES 와 비교 — 신규 series 있는지 확인
3. 신규 발견 시:
   - fetch_onepiece_http.py 의 SERIES 리스트 자동 업데이트 (in-place)
   - 모든 series 카드 fetch (fetch_onepiece_http.py 호출)
   - 카드 이미지 다운로드 (download_onepiece_images.py 호출)
   - card-to-box 빌드 (build_card_to_box.py 호출)
4. 변경 사항 stdout 으로 리포트 (CI 가 commit + push)

GitHub Actions 에서 호출됨. cmd 에서 수동 실행도 가능:
  python scripts/sync_onepiece.py
  python scripts/sync_onepiece.py --dry-run    # 새 series 만 출력 (fetch 안 함)
"""

import argparse
import json
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FETCH_SCRIPT = ROOT / "scripts" / "fetch_onepiece_http.py"

BASE = "https://www.onepiece-cardgame.com"
LIST_URL = BASE + "/cardlist/"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8")


def discover_remote_series():
    """일판 공식 사이트에서 현재 series 목록 가져옴 → [(code, series_id), ...]"""
    html = fetch(LIST_URL)
    series = []
    # <option value="550115">ブースターパック 神の島の冒険【OP-15】</option> 같은 패턴
    for m in re.finditer(r'<option\s+value=["\']?(\d{6,})["\']?[^>]*>([^<]+)</option>', html):
        sid, label = m.group(1), m.group(2).strip()
        # OP-XX, EB-XX, ST-XX, PRB-XX 코드 추출 (label 어디든)
        cm = re.search(r'(OP|EB|ST|PRB)[-]?(\d+[A-Z]?)', label.upper())
        if cm:
            code = f"{cm.group(1)}{cm.group(2).zfill(2)}"
            series.append((code, sid, label))
    return series


def get_local_series():
    """fetch_onepiece_http.py 의 SERIES 리스트 파싱"""
    text = FETCH_SCRIPT.read_text("utf-8")
    series = []
    block = re.search(r'SERIES\s*=\s*\[(.*?)\]', text, re.DOTALL)
    if not block:
        return series
    for m in re.finditer(r'\(\s*"([A-Z]+\d+)"\s*,\s*"(\d+)"\s*\)', block.group(1)):
        series.append((m.group(1), m.group(2)))
    return series


def update_local_series(new_entries):
    """fetch_onepiece_http.py 의 SERIES 리스트에 새 항목 prepend"""
    if not new_entries:
        return False
    text = FETCH_SCRIPT.read_text("utf-8")
    block_m = re.search(r'(SERIES\s*=\s*\[)(.*?)(\])', text, re.DOTALL)
    if not block_m:
        return False
    # 새 entries 를 ("CODE", "ID"), 형태로
    new_lines = "\n".join(f'    ("{code}", "{sid}"),' for code, sid in new_entries)
    new_block = block_m.group(1) + "\n" + new_lines + block_m.group(2) + block_m.group(3)
    new_text = text[:block_m.start()] + new_block + text[block_m.end():]
    FETCH_SCRIPT.write_text(new_text, encoding="utf-8")
    return True


def run_script(name, *args):
    """다른 스크립트 실행"""
    cmd = [sys.executable, str(ROOT / "scripts" / name), *args]
    print(f"  $ {' '.join(cmd)}")
    r = subprocess.run(cmd, cwd=str(ROOT))
    if r.returncode != 0:
        print(f"  ❌ {name} 실패 (exit {r.returncode})")
        sys.exit(r.returncode)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="감지만, fetch X")
    parser.add_argument("--skip-images", action="store_true", help="이미지 다운로드 skip")
    args = parser.parse_args()

    print("=" * 60)
    print("일판 공식 신규 series 자동 감지")
    print("=" * 60)

    print("\n[1/4] 원격 series 목록 가져오기...")
    try:
        remote = discover_remote_series()
    except Exception as e:
        print(f"❌ fetch 실패: {e}")
        sys.exit(1)
    print(f"  → {len(remote)} series 발견")

    print("\n[2/4] 로컬 series 와 비교...")
    local = get_local_series()
    local_codes = {c for c, _ in local}
    print(f"  → 로컬: {len(local)} series 등록됨")

    new_entries = []
    for code, sid, label in remote:
        if code not in local_codes:
            new_entries.append((code, sid))
            print(f"  🆕 신규: {code} (ID={sid}) {label[:40]}")

    if not new_entries:
        print("\n  ✅ 신규 series 없음. 동기화 불필요.")
        return

    print(f"\n  → {len(new_entries)} 개 신규 series 발견")

    if args.dry_run:
        print("\n[dry-run] fetch 없이 종료")
        return

    print("\n[3/4] fetch_onepiece_http.py 의 SERIES 리스트 업데이트...")
    if not update_local_series(new_entries):
        print("  ❌ SERIES 리스트 업데이트 실패")
        sys.exit(1)
    print(f"  ✓ {len(new_entries)} 개 추가")

    print("\n[4/4] 신규 series 동기화...")
    run_script("fetch_onepiece_http.py")
    if not args.skip_images:
        run_script("download_onepiece_images.py")
    run_script("build_card_to_box.py")

    print("\n━━━ 동기화 완료 ━━━")
    print(f"  신규 series {len(new_entries)} 개 추가됨:")
    for code, sid in new_entries:
        print(f"    - {code} (ID={sid})")
    print(f"\n  CI: data/ 변경 사항 commit + push 필요")


if __name__ == "__main__":
    main()
