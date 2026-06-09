"""
build_cards_meta_index.py — 모든 카드 ID 의 메타 인덱스 생성

용도:
  PSA Cert# 등록 시 백엔드에서 카드 매칭 검증을 위한 정적 인덱스 파일 생성.
  data/history/ 디렉토리의 모든 카드 ID + manual-boxes/all-cards 의 ID 를
  대상으로 SNKRDUNK API 호출 → 메타 추출 → data/cards-meta-index.json

저장 형식:
  { "706813": { "name": "...", "code": "ST21-014", "brand": "onepiece" }, ... }

사용:
  python scripts/build_cards_meta_index.py            # 전체 (없는 것만 추가)
  python scripts/build_cards_meta_index.py --fresh    # 처음부터 재작성
  python scripts/build_cards_meta_index.py 706813     # 특정 ID 만
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
HISTORY_DIR = ROOT / "data" / "history"
INDEX_FILE = ROOT / "data" / "cards-meta-index.json"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


def fetch_meta(cid):
    """SNKRDUNK API 에서 카드 메타 가져오기"""
    url = f"https://snkrdunk.com/v1/apparels/{cid}"
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/json",
        "Accept-Language": "ja,en;q=0.9",
        "Referer": "https://snkrdunk.com/",
    })
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read().decode("utf-8"))
    except Exception as e:
        print(f"  ✗ {cid}: fetch fail — {e}")
        return None
    a = data.get("apparel") or data.get("data", {}).get("apparel") or data
    if not a or not (a.get("name") or a.get("title")):
        print(f"  ✗ {cid}: no name field, keys: {list(data.keys())[:5]}")
        return None
    name = a.get("name") or a.get("title")
    return {
        "name": name,
        "code": a.get("productNumber") or a.get("product_number") or a.get("code") or a.get("modelNumber"),
        "brand": a.get("brand") or ("onepiece" if "ONE PIECE" in name.upper() else "pokemon"),
    }


def _atomic_save(path, data):
    """Atomic write — tmp 파일에 쓰고 JSON 검증 후 os.replace 로 교체.
    중단/동시 read 와 안전. 누적 손상 방지."""
    import os
    tmp = path.with_suffix(".tmp")
    json_bytes = json.dumps(data, ensure_ascii=False, indent=0).encode("utf-8")
    try:
        tmp.write_bytes(json_bytes)
        # 검증
        json.loads(tmp.read_text(encoding="utf-8"))
        # 원자적 교체
        os.replace(str(tmp), str(path))
    except Exception as e:
        try: tmp.unlink()
        except: pass
        print(f"  ! atomic_save fail: {e}")


def collect_ids():
    """대상 ID 수집 — history 디렉토리 + box 데이터"""
    ids = set()
    if HISTORY_DIR.exists():
        for f in HISTORY_DIR.glob("*.json"):
            ids.add(f.stem)
    # all-cards.json 의 ID 도 추가 (혹시 history 없는 카드)
    try:
        with open(ROOT / "data" / "all-cards.json", "r", encoding="utf-8") as f:
            d = json.load(f)
            for c in (d.get("details") or d.get("cards") or []):
                if c.get("id"):
                    ids.add(str(c["id"]))
    except Exception:
        pass
    return ids


def main():
    args = sys.argv[1:]
    fresh = "--fresh" in args
    args = [a for a in args if a != "--fresh"]
    explicit_ids = [a for a in args if a.isdigit()]

    # 기존 인덱스 로드
    index = {}
    if not fresh and INDEX_FILE.exists():
        with open(INDEX_FILE, "r", encoding="utf-8") as f:
            index = json.load(f)
        print(f"Loaded existing index: {len(index)} entries")

    # 처리 대상
    if explicit_ids:
        target_ids = explicit_ids
        print(f"Target: {len(target_ids)} explicit IDs")
    else:
        target_ids = sorted(collect_ids() - (set() if fresh else set(index.keys())), key=lambda x: int(x))
        print(f"Target: {len(target_ids)} new IDs to fetch")

    saved = 0
    failed = 0
    for i, cid in enumerate(target_ids, 1):
        if i % 50 == 0:
            print(f"  Progress: {i}/{len(target_ids)} (saved={saved}, failed={failed})")
            # 중간 저장 — atomic write (tmp -> 검증 -> os.replace)
            _atomic_save(INDEX_FILE, index)
        meta = fetch_meta(cid)
        if meta:
            index[cid] = meta
            saved += 1
        else:
            failed += 1
        time.sleep(0.3)  # SNKRDUNK 부하 분산

    # 최종 저장 — atomic
    _atomic_save(INDEX_FILE, index)
    print(f"\n✓ Done. Total {len(index)} entries (saved {saved}, failed {failed})")
    print(f"  → {INDEX_FILE}")


if __name__ == "__main__":
    main()
