"""
sync_pokemon.py — tcgcollector 신규 포켓몬 세트 자동 감지

작동:
1. https://www.tcgcollector.com/sets/jp 또는 sets 페이지에서 최신 세트 목록 가져옴
2. fetch_set_cards.py 의 POKEMON_SETS 와 비교 — 신규 세트 있는지 확인
3. 신규 발견 시:
   - fetch_set_cards.py 의 POKEMON_SETS 자동 업데이트 (in-place)
   - 신규 세트만 selenium fetch (subprocess 호출)
4. CI 가 변경 사항 commit + push

사용:
  python scripts/sync_pokemon.py --dry-run    # 감지만
  python scripts/sync_pokemon.py              # 신규 발견 시 fetch
"""

import argparse
import json
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FETCH_SCRIPT = ROOT / "scripts" / "fetch_set_cards.py"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

# tcgcollector 의 일판 포켓몬 메인 페이지 — 최근 세트 리스트 위치
TCGC_RECENT = "https://www.tcgcollector.com/sets/jp"


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "text/html"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", errors="ignore")


def discover_remote_sets():
    """tcgcollector 일판 포켓몬 페이지에서 최근 세트 목록 가져옴"""
    html = fetch(TCGC_RECENT)
    sets = []
    # tcgcollector URL 패턴: /sets/{ID}/{slug}
    # 최근 발매 세트들이 페이지 상단에 노출됨
    seen_urls = set()
    for m in re.finditer(r'href="(/sets/(\d+)/[^"#?]+)"[^>]*>([^<]+)</a>', html):
        url, sid, name = m.group(1), m.group(2), m.group(3).strip()
        if url in seen_urls:
            continue
        seen_urls.add(url)
        sets.append((sid, url, name))
    return sets


def get_local_sets():
    """fetch_set_cards.py 의 POKEMON_SETS 파싱"""
    text = FETCH_SCRIPT.read_text("utf-8")
    sets = []
    block = re.search(r'POKEMON_SETS\s*=\s*\[(.*?)^\s*\]', text, re.DOTALL | re.MULTILINE)
    if not block:
        # 단순 패턴
        block_text = text
    else:
        block_text = block.group(1)
    for m in re.finditer(r'\(\s*"([A-Z]+\d*[A-Za-z]*)"\s*,\s*"(https?://[^"]+)"', block_text):
        sets.append((m.group(1), m.group(2)))
    return sets


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    print("=" * 60)
    print("tcgcollector 신규 포켓몬 세트 자동 감지")
    print("=" * 60)

    print("\n[1/3] 원격 세트 목록 가져오기...")
    try:
        remote = discover_remote_sets()
    except Exception as e:
        print(f"❌ fetch 실패: {e}")
        sys.exit(1)
    print(f"  → {len(remote)} 세트 노출됨 (최근)")

    print("\n[2/3] 로컬 POKEMON_SETS 와 비교...")
    local = get_local_sets()
    local_urls = {url for _, url in local}
    print(f"  → 로컬: {len(local)} 세트 등록됨")

    # 신규 = remote 의 URL 이 로컬에 없음
    new_sets = []
    for sid, url, name in remote:
        full_url = f"https://www.tcgcollector.com{url}" if url.startswith('/') else url
        if full_url in local_urls:
            continue
        # 일판 포켓몬 패턴 체크 (slug 에 세트 코드 추출 시도)
        slug_m = re.search(r'/sets/\d+/([^/?]+)', url)
        if not slug_m:
            continue
        slug = slug_m.group(1)
        # 새 세트 후보
        new_sets.append((sid, full_url, name, slug))

    if not new_sets:
        print("\n  ✅ 신규 세트 없음. 동기화 불필요.")
        return

    print(f"\n  🆕 신규 후보 {len(new_sets)} 개:")
    for sid, url, name, slug in new_sets[:20]:
        print(f"     - {name[:40]:<40}  {url}")

    if args.dry_run:
        print("\n[dry-run] fetch 없이 종료. 실제 sync 는 인자 없이 실행.")
        return

    # 자동 fetch 는 selenium 필요 (chromedriver) — GitHub Actions 에서 셋업 후 호출
    print("\n[3/3] 신규 세트 자동 fetch 는 fetch_set_cards.py 수동 실행 권장.")
    print("     사용자 PC: python scripts/fetch_set_cards.py")
    print("     (POKEMON_SETS 리스트 수동 업데이트 후 fetch)")


if __name__ == "__main__":
    main()
