"""Read public CardHobby listing attributes into a separate local evidence cache.

The path is published by CardHobby's detail page and util.js. This helper never
logs in or changes the collected price archive or website data. Attribute values
are seller supplied; an absent field does not verify certification. Good and
VeryGood are not treated as A/NM.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / '.cache/chinese-price-recheck-20261011/detail-research'
ENDPOINT = 'https://www.cardhobby.com.cn/NewCommodity/GetCommodityProperties'


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def save_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def parse_properties(payload):
    if (not isinstance(payload, dict) or type(payload.get('result')) is not int
            or payload.get('result') != 1 or not isinstance(payload.get('data'), list)):
        raise ValueError('Public listing attributes were not returned successfully')
    fields = {}
    for row in payload['data']:
        if not isinstance(row, dict) or not isinstance(row.get('PropertyControlName'), str):
            raise ValueError('Invalid attribute row')
        key = row['PropertyControlName']
        raw_value = row.get('PropertyValue')
        value = '' if raw_value is None else str(raw_value)
        if key in fields and fields[key] != value:
            raise ValueError('Conflicting duplicate attribute fields')
        fields[key] = value
    return fields


def fetch_properties(listing_id, output=OUTPUT, retries=1):
    if not re.fullmatch(r'[1-9][0-9]*', str(listing_id)):
        raise ValueError('Invalid public listing ID')
    path = Path(output) / f'properties-{listing_id}.json'
    if path.exists():
        payload = read_json(path)
        return payload, parse_properties(payload), False
    url = f'{ENDPOINT}?id={listing_id}'
    request = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0',
        'Referer': f'https://www.cardhobby.com.cn/market/item/{listing_id}',
    })
    for attempt in range(retries + 1):
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                payload = json.loads(response.read().decode('utf-8-sig'))
            fields = parse_properties(payload)
            save_json(path, payload)
            time.sleep(0.2)
            return payload, fields, True
        except Exception:
            if attempt == retries:
                raise
            time.sleep(0.7)


def grade_evidence(grade, fields):
    """Return explicit contradictions and the limited support actually present."""
    contradictions = []
    norm = lambda value: re.sub(r'\s+', '', '' if value is None else str(value)).casefold()
    graded = norm(fields.get('Graded', ''))
    grader = norm(fields.get('ProfessionalGrader', ''))
    score = next((fields[k] for k in ('Grade', 'Grading', 'Score', 'CardGrade') if fields.get(k)), '')
    version = norm(fields.get('Version', ''))
    if version in ('ja', 'jp', 'jpn', 'japanese', 'en', 'eng', 'english', 'cht', 'tc',
                   'zh-tw', 'zh-hant', 'traditionalchinese', '繁中', '繁體', '繁体',
                   'ko', 'kor', 'korean', 'fr', 'french', 'de', 'german', 'it', 'italian',
                   'es', 'spanish', 'pt', 'portuguese'):
        contradictions.append('detail_language_not_simplified_chinese')
    if grade == 'psa10':
        if graded in ('no', 'false', '0'):
            contradictions.append('detail_says_not_graded')
        if grader and grader not in ('psa', 'professionalsportsauthenticator'):
            contradictions.append('detail_grading_company_not_PSA')
        if score and norm(score) not in ('10', '10.0', 'gemmint10', 'gemmt10'):
            contradictions.append('detail_grade_not_10')
    elif grade == 'raw':
        if graded in ('yes', 'true', '1'):
            contradictions.append('detail_says_graded')
        condition = norm(fields.get('CardCondition', ''))
        if condition and condition not in ('a', 'a级', 'a級', 'nm', 'nearmint'):
            contradictions.append('detail_condition_not_explicit_A_or_NM')
    return {
        'contradictions': contradictions,
        'graded': fields.get('Graded'),
        'gradingCompany': fields.get('ProfessionalGrader'),
        'gradeValue': score or None,
        'condition': fields.get('CardCondition'),
        'languageVersion': fields.get('Version'),
        'psaCompanyAndGradeExplicitlySupported': grade == 'psa10' and graded == 'yes' and grader == 'psa' and norm(score) in ('10', '10.0'),
        'certificateVerificationPerformed': False,
    }


def current_targets(market):
    targets = []
    for card in market.get('cards', {}).values():
        for grade, quote in card.get('grades', {}).items():
            targets.append({'kind': 'card', 'targetId': card['sourceId'], 'grade': grade,
                            'name': card.get('name'), 'number': card.get('number'), **{k: quote.get(k) for k in ('date', 'priceMinor', 'sourceUrl')}})
    for boxes in market.get('boxes', {}).values():
        for box in boxes:
            targets.append({'kind': 'box', 'targetId': box['targetId'], 'grade': 'box',
                            **{k: box.get(k) for k in ('date', 'priceMinor', 'sourceUrl')}})
    return targets


def accepted_targets(prices):
    if (prices.get('source') != 'cardhobby' or prices.get('currency') != 'CNY'
            or not isinstance(prices.get('records'), list)):
        raise ValueError('Expected a local CardHobby CNY auction archive')
    targets = []
    for row in prices['records']:
        if row.get('grade') not in ('psa10', 'raw', 'box'):
            raise ValueError('Unsupported archive grade')
        targets.append({k: row.get(k) for k in
                        ('kind', 'targetId', 'sourceId', 'grade', 'name', 'number', 'title',
                         'priceMinor', 'sourceUrl', 'auctionEndAt', 'listingId')})
    return targets


def ensure_listing_details(source, quotes, workers=2):
    """Cache public fields for future accepted auctions; never invent missing data.

    ``source`` is the local archive directory, and ``quotes`` is an iterable of
    normalized auction records with listingId/sourceUrl. Only their missing or
    invalid attribute entries are refreshed. Other cached IDs are preserved.
    Network failures remain pending and are reported for the strict compiler.
    """
    source = Path(source)
    cache_path = source / 'listing-details.json'
    cache = read_json(cache_path) if cache_path.exists() else {'schemaVersion': 1, 'source': 'cardhobby', 'endpoint': ENDPOINT, 'items': {}}
    if (not isinstance(cache, dict) or cache.get('schemaVersion') != 1
            or cache.get('source') != 'cardhobby' or cache.get('endpoint') != ENDPOINT
            or not isinstance(cache.get('items'), dict)):
        raise ValueError('Invalid existing public attribute cache; it was not overwritten')
    items = dict(cache['items'])
    requested = {}
    for quote in quotes:
        listing_id = str(quote.get('listingId', ''))
        expected_url = f'https://www.cardhobby.com.cn/market/item/{listing_id}'
        if not re.fullmatch(r'[1-9][0-9]*', listing_id) or quote.get('sourceUrl') != expected_url:
            raise ValueError('Every attribute target needs its original public CardHobby URL')
        requested[listing_id] = expected_url
    missing, failures, fetched_count = [], [], 0
    for listing_id, expected_url in requested.items():
        detail = items.get(listing_id)
        try:
            if (not isinstance(detail, dict) or str(detail.get('id')) != listing_id
                    or detail.get('sourceUrl') != expected_url
                    or detail.get('propertiesUrl') != f'{ENDPOINT}?id={listing_id}'):
                raise ValueError('Attribute metadata does not match the requested listing')
            observed = datetime.fromisoformat(str(detail.get('observedAt')).replace('Z', '+00:00'))
            if observed.tzinfo is None or observed > datetime.now(timezone.utc):
                raise ValueError('Attribute observation time is missing or invalid')
            parse_properties({'result': 1, 'data': detail.get('properties')})
        except (ValueError, TypeError):
            missing.append(listing_id)
    def save_cache():
        save_json(cache_path, {**cache, 'endpoint': ENDPOINT, 'requirePublicAttributes': True, 'items': items})
    # Activate the strict policy before requests, including an interrupted run.
    save_cache()
    pool = ThreadPoolExecutor(max_workers=max(1, min(int(workers), 3)))
    pending = {}
    try:
        pending = {pool.submit(fetch_properties, listing_id, source / 'listing-attributes'): listing_id for listing_id in missing}
        for future in as_completed(pending):
            listing_id = pending[future]
            try:
                payload, fields, fetched = future.result()
                items[listing_id] = {'id': listing_id, 'sourceUrl': requested[listing_id],
                                     'propertiesUrl': f'{ENDPOINT}?id={listing_id}',
                                     'observedAt': datetime.now(timezone.utc).isoformat(), 'properties': payload['data']}
                fetched_count += 1
                save_cache()
            except Exception as exc:
                failures.append({'listingId': listing_id, 'error': str(exc)})
    except KeyboardInterrupt:
        for future in pending:
            future.cancel()
        raise
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
        save_cache()
    report = {'requestedCount': len(requested), 'cachedCount': len(requested) - len(missing),
              'fetchedCount': fetched_count, 'failedCount': len(failures),
              'failures': sorted(failures, key=lambda row: row['listingId']), 'cachePath': str(cache_path)}
    save_json(source / 'listing-details-report.json', report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--market', type=Path, default=ROOT / 'data/chinese-market.json')
    parser.add_argument('--prices', type=Path, help='Validate every accepted record in a local auction archive instead of representative current prices')
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--workers', type=int, default=2)
    args = parser.parse_args()
    targets = accepted_targets(read_json(args.prices)) if args.prices else current_targets(read_json(args.market))
    by_id = {}
    for target in targets:
        match = re.fullmatch(r'https://www\.cardhobby\.com\.cn/market/item/([1-9][0-9]*)', str(target.get('sourceUrl', '')))
        if not match:
            raise ValueError('Current price is missing its original public listing URL')
        target['listingId'] = match.group(1)
        by_id.setdefault(match.group(1), []).append(target)
    records, errors = [], []
    cache_path = args.output / 'listing-details.json'
    details = read_json(cache_path).get('items', {}) if cache_path.exists() else {}
    def save_details():
        save_json(cache_path, {'schemaVersion': 1, 'source': 'cardhobby', 'endpoint': ENDPOINT,
                              'items': details})
    pool = ThreadPoolExecutor(max_workers=max(1, min(args.workers, 3)))
    pending = {}
    try:
        pending = {pool.submit(fetch_properties, item_id, args.output): item_id for item_id in by_id}
        for done, future in enumerate(as_completed(pending), 1):
            item_id = pending[future]
            try:
                payload, fields, fetched = future.result()
                details[item_id] = {'id': item_id, 'sourceUrl': f'https://www.cardhobby.com.cn/market/item/{item_id}',
                                    'propertiesUrl': f'{ENDPOINT}?id={item_id}',
                                    'observedAt': datetime.now(timezone.utc).isoformat(), 'properties': payload['data']}
                for target in by_id[item_id]:
                    records.append({**target, 'fields': fields, **grade_evidence(target['grade'], fields),
                                    'propertiesUrl': f'{ENDPOINT}?id={item_id}'})
            except Exception as exc:
                errors.append({'listingId': item_id, 'error': str(exc), 'targets': by_id[item_id]})
            if done % 25 == 0:
                save_details()
                print(f'Attributes: {done}/{len(by_id)}; failures {len(errors)}', flush=True)
    except KeyboardInterrupt:
        for future in pending:
            future.cancel()
        raise
    finally:
        pool.shutdown(wait=False, cancel_futures=True)
        save_details()
    result = {
        'checkedAt': datetime.now(timezone.utc).isoformat(),
        'scope': 'all_accepted_auction_records' if args.prices else 'one representative source URL for each current grade or box-format price; not every daily-median contributor or every historical auction',
        'inputPath': str(args.prices or args.market),
        'endpoint': ENDPOINT, 'targetCount': len(targets), 'uniqueListingCount': len(by_id),
        'successTargetCount': len(records), 'errors': errors,
        'contradictoryListings': sorted({r['listingId'] for r in records if r['contradictions']}),
        'records': sorted(records, key=lambda r: (r['grade'], r['targetId'])),
    }
    report_name = 'accepted-auction-detail-review.json' if args.prices else 'current-price-detail-review.json'
    save_json(args.output / report_name, result)
    save_details()
    print(json.dumps({k: result[k] for k in ('targetCount', 'uniqueListingCount', 'successTargetCount', 'contradictoryListings')}, ensure_ascii=False))


if __name__ == '__main__':
    main()
