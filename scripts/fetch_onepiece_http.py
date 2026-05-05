"""
fetch_onepiece_http.py — 원피스 일판 공식 카드리스트 (selenium 없이 HTTP 만)

소스: https://www.onepiece-cardgame.com/cardlist/?series={ID}
- 시리즈 ID 하드코딩 (이미 디스커버리 완료)
- urllib 로 단순 GET → 정규식 파싱 → JSON
- 출력: data/cards-by-set/{code}.json (포켓몬 tcgcollector 와 동일 포맷)

사용:
  python scripts/fetch_onepiece_http.py            # 전체
  python scripts/fetch_onepiece_http.py --only OP15
"""

import argparse
import json
import re
import time
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "cards-by-set"
OUT_DIR.mkdir(parents=True, exist_ok=True)

BASE = "https://www.onepiece-cardgame.com"

# 디스커버리 완료된 매핑 (사용자 PowerShell 실행으로 확인됨)
SERIES = [
    ("OP01", "550101"),
    ("OP02", "550102"),
    ("OP03", "550103"),
    ("OP04", "550104"),
    ("OP05", "550105"),
    ("OP06", "550106"),
    ("OP07", "550107"),
    ("OP08", "550108"),
    ("OP09", "550109"),
    ("OP10", "550110"),
    ("OP11", "550111"),
    ("OP12", "550112"),
    ("OP13", "550113"),
    ("OP14", "550114"),
    ("OP15", "550115"),
    ("EB01", "550201"),
    ("EB02", "550202"),
    ("EB03", "550203"),
    ("EB04", "550204"),
]

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def fetch(url: str, timeout: int = 30) -> str:
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "ja,en;q=0.8,ko;q=0.6",
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = r.read()
        for enc in ("utf-8", "shift_jis", "euc-jp", "cp932"):
            try:
                return raw.decode(enc)
            except UnicodeDecodeError:
                continue
        return raw.decode("utf-8", errors="ignore")


def parse_cards(html: str, code: str) -> list[dict]:
    """
    일판 공식 사이트 HTML 구조:
      <dl class="modalCol" id="OP15-001">
        <dt>
          <div class="cardName">クリーク</div>
        </dt>
        <dd>
          <img class="lazy" src="/images/cardlist/dummy.gif"
               data-src="../images/cardlist/card/OP15-001.png?260428" alt="..."/>
        </dd>
      </dl>
    """
    cards = {}  # number -> card dict

    # modalCol 블록 추출
    blocks = re.findall(
        r'<dl[^>]*class=["\'][^"\']*modalCol[^"\']*["\'][^>]*id=["\']([^"\']+)["\'][^>]*>(.*?)</dl>',
        html, re.DOTALL
    )

    for block_id, block in blocks:
        # block_id 예: "OP15-001" 또는 "OP15-001_p1" (parallel)
        id_m = re.match(r'([A-Z]+\d+)[\-_](\d+)(?:_(\w+))?', block_id)
        if not id_m:
            continue
        set_part = id_m.group(1)
        if set_part.upper() != code.upper():
            continue
        number = id_m.group(2)
        variant = id_m.group(3) or ""  # p1, p2, sp 등

        # variant 가 있으면 base 카드 우선 (p1 같은 패럴은 스킵)
        if variant:
            continue

        # 이름
        name = ""
        m = re.search(r'class=["\']cardName["\'][^>]*>([^<]+)<', block)
        if m:
            name = m.group(1).strip()

        # 이미지 — data-src 에서 cardlist/card/ 경로만
        img = ""
        for m in re.finditer(r'data-src=["\']([^"\']+)["\']', block):
            url = m.group(1)
            if 'cardlist/card/' in url and 'attribute' not in url:
                # ../images/... → 절대 URL
                if url.startswith('../'):
                    url = BASE + '/' + url[3:]
                elif url.startswith('/'):
                    url = BASE + url
                elif url.startswith('//'):
                    url = 'https:' + url
                # ?260428 같은 cache buster 유지 (변경 시 새 이미지)
                img = url
                break

        cards[number] = {"number": number, "name": name, "image": img}

    return list(cards.values())


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--only", help="특정 세트만 (예: OP15)")
    p.add_argument("--debug", action="store_true", help="HTML 일부 저장")
    args = p.parse_args()

    print("=" * 60)
    print(f"원피스 일판 공식 카드리스트 (HTTP) → {OUT_DIR.relative_to(ROOT)}/")
    print("=" * 60)

    targets = SERIES
    if args.only:
        targets = [(c, s) for c, s in SERIES if c == args.only]
        if not targets:
            print(f"❌ {args.only} 시리즈 ID 없음")
            return

    fetched_at = datetime.now(timezone.utc).isoformat()
    success, failed = 0, []

    for code, sid in targets:
        url = f"{BASE}/cardlist/?series={sid}"
        print(f"\n  {code:<6} ← series={sid}")
        print(f"      → {url}")
        try:
            html = fetch(url)
        except Exception as e:
            print(f"      ❌ fetch FAIL: {e}")
            failed.append(code)
            continue

        if args.debug:
            (OUT_DIR.parent / f"_debug_{code}.html").write_text(html[:500_000], encoding="utf-8")

        cards = parse_cards(html, code)
        print(f"      ✓ {len(cards)} 카드 파싱")

        if not cards:
            print(f"      ❌ 0 카드 — HTML 구조 확인 필요 (--debug 로 _debug_{code}.html 저장)")
            failed.append(code)
            continue

        cards.sort(key=lambda c: int(c["number"]) if c["number"].isdigit() else 9999)

        payload = {
            "code": code,
            "fetchedAt": fetched_at,
            "source": "onepiece-cardgame.com (일판 공식)",
            "cardCount": len(cards),
            "cards": cards,
        }
        out = OUT_DIR / f"{code}.json"
        # 기존 파일 unlink → 새로 작성 (truncate 보장 — Windows mount NULL 바이트 방지)
        if out.exists():
            try:
                out.unlink()
            except Exception:
                pass
        # 명시적 'w' + truncate
        with open(out, "w", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(payload, ensure_ascii=False, indent=2))
            f.flush()
            try:
                import os
                os.fsync(f.fileno())
            except Exception:
                pass
        print(f"      → {out.relative_to(ROOT)}")
        success += 1
        time.sleep(0.8)

    print(f"\n━━━ 완료 ━━━")
    print(f"  성공: {success}")
    print(f"  실패: {failed}")


if __name__ == "__main__":
    main()
