"""Collect the previous KST day's final Hana/Naver daily FX quotes.
Weekends/holidays use the most recent published trading date. Never mix dates
or replace a complete snapshot with partial/live data. JPY is quoted per 100.
"""
import argparse
import json
import math
import os
import tempfile
import urllib.request
from datetime import date, datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT_FILE = ROOT / "data" / "fx-rates.json"
KST = timezone(timedelta(hours=9))
UA = "Mozilla/5.0"
API_URLS = {
    currency: f"https://api.stock.naver.com/marketindex/exchange/FX_{currency}KRW/prices?page=1&pageSize=60"
    for currency in ("USD", "JPY")
}


def fetch_daily(currency):
    req = urllib.request.Request(API_URLS[currency], headers={
        "User-Agent": UA, "Accept": "application/json",
        "Referer": "https://m.stock.naver.com/",
    })
    with urllib.request.urlopen(req, timeout=20) as response:
        rows = json.loads(response.read().decode("utf-8"))
    if not isinstance(rows, list):
        raise ValueError(f"{currency}: unexpected daily history response")
    return rows


def previous_close(rows, target):
    eligible = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            traded = date.fromisoformat(str(row.get("localTradedAt", ""))[:10])
        except ValueError:
            continue
        if traded <= target:
            eligible.append((traded, row))
    if not eligible:
        raise ValueError("No published close on or before the target date")
    traded, row = max(eligible, key=lambda item: item[0])
    # Do not quietly fall back to an older row when the latest close is corrupt.
    value = float(str(row.get("closePrice", "")).replace(",", ""))
    if not math.isfinite(value) or value <= 0:
        raise ValueError("Invalid daily close")
    if (target - traded).days > 14:
        raise ValueError("Daily history is stale by more than 14 days")
    return traded, value


def build_snapshot(now=None, fetcher=fetch_daily):
    now = now or datetime.now(KST)
    if now.tzinfo is None:
        raise ValueError("Collection time must include a timezone")
    now = now.astimezone(KST)
    target = now.date() - timedelta(days=1)
    quotes = {c: previous_close(fetcher(c), target) for c in ("USD", "JPY")}
    if quotes["USD"][0] != quotes["JPY"][0]:
        raise ValueError("USD and JPY daily close dates differ; keep the previous snapshot")
    return {
        "updated": now.isoformat(),
        "asOf": quotes["USD"][0].isoformat(),
        "targetDate": target.isoformat(),
        "basis": "previous-business-day-close",
        "timezone": "Asia/Seoul",
        "rates": {
            "USD": round(quotes["USD"][1], 2),
            "JPY": round(quotes["JPY"][1] / 100, 4),
            "JPY_PER_100": round(quotes["JPY"][1], 2),
        },
        "source": "naver-finance",
        "sourceDetail": "hana-bank-daily-close",
    }


def main(argv=None, now=None, fetcher=fetch_daily, out_file=OUT_FILE):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true", help="Validate/print without changing files")
    args = parser.parse_args(argv)
    try:
        out = build_snapshot(now=now, fetcher=fetcher)
    except Exception as exc:
        print(f"FX collection failed; previous file kept: {exc}")
        return 1
    serialized = json.dumps(out, ensure_ascii=False, indent=2) + "\n"
    if args.dry_run:
        print(serialized)
        return 0
    out_file = Path(out_file)
    out_file.parent.mkdir(parents=True, exist_ok=True)
    # Replace both currencies together, including when the process is interrupted.
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=out_file.parent,
                                         prefix=".fx-rates-", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(serialized)
        os.replace(temporary, out_file)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()
    print(f"Saved FX close for {out['asOf']} (requested {out['targetDate']}): {out['rates']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
