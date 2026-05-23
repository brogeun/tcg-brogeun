"""
fix_history_grade_dup.py — daily cron 버그로 깨진 history 데이터 정리

문제: scrape_snkrdunk.py 의 fetch_card_history_1ea() 가 sales-history API 의
      salesChartOptionId 파라미터가 무시되는 것을 모르고 호출 → PSA10/PSA9/Raw
      모든 등급에 같은 sales-history 데이터를 채워넣음.

영향 범위: 매일 갱신 시작된 시점 (대체로 2026-04-24 이후) ~ 현재까지의 daily 데이터.
          (이전의 풀백필 데이터는 정확함 — 그대로 보존)

조치 방향:
  - 일자 >= CUTOFF_DATE 인 항목 중 psa10_price == psa9_price == raw_price (셋 다
    동일하고 모두 값이 있음) 인 점에서 psa9_price/raw_price/psa9_vol/raw_vol 만 제거.
  - psa10_price 와 vol/total 필드는 유지 (가격 자체는 sales-history 통합 단가라
    PSA10 시세에 어느 정도 근사함. 다음 daily 가 sales-chart 로 덮어씀).
  - 일부 점만 동일 (예: psa10=psa9 인데 raw 다름) → 건드리지 않음.

검증/롤백:
  - 백업 폴더 data/history.bak-fix-grade-dup/ 에 변경 전 원본 복사
  - 변경된 파일 수 / 정리된 점 수 출력
"""
import json
import shutil
from pathlib import Path
from datetime import datetime

ROOT = Path(__file__).resolve().parent.parent
HIST = ROOT / "data" / "history"
BACKUP = ROOT / "data" / "history.bak-fix-grade-dup"

# 이 날짜 이후의 데이터만 정리 — 이전 (풀백필) 은 정확하므로 그대로
CUTOFF_DATE = "2026-04-24"


def fix_history_file(path):
    """1개 파일 정리. return: (changed, fixed_points)"""
    try:
        d = json.loads(path.read_text("utf-8"))
    except Exception:
        return False, 0

    points = d.get("history") or []
    if not points:
        return False, 0

    fixed = 0
    for p in points:
        date = p.get("date") or ""
        if date < CUTOFF_DATE:
            continue
        p10 = p.get("psa10_price")
        p9 = p.get("psa9_price")
        raw = p.get("raw_price")
        # 셋 다 값이 있고 모두 동일 = daily 가 잘못 채운 게 거의 확실
        if p10 and p9 and raw and p10 == p9 == raw:
            # psa9 / raw 필드만 제거 — psa10 은 유지 (sales-history 통합 단가)
            p.pop("psa9_price", None)
            p.pop("psa9_vol", None)
            p.pop("raw_price", None)
            p.pop("raw_vol", None)
            fixed += 1

    if fixed == 0:
        return False, 0

    out = {
        "id": d.get("id"),
        "updatedAt": datetime.utcnow().isoformat() + "+00:00",
        "source": (d.get("source") or "") + " + grade-dup-fix",
        "history": points,
    }
    path.write_bytes(json.dumps(out, ensure_ascii=False, indent=2).encode("utf-8"))
    return True, fixed


def main():
    if not HIST.exists():
        print("⚠ data/history/ 가 없습니다.")
        return

    # 백업 (이미 있으면 skip)
    if not BACKUP.exists():
        print(f"백업 중: {BACKUP.name} ...")
        shutil.copytree(HIST, BACKUP)
        print(f"백업 완료")

    files = sorted(HIST.glob("*.json"))
    print(f"history 파일: {len(files):,} 개")
    print(f"CUTOFF: {CUTOFF_DATE} 이후 점에서 psa10=psa9=raw 동일이면 psa9/raw 제거")
    print()

    changed_files = 0
    total_fixed = 0
    for i, f in enumerate(files, 1):
        try:
            changed, fixed = fix_history_file(f)
        except Exception as e:
            print(f"[{i}/{len(files)}] {f.stem} 에러: {e}")
            continue
        if changed:
            changed_files += 1
            total_fixed += fixed
        if i % 1000 == 0:
            print(f"진행: {i:,} / {len(files):,} (변경 {changed_files:,}, 정리 {total_fixed:,}점)")

    print()
    print(f"================ 완료 ================")
    print(f"변경된 파일: {changed_files:,}")
    print(f"정리된 데이터 점: {total_fixed:,}")
    print(f"백업: {BACKUP}")
    print(f"")
    print(f"다음 단계:")
    print(f"  git add data/history/ scripts/scrape_snkrdunk.py scripts/fix_history_grade_dup.py")
    print(f"  git commit -m 'fix: daily cron PSA10/9/raw dup + 1mo cleanup'")
    print(f"  git push")


if __name__ == "__main__":
    main()
