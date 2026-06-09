"""
backfill_op16.py — OP-16 전용 통합 백필 스크립트 (안전, 단계별)

다른 카드/박스 데이터 절대 안 건드림. OP-16 만 정확히 처리.

흐름:
  1. data 백업 (data.bak-op16-{timestamp}/)
  2. SNKRDUNK 카탈로그 재수집 (onepiece) -> all-cards.json 갱신
  3. OP-16 카드 SNKRDUNK 매칭 수 확인
  4. OP-16 박스 메타 (name, image, lastPrice) SNKRDUNK API fetch
     -> manual-boxes-onepiece.json 의 OP-16 entry 갱신
  5. OP-16 박스 시세 백필 (history/816932.json)
  6. OP-16 카드 빈 history 파일 생성 (data/op16_card_ids.txt 도 생성)
  7. cards-meta-index 갱신 (build_cards_meta_index 호출)
  8. OP-16 카드 시세 백필 (backfill_card_history --ids-file=data/op16_card_ids.txt)
  9. 결과 요약

사용:
  python scripts/backfill_op16.py            # 전체
  python scripts/backfill_op16.py --skip-cards  # 카드 시세 백필만 skip
  python scripts/backfill_op16.py --dry-run  # 작업 안 함, 계획만 출력

안전장치:
  - 각 단계 실패 시 즉시 중단 (이후 단계 안 진행)
  - 카드 시세 백필은 --ids-file 로 OP-16 cid 만 처리 (다른 카드 건드리지 않음)
  - 빈 history 파일은 backfill 후 채워짐 (실패 시 빈 채로 유지)
  - manual-boxes 갱신 전 기존 entry 백업
"""

import argparse
import io
import json
import shutil
import subprocess
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

# 윈도우 cmd 의 cp949 인코딩 우회 — 한글/유니코드 안전 출력
try:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')
    sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding='utf-8', errors='replace')
except Exception:
    pass

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
HISTORY = DATA / "history"
ALL_CARDS = DATA / "all-cards.json"
MANUAL_BOXES = DATA / "manual-boxes-onepiece.json"
IDS_FILE = DATA / "op16_card_ids.txt"

OP16_BOX_ID = "816932"  # SNKRDUNK 의 OP-16 박스 cid (수동 확인)
OP16_CODE_PREFIX = "OP16-"  # productNumber 매칭용

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def banner(title):
    print()
    print("=" * 64)
    print(title)
    print("=" * 64)


def step(n, title):
    print()
    print(f"--- Step {n} - {title}")


def run(cmd, dry=False):
    """subprocess 실행 — 실패 시 중단"""
    print(f"  $ {' '.join(cmd)}")
    if dry:
        print("  [dry-run] skip")
        return
    r = subprocess.run(cmd, cwd=str(ROOT))
    if r.returncode != 0:
        print(f"  [FAIL] exit {r.returncode} — 중단")
        sys.exit(r.returncode)


def fetch_snkrdunk_meta(cid):
    """SNKRDUNK API 에서 박스/카드 메타 fetch"""
    url = f"https://snkrdunk.com/v1/apparels/{cid}"
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json",
        "Accept-Language": "ja,en;q=0.9",
        "Referer": "https://snkrdunk.com/",
    })
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def backup_data(dry=False):
    """data 폴더의 핵심 파일들 timestamp 백업"""
    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    bak_dir = DATA / f"_bak-op16-{ts}"
    print(f"  -> {bak_dir}")
    if dry:
        return bak_dir
    bak_dir.mkdir(parents=True, exist_ok=True)
    # 핵심 파일만 — history 전체는 용량 큼, 영향받는 것만
    for f in [ALL_CARDS, MANUAL_BOXES, DATA / "cards-meta-index.json"]:
        if f.exists():
            shutil.copy2(f, bak_dir / f.name)
    # history 중 OP-16 박스 history (있다면)
    op16_box_hist = HISTORY / f"{OP16_BOX_ID}.json"
    if op16_box_hist.exists():
        (bak_dir / "history").mkdir(exist_ok=True)
        shutil.copy2(op16_box_hist, bak_dir / "history" / op16_box_hist.name)
    print(f"  [OK] 백업 완료")
    return bak_dir


def discover_op16_cards():
    """all-cards.json 의 OP-16 카드 추출"""
    if not ALL_CARDS.exists():
        return []
    d = json.loads(ALL_CARDS.read_text("utf-8"))
    details = d.get("details") or []
    op16 = []
    for c in details:
        pn = str(c.get("productNumber") or "")
        if pn.upper().startswith(OP16_CODE_PREFIX):
            op16.append(c)
    return op16


def refresh_box_meta(dry=False):
    """OP-16 박스 메타 (name, image, lastPrice) SNKRDUNK API 에서 fetch -> manual-boxes 갱신"""
    if not MANUAL_BOXES.exists():
        print("  [!] manual-boxes-onepiece.json 없음 — skip")
        return
    print(f"  -> SNKRDUNK API fetch (id={OP16_BOX_ID})")
    if dry:
        print("  [dry-run] skip")
        return
    try:
        d = fetch_snkrdunk_meta(OP16_BOX_ID)
    except Exception as e:
        print(f"  [!] fetch 실패: {e} — 기존 메타 유지")
        return
    a = d.get("apparel") or d.get("data", {}).get("apparel") or d
    name = a.get("name") or a.get("title") or ""
    image = (a.get("imageUrl") or a.get("image") or
             (a.get("images", [{}])[0].get("url") if isinstance(a.get("images"), list) else ""))
    last_price = a.get("lastPrice") or a.get("price") or 0
    if isinstance(last_price, dict):
        last_price = last_price.get("amount") or 0

    mb = json.loads(MANUAL_BOXES.read_text("utf-8"))
    found = False
    for p in mb.get("products", []):
        if str(p.get("id")) == OP16_BOX_ID:
            if name: p["name"] = name
            if image: p["image"] = image
            if last_price: p["lastPrice"] = last_price
            found = True
            break
    if not found:
        print(f"  [!] manual-boxes 에 OP-16 entry 없음")
        return
    MANUAL_BOXES.write_text(json.dumps(mb, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  [OK] name: {(name or '')[:60]}")
    print(f"  [OK] image: {(image or '')[:80]}")
    print(f"  [OK] lastPrice: {last_price}")


def init_op16_card_history(op16_cards, dry=False):
    """OP-16 카드별 history 빈 파일 생성 + ids 파일 생성"""
    HISTORY.mkdir(exist_ok=True)
    created = 0
    existing = 0
    cid_list = []
    for c in op16_cards:
        cid = str(c.get("id") or "")
        if not cid:
            continue
        cid_list.append(cid)
        p = HISTORY / f"{cid}.json"
        if p.exists():
            existing += 1
            continue
        if dry:
            created += 1
            continue
        # 빈 history (backfill 이 fetch 후 채움)
        # 빈 history 는 is_card_history()=False 라 only_ids 명시 시에만 처리됨
        init = {"id": cid, "history": [], "_init": "op16-pending"}
        p.write_text(json.dumps(init, ensure_ascii=False, indent=2), encoding="utf-8")
        created += 1
    # ids file 작성
    if not dry:
        IDS_FILE.write_text("\n".join(cid_list) + "\n", encoding="utf-8")
    print(f"  [OK] 신규 빈 history: {created}개 / 기존: {existing}개")
    print(f"  [OK] ids 파일: {IDS_FILE.relative_to(ROOT)} ({len(cid_list)}개 cid)")
    return cid_list


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--skip-cards", action="store_true", help="카드 시세 백필 skip (박스만)")
    parser.add_argument("--skip-discover", action="store_true", help="SNKRDUNK 카탈로그 재수집 skip (이미 있으면)")
    parser.add_argument("--dry-run", action="store_true", help="실제 작업 안 함, 계획만")
    args = parser.parse_args()
    dry = args.dry_run

    banner(f"OP-16 통합 백필 (dry-run={dry})")
    print(f"  Box ID: {OP16_BOX_ID}")
    print(f"  Card prefix: {OP16_CODE_PREFIX}")

    # 1. 백업
    step(1, "data 백업")
    backup_data(dry=dry)

    # 2. SNKRDUNK 카탈로그 재수집 (포켓몬 + 원피스 둘 다 — 한 쪽만 하면 all-cards 가 덮어써짐)
    step(2, "SNKRDUNK 카탈로그 재수집 (포켓몬 + 원피스)")
    if args.skip_discover:
        print("  [--skip-discover] skip")
    else:
        # 인자 안 줘서 양쪽 brand 모두 처리 (~3~5분)
        run([sys.executable, str(ROOT / "scripts" / "discover_cards.py")], dry=dry)

    # 3. OP-16 카드 매칭 수 확인
    step(3, "OP-16 카드 SNKRDUNK 매칭 확인")
    op16_cards = discover_op16_cards()
    print(f"  OP-16 카드: {len(op16_cards)}장")
    if op16_cards[:3]:
        for c in op16_cards[:3]:
            print(f"    {c.get('id')} {c.get('productNumber','?')} {(c.get('name') or '')[:50]}")
    if len(op16_cards) < 10:
        print(f"  [!] 카드 매칭 너무 적음 ({len(op16_cards)}장) — SNKRDUNK 미인덱싱 가능")
        print(f"  [!] 박스 백필은 계속, 카드 백필은 효과 없을 수 있음")

    # 4. 박스 메타 갱신
    step(4, "OP-16 박스 메타 (name/image/lastPrice) SNKRDUNK fetch")
    refresh_box_meta(dry=dry)

    # 5. 박스 시세 백필
    step(5, "OP-16 박스 시세 전체기간 백필")
    run([sys.executable, str(ROOT / "scripts" / "backfill_box_history.py"),
         "--only", OP16_BOX_ID], dry=dry)

    if args.skip_cards:
        banner("완료 (--skip-cards — 카드 시세 백필 안 함)")
        return

    # 6. OP-16 카드 빈 history 생성
    step(6, "OP-16 카드 빈 history 파일 생성")
    cid_list = init_op16_card_history(op16_cards, dry=dry)
    if not cid_list:
        print("  [!] OP-16 카드 0개 — 카드 백필 skip")
        banner("완료 (카드 매칭 없음)")
        return

    # 7. cards-meta-index 갱신
    step(7, "cards-meta-index 갱신 (OP-16 메타 추가)")
    run([sys.executable, str(ROOT / "scripts" / "build_cards_meta_index.py")], dry=dry)

    # 8. 카드 시세 백필 (OP-16 만)
    step(8, "OP-16 카드 시세 백필 (오래 걸림, 카드당 약 1초)")
    print(f"  대상: {len(cid_list)}장 / 예상 시간: {len(cid_list)//60+1}분")
    run([sys.executable, str(ROOT / "scripts" / "backfill_card_history.py"),
         f"--ids-file={IDS_FILE.relative_to(ROOT)}"], dry=dry)

    banner("완료")
    print(f"  [OK] 박스 시세 백필: history/{OP16_BOX_ID}.json")
    print(f"  [OK] 카드 시세 백필: {len(cid_list)}장")
    print(f"\n  다음:")
    print(f"    git add data/ index.html")
    print(f"    git commit -m 'OP-16 SNKRDUNK 백필 (박스+카드)'")
    print(f"    git push")


if __name__ == "__main__":
    main()
