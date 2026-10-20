"""
backfill_card_history.py — 카드 등급별 가격 + 통합 거래량 풀백필 (v2)

SNKRDUNK API 분석 (검증 완료):
- /v1/apparels/{cid}/sales-chart/used?range=all&salesChartOptionId={ID}
  → 등급별 일별 단가 점들. PSA10=22, PSA9=23, A(raw)=18
- /v1/apparels/{cid}/sales-history?page=N&per_page=100
  → 모든 거래. salesChartOptionId 무시함 → 등급 통합. 일별 거래량 + outlier-median 단가.

저장 형식 (entries):
  {date, psa10_price, psa9_price, raw_price, total_vol, total_price}
  - psa10/psa9/raw_price = SNKRDUNK 차트 점 (등급별)
  - total_vol = 등급 통합 일별 거래 건수
  - total_price = 등급 통합 일별 단가 (outlier 제거 + median)

사용:
  python scripts/backfill_card_history.py            # 모든 카드 풀백필
  python scripts/backfill_card_history.py 289056     # 특정 ID
  python scripts/backfill_card_history.py --fresh    # 처음부터 재작성
  python scripts/backfill_card_history.py --days 90  # 최근 90일치만
"""
import json
import math
import os
import re
import sys
import tempfile
import time
import urllib.request
from urllib.parse import urlsplit
from collections import defaultdict
from datetime import datetime, timezone, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
HISTORY_DIR = ROOT / "data" / "history"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# SNKRDUNK 의 sales-chart/used?salesChartOptionId={ID} 등급 매핑
# 공식 salesChartOption: 18=A(raw), 22=PSA10, 23=PSA9
# BGS (cid 671486 으로 검증): 25=BGS10 BL(Black Label), 26=BGS10 GL(Gold Label), 27=BGS9.5
# 검증: 풀백필 후 PSA10 > PSA9 > raw, BGS10 BL > BGS10 GL > BGS9.5 자연스러운지 가격 갭 보면 됨
GRADE_OPTION_IDS = {
    "psa10":    22,
    "psa9":     23,
    "raw":      18,
    "bgs10_bl": 25,
    "bgs10_gl": 26,
    "bgs95":    27,
}
# Verified from official 671486 option25 metadata; never infer labels from prices.
GRADE_OPTION_LABELS = {18: 'A', 22: 'PSA10', 23: 'PSA9',
                       25: 'BGS10 BL', 26: 'BGS10 GL', 27: 'BGS9.5'}


class CollectionError(ValueError):
    """A failed or incomplete source must never replace a saved history."""


def source_json(url):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA, "Accept": "application/json", "Referer": "https://snkrdunk.com/",
    })
    try:
        with urllib.request.urlopen(req, timeout=15) as response:
            payload = json.loads(response.read().decode("utf-8"))
    except Exception as error:
        raise CollectionError(type(error).__name__ + ': ' + str(error) + '; source=' + url) from error
    if not isinstance(payload, dict):
        raise CollectionError('Source JSON must be an object: ' + url)
    return payload


def fetch_chart_grade(cid, opt_id):
    """sales-chart/used + 옵션 ID → {date: price} (일별 단가, SNKRDUNK 자체 산출)"""
    if type(opt_id) is not int or opt_id not in GRADE_OPTION_LABELS:
        raise CollectionError('Unsupported requested grade option for ' + str(cid))
    url = (f"https://snkrdunk.com/v1/apparels/{cid}/sales-chart/used"
           f"?range=all&salesChartOptionId={opt_id}")
    d = source_json(url)
    points = d.get("points")
    if not isinstance(points, list):
        raise CollectionError('Missing chart points array for ' + str(cid) + '/' + str(opt_id))
    choices = d.get('salesChartOption')
    if not isinstance(choices, list):
        raise CollectionError('Missing chart option array for ' + str(cid) + '/' + str(opt_id))
    labels = {}
    for choice in choices:
        if (not isinstance(choice, dict) or type(choice.get('id')) is not int
                or not isinstance(choice.get('localizedName'), str) or not choice['localizedName'].strip()
                or choice['id'] in labels):
            raise CollectionError('Malformed or duplicate chart option for ' + str(cid) + '/' + str(opt_id))
        labels[choice['id']] = choice['localizedName']
    if ((points or opt_id in labels) and labels.get(opt_id) != GRADE_OPTION_LABELS[opt_id]):
        raise CollectionError('Nonempty/mismatched chart without exact requested grade label for '
                              + str(cid) + '/' + str(opt_id))
    by_date = {}
    for p in points:
        if not isinstance(p, list) or len(p) < 2:
            raise CollectionError('Malformed chart point for ' + str(cid))
        ts_ms, price = p[:2]
        if any(type(value) not in (int, float) or not math.isfinite(value) for value in (ts_ms, price)) or price <= 0:
            raise CollectionError('Invalid chart timestamp/price for ' + str(cid))
        if int(price) <= 0:
            raise CollectionError('Chart price is below the saved JPY precision for ' + str(cid))
        try:
            # Keep the legacy UTC contract used by downstream archive normalization.
            day = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime("%Y-%m-%d")
        except (ValueError, OSError, OverflowError) as error:
            raise CollectionError('Invalid chart timestamp for ' + str(cid)) from error
        by_date[day] = int(price)
    return by_date


def fetch_volume(cid, days_limit=None, max_pages=9999):
    """sales-history 페이지네이션 (등급 통합) → 일별 거래량 + outlier 제거된 일별 median 단가
    return: (counts dict, prices dict)"""
    counts = defaultdict(int)
    prices = defaultdict(list)
    today = datetime.now()
    cutoff = (today - timedelta(days=days_limit)).strftime("%Y-%m-%d") if days_limit else "0000-00-00"
    previous_day = None
    cutoff_page = None
    seen_pages = set()
    completed = False
    for page in range(1, max_pages + 1):
        url = f"https://snkrdunk.com/v1/apparels/{cid}/sales-history?page={page}&per_page=100"
        d = source_json(url)
        items = d.get("history")
        if not isinstance(items, list):
            raise CollectionError('Missing sales-history array for ' + str(cid) + ' page ' + str(page))
        if not items:
            completed = True
            break
        fingerprint = json.dumps(items, sort_keys=True, separators=(',', ':'), allow_nan=False)
        if fingerprint in seen_pages:
            raise CollectionError('Repeated sales-history page for ' + str(cid) + ' page ' + str(page))
        seen_pages.add(fingerprint)
        for it in items:
            if not isinstance(it, dict) or not isinstance(it.get('date'), str):
                raise CollectionError('Malformed sales-history row for ' + str(cid))
            date_str = (it.get("date") or "").strip()
            m = re.match(r"(\d{4})[/-](\d{2})[/-](\d{2})", date_str)
            if m:
                d2 = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
                try:
                    datetime.strptime(d2, '%Y-%m-%d')
                except ValueError as error:
                    raise CollectionError('Invalid sales-history date for ' + str(cid)) from error
            else:
                m2 = re.fullmatch(r"(\d+)\s*(日|時間|分|秒|days?|hours?|minutes?|mins?|seconds?)(?:前|\s+ago)?", date_str, re.I)
                if not m2:
                    raise CollectionError('Unrecognized sales-history date for ' + str(cid))
                amount, unit = int(m2.group(1)), m2.group(2).lower()
                field = 'days' if unit == '日' or unit.startswith('day') else 'hours' if unit == '時間' or unit.startswith('hour') else 'minutes' if unit == '分' or unit.startswith('min') else 'seconds'
                d2 = (today - timedelta(**{field: amount})).strftime('%Y-%m-%d')
            if previous_day is not None and d2 > previous_day:
                raise CollectionError('Sales-history dates increased within/across pages for ' + str(cid) + ' page ' + str(page))
            previous_day = d2
            if d2 < cutoff:
                if cutoff_page is None:
                    cutoff_page = page
                continue
            pr_raw = it.get("price")
            if isinstance(pr_raw, str):
                pm = re.fullmatch(r"\s*(?:[¥￥]|JPY)?\s*([0-9][0-9,]*)\s*", pr_raw)
                pr = int(pm.group(1).replace(",", "")) if pm else None
            elif type(pr_raw) in (int, float) and math.isfinite(pr_raw):
                pr = int(pr_raw)
            else:
                pr = None
            if pr is None or pr <= 0:
                raise CollectionError('Invalid sales-history JPY price for ' + str(cid))
            counts[d2] += 1
            prices[d2].append(pr)
        # A cutoff inside one page alone is insufficient: confirm the whole
        # following page is still chronologically older (or explicitly empty).
        if cutoff_page is not None and page > cutoff_page:
            completed = True
            break
        # SNKRDUNK 가 per_page 무시하고 ~20건씩 줘 — items 비어야 진짜 끝
        time.sleep(0.25)
    if not completed:
        raise CollectionError('Sales-history page limit reached before completion for ' + str(cid))
    # 일별 outlier 제거 + median (다수 매수로 인한 가격 spike 제거)
    avg_prices = {}
    for dt, p in prices.items():
        if not p:
            continue
        s = sorted(p)
        init = s[len(s) // 2]
        clean = [pp for pp in p if 0.5 * init <= pp <= 2.0 * init]
        if not clean:
            clean = p
        sc = sorted(clean)
        avg_prices[dt] = sc[len(sc) // 2]
    return dict(counts), avg_prices


def is_card_history(history):
    """카드인지 (psa10/psa9/raw 키 있음) 판별"""
    for r in history:
        if any(k in r for k in ("psa10_price", "psa9_price", "raw_price")):
            return True
    return False


def explicit_non_graded_reason(row):
    """Saved type/category evidence only; product names are never classification."""
    if not isinstance(row, dict):
        return None
    kind = str(row.get('kind') or '').strip().lower()
    categories = {str(row.get('categoryId'))} if row.get('categoryId') is not None else set()
    if isinstance(row.get('categories'), list):
        categories.update(str(item.get('id')) for item in row['categories'] if isinstance(item, dict))
    if (kind == 'box' or '14' in categories) and '25' not in categories:
        return 'explicit-box'
    if kind == 'card' and str(row.get('packaging') or '').lower() == 'sealed':
        return 'explicit-sealed-card'
    return None


def collect_non_graded_products():
    """Match primary collection's explicit lists/catalogues, without browser imports."""
    paths = set()
    for pattern in ('top10-*.json', 'price-*.json', 'manual-boxes-*.json'):
        paths.update(DATA_DIR.glob(pattern))
    paths.update(DATA_DIR / name for name in ('cards-meta.json', 'cards-meta-index.json', 'all-cards.json',
                                             'cards-detail.json', 'futuristic-market.json', 'anniversary-market.json'))
    found = {}

    def accept(row, key=None, box_list=False):
        if not isinstance(row, dict):
            return
        cid = str(row.get('id') or key or '')
        if not re.fullmatch(r'[1-9][0-9]*', cid) or (key is not None and str(key) != cid):
            return
        reason = explicit_non_graded_reason(row)
        if reason:
            found[cid] = reason
        if box_list:
            found[cid] = 'explicit-box-list'

    for path in sorted(paths):
        if not path.is_file():
            continue
        try:
            payload = json.loads(path.read_bytes())
        except Exception as error:
            raise CollectionError('Cannot read product classification ' + path.name) from error
        if not isinstance(payload, dict):
            continue
        box_list = bool(re.fullmatch(r'(?:manual-boxes-(?:pokemon|onepiece)|price-(?:pokemon|onepiece)-box)\.json', path.name))
        for field in ('products', 'cards', 'details', 'boxes'):
            rows = payload.get(field)
            if isinstance(rows, list):
                for row in rows:
                    if field == 'boxes' and type(row) in (str, int):
                        accept({'id': row}, box_list=True)
                    else:
                        accept(row, box_list=box_list or field == 'boxes')
            elif isinstance(rows, dict):
                for cid, row in rows.items():
                    accept(row, cid, box_list=box_list or field == 'boxes')
        for cid, row in payload.items():
            if str(cid).isdigit():
                accept(row, cid, box_list=box_list)
        verified_boxes = payload.get('collection', {}).get('verifiedBoxIds', []) if isinstance(payload.get('collection'), dict) else []
        if not isinstance(verified_boxes, list):
            raise CollectionError('Malformed verified box IDs in ' + path.name)
        for cid in verified_boxes:
            if type(cid) not in (str, int) or not re.fullmatch(r'[1-9][0-9]*', str(cid)):
                raise CollectionError('Invalid verified box ID in ' + path.name)
            found[str(cid)] = 'verified-box-id'
    found.update(verified_scope_exclusions())
    return found


def verified_scope_exclusions():
    """Reuse only the index's explicit, officially evidenced non-single reason."""
    policy = DATA_DIR / 'market-price-index-dynamic-policy.json'
    if not policy.is_file():
        return {}
    try:
        scope_path = json.loads(policy.read_bytes()).get('scope', {}).get('exclusionsSourcePath')
        if scope_path is None:
            return {}
        relative = Path(scope_path)
        if relative.is_absolute() or not relative.parts or relative.parts[0] != 'data':
            raise CollectionError('Scope exclusions must remain within data')
        path = (DATA_DIR / Path(*relative.parts[1:])).resolve()
        if not path.is_relative_to(DATA_DIR.resolve()):
            raise CollectionError('Scope exclusions must remain within data')
        document = json.loads(path.read_bytes())
        if (not isinstance(document, dict) or document.get('schemaVersion') != 1
                or document.get('reportKind') != 'card-index-platform-scope-exclusions'
                or document.get('source') != 'SNKRDUNK' or not isinstance(document.get('exclusions'), list)):
            raise CollectionError('Invalid verified scope-exclusion contract')
        found = {}
        for row in document['exclusions']:
            if not isinstance(row, dict):
                raise CollectionError('Invalid scope-exclusion record')
            if row.get('reason') != 'verified-not-single':
                continue
            cid = row.get('productId')
            url = urlsplit(str(row.get('evidenceUrl', '')))
            if (not isinstance(cid, str) or not re.fullmatch(r'[1-9][0-9]*', cid) or cid in found
                    or row.get('appliesTo') != 'all-observed-history'
                    or not isinstance(row.get('evidence'), str) or not row['evidence'].strip()
                    or url.scheme != 'https' or url.hostname != 'snkrdunk.com' or not url.path
                    or datetime.strptime(row.get('verifiedAt', ''), '%Y-%m-%d').date() > datetime.now(timezone.utc).date()):
                raise CollectionError('Invalid officially verified non-single exclusion')
            found[cid] = 'verified-not-single'
        return found
    except CollectionError:
        raise
    except Exception as error:
        raise CollectionError('Cannot read verified scope exclusions') from error


def is_box_only_history(history):
    """A positive saved box quote with no card-grade/raw fields is box evidence."""
    has_box_quote = False
    for row in history:
        if any(key.endswith('_price') and key not in ('box_price', 'total_price') for key in row):
            return False
        price = row.get('box_price')
        if type(price) in (int, float) and math.isfinite(price) and price > 0:
            has_box_quote = True
    return has_box_quote


def atomic_history(path, payload, original):
    """Replace only after all source calls succeeded; retain exact old bytes on error."""
    raw = json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False).encode('utf-8')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + '.', suffix='.tmp', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(raw)
        json.loads(temporary.read_bytes())
        if path.read_bytes() != original:
            raise CollectionError('History changed during collection; preserving the newer local file')
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def main():
    args = sys.argv[1:]
    days_limit = None
    only_ids = []
    fresh = "--fresh" in args
    # NEW: --ids-file=PATH  텍스트 파일에서 ID 리스트 읽음 (한 줄당 하나)
    # NEW: --resume  이미 valid JSON 인 파일 skip
    ids_file = None
    resume = "--resume" in args
    batch_n = 0   # NEW: --batch N --of M  → 전체를 M등분, N번째 배치만 처리 (스트라이드)
    batch_of = 0
    skip_next = False
    for i, a in enumerate(args):
        if skip_next:
            skip_next = False
            continue  # --days/--batch/--of 의 값 → 카드 ID 로 오인 방지
        if a == "--days" and i + 1 < len(args):
            days_limit = int(args[i + 1]); skip_next = True
        elif a == "--batch" and i + 1 < len(args):
            batch_n = int(args[i + 1]); skip_next = True
        elif a == "--of" and i + 1 < len(args):
            batch_of = int(args[i + 1]); skip_next = True
        elif a.startswith("--ids-file="):
            ids_file = a.split("=", 1)[1]
        elif a.isdigit():
            only_ids.append(a)

    if ids_file:
        try:
            with open(ids_file, "r", encoding="utf-8") as fp:
                only_ids = [line.strip() for line in fp if line.strip() and not line.startswith("#")]
            print(f"[--ids-file] {ids_file} 에서 {len(only_ids)} ID 로드")
        except Exception as e:
            print(f"⚠ ids-file 읽기 실패: {e}")
            return 1

    if (days_limit is not None and days_limit < 1) or batch_of < 0 or batch_n < 0 or (batch_of and batch_n >= batch_of):
        print('::error::Invalid days/batch bounds')
        return 1

    print("=" * 60)
    print("카드 백필 v2 — sales-chart/used (등급별) + sales-history (통합 거래량)")
    print(f"days_limit: {days_limit or 'ALL'}, target: {len(only_ids) if only_ids else 'ALL CARDS'}, fresh: {fresh}, resume: {resume}")
    print("=" * 60)

    # 카드 ID 추출 — history 폴더에서 카드 history 만
    targets = []
    read_failures = 0
    skipped_non_graded = defaultdict(int)
    try:
        non_graded = collect_non_graded_products()
    except CollectionError as error:
        print('::error::' + str(error) + '; existing history retained')
        return 1
    only_ids_set = set(only_ids) if only_ids else None
    for f in sorted(HISTORY_DIR.glob("*.json")):
        cid = f.stem
        if only_ids_set and cid not in only_ids_set:
            continue
        try:
            raw = f.read_bytes()
            d = json.loads(raw)
            if not isinstance(d, dict) or str(d.get('id')) != cid or not isinstance(d.get('history'), list):
                raise CollectionError('Existing history identity/schema is invalid')
            history = d['history']
            seen_dates = set()
            for row in history:
                if not isinstance(row, dict) or not isinstance(row.get('date'), str) or row['date'] in seen_dates:
                    raise CollectionError('Existing history has malformed/duplicate dated rows')
                datetime.strptime(row['date'], '%Y-%m-%d')
                seen_dates.add(row['date'])
            reason = non_graded.get(cid) or explicit_non_graded_reason(d)
            if reason is None and is_box_only_history(history):
                reason = 'saved-box-only-history'
            if reason:
                skipped_non_graded[reason] += 1
                continue  # IDs/--fresh must not force non-graded products through grade APIs.
            # Explicit IDs still include ambiguous/unknown products, as before.
            if only_ids_set or is_card_history(history):
                # resume 모드 — 이미 valid 한 JSON 이면 skip (only_ids 없을 때만 의미)
                if resume and not only_ids_set:
                    continue
                targets.append((cid, f, d, raw))
        except Exception as e:
            print(f"  [{cid}] read fail: {e}")
            read_failures += 1
            continue

    if batch_of > 1:
        targets = targets[batch_n::batch_of]
        print(f"[배치] {batch_n + 1}/{batch_of} 만 처리 (스트라이드)")
    print(f"카드 history 파일: {len(targets)} 개 / 등급 대상 제외: {dict(skipped_non_graded)}\n")
    success = 0
    unchanged = 0
    fail = read_failures
    for i_t, (cid, path, existing, original) in enumerate(targets, 1):
        print(f"[{i_t}/{len(targets)}] {cid}", end=" ", flush=True)
        existing_by_date = {h["date"]: dict(h) for h in existing.get("history", []) if h.get("date")}
        by_date = {} if fresh else dict(existing_by_date)
        any_new = False
        grade_counts = {}
        try:
            # Every grade and the complete requested sales range must succeed.
            # In-memory partial results are discarded on any failure below.
            for grade, opt_id in GRADE_OPTION_IDS.items():
                chart = fetch_chart_grade(cid, opt_id)
                grade_counts[grade] = len(chart)
                for date, price in chart.items():
                    if date not in by_date:
                        by_date[date] = {"date": date}
                    by_date[date][f"{grade}_price"] = price
                    any_new = True
                time.sleep(0.2)
            vols, sh_prices = fetch_volume(cid, days_limit=days_limit)
            for date, count in vols.items():
                if date not in by_date:
                    by_date[date] = {"date": date}
                by_date[date]["total_vol"] = count
                any_new = True
            for date, price in sh_prices.items():
                if date not in by_date:
                    by_date[date] = {"date": date}
                by_date[date]["total_price"] = price
        except Exception as error:
            print('SOURCE FAILED; previous bytes and timestamp retained: ' + str(error))
            fail += 1
            continue
        if not any_new:
            print("(verified empty sources; existing bytes and timestamp retained)")
            unchanged += 1
            continue
        new_history = sorted(by_date.values(), key=lambda h: h.get("date", ""))
        if new_history == existing.get('history'):
            print('(verified unchanged sources; existing bytes and timestamp retained)')
            unchanged += 1
            continue
        out = {
            **existing,
            "id": str(cid),
            "updatedAt": datetime.now(timezone.utc).isoformat(),
            "source": "backfill v2 (sales-chart/used per grade + sales-history vol)",
            "history": new_history,
        }
        try:
            atomic_history(path, out, original)
        except Exception as e:
            print(f"⚠ atomic-write fail (원본 유지): {e}")
            fail += 1
            continue
        # 통계 — 등급별 days + 통합 거래량
        vol_total = sum(h.get("total_vol", 0) for h in new_history)
        # BGS 는 데이터 있을 때만 표시 (보통 0이라 noise)
        bgs_parts = []
        for g in ("bgs10_bl", "bgs10_gl", "bgs95"):
            n = grade_counts.get(g, 0)
            if n > 0:
                bgs_parts.append(f"{g}={n}d")
        bgs_str = (" " + " ".join(bgs_parts)) if bgs_parts else ""
        print(f"OK psa10={grade_counts['psa10']}d psa9={grade_counts['psa9']}d "
              f"raw={grade_counts['raw']}d vol={vol_total}{bgs_str}")
        success += 1
        time.sleep(0.3)

    print(f"\nDone: OK {success} / Unchanged {unchanged} / Fail {fail}")
    return 1 if fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
