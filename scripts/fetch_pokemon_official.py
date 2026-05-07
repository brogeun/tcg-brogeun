"""
fetch_pokemon_official.py — 일본 공식 사이트 (pokemon-card.com) 에서 박스별 카드 리스트 fetch

기존 fetch_set_cards.py (selenium + tcgcollector) 의 한계:
  - SR/HR/SAR/Secret 등급 카드를 lazy load 못 잡아 카운트 부족
  - selenium 무거움

이 스크립트:
  - 일본 공식 사이트의 박스 검색 페이지 직접 fetch
  - 모든 등급 (base + SR/HR/SAR + Secret 등) 한 번에 받음
  - urllib 만 사용 (selenium 불필요, 빠름)

사용:
  python scripts/fetch_pokemon_official.py            # 모든 박스
  python scripts/fetch_pokemon_official.py SV5K S8b  # 특정 박스만
  python scripts/fetch_pokemon_official.py --force    # 기존 덮어쓰기
"""
import json
import re
import sys
import time
import urllib.request
import urllib.parse
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "cards-by-set"
OUT_DIR.mkdir(parents=True, exist_ok=True)

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

# 박스 코드 → 일본 공식 사이트의 expansion code (regulation 또는 series)
# 사이트에서 "シリーズ で絞り込む" 의 series ID 사용
# 확인: https://www.pokemon-card.com/card-search/index.php 에서 series 필터 옵션 코드
BOX_TO_SERIES = {
    # 신규 23개 박스 — series 코드 (일본 공식 사이트 검색에서 확인됨)
    'SV5K': '60',   'SV4a': '59',   'SV4M': '58',   'SV4K': '57',
    'SV3a': '56',   'SV3':  '55',   'SV2a': '54',   'SV2D': '53',
    'SV2P': '52',   'SV1a': '51',
    'S12a': '47',   'S12':  '46',   'S11a': '45',   'S11':  '44',
    'S10b': '43',   'S10a': '42',   'S9a':  '41',   'S9':   '40',
    'S8b':  '39',   'S8':   '38',   'S7R':  '37',   'S7D':  '36',
    'S6a':  '35',
    # 기존 박스도 보조 — 필요 시 add
    'SV5M': '61',   'SV5a': '62',   'SV6':  '63',   'SV6a': '64',
    'SV7':  '65',   'SV7a': '66',   'SV8':  '67',   'SV8a': '68',
    'SV9':  '69',   'SV9a': '70',   'SV10': '71',
}


def fetch_html(url, post_data=None):
    headers = {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,*/*",
        "Accept-Language": "ja,en;q=0.9,ko;q=0.8",
        "Referer": "https://www.pokemon-card.com/",
    }
    if post_data:
        data = urllib.parse.urlencode(post_data, doseq=True).encode("utf-8")
        req = urllib.request.Request(url, data=data, headers={
            **headers, "Content-Type": "application/x-www-form-urlencoded",
        })
    else:
        req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", errors="replace")


# 페이지에서 카드 정보 추출 — 카드 그리드의 a 태그 패턴
# 공식 사이트는 보통: <a href="/card-search/details.php/card/12345/...">
CARD_LINK_RE = re.compile(
    r'<a[^>]+href="(/card-search/details\.php/card/(\d+)/[^"]*)"[^>]*>'
    r'.*?<img[^>]+src="([^"]+)"[^>]*alt="([^"]*)"',
    re.DOTALL
)
# 카드 번호 패턴: "001/100" 또는 "S12a 001"
NUM_RE = re.compile(r'(\d{1,3})\s*/\s*(\d{1,4})')
PAGINATION_RE = re.compile(r'pageID=(\d+)|page=(\d+)')


def fetch_box_cards(code, series_id, force=False):
    """박스 1개의 모든 카드 fetch — 페이지네이션 자동"""
    cards = []
    page = 1
    seen_ids = set()
    while True:
        # 일본 공식 검색 URL
        url = (f"https://www.pokemon-card.com/card-search/index.php"
               f"?keyword=&se_ta={series_id}&pg={page}")
        try:
            html = fetch_html(url)
        except Exception as e:
            print(f"    page {page} 실패: {e}")
            break

        page_cards = []
        for m in CARD_LINK_RE.finditer(html):
            href, card_id, img_src, name = m.groups()
            if card_id in seen_ids:
                continue
            seen_ids.add(card_id)
            # 이미지 URL 절대화
            if img_src.startswith("/"):
                img_src = "https://www.pokemon-card.com" + img_src
            # 카드 번호 추출
            num_m = NUM_RE.search(name) or NUM_RE.search(html[m.end():m.end()+500])
            number = num_m.group(0) if num_m else ""
            page_cards.append({
                "id": card_id,
                "name": name.strip(),
                "image": img_src,
                "number": number,
                "url": "https://www.pokemon-card.com" + href,
                "fullId": f"{code}-{number.split('/')[0].zfill(3)}" if number else "",
            })

        if not page_cards:
            break
        cards.extend(page_cards)
        # 다음 페이지 있는지 — 마지막 페이지면 멈춤
        # 공식 사이트는 보통 pagenation link 로 표시. "次へ" 또는 page=N+1 link
        if f"pg={page+1}" not in html and f"page={page+1}" not in html:
            break
        page += 1
        time.sleep(0.5)
        if page > 30:  # 안전장치
            print(f"    안전장치: 30 페이지 초과 — break")
            break

    return cards


def main():
    args = sys.argv[1:]
    force = "--force" in args
    only_codes = [a for a in args if not a.startswith("--")]

    targets = list(BOX_TO_SERIES.items())
    if only_codes:
        targets = [(c, s) for c, s in targets if c in only_codes]

    print("=" * 60)
    print(f"일본 공식 사이트에서 박스 카드 fetch ({len(targets)} 박스)")
    print("=" * 60)
    print()

    success = 0
    fail = 0
    for code, series_id in targets:
        out_path = OUT_DIR / f"{code}.json"
        if out_path.exists() and not force:
            try:
                existing = json.loads(out_path.read_bytes().rstrip(b'\x00').rstrip())
                if existing.get('cardCount', 0) > 0:
                    print(f"  {code:<6} skip ({existing['cardCount']} 카드, --force 로 덮어쓰기)")
                    continue
            except Exception:
                pass
        print(f"  {code:<6} (series {series_id}) fetching...", end=" ", flush=True)
        try:
            cards = fetch_box_cards(code, series_id, force)
            if not cards:
                print(f"❌ 카드 0장")
                fail += 1
                continue
            data = {
                "code": code,
                "fetchedAt": datetime.now(timezone.utc).isoformat(),
                "source": "pokemon-card.com (official JP)",
                "cardCount": len(cards),
                "cards": cards,
            }
            try: out_path.unlink()
            except Exception: pass
            out_path.write_bytes(json.dumps(data, ensure_ascii=False, indent=2).encode("utf-8"))
            print(f"✓ {len(cards)} 카드")
            success += 1
        except Exception as e:
            print(f"❌ {e}")
            fail += 1
        time.sleep(1.5)

    print()
    print(f"완료: ✓ {success} / ❌ {fail}")
    print(f"파일: {OUT_DIR.relative_to(ROOT)}/")


if __name__ == "__main__":
    main()
