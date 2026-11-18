"""Publish per-product observations from the already verified daily SNKRDUNK grade charts."""
import argparse
import gzip
import hashlib
import json
import math
import re
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from update_dynamic_card_index import data_reference

JST = timezone(timedelta(hours=9))
BUCKETS = 32
GRADES = {'raw': (18, 'A'), 'psa10': (22, 'PSA10')}


def project(source, excluded=()):
    day = date.fromisoformat(source['collectionAsOfJST'])
    summary = source['scopeSummary']
    records = source['records']
    if (source.get('reportKind') != 'market-price-index-live-history'
            or source.get('source') != 'SNKRDUNK' or source.get('currency') != 'JPY'
            or source.get('timezone') != 'Asia/Tokyo' or summary.get('complete') is not True
            or summary.get('failedConditions') != 0 or not records
            or len(records) != summary['requestedConditions']):
        raise ValueError('Incomplete or unexpected daily grade source')

    buckets = [{} for _ in range(BUCKETS)]
    seen = set()
    for record in records:
        cid, grade = record['id'], record['grade']
        code, label = GRADES[grade]
        if (not re.fullmatch(r'[1-9][0-9]{0,19}', cid)
                or record.get('status') != 'ok' or (cid, grade) in seen
                or (record['conditionCode'], record['conditionLabel']) != (code, label)):
            raise ValueError('Unverified product or grade')
        seen.add((cid, grade))
        if cid in excluded or record.get('httpStatus') is None:
            continue  # Older archive-only records have no direct HTTP receipt.
        if record['httpStatus'] != 200:
            raise ValueError('Unsuccessful grade observation')
        checked = datetime.fromisoformat(record['fetchedAt'])
        if checked.tzinfo is None:
            raise ValueError('Missing per-product collection timezone')
        fresh = []
        for row in record['history']:
            if row.get('sourceObservation') != 'current-public-graded-chart':
                continue
            # Retained observations from an earlier run may carry the same tag.
            # The collector only overlays new observations and reports their
            # latest date. Limit publication to a point proven by that receipt.
            if row['date'] != record['freshLatestDate']:
                continue
            stamp_day = datetime.fromtimestamp(row['sourceTimestampMs'] / 1000, JST).date()
            price = row['price']
            if (stamp_day.isoformat() != row['date'] or stamp_day > day
                    or type(price) not in (float, int) or not math.isfinite(price)
                    or price <= 0 or record.get('conditionLabelVerified') is not True):
                raise ValueError('Invalid current grade observation')
            fresh.append([row['date'], price])
        if len(fresh) != int(record['freshLatestDate'] is not None):
            raise ValueError('Latest source observation is missing or duplicated')
        product = buckets[int(cid) % BUCKETS].setdefault(cid, {})
        if grade in product:
            raise ValueError('Duplicate product grade')
        product[grade] = [int(checked.timestamp()), *fresh]
    if len(seen) != 2 * len({cid for cid, grade in seen}):
        raise ValueError('Missing per-product grade check')
    return [{cid: product for cid, product in bucket.items() if set(product) == GRADES.keys()}
            for bucket in buckets]


def export(root):
    index = json.loads((root / 'data/market-price-index.json').read_bytes())
    evidence = index['sourceSummary']['liveCollection']
    raw = data_reference(root, evidence['sourcePath']).read_bytes()
    if not evidence['complete'] or hashlib.sha256(raw).hexdigest() != evidence['sourceSha256']:
        raise ValueError('Daily grade archive differs from the verified index')
    source = json.loads(gzip.decompress(raw))
    if source['collectionAsOfJST'] != evidence['collectionAsOfJST']:
        raise ValueError('Daily grade archive date mismatch')
    policy = json.loads((root / 'data/market-price-index-dynamic-policy.json').read_bytes())
    scope = json.loads(data_reference(root, policy['scope']['exclusionsSourcePath']).read_bytes())
    excluded = {row['productId'] for row in scope['exclusions'] if row['reason'] == 'verified-not-single'}
    buckets = project(source, excluded)
    output = root / 'data/card-grade-days'
    output.mkdir(parents=True, exist_ok=True)
    for number, products in enumerate(buckets):
        payload = {'version': 1, 'bucket': number, 'marketDay': evidence['collectionAsOfJST'],
                   'products': products}
        path = output / f'{number:02}.json'
        temporary = path.with_suffix('.tmp')
        temporary.write_bytes(json.dumps(payload, separators=(',', ':'), allow_nan=False).encode())
        temporary.replace(path)
    print(json.dumps({'marketDay': evidence['collectionAsOfJST'], 'products': sum(map(len, buckets)),
                      'buckets': len(buckets), 'additionalSourceRequests': 0}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--has-current-source', action='store_true')
    args = parser.parse_args()
    if args.has_current_source:
        index = json.loads((args.root / 'data/market-price-index.json').read_bytes())
        source = index['sourceSummary']['liveCollection']
        raise SystemExit(0 if source['complete'] and source['collectionAsOfJST'] == datetime.now(JST).date().isoformat() else 1)
    export(args.root.resolve())
