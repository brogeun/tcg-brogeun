"""
check_history_range.py — data/history 의 각 파일 date range 확인
1년치까지만 있는지, 더 긴 데이터 있는지 진단
"""
import json
import os
import glob
from datetime import datetime, timedelta

files = glob.glob("data/history/*.json")
print(f"총 {len(files)}개 history 파일\n")

# size 큰 5개 + earliest date 빠른 5개
items = []
for f in files:
    try:
        d = json.load(open(f, encoding="utf-8"))
        h = d.get("history", [])
        if not h:
            continue
        ts_min = min(p[0] for p in h)
        ts_max = max(p[0] for p in h)
        items.append((f, len(h), ts_min, ts_max))
    except Exception:
        pass

# 데이터 많은 순
items.sort(key=lambda x: -x[1])
print("=== 데이터 많은 순 TOP 10 ===")
for f, n, mn, mx in items[:10]:
    dmin = datetime.fromtimestamp(mn / 1000).strftime("%Y-%m-%d")
    dmax = datetime.fromtimestamp(mx / 1000).strftime("%Y-%m-%d")
    days = (mx - mn) / 86400000
    print(f"  {os.path.basename(f):15s}: {n:>4}점, {dmin} ~ {dmax} ({days:.0f}일)")

# 가장 옛 데이터 가진 순
items_old = sorted(items, key=lambda x: x[2])
print(f"\n=== 가장 옛 데이터 가진 TOP 5 ===")
for f, n, mn, mx in items_old[:5]:
    dmin = datetime.fromtimestamp(mn / 1000).strftime("%Y-%m-%d")
    dmax = datetime.fromtimestamp(mx / 1000).strftime("%Y-%m-%d")
    print(f"  {os.path.basename(f):15s}: {n}점, {dmin} ~ {dmax}")

# 전체 통계
from collections import Counter
year_range_bucket = Counter()
for _, _, mn, mx in items:
    days = (mx - mn) / 86400000
    if days < 180:
        year_range_bucket["6개월 미만"] += 1
    elif days < 365:
        year_range_bucket["6~12개월"] += 1
    elif days < 730:
        year_range_bucket["1~2년"] += 1
    else:
        year_range_bucket["2년+"] += 1

print(f"\n=== 전체 분포 ===")
for k in ["6개월 미만", "6~12개월", "1~2년", "2년+"]:
    print(f"  {k}: {year_range_bucket.get(k, 0)}개")
