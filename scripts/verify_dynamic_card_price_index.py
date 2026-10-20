"""Independent raw-price audit for the dynamic SNKRDUNK card reference index.

No builder or estimator is imported. Inputs remain read-only. An audit artifact
is written only when --output is explicitly provided.
"""
from __future__ import annotations

import argparse
import bisect
import gzip
import hashlib
import json
import math
import re
import statistics
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import numpy as np


ROOT = Path(__file__).resolve().parents[1]
BRANDS = ('pokemon', 'onepiece')
GRADES = ('raw', 'psa10')
OPTIONS = {'raw': 18, 'psa10': 22}
KINDS = {'card', 'single', 'single-card', 'single_card', 'single card'}
JST = timezone(timedelta(hours=9))
ALLOWED_LEGACY_SOURCES = ('backfill v2', 'card history v3 (grade chart + complete sales pages)')
UNIVERSE_PATH = 'data/card-index-platform-universe-20261012.json'
PLATFORM_HISTORY_PATH = 'data/card-index-platform-history-20261012.json'
POLICY_PATH = 'data/market-price-index-dynamic-policy.json'
METHOD_ID = 'dynamic-equal-initial-amount-card-basket-v1'
SNAPSHOT_PATHS = ['data/market-price-index-live-history-20261011.json',
                  'data/market-price-index-live-history-20261012.json', PLATFORM_HISTORY_PATH]
SOURCE_EVIDENCE = [
    {'title': 'S&P index mathematics: non-capitalization weights and continuity divisor',
     'url': 'https://www.spglobal.com/spdji/en/methodology/article/index-mathematics-methodology/'},
    {'title': 'SNKRDUNK same-card multiple-quantity listing, June 7 2024',
     'url': 'https://snkrdunk.com/information/244'},
    {'title': 'SNKRDUNK card listing rules: up to ten copies and lowest grade in multiple listings',
     'url': 'https://help.snkrdunk-guide.com/ja/articles/トレカの出品ガイドライン-82acc9c4'},
]


def check(ok, message):
    if not ok:
        raise AssertionError(message)


def positive(value):
    return type(value) in (int, float) and math.isfinite(value) and value > 0


def close(actual, expected, label, tolerance=5.1e-8):
    if expected is None:
        check(actual is None, label + ': missing value was replaced')
    else:
        check(type(actual) in (int, float) and math.isfinite(actual), label + ': invalid number')
        check(math.isclose(actual, expected, rel_tol=1e-10, abs_tol=tolerance),
              f'{label}: {actual!r} differs from {expected!r}')


def read_json(path):
    path = Path(path)
    raw = path.read_bytes()
    # Fingerprints always hash the stored source bytes, including gzip bytes.
    # Decompression changes only the parser input, never provenance identity.
    if path.name.endswith('.json.gz'):
        raw = gzip.decompress(raw)
    return json.loads(raw)


def within(root, key):
    check(isinstance(key, str) and key, 'Empty source path')
    path = (root / key).resolve()
    check(path.is_relative_to(root.resolve()), 'Source path escapes repository')
    return path


def date_value(text):
    check(isinstance(text, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', text), 'Invalid ISO date')
    return date.fromisoformat(text)


def single_catalog(records):
    """All languages are admitted; catalog identity and single-card kind matter."""
    groups = defaultdict(list)
    for row in records:
        if isinstance(row, dict) and type(row.get('id')) in (str, int):
            groups[str(row['id'])].append(row)
    return {cid: rows[0] for cid, rows in groups.items()
            if cid.isdigit() and len(rows) == 1 and rows[0].get('brand') in BRANDS
            and str(rows[0].get('kind', '')).casefold() in KINDS}


def legacy_prices(payload, cutoff):
    if not isinstance(payload, dict) or not str(payload.get('source', '')).startswith(ALLOWED_LEGACY_SOURCES):
        return {}
    if payload.get('currency', 'JPY') != 'JPY' or not isinstance(payload.get('history'), list):
        return {}
    shift = payload['source'].startswith('backfill v2') and payload.get('historyTimezone') != 'Asia/Tokyo'
    values = {grade: {} for grade in GRADES}
    conflicts = {grade: set() for grade in GRADES}
    for row in payload['history']:
        if not isinstance(row, dict) or row.get('currency', 'JPY') != 'JPY':
            continue
        try:
            day = date_value(row.get('date')) + timedelta(days=int(shift))
        except (AssertionError, ValueError, OverflowError):
            continue
        if day > cutoff:
            continue
        for grade in GRADES:
            amount = row.get(grade + '_price')
            if not positive(amount) or day in conflicts[grade]:
                continue
            if day in values[grade] and values[grade][day] != amount:
                values[grade].pop(day)
                conflicts[grade].add(day)
            else:
                values[grade][day] = float(amount)
    return {grade: rows for grade, rows in values.items() if rows}


def chart_prices(rows, cutoff):
    check(isinstance(rows, list), 'Chart history is not a list')
    values, conflicts = {}, set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        try:
            day = date_value(row.get('date'))
            stamp = row.get('sourceTimestampMs')
            check(type(stamp) in (int, float) and math.isfinite(stamp), 'Invalid source timestamp')
            check(datetime.fromtimestamp(stamp / 1000, timezone.utc).astimezone(JST).date() == day,
                  'Source timestamp differs from the declared JST date')
        except (AssertionError, ValueError, OverflowError, OSError):
            continue
        amount = row.get('price')
        if day > cutoff or not positive(amount) or day in conflicts:
            continue
        if day in values and values[day] != amount:
            values.pop(day)
            conflicts.add(day)
        else:
            values[day] = float(amount)
    return values


def old_snapshot_scope(card):
    """The old snapshots' stated Japanese subset, never a new-index filter."""
    pattern = (r'\[(?:EN|ENG|KR|KOR|KO|ZH|CN|CHN|SC|TC|CH|TW|TWN|FR|FRA|DE|GER|IT|ITA|ES|SPA|PT|POR|TH|THA|ID|IND|VI|VIE)\]|'
               r'\b(?:English|Korean|Chinese|French|German|Italian|Spanish|Portuguese|Thai|Indonesian|Vietnamese)\s+(?:Ver(?:sion)?\.?|Edition)\b|'
               r'(?:英語版|韓国語版|中国語版)')
    if re.search(pattern, str(card.get('name', '')), re.I):
        return False
    other = {'en', 'eng', 'english', '英語', '英語版', 'ko', 'kr', 'kor', 'korean',
             '韓国語', '韓国語版', 'zh', 'cn', 'chn', 'tw', 'twn', 'chinese',
             '中国語', '中国語版', 'fr', 'french', 'de', 'german', 'it', 'italian',
             'es', 'spanish', 'pt', 'portuguese', 'th', 'thai', 'id', 'indonesian', 'vi', 'vietnamese'}
    return not any(str(card.get(key, '')).casefold().replace('_', '-').split('-')[0] in other
                   for key in ('language', 'cardLanguage', 'editionLanguage'))


def input_paths(payload):
    summary = payload.get('sourceSummary', {})
    universe_path = summary.get('universeSourcePath')
    snapshots = [row.get('sourcePath') for row in summary.get('sourceSnapshots', [])]
    check(isinstance(universe_path, str) and len(snapshots) == 3
          and snapshots[:2] == SNAPSHOT_PATHS[:2] and len(set(snapshots)) == 3,
          'Snapshot order or selected platform-universe path is missing')
    return universe_path, snapshots


def verify_fingerprints(root, payload, report):
    expected = payload.get('inputFingerprints')
    check(isinstance(expected, dict) and expected and report.get('inputFingerprints') == expected,
          'Input fingerprints are absent or differ from validation')
    universe_path, snapshots = input_paths(payload)
    required = {'data/cards-meta.json', universe_path, POLICY_PATH, *snapshots}
    exclusion_path = read_json(root / POLICY_PATH).get('scope', {}).get('exclusionsSourcePath')
    if exclusion_path is not None:
        within(root, exclusion_path)
        required.add(exclusion_path)
    required.update(path.relative_to(root).as_posix() for path in (root / 'data/history').glob('*.json'))
    check(set(expected) == required, 'Fingerprint set differs from the full original/source/policy universe')
    for key, digest in expected.items():
        check(hashlib.sha256(within(root, key).read_bytes()).hexdigest() == digest,
              'Source fingerprint differs: ' + key)
    return len(required)


def verify_universe(root, fingerprints, universe_path=UNIVERSE_PATH):
    catalog = read_json(root / 'data/cards-meta.json')
    original = single_catalog(catalog['cards'])
    universe = read_json(within(root, universe_path))
    check(all(universe.get(key) == value for key, value in {
        'schemaVersion': 1, 'reportKind': 'card-index-platform-universe', 'source': 'SNKRDUNK'}.items()),
        'Platform universe source contract differs')
    scope = universe.get('scope', {})
    check(scope.get('brands') == list(BRANDS) and scope.get('languages') == 'all'
          and scope.get('currency') == 'JPY' and scope.get('productTypes') == ['single-card'],
          'Platform universe excludes languages or admits other product types')
    reference = universe.get('catalogReference', {})
    check(reference.get('path') == 'data/cards-meta.json'
          and reference.get('sha256') == fingerprints['data/cards-meta.json'], 'Universe catalog binding differs')
    rows = universe.get('products')
    check(isinstance(rows, list), 'Universe products are missing')
    discovered = single_catalog(rows)
    check(len(discovered) == len(rows), 'Universe has duplicate IDs, non-single products or unsupported brands')
    for cid, product in discovered.items():
        evidence = product.get('evidence', {})
        if cid in original:
            check(product['brand'] == original[cid]['brand'], 'Discovered ID changes original product brand')
            check(evidence.get('catalogDeclaredSingle') is True or evidence.get('category25Observed') is True,
                  'Original product has no declared single-card scope evidence')
        else:
            check(evidence.get('category25Observed') is True,
                  'New discovery ID has no single-card category evidence')
            listing = evidence.get('listingSources', []) + evidence.get('historicalListingSources', [])
            check(isinstance(listing, list) and listing and any(
                isinstance(row, dict) and row.get('brand') == product['brand']
                and row.get('categoryId') == 25
                and urlsplit(str(row.get('url', ''))).hostname == 'snkrdunk.com' for row in listing),
                'New discovery ID has no bound official brand/single-card listing source')
    discovery = universe.get('discovery')
    check(isinstance(discovery, dict) and discovery.get('platformUniverseVerified') is False,
          'Public page traversal was promoted to entire-platform universe certification')
    verify_discovery(discovery, discovered)
    admitted = {**original, **discovered}
    check('146897' in admitted and admitted['146897']['brand'] == 'pokemon',
          'English Gogh card is absent from the all-language known universe')
    return admitted, original, universe


def verify_discovery(discovery, products):
    """Reconcile completed page streams with retained per-product evidence."""
    check(type(discovery.get('complete')) is bool and type(discovery.get('pageTraversalComplete')) is bool,
          'Discovery completion flags are missing')
    if discovery['complete'] is not True and discovery['pageTraversalComplete'] is not True:
        return
    check(discovery['complete'] is True and discovery['pageTraversalComplete'] is True
          and discovery.get('listingPricesUsed') is False
          and discovery.get('potentialServerRankingCap') is False,
          'Completed discovery has incompatible traversal/price/cap claims')
    streams = discovery.get('streams')
    expected = {(brand, order) for brand in BRANDS for order in ('popular', 'new')}
    check(isinstance(streams, list) and len(streams) == len(expected)
          and {(row.get('brand'), row.get('order')) for row in streams} == expected,
          'Completed discovery does not cover all four declared listing streams')
    stream_map = {(row['brand'], row['order']): row for row in streams}
    ids = {key: set() for key in expected}
    current_listing_ids = discovery.get('currentListingProductIds')
    current_run = discovery.get('sourceRun')
    if current_listing_ids is not None:
        check(isinstance(current_listing_ids, dict) and set(current_listing_ids) == set(BRANDS)
              and isinstance(current_run, str) and bool(current_run), 'Current listing run identity is missing')
        for brand in BRANDS:
            check(isinstance(current_listing_ids[brand], dict)
                  and set(current_listing_ids[brand]) == {'popular', 'new'}, 'Current listing streams differ')
            for order, product_ids in current_listing_ids[brand].items():
                check(isinstance(product_ids, list) and len(product_ids) == len(set(product_ids))
                      and all(type(cid) is str and cid in products and products[cid]['brand'] == brand
                              for cid in product_ids), 'Current listing product IDs are invalid or duplicated')
    for row in streams:
        check(row.get('categoryId') == 25 and row.get('terminalEmpty') is True
              and row.get('errors') == [] and row.get('potentialCap') is False
              and type(row.get('pages')) is int and row['pages'] >= 1
              and type(row.get('uniqueIDs')) is int and row['uniqueIDs'] >= 0,
              'Completed listing stream has no valid empty terminal page or has errors/cap risk')
    for cid, product in products.items():
        for listing in product.get('evidence', {}).get('listingSources', []):
            key = listing.get('brand'), listing.get('order')
            check(key in expected and key[0] == product['brand'], 'Listing evidence brand/order differs')
            if current_listing_ids is not None:
                check(listing.get('sourceRun') == current_run, 'Current listing evidence belongs to a historical run')
            url = urlsplit(str(listing.get('url', '')))
            query = parse_qs(url.query)
            check(url.scheme == 'https' and url.hostname == 'snkrdunk.com'
                  and url.path == '/en/v1/trading-cards'
                  and query.get('brandId') == [key[0]] and query.get('order') == [key[1]]
                  and query.get('categoryId') == ['25'] and query.get('perPage') == ['100']
                  and type(listing.get('page')) is int and 1 <= listing['page'] < stream_map[key]['pages']
                  and query.get('page') == [str(listing['page'])] and listing.get('categoryId') == 25,
                  'Listing evidence does not match the official single-card page stream')
            ids[key].add(cid)
    for key, row in stream_map.items():
        check(len(ids[key]) == row['uniqueIDs'], 'Listing unique-ID count differs from retained product evidence')
        if current_listing_ids is not None:
            check(ids[key] == set(current_listing_ids[key[0]][key[1]]),
                  'Current listing IDs differ from this run evidence; historical-only products were included')


def verify_snapshot_counts(overlay, scope, require_complete=False):
    check(all(overlay.get(key) == value for key, value in {
        'schemaVersion': 1, 'reportKind': 'market-price-index-live-history',
        'source': 'SNKRDUNK', 'currency': 'JPY', 'timezone': 'Asia/Tokyo', 'grades': list(GRADES)}.items()),
        'Chart overlay source contract differs')
    records = overlay.get('records')
    check(isinstance(records, list) and all(isinstance(row, dict) for row in records),
          'Chart records are missing or malformed')
    keys = [(str(row.get('id')), row.get('grade')) for row in records]
    check(len(keys) == len(set(keys)), 'Chart overlay repeats a product condition')
    check(all(grade in GRADES for cid, grade in keys), 'Chart overlay has an unsupported condition')
    declared = overlay.get('scopeSummary')
    check(isinstance(declared, dict), 'Chart scope counts are missing')
    counts = {'attemptedProducts': len({cid for cid, grade in keys}), 'attemptedConditions': len(records),
              'succeededConditions': sum(row.get('status') == 'ok' for row in records),
              'failedConditions': sum(row.get('status') == 'failed' for row in records),
              'emptyConditions': sum(row.get('status') == 'ok' and not row.get('history') for row in records)}
    check(counts['succeededConditions'] + counts['failedConditions'] == len(records), 'Unknown chart request status')
    for key, value in counts.items():
        check(type(declared.get(key)) is int and declared[key] == value, 'Chart scope count differs: ' + key)
    check(type(declared.get('complete')) is bool, 'Chart completion status is missing')
    if declared['complete'] or require_complete:
        check(declared['complete'] is True and counts['failedConditions'] == 0
              and set(keys) == {(cid, grade) for cid in scope for grade in GRADES},
              'Complete chart collection does not cover the known product-condition universe')
    return records, counts


def verified_scope_exclusions(document, raw_scope, cutoff):
    """Explicit product-type corrections apply throughout observed history."""
    check(isinstance(document, dict) and document.get('schemaVersion') == 1
          and document.get('reportKind') == 'card-index-platform-scope-exclusions'
          and document.get('source') == 'SNKRDUNK' and isinstance(document.get('exclusions'), list),
          'Scope-exclusion source contract differs')
    excluded = set()
    for item in document['exclusions']:
        check(isinstance(item, dict), 'Invalid scope-exclusion record')
        cid = item.get('productId')
        url = urlsplit(str(item.get('evidenceUrl', '')))
        check(type(cid) is str and cid in raw_scope and cid not in excluded
              and item.get('reason') == 'verified-not-single'
              and item.get('appliesTo') == 'all-observed-history'
              and isinstance(item.get('evidence'), str) and bool(item['evidence'].strip())
              and url.scheme == 'https' and url.hostname == 'snkrdunk.com' and bool(url.path),
              'Scope exclusion is duplicated, unknown or lacks an official product-type justification')
        check(date_value(item.get('verifiedAt')) <= cutoff, 'Scope exclusion uses future verification')
        excluded.add(cid)
    return excluded


def reconstruct_sources(root, payload, report):
    root = root.resolve()
    count = verify_fingerprints(root, payload, report)
    universe_path, snapshot_paths = input_paths(payload)
    admitted, original, universe = verify_universe(root, payload['inputFingerprints'], universe_path)
    cutoff = date_value(payload['currentJSTDate'])
    prices, counters = {}, Counter()
    for path in sorted((root / 'data/history').glob('*.json')):
        cid = path.stem
        try:
            raw = read_json(path)
        except (ValueError, UnicodeError):
            counters['invalidHistoryFiles'] += 1
            continue
        if cid not in admitted or not isinstance(raw, dict) or str(raw.get('id')) != cid:
            continue
        values = legacy_prices(raw, cutoff)
        if values:
            prices[cid] = {'brand': admitted[cid]['brand'], 'grades': values}
    snapshots = []
    for snapshot_index, key in enumerate(snapshot_paths):
        overlay = read_json(root / key)
        latest = snapshot_index == len(snapshot_paths) - 1
        binding_matches = overlay.get('targetFingerprint') == payload['inputFingerprints']['data/cards-meta.json']
        declared_snapshot = payload['sourceSummary']['sourceSnapshots'][snapshot_index]
        check(declared_snapshot.get('sourceSha256') == payload['inputFingerprints'][key],
              'Declared source snapshot hash differs from the bound input')
        if not latest and not binding_matches:
            check(declared_snapshot.get('skipped') == 'catalog-fingerprint-changed',
                  'A historical snapshot with changed catalog provenance was not explicitly skipped')
            snapshots.append({'sourcePath': key, 'skipped': 'catalog-fingerprint-changed'})
            continue
        check(binding_matches, 'Current chart overlay catalog hash differs')
        check(declared_snapshot.get('skipped') is None, 'A still-bound chart overlay was silently skipped')
        if latest:
            check(overlay.get('universePath') == universe_path
                  and overlay.get('universeFingerprint') == payload['inputFingerprints'][universe_path],
                  'Platform chart collection is bound to a different universe')
            check(overlay.get('unitPriceVerified') is False and overlay.get('platformUniverseVerified') is False,
                  'Platform chart collection was promoted to unit/full-universe certification')
        scope = admitted if latest else {cid: product for cid, product in original.items() if old_snapshot_scope(product)}
        records, counts = verify_snapshot_counts(overlay, scope)
        compare_objects(declared_snapshot.get('scopeSummary'), overlay['scopeSummary'], 'Declared snapshot scope')
        compare_objects(declared_snapshot.get('verifiedScopeCounts'), counts, 'Declared verified snapshot counts')
        check(declared_snapshot.get('complete') is overlay['scopeSummary']['complete'],
              'Declared source completion differs from the bound collection')
        for record in records:
            cid, grade = str(record.get('id')), record['grade']
            check(record.get('conditionCode') == OPTIONS[grade], 'Chart condition code differs')
            if record['status'] != 'ok' or cid not in scope:
                continue
            check(record.get('brand') == scope[cid]['brand'] and record.get('range') == 'all',
                  'Chart product brand/range differs')
            actual = chart_prices(record.get('history'), cutoff)
            if latest:
                fresh_count = record.get('freshAcceptedPoints')
                check(type(fresh_count) is int and fresh_count >= 0, 'Fresh chart price count is missing')
                if fresh_count:
                    check(record.get('conditionLabelVerified') is True
                          and record.get('conditionLabel') == ('A' if grade == 'raw' else 'PSA10'),
                          'Nonempty fresh chart has no independently identified A/PSA10 option')
                for row in record['history']:
                    if not isinstance(row, dict) or row.get('sourceTimestampMs') is not None:
                        continue
                    try:
                        day = date_value(row.get('date'))
                    except (AssertionError, ValueError):
                        continue
                    existing = prices.get(cid, {}).get('grades', {}).get(grade, {}).get(day)
                    counters['archiveEchoWithoutTimestamp' if existing == row.get('price')
                             else 'unverifiedTimestampLessRowsExcluded'] += 1
                check(record.get('unitPriceVerified') is not True, 'Chart lot quantities were certified without evidence')
            if actual:
                item = prices.setdefault(cid, {'brand': scope[cid]['brand'], 'grades': {}})
                item['grades'].setdefault(grade, {}).update(actual)
        snapshots.append({'sourcePath': key, **counts, 'complete': overlay['scopeSummary']['complete']})
    retrieved = dict(admitted)
    policy = read_json(root / POLICY_PATH)
    exclusion_path = policy.get('scope', {}).get('exclusionsSourcePath')
    exclusions = {'sourcePath': None, 'sourceSha256': None, 'excludedProducts': 0, 'productIds': []}
    if exclusion_path is not None:
        excluded = verified_scope_exclusions(read_json(within(root, exclusion_path)), retrieved, cutoff)
        for cid in excluded:
            admitted.pop(cid)
            prices.pop(cid, None)
        exclusions = {'sourcePath': exclusion_path, 'sourceSha256': payload['inputFingerprints'][exclusion_path],
                      'excludedProducts': len(excluded), 'productIds': sorted(excluded, key=int)}
    all_days = [day for item in prices.values() for history in item['grades'].values() for day in history]
    check(all_days and max(all_days).isoformat() == payload['sourceAsOf'], 'Maximum actual source date differs')
    declared_paths = [row.get('sourcePath') for row in payload['sourceSummary'].get('sourceSnapshots', [])]
    check(declared_paths == snapshot_paths, 'Snapshot precedence differs from the actual collection order')
    summary = {'inputFileCount': count, 'retrievedScopeProducts': len(retrieved),
               'knownScopeProducts': len(admitted), 'priceProducts': len(prices), 'scopeExclusions': exclusions,
               'firstSourceDate': min(all_days).isoformat(), 'sourceAsOf': max(all_days).isoformat(),
               'byBrand': {brand: {'knownScopeProducts': sum(card['brand'] == brand for card in admitted.values()),
                    'retrievedScopeProducts': sum(card['brand'] == brand for card in retrieved.values()),
                    'priceProducts': sum(item['brand'] == brand for item in prices.values()),
                    'actualConditionDates': sum(len(history) for item in prices.values() if item['brand'] == brand
                                               for history in item['grades'].values())} for brand in BRANDS},
               'snapshots': snapshots, 'discoveryComplete': universe['discovery'].get('complete'),
               'pageTraversalComplete': universe['discovery'].get('pageTraversalComplete'),
               'priceCollectionComplete': snapshots[-1].get('complete') is True
                    and overlay['scopeSummary'].get('priceCollectionComplete') is True,
               'platformUniverseVerified': False, 'priceUnitVerified': False, **dict(counters)}
    declared = payload['sourceSummary']
    check(declared.get('printedLanguages') == 'all' and declared.get('latest60CacheMixed') is False
          and declared.get('excludedDailySalesHistoryContract') is True
          and declared.get('observationCutoffDate') == payload['currentJSTDate'],
          'Declared source scope/normalization differs')
    compare_objects(declared.get('admittedCatalogProducts'), len(admitted), 'Declared universe size')
    compare_objects(declared.get('retrievedCatalogProducts'), len(retrieved), 'Declared retrieved universe size')
    compare_objects(declared.get('retrievedCatalogProductsByBrand'),
                    {brand: summary['byBrand'][brand]['retrievedScopeProducts'] for brand in BRANDS},
                    'Declared per-brand retrieved universe size')
    compare_objects(declared.get('admittedCatalogProductsByBrand'),
                    {brand: summary['byBrand'][brand]['knownScopeProducts'] for brand in BRANDS},
                    'Declared per-brand universe size')
    compare_objects(declared.get('savedPriceProducts'), len(prices), 'Declared available-price products')
    compare_objects(declared.get('firstSourceDate'), summary['firstSourceDate'], 'Declared first native source date')
    compare_objects(declared.get('platformDiscovery'), universe['discovery'], 'Declared listing traversal')
    compare_objects(declared.get('scopeExclusions'), exclusions, 'Declared applied product-type exclusions')
    compare_objects(declared.get('liveCollection'), declared['sourceSnapshots'][-1], 'Declared latest collection')
    check(declared.get('universeSourceSha256') == payload['inputFingerprints'][universe_path],
          'Declared universe hash differs from the bound input')
    return prices, admitted, summary


def representative_price(history, day, window_days):
    check(type(window_days) is int and window_days > 0, 'Invalid price window')
    window = [amount for observed, amount in history.items()
              if day - timedelta(days=window_days - 1) <= observed <= day and positive(amount)]
    return statistics.median(window) if window else None


def native_count(history, cutoff, window_days):
    return sum(cutoff - timedelta(days=window_days - 1) <= day <= cutoff and positive(amount)
               for day, amount in history.items())


class PriceHistory:
    """Independent indexed actual-price windows, without synthetic carry rows."""
    def __init__(self, history):
        self.days = sorted(day for day, amount in history.items() if positive(amount))
        self.amounts = [float(history[day]) for day in self.days]

    def bounds(self, cutoff, window_days):
        return (bisect.bisect_left(self.days, cutoff - timedelta(days=window_days - 1)),
                bisect.bisect_right(self.days, cutoff))

    def window(self, cutoff, window_days):
        left, right = self.bounds(cutoff, window_days)
        return statistics.median(self.amounts[left:right]) if right > left else None

    def count(self, cutoff, window_days):
        left, right = self.bounds(cutoff, window_days)
        return right - left

    def latest_native(self, cutoff):
        right = bisect.bisect_right(self.days, cutoff)
        return self.days[right - 1] if right else None

    def eligible(self, cutoff, minimum_observations, window_days, seasoning_days):
        return bool(self.days and self.days[0] <= cutoff - timedelta(days=seasoning_days)
                    and self.count(cutoff, window_days) >= minimum_observations)


def basket_value(quantities, prices):
    check(set(quantities).issubset(prices), 'Active condition has no valuation')
    check(all(positive(q) and positive(prices[key]) for key, q in quantities.items()),
          'Zero/nonfinite quantity or valuation')
    return math.fsum(q * prices[key] for key, q in quantities.items())


def neutral_divisor(old_quantities, new_quantities, prices, old_divisor):
    check(positive(old_divisor), 'Invalid divisor')
    old_value = basket_value(old_quantities, prices)
    new_value = basket_value(new_quantities, prices)
    check(positive(old_value) and positive(new_value), 'Empty basket cannot be silently linked')
    return old_divisor * new_value / old_value


def holdings_return(quantities, previous_prices, current_prices):
    before = basket_value(quantities, previous_prices)
    after = basket_value(quantities, current_prices)
    return (after / before - 1) * 100


def load_bound_state(payload, report, data_path):
    reference = payload.get('modelStateRef')
    if reference is None:
        check(isinstance(payload.get('modelState'), dict), 'No model state or bound model-state file')
        check(report.get('modelStateRef') is None, 'Validation model-state reference differs')
        return payload['modelState'], None
    check(isinstance(reference, dict) and report.get('modelStateRef') == reference,
          'Validation model-state reference differs')
    name = reference.get('file')
    check(isinstance(name, str) and name and Path(name).name == name
          and not Path(name).is_absolute() and name not in ('.', '..'), 'Unsafe model-state file')
    directory = Path(data_path).resolve().parent
    path = (directory / name).resolve()
    check(path.parent == directory and path.is_relative_to(directory), 'Model-state file escapes output directory')
    raw = path.read_bytes()
    check(hashlib.sha256(raw).hexdigest() == reference.get('sha256'), 'Model-state hash mismatch')
    state = json.loads(raw)
    check(isinstance(state, dict) and set(state) == set(BRANDS), 'Model-state brands differ')
    return state, dict(reference)


def verify_policy(root, payload, report):
    reference = payload.get('methodPolicy')
    check(isinstance(reference, dict) and report.get('methodPolicy') == reference,
          'Validation refers to a different method policy')
    check(reference.get('path') == POLICY_PATH, 'Unexpected dynamic policy path')
    raw = (root / POLICY_PATH).read_bytes()
    sha = hashlib.sha256(raw).hexdigest()
    check(reference.get('sha256') == sha == payload['inputFingerprints'][POLICY_PATH],
          'Dynamic method policy hash differs')
    policy = json.loads(raw)
    check(policy.get('schemaVersion') == 1 and policy.get('reportKind') == 'dynamic-card-index-policy'
          and policy.get('methodId') == METHOD_ID and policy.get('configurationFrozen') is True,
          'Dynamic method policy schema or frozen configuration differs')
    check(reference.get('version') == policy.get('version')
          and reference.get('configurationFrozen') is True
          and reference.get('constituentConditionsFrozenOnAdmission') is True,
          'Applied policy version or condition-pinning status differs')
    scope = policy.get('scope', {})
    check(scope.get('source') == 'SNKRDUNK' and scope.get('brands') == list(BRANDS)
          and scope.get('printedLanguages') == 'all' and scope.get('productTypes') == ['single-card']
          and scope.get('maximumProducts') is None and scope.get('selectionUsesCurrentRankOrReturns') is False,
          'Dynamic policy reintroduces a language/ranking/count restriction')
    config = policy.get('config')
    check(isinstance(config, dict), 'Dynamic policy config is missing')
    required = {'base_date': '2024-01-01', 'window_days': 30, 'eligibility_window_days': 30,
                'minimum_observations': 3, 'seasoning_days': 30, 'review_frequency': 'monthly',
                'condition_policy': 'split-fixed', 'weighting': 'equal-amount-fixed', 'select_prediction': False}
    check(all(config.get(key) == value for key, value in required.items()),
          'Applied prior-cutoff/fixed-quantity/condition/membership recipe differs')
    check(config.get('grouping') in ('global', 'grade', 'grade_price', 'grade_set'), 'Invalid frozen grouping')
    check(all(config.get('prediction_rule_by_brand', {}).get(brand,
              config.get('prediction_rule', 'native-price-anchor')) == 'native-price-anchor' for brand in BRANDS),
          'An estimator failing the native-quote timing invariant was applied instead of kept as a benchmark')
    check(set(config.get('development_seeds', [])).isdisjoint(config.get('validation_seeds', [])),
          'Development and final holdout seeds overlap')
    for event in config.get('exit_events', []):
        check(isinstance(event, dict) and set(event) == {'productId', 'effectiveDate', 'reason', 'evidence'}
              and event['reason'] in ('verified-not-single', 'verified-out-of-scope', 'verified-market-deletion')
              and isinstance(event['evidence'], str) and bool(event['evidence'].strip()),
              'Exit has no explicit verified reason/evidence')
        date_value(event['effectiveDate'])
    check(len({str(event['productId']) for event in config.get('exit_events', [])}) == len(config.get('exit_events', [])),
          'Repeated exit events conflict with the no-reentry policy')
    return config, reference


def review_dates(baseline, source_as_of):
    dates, cursor = [baseline], baseline
    while True:
        cursor = date(cursor.year + int(cursor.month == 12), cursor.month % 12 + 1, 1)
        if cursor > source_as_of:
            break
        dates.append(cursor)
    return dates


def reconstruct_membership(prices, config, source_as_of):
    baseline = date_value(config['base_date'])
    reviews = review_dates(baseline, source_as_of)
    indexed = {cid: {grade: PriceHistory(history) for grade, history in product['grades'].items()}
               for cid, product in prices.items()}
    conditions, entries = {}, defaultdict(list)
    admitted = set()
    exits = {str(event['productId']): date_value(event['effectiveDate']) for event in config.get('exit_events', [])}
    for effective in reviews:
        cutoff = effective - timedelta(days=1)
        for cid in sorted(prices):
            if cid in admitted or cid in exits and effective >= exits[cid]:
                continue
            grades = [grade for grade in GRADES if grade in indexed[cid] and indexed[cid][grade].eligible(
                cutoff, config['minimum_observations'], config['eligibility_window_days'], config['seasoning_days'])]
            if not grades:
                continue
            admitted.add(cid)
            entries[effective].append(cid)
            for grade in grades:
                history = indexed[cid][grade]
                key = cid + ':' + grade
                initial_weight = 1 / len(grades)
                entry_price = history.window(effective, config.get('window_days', 30))
                check(positive(entry_price), 'New condition has no actual price at effective date')
                initial_quantity = (initial_weight / entry_price
                                    if config.get('weighting') == 'equal-amount-fixed' else initial_weight)
                conditions[key] = {'id': key, 'productId': cid, 'grade': grade, 'brand': prices[cid]['brand'],
                    'admissionDate': effective.isoformat(),
                    'referencePrice': history.window(cutoff, config['eligibility_window_days']),
                    'referenceSourceDate': history.latest_native(cutoff).isoformat(),
                    'eligibilityObservedDays': history.count(cutoff, config['eligibility_window_days']),
                    'firstObservedDate': history.days[0].isoformat(), 'initialQuantity': initial_quantity,
                    'initialCapitalWeight': initial_weight, 'entryPrice': entry_price,
                    'exitDate': exits[cid].isoformat() if cid in exits else None,
                    'history': history}
    return conditions, entries, reviews


def set_code(card):
    for key in ('setId', 'setCode', 'set'):
        if isinstance(card.get(key), str) and card[key]:
            return card[key]
    match = re.search(r'\[([A-Za-z]{1,5}(?:\d{1,3}[A-Za-z]?)?(?:-[A-Za-z]{1,2})?)', str(card.get('name', '')))
    return match.group(1) if match else 'unknown'


def expected_group(condition, grouping, card):
    if grouping == 'global':
        return 'all'
    if grouping == 'grade':
        return condition['grade']
    if grouping == 'grade_price':
        return condition['grade'] + ':price:' + str(bisect.bisect_right((5000, 20000, 100000), condition['referencePrice']))
    if grouping == 'grade_set':
        return condition['grade'] + ':set:' + set_code(card)
    raise AssertionError('Unsupported model grouping')


def observation_panel(conditions, days, window_days):
    values = np.full((len(conditions), len(days)), np.nan)
    latest = np.zeros(values.shape, dtype=np.int32)
    for i, condition in enumerate(conditions):
        history = condition['history']
        for j, day in enumerate(days):
            if condition.get('exitDate') is not None and day > date_value(condition['exitDate']):
                continue
            amount = history.window(day, window_days)
            if amount is not None:
                values[i, j] = amount
                latest[i, j] = history.latest_native(day).toordinal()
    return values, latest


def native_observation_panel(conditions, days):
    values = np.full((len(conditions), len(days)), np.nan)
    first, last = days[0], days[-1]
    for i, condition in enumerate(conditions):
        history = condition['history']
        for observed, amount in zip(history.days, history.amounts):
            if first <= observed <= last and (condition.get('exitDate') is None
                                             or observed <= date_value(condition['exitDate'])):
                values[i, (observed - first).days] = amount
    return values


def factor_array(raw, length, label):
    check(isinstance(raw, list) and len(raw) == length and all(value is None or positive(value) for value in raw),
          label + ': invalid factors/dates')
    return np.array([np.nan if value is None else value for value in raw])


def check_components(values, factors, raw_components, label):
    active = np.isfinite(values).any(axis=0)
    check(np.array_equal(active, np.isfinite(factors)), label + ': unidentified date was filled')
    check(isinstance(raw_components, list) and len(raw_components) == len(active)
          and all(type(component) is int for component in raw_components), label + ': invalid components')
    components = np.asarray(raw_components, dtype=int)
    check(np.array_equal(components >= 0, active), label + ': component/date identification differs')
    parents = list(range(len(active)))
    def find(x):
        while parents[x] != x:
            parents[x] = parents[parents[x]]
            x = parents[x]
        return x
    for row in np.isfinite(values):
        observed = np.flatnonzero(row)
        check(bool(len(observed)), label + ': fitted condition has no actual observation')
        anchor = int(observed[0])
        for current in observed[1:]:
            parents[find(int(current))] = find(anchor)
    root_labels, label_roots = {}, {}
    for j in np.flatnonzero(active):
        root, component = find(int(j)), int(components[j])
        check(root_labels.setdefault(root, component) == component
              and label_roots.setdefault(component, root) == root, label + ': connected components differ')
    for component in label_roots:
        anchor = int(np.flatnonzero(components == component)[0])
        close(float(factors[anchor]), 1., label + ': component factor normalization', 1e-9)
    return components


def native_ppml_scores(values, quantities, factors, native_alpha, label):
    valid = np.isfinite(values)
    actual = np.where(valid, values, 0.)
    safe_factors = np.where(np.isfinite(factors), factors, 0.)
    row_y = actual.sum(axis=1)
    row_f = valid @ safe_factors
    check(np.all(row_f > 0), label + ': condition coefficient not identified')
    recovered = row_y / row_f
    if native_alpha is None:
        native_alpha = recovered
    check(np.all(np.isfinite(native_alpha)) and np.all(native_alpha > 0), label + ': invalid coefficients')
    row_residual = row_y - native_alpha * row_f
    date_y = quantities @ actual
    date_prediction = safe_factors * ((quantities * native_alpha) @ valid)
    residual = max(float(np.max(np.abs(row_residual) / np.maximum(1., row_y))),
                   float(np.max(np.abs(date_y - date_prediction) / np.maximum(1., date_y))))
    check(residual <= 1e-8, label + ': native-price PPML normal equations fail: ' + str(residual))
    return recovered, residual


def factor_ratio(state, group, current, anchor, disclose_global_group=False):
    factors, components = state['_groupFactors'][group], state['groupComponents'][group]
    global_f, global_c = state['_globalFactors'], state['globalComponents']
    if np.isfinite(factors[current]) and np.isfinite(factors[anchor]) and components[current] == components[anchor]:
        return factors[current] / factors[anchor], bool(disclose_global_group and state['groupUsesGlobalFallback'][group])
    if np.isfinite(factors[anchor]) and np.isfinite(global_f[current]):
        available = np.flatnonzero(np.isfinite(factors[anchor:current + 1])) + anchor
        last = int(available[-1]) if len(available) else anchor
        if components[last] == components[anchor] and np.isfinite(global_f[last]) and global_c[last] == global_c[current]:
            return factors[last] / factors[anchor] * global_f[current] / global_f[last], True
    if np.isfinite(global_f[current]) and np.isfinite(global_f[anchor]) and global_c[current] == global_c[anchor]:
        return global_f[current] / global_f[anchor], True
    return None, True


def reconstructed_valuations(actual, source_dates, conditions, state, days):
    valuations = actual.copy()
    ages = np.zeros(actual.shape, dtype=np.int32)
    fallback = np.zeros(actual.shape, dtype=bool)
    for i, condition in enumerate(conditions):
        anchor = None
        for j, day in enumerate(days):
            if np.isfinite(actual[i, j]):
                anchor = j
            elif anchor is not None:
                ratio, was_fallback = factor_ratio(state, condition['groupId'], j, anchor)
                if ratio is not None:
                    valuations[i, j] = actual[i, anchor] * ratio
                    ages[i, j] = day.toordinal() - int(source_dates[i, anchor])
                    fallback[i, j] = was_fallback
    return valuations, ages, fallback


def native_window_valuations(actual, conditions, state, days, model_days, window_days, minimum_days):
    valuations = actual.copy()
    ages = np.zeros(actual.shape, dtype=np.int32)
    fallback = np.zeros(actual.shape, dtype=bool)
    support = np.zeros(actual.shape, dtype=np.int16)
    native_support = np.zeros(actual.shape, dtype=np.int16)
    ratio_cache = {}
    first = model_days[0]
    for i, condition in enumerate(conditions):
        history = condition['history']
        exit_date = date_value(condition['exitDate']) if condition.get('exitDate') is not None else None
        for j, day in enumerate(days):
            if np.isfinite(actual[i, j]):
                continue
            native_day = history.latest_native(min(day, exit_date) if exit_date is not None else day)
            if native_day is None or native_day < first:
                continue
            native_position = bisect.bisect_left(history.days, native_day)
            native_amount = history.amounts[native_position]
            anchor = (native_day - first).days
            current = (day - first).days
            key = condition['groupId'], anchor
            if key not in ratio_cache:
                ratios = np.full(len(model_days), np.nan)
                reasons = np.zeros(len(model_days), dtype=bool)
                for k in range(anchor, len(model_days)):
                    ratio, used_global = factor_ratio(state, condition['groupId'], k, anchor, True)
                    if ratio is not None:
                        ratios[k], reasons[k] = ratio, used_global
                ratio_cache[key] = ratios, reasons
            ratios, reasons = ratio_cache[key]
            start = max(0, current - window_days + 1)
            target = ratios[start:current + 1]
            known = np.isfinite(target) & (target > 0)
            support[i, j] = int(known.sum())
            native_support[i, j] = int(np.sum(known & ~reasons[start:current + 1]))
            fallback[i, j] = bool(np.any(reasons[start:current + 1][known]))
            ages[i, j] = (day - native_day).days
            if support[i, j] >= minimum_days:
                valuations[i, j] = native_amount * float(np.median(target[known]))
    return valuations, ages, fallback, support, native_support


def verify_model_state(state, conditions, days, actual, catalog, config, brand):
    check(state.get('brand') == brand and state.get('baseDate') == days[0].isoformat()
          and state.get('sourceAsOf') == days[-1].isoformat()
          and state.get('dates') == [day.isoformat() for day in days]
          and state.get('valuationWindowDays') == config['window_days'], 'Model state date/brand/window differs')
    for key, value in config.items():
        if key != 'exit_events':
            if key == 'minimum_model_factor_days' and value is None:
                value = math.ceil(config['window_days'] / 2)
            check(state.get('config', {}).get(key) == value, 'Applied model config differs from frozen policy: ' + key)
    check(state.get('exitEvents') == config.get('exit_events', []) and state.get('historicalRevisions') is True,
          'Model exit events or retrospective revision status differs')
    selected = state.get('selectedConfig', {})
    grouping = config.get('grouping_by_brand', {}).get(brand, config['grouping'])
    prediction_rule = config.get('prediction_rule_by_brand', {}).get(brand, config.get('prediction_rule', 'native-price-anchor'))
    representation = 'native-daily' if prediction_rule == 'native-price-anchor' else 'rolling-window'
    check(prediction_rule in ('native-price-anchor', 'window-price-anchor')
          and config.get('training_representation') in (None, representation), 'Frozen training representation/rule differs')
    minimum_days = config.get('minimum_model_factor_days') or math.ceil(config['window_days'] / 2)
    model_start = (days[0] - timedelta(days=max(config['window_days'], config['eligibility_window_days']))
                   if representation == 'native-daily' else days[0])
    model_days = [model_start + timedelta(days=i) for i in range((days[-1] - model_start).days + 1)]
    check(state.get('modelDates') == [day.isoformat() for day in model_days]
          and state.get('trainingRepresentation') == representation and state.get('predictionRule') == prediction_rule
          and state.get('minimumModelFactorDays') == minimum_days, 'Model native/window calendar or support rule differs')
    check(selected.get('grouping') == grouping and selected.get('predictionRule') == prediction_rule
          and selected.get('trainingRepresentation') == representation
          and selected.get('selectionUsesIndexMagnitude') is False and selected.get('selectedUsingHeldoutError') is False,
          'Operational model recipe was reselected or differs from frozen policy')
    rows = state.get('conditions')
    check(isinstance(rows, list) and len(rows) == len(conditions), 'Model constituent-condition count differs')
    check([row.get('id') for row in rows] == [condition['id'] for condition in conditions],
          'Model admitted condition identity/order differs')
    for row, condition in zip(rows, conditions):
        for key in ('productId', 'grade', 'admissionDate', 'referenceSourceDate', 'eligibilityObservedDays', 'firstObservedDate'):
            check(row.get(key) == condition[key], 'Past-only admission evidence differs: ' + condition['id'] + '/' + key)
        check(row.get('exitDate') == condition.get('exitDate'), 'Verified scope exit date differs')
        close(row.get('referencePrice'), condition['referencePrice'], 'Admission reference price')
        close(row.get('initialQuantity'), condition['initialQuantity'], 'Fixed product quantity')
        if config['weighting'] == 'equal-amount-fixed':
            close(row.get('entryPrice'), condition['entryPrice'], 'Actual effective-date entry price')
            close(row.get('initialCapitalWeight'), condition['initialCapitalWeight'], 'Initial condition capital share')
        check(row.get('setCode') == set_code(catalog.get(condition['productId'], {})), 'Product set code differs')
        check(row.get('groupId') == expected_group(condition, grouping, catalog.get(condition['productId'], {})),
              'Grouping uses another grade, future price or different set')
        condition['groupId'] = row['groupId']
    fitted_actual = native_observation_panel(conditions, model_days) if representation == 'native-daily' else actual
    quantities = np.array([condition['initialQuantity'] for condition in conditions])
    global_f = factor_array(state.get('globalFactors'), len(model_days), brand + ': global factors')
    check_components(fitted_actual, global_f, state.get('globalComponents'), brand + ': global')
    global_alpha, global_residual = native_ppml_scores(fitted_actual, quantities, global_f, None, brand + ': global')
    groups = set(condition['groupId'] for condition in conditions)
    check(set(state.get('groupFactors', {})) == groups == set(state.get('groupComponents', {}))
          == set(state.get('groupUsesGlobalFallback', {})), 'Model group universe differs')
    group_arrays, residuals = {}, {'global': global_residual}
    for group in sorted(groups):
        ix = np.array([i for i, condition in enumerate(conditions) if condition['groupId'] == group])
        factors = factor_array(state['groupFactors'][group], len(model_days), brand + ':' + group)
        product_count = len({conditions[i]['productId'] for i in ix})
        uses_global_fit = grouping == 'global' or product_count < config['minimum_group_products']
        disclosed_fallback = grouping != 'global' and product_count < config['minimum_group_products']
        check(state['groupUsesGlobalFallback'][group] is disclosed_fallback, 'Thin group fallback rule differs')
        alpha = np.array([rows[i]['alpha'] * conditions[i]['referencePrice'] for i in ix])
        if uses_global_fit:
            check(np.array_equal(factors, global_f, equal_nan=True)
                  and state['groupComponents'][group] == state['globalComponents'], 'Thin group is not the global model')
            check(np.allclose(alpha, global_alpha[ix], rtol=1e-8, atol=1e-7), 'Thin-group coefficients differ')
            residuals[group] = global_residual
        else:
            check_components(fitted_actual[ix], factors, state['groupComponents'][group], brand + ':' + group)
            _, residuals[group] = native_ppml_scores(fitted_actual[ix], quantities[ix], factors, alpha, brand + ':' + group)
        group_arrays[group] = factors
    state['_globalFactors'], state['_groupFactors'] = global_f, group_arrays
    state['_modelDays'], state['_predictionRule'], state['_minimumFactorDays'] = model_days, prediction_rule, minimum_days
    return residuals


def native_breadth(conditions, active, prices, day):
    now, previous = {}, {}
    yesterday = day - timedelta(days=1)
    for key in active:
        condition = conditions[key]
        history = prices[condition['productId']]['grades'][condition['grade']]
        if day in history:
            now[key] = history[day]
        if yesterday in history:
            previous[key] = history[yesterday]
    paired = set(now) & set(previous)
    by_product = defaultdict(list)
    for key in paired:
        by_product[conditions[key]['productId']].append(now[key] / previous[key])
    relatives = [statistics.mean(ratios) for ratios in by_product.values()]
    up = sum(ratio > 1 and not math.isclose(ratio, 1, abs_tol=1e-12, rel_tol=0) for ratio in relatives)
    down = sum(ratio < 1 and not math.isclose(ratio, 1, abs_tol=1e-12, rel_tol=0) for ratio in relatives)
    current_ids = {conditions[key]['productId'] for key in now}
    previous_ids = {conditions[key]['productId'] for key in previous}
    matched = len(by_product)
    return {'sourceObservedProducts': len(current_ids), 'sourceObservedConditions': len(now),
        'matchedProducts': matched, 'matchedConditions': len(paired), 'up': up, 'down': down,
        'flat': matched - up - down, 'newObservedProducts': len(current_ids - previous_ids),
        'unpairedProducts': len(current_ids) - matched, 'upRatio': up / matched if matched else None,
        'pairCoverageRatio': matched / len(current_ids) if current_ids else None}


def verify_brand(payload, state, prices, catalog, expected, entries, reviews, config, brand):
    series = payload['series'][brand]
    baseline, source_day = date_value(payload['baseDate']), date_value(payload['sourceAsOf'])
    days = [baseline + timedelta(days=i) for i in range((source_day - baseline).days + 1)]
    check([point.get('date') for point in series.get('points', [])] == [day.isoformat() for day in days],
          'Daily calendar is missing or repeats dates')
    conditions = [condition for condition in expected.values() if condition['brand'] == brand]
    actual, source_dates = observation_panel(conditions, days, config['window_days'])
    residuals = verify_model_state(state, conditions, days, actual, catalog, config, brand)
    if state['_predictionRule'] == 'native-price-anchor':
        valuations, ages, fallback, support, native_support = native_window_valuations(actual, conditions, state, days,
            state['_modelDays'], config['window_days'], state['_minimumFactorDays'])
    else:
        valuations, ages, fallback = reconstructed_valuations(actual, source_dates, conditions, state, days)
        support = np.isfinite(valuations).astype(np.int16)
        native_support = support
    condition_map = {condition['id']: condition for condition in conditions}
    row_map = {condition['id']: i for i, condition in enumerate(conditions)}
    by_product = defaultdict(list)
    for condition in conditions:
        by_product[condition['productId']].append(condition['id'])
    quantity, divisor, audit_reviews = {}, None, []
    previous_value, previous_sum, peak = None, None, None
    base_grade_exposure, current_grade_exposure = None, None
    point_checks = 0
    for j, (day, point) in enumerate(zip(days, series['points'])):
        daily_prices = {condition['id']: float(valuations[i, j]) for i, condition in enumerate(conditions)
                        if np.isfinite(valuations[i, j])}
        old_known = set(quantity).issubset(daily_prices)
        old_sum = basket_value(quantity, daily_prices) if quantity and old_known else None
        before_divisor = divisor
        entering = [cid for cid in entries.get(day, []) if cid in by_product]
        leaving = [event for event in config.get('exit_events', []) if date_value(event['effectiveDate']) == day
                   and str(event['productId']) in {condition_map[key]['productId'] for key in quantity}]
        proposed = dict(quantity)
        for event in leaving:
            for key in by_product[str(event['productId'])]:
                proposed.pop(key, None)
        for cid in entering:
            for key in by_product[cid]:
                proposed[key] = condition_map[key]['initialQuantity']
        if proposed != quantity:
            check(day in reviews or leaving, 'Membership changed outside its scheduled/verified event')
            new_sum = basket_value(proposed, daily_prices)
            old_observed = math.fsum(q * daily_prices[key] for key, q in quantity.items()
                                    if np.isfinite(actual[row_map[key], j])) if quantity else None
            new_observed = math.fsum(q * daily_prices[key] for key, q in proposed.items()
                                    if np.isfinite(actual[row_map[key], j]))
            divisor = new_sum / 100 if divisor is None else neutral_divisor(quantity, proposed, daily_prices, divisor)
            check(positive(divisor), 'Invalid continuity divisor')
            before_level = old_sum / before_divisor if before_divisor is not None else 100.
            close(new_sum / divisor, before_level, 'Membership change generated a return')
            quantity = proposed
            audit_reviews.append({'effectiveDate': day.isoformat(), 'cutoff': (day - timedelta(days=1)).isoformat(),
                'initial': before_divisor is None, 'entrants': entering, 'exits': leaving, 'oldValue': old_sum,
                'newValue': new_sum, 'divisorBefore': before_divisor, 'divisorAfter': divisor,
                'oldObservedValue': old_observed,
                'oldEstimatedValue': old_sum - old_observed if old_sum is not None else None,
                'oldEstimatedValueSharePct': (old_sum - old_observed) / old_sum * 100 if old_sum else None,
                'newObservedValue': new_observed, 'newEstimatedValue': new_sum - new_observed,
                'newEstimatedValueSharePct': (new_sum - new_observed) / new_sum * 100,
                'priceLevelBeforeReview': before_level, 'priceLevelAfterReview': new_sum / divisor,
                'holdings': [{'conditionId': key, 'quantity': q} for key, q in sorted(quantity.items(), key=lambda x: row_map[x[0]])]})
        check(quantity and divisor is not None, 'No supported baseline basket')
        valid = set(quantity).issubset(daily_prices)
        observed_keys = [key for key in quantity if np.isfinite(actual[row_map[key], j])]
        observed_set = set(observed_keys)
        missing_keys = [key for key in quantity if key not in observed_set]
        observed_sum = math.fsum(quantity[key] * daily_prices[key] for key in observed_keys)
        estimated_sum = math.fsum(quantity[key] * daily_prices[key] for key in missing_keys) if valid else None
        total = observed_sum + estimated_sum if valid else None
        value = total / divisor if valid else None
        ids = {condition_map[key]['productId'] for key in quantity}
        observed_ids = {condition_map[key]['productId'] for key in observed_keys}
        fully_observed = {cid for cid in ids if all(key in observed_set for key in by_product[cid] if key in quantity)}
        stale_keys = [key for key in missing_keys if ages[row_map[key], j] > config['stale_after_days']]
        stale_sum = math.fsum(quantity[key] * daily_prices[key] for key in stale_keys) if valid else None
        product_values = defaultdict(float)
        if valid:
            for key, q in quantity.items():
                product_values[condition_map[key]['productId']] += q * daily_prices[key]
        grade_values = {grade: math.fsum(q * daily_prices[key] for key, q in quantity.items()
                        if condition_map[key]['grade'] == grade) for grade in GRADES} if valid else None
        grade_exposure = {grade: amount / total * 100 for grade, amount in grade_values.items()} if valid else None
        if j == 0:
            base_grade_exposure = grade_exposure
        current_grade_exposure = grade_exposure
        if 'gradeValueSharePct' in point:
            compare_objects(point['gradeValueSharePct'], grade_exposure, brand + '/' + day.isoformat() + '/gradeExposure')
        expected_point = {'value': value, 'logIndex': math.log(value / 100) if value else None,
            'dailyReturn': (value / previous_value - 1) * 100 if value and previous_value else None,
            'valueSum': total, 'divisor': divisor,
            'priceChangeBeforeReviewPct': (old_sum / previous_sum - 1) * 100 if old_sum and previous_sum else None,
            'observedContribution': observed_sum / divisor, 'estimatedContribution': estimated_sum / divisor if valid else None,
            'observedValueSharePct': observed_sum / total * 100 if valid else None,
            'estimatedValueSharePct': estimated_sum / total * 100 if valid else None,
            'staleEstimatedValueSharePct': stale_sum / total * 100 if valid else None,
            'observedProducts': len(observed_ids), 'observedConditions': len(observed_keys),
            'fullyObservedProducts': len(fully_observed), 'estimatedProducts': len(ids - fully_observed),
            'estimatedConditions': len(missing_keys), 'basketProducts': len(ids), 'basketConditions': len(quantity),
            'fixedBasketProducts': len(ids), 'fixedBasketConditions': len(quantity),
            'newlyAdmittedProducts': len(entering), 'verifiedExitProducts': len(leaving),
            'fallbackEstimatedConditions': sum(bool(fallback[row_map[key], j]) for key in missing_keys),
            'estimatedFactorWindowDays': config['window_days'] if state['_predictionRule'] == 'native-price-anchor' else 1,
            'minimumEstimatedFactorSupportDays': min(int(support[row_map[key], j]) for key in missing_keys) if missing_keys else None,
            'medianEstimatedFactorSupportDays': statistics.median(int(support[row_map[key], j]) for key in missing_keys) if missing_keys else None,
            'minimumEstimatedNativeGroupSupportDays': min(int(native_support[row_map[key], j]) for key in missing_keys) if missing_keys else None,
            'medianEstimatedSourceAgeDays': statistics.median(int(ages[row_map[key], j]) for key in missing_keys) if missing_keys and valid else None,
            'maxEstimatedSourceAgeDays': max(int(ages[row_map[key], j]) for key in missing_keys) if missing_keys and valid else None,
            'top10ProductValueSharePct': math.fsum(sorted(product_values.values(), reverse=True)[:10]) / total * 100 if valid else None,
            **native_breadth(condition_map, quantity, prices, day)}
        for key, expected_value in expected_point.items():
            close(point.get(key), expected_value, brand + '/' + day.isoformat() + '/' + key)
            point_checks += 1
        check(point.get('provisional') is (day.isoformat() == payload['currentJSTDate']), 'Provisional date differs')
        status = ('fully-observed-basket' if valid and not missing_keys else
                  'actual-and-estimated-basket' if valid else 'unidentified-basket-price')
        check(point.get('status') == status, 'Actual/estimated/unidentified status differs')
        if value is not None and (peak is None or value > peak['value']):
            peak = {'date': day.isoformat(), 'value': value}
        previous_value, previous_sum = value, total
    compare_objects(state.get('reviews'), audit_reviews, brand + '/membershipReviews')
    check(state.get('reviewDates') == [day.isoformat() for day in reviews],
          brand + ': scheduled monthly review dates differ')
    known = [point for point in series['points'] if point['value'] is not None]
    check(known and series['firstCalculatedDate'] == known[0]['date'] and series['lastCalculatedDate'] == known[-1]['date'],
          'Calculated availability dates differ')
    diagnostics = series['diagnostics']
    check(diagnostics.get('divisorUsesEstimatedReviewPrices') is
          any((review['oldEstimatedValueSharePct'] or 0) > 1e-10 for review in audit_reviews),
          brand + ': composition-price estimation reliance is misstated')
    close(diagnostics.get('maxReviewOldEstimatedValueSharePct'),
          max((review['oldEstimatedValueSharePct'] or 0) for review in audit_reviews),
          brand + '/maxReviewOldEstimatedValueSharePct')
    check(diagnostics.get('membershipReviewCount') == len(audit_reviews)
          and diagnostics.get('scheduledMonthlyReviews') == len(reviews),
          brand + ': monthly review counts differ')
    compare_objects(diagnostics.get('peak'), peak, brand + '/peak')
    drawdown = (known[-1]['value'] / peak['value'] - 1) * 100
    close(diagnostics.get('drawdownPct'), drawdown, brand + '/drawdown')
    close(known[0]['value'], 100., brand + '/base')
    check(peak['value'] >= known[-1]['value'], 'Peak is below the latest calculated level')
    latest = known[-1]
    gogh = {condition['id']: {'admissionDate': condition['admissionDate'],
            'initialQuantity': condition['initialQuantity'], 'referencePrice': condition['referencePrice'],
            'currentValuation': (float(valuations[row_map[condition['id']], -1])
                                  if np.isfinite(valuations[row_map[condition['id']], -1]) else None),
            'currentContribution': (quantity.get(condition['id'], 0) * float(valuations[row_map[condition['id']], -1]) / divisor
                                    if np.isfinite(valuations[row_map[condition['id']], -1]) else None)}
            for condition in conditions if condition['productId'] == '146897'}
    return {'dailyPoints': len(days), 'pointFieldsChecked': point_checks, 'firstDate': known[0]['date'],
        'lastDate': latest['date'], 'current': latest['value'], 'peak': peak, 'drawdownPct': drawdown,
        'baseProducts': known[0]['basketProducts'], 'currentProducts': latest['basketProducts'],
        'baseConditions': known[0]['basketConditions'], 'currentConditions': latest['basketConditions'],
        'observedValueSharePct': latest['observedValueSharePct'], 'estimatedValueSharePct': latest['estimatedValueSharePct'],
        'staleEstimatedValueSharePct': latest['staleEstimatedValueSharePct'],
        'top10ProductValueSharePct': latest['top10ProductValueSharePct'],
        'baseGradeValueSharePct': base_grade_exposure, 'currentGradeValueSharePct': current_grade_exposure,
        'currentGradeConditions': {grade: sum(condition_map[key]['grade'] == grade for key in quantity) for grade in GRADES},
        'monthlyCompositionChanges': len(audit_reviews), 'ppmlNativeScoreResiduals': residuals,
        'divisorUsesEstimatedReviewPrices': diagnostics['divisorUsesEstimatedReviewPrices'],
        'maxReviewOldEstimatedValueSharePct': diagnostics['maxReviewOldEstimatedValueSharePct'],
        'goghConditions': gogh, 'goghIncluded': bool(gogh)}


def compare_objects(actual, expected, label):
    if isinstance(expected, dict):
        check(isinstance(actual, dict), label + ': missing object')
        for key, value in expected.items():
            compare_objects(actual.get(key), value, label + '/' + key)
    elif isinstance(expected, list):
        check(isinstance(actual, list) and len(actual) == len(expected), label + ': list length differs')
        for i, (value, wanted) in enumerate(zip(actual, expected)):
            compare_objects(value, wanted, label + '/' + str(i))
    elif type(expected) is float:
        close(actual, expected, label)
    else:
        check(type(actual) is type(expected) and actual == expected, label + ': value differs')


def verify_weekly(payload):
    source_day, base = date_value(payload['sourceAsOf']), date_value(payload['baseDate'])
    sunday = source_day - timedelta(days=(source_day.weekday() + 1) % 7)
    check(payload.get('latestCompleteWeekEnd') == sunday.isoformat(), 'Weekly cutoff differs')
    count = 0
    for brand in BRANDS:
        expected = []
        for daily in payload['series'][brand]['points']:
            day = date_value(daily['date'])
            if day > sunday or day != base and day.weekday() != 6:
                continue
            point = dict(daily)
            point.update(periodStart=max(base, day - timedelta(days=6)).isoformat(), periodEnd=day.isoformat(), dailyReturn=None,
                weeklyReturn=((point['value'] / expected[-1]['value'] - 1) * 100
                    if expected and positive(point['value']) and positive(expected[-1]['value'])
                    and day - date_value(expected[-1]['date']) == timedelta(days=7) else None))
            expected.append(point)
        compare_objects(payload['weeklySeries'][brand]['points'], expected, brand + '/weeklySameDailyIndex')
        count += len(expected)
    return count


def historical_surge_evidence(rows, source_day, window_days):
    """Actual fixed-quantity path; no estimated day or grade substitution."""
    check(rows and len({row['productId'] for row in rows}) == 1, 'Stress path mixes product identities')
    cid = rows[0]['productId']
    admission = date_value(rows[0]['admissionDate'])
    blackout_start = source_day - timedelta(days=29)
    if admission >= blackout_start or any(
            row.get('exitDate') is not None and date_value(row['exitDate']) < source_day
            or row['history'].latest_native(blackout_start - timedelta(days=1)) is None
            or row['history'].window(source_day, window_days) is None for row in rows):
        return None
    path = []
    for i in range((source_day - admission).days + 1):
        day = admission + timedelta(days=i)
        prices = [row['history'].window(day, window_days) for row in rows]
        if all(price is not None for price in prices):
            path.append((day, math.fsum(row['initialQuantity'] * price for row, price in zip(rows, prices))))
    if not path:
        return None
    peak_day, peak_value = max(path, key=lambda point: point[1])
    low_day, low_value = min((point for point in path if point[0] <= peak_day), key=lambda point: point[1])
    current_value = path[-1][1]
    if peak_value / low_value < 10 or current_value / peak_value > .8:
        return None
    return {'productId': cid, 'admissionDate': admission.isoformat(), 'pathStartDate': path[0][0].isoformat(),
        'pathActualWindowPoints': len(path), 'troughDate': low_day.isoformat(), 'peakDate': peak_day.isoformat(),
        'troughValueJPY': low_value, 'peakValueJPY': peak_value, 'currentValueJPY': current_value,
        'peakMultiple': peak_value / low_value, 'drawdownPct': (current_value / peak_value - 1) * 100}


def verify_forecast_metadata(payload, config, expected):
    """Verify target separation and actual truth, without certifying predictions."""
    output = {}
    source_day = date_value(payload['sourceAsOf'])
    known_products = {brand: {condition['productId'] for condition in expected.values() if condition['brand'] == brand}
                      for brand in BRANDS}
    validation = payload['dynamicValidation'].get('predictionValidation')
    check(isinstance(validation, dict) and set(validation) == set(BRANDS), 'Final forecast-validation brands differ')
    for brand, result in validation.items():
        if result.get('notRun') is True:
            check(config.get('validate_holdouts') is False, 'Required forecast checks were silently skipped')
            output[brand] = {'notRun': True}
            continue
        check(result.get('phase') == 'validation' and result.get('selectionScore') is None
              and result.get('selectionUsesIndexMagnitude') is False
              and result.get('tailTestsReusedFromDevelopment') is False,
              'Final forecast target tests were reused as a model/curve selection score')
        checked, targets = [], set()
        tests = result.get('tests')
        check(isinstance(tests, list), 'Final forecast tests are missing')
        stress_tests = [test for test in tests if test.get('kind') == 'historical-surge-then-drawdown']
        check(len(stress_tests) <= 1, 'Historical surge/drawdown stress test was duplicated')
        stress_evidence = []
        if config.get('validate_holdouts') is True:
            by_product = defaultdict(list)
            for condition in expected.values():
                if condition['brand'] == brand and hashlib.sha256(
                        ('dynamic-card-index-validation-v1:' + brand + ':' + condition['productId']).encode()).digest()[0] % 2 == 1:
                    by_product[condition['productId']].append(condition)
            stress_evidence = [evidence for cid in sorted(by_product)
                if (evidence := historical_surge_evidence(by_product[cid], source_day, config['window_days'])) is not None]
            check(bool(stress_tests) is bool(stress_evidence),
                  'Historical surge/drawdown stress test is missing despite qualifying actual-price targets')
        if stress_tests:
            stress = stress_tests[0]
            check(stress.get('durationDays') == 30 and stress.get('seed') is None,
                  'Historical surge/drawdown stress mask period differs')
            check(stress.get('heldoutProductIds') == [item['productId'] for item in stress_evidence],
                  'Historical surge/drawdown targets differ from the complete actual-source selection rule')
            compare_objects(stress.get('stressProducts'), stress_evidence, 'Actual historical surge/drawdown source evidence')
        for test in tests:
            check(test.get('productPartition') == 'validation' and test.get('independentFromSelection') is True
                  and test.get('usedForPredictorSelection') is False, 'Forecast targets overlap the development role')
            ids = test.get('heldoutProductIds')
            check(isinstance(ids, list) and len(ids) == len(set(ids))
                  and test.get('heldoutProducts') == len(ids), 'Forecast target IDs/count differ')
            for cid in ids:
                check(type(cid) is str and hashlib.sha256(
                    ('dynamic-card-index-validation-v1:' + brand + ':' + cid).encode()).digest()[0] % 2 == 1,
                    'Final forecast target is a development-partition product')
                check(cid in known_products[brand],
                      'Forecast target is outside the actual admitted brand cohort')
            targets.update(ids)
            id_set = set(ids)
            rows = [condition for condition in expected.values()
                    if condition['brand'] == brand and condition['productId'] in id_set
                    and condition['history'].window(source_day, config['window_days']) is not None]
            actual_value = math.fsum(condition['initialQuantity'] * condition['history'].window(source_day, config['window_days'])
                                     for condition in rows)
            check(test.get('heldoutKnownConditions') == len(rows), 'Held-out actual condition denominator differs')
            if test.get('unidentified') is not True:
                close(test.get('actualValueJPY'), actual_value, 'Held-out actual fixed-quantity source value')
                estimate = test.get('estimatedValueJPY')
                check(positive(estimate), 'Held-out estimate total is invalid')
                close(test.get('valueBiasPct'), (estimate / actual_value - 1) * 100, 'Forecast aggregate bias equation')
                check(type(test.get('valueAbsoluteErrorPct')) in (int, float)
                      and test['valueAbsoluteErrorPct'] + 1e-8 >= abs(test['valueBiasPct']),
                      'Absolute forecast error is below absolute aggregate bias')
            checked.append({'kind': test.get('kind'), 'seed': test.get('seed'), 'durationDays': test.get('durationDays'),
                            'heldoutProducts': len(ids), 'actualSourceValueIndependentlyChecked': True,
                            'predictionIndependentlyRefitted': False})
        output[brand] = {'targetTestsChecked': len(checked), 'distinctFinalTargets': len(targets), 'tests': checked,
                         'historicalSurgeDrawdownEvidence': stress_evidence,
                         'forecastIsExternalFutureValidation': False}
    return output


def verify(root, data_path, report_path, allow_incomplete_source=False):
    raw = data_path.read_bytes()
    payload, report = json.loads(raw), read_json(report_path)
    sha = hashlib.sha256(raw).hexdigest()
    check(payload.get('schemaVersion') == 1 and payload.get('reportKind') == 'market-price-index'
          and payload.get('source') == 'SNKRDUNK' and payload.get('currency') == 'JPY'
          and payload.get('targetLanguage') == 'all' and payload.get('referenceOnly') is True,
          'Published dynamic price reference source/scope differs')
    check(report.get('schemaVersion') == 1 and report.get('reportKind') == 'market-price-index-validation'
          and report.get('status') in ('candidate', 'passed') and report.get('dataSha256') == sha,
          'Validation is not bound to these exact data bytes')
    flags = {'priceUnitVerified': False, 'languageVerified': False,
             'representativeMarketIndex': False, 'statisticalConfidenceValidated': False}
    check(payload.get('strictFlags') == flags == report.get('strictFlags')
          and report.get('calculationOnly') is True and report.get('marketReady') is False,
          'Computational audit was promoted to market/unit/confidence certification')
    check(payload['methodology'].get('id') == METHOD_ID == report.get('methodId')
          and payload['methodology'].get('printedLanguageRestriction') is None
          and payload['methodology'].get('maximumProducts') is None
          and payload['methodology'].get('marketCapitalizationIndex') is False,
          'Dynamic method identifier/market-cap/ranking restriction differs')
    method = payload['methodology']
    semantics = {'weighting': 'equal-amount-fixed', 'conditionPolicy': 'split-fixed',
        'fixedBasket': False, 'fixedQuantitiesBetweenReviews': True, 'observationsOnly': False,
        'quantityWeights': False, 'carryDays': 0, 'priceAbsenceCausesDeletion': False,
        'conditionAdditionPolicy': 'none: conditions fixed at first product admission',
        'eligibilityWindowDays': 30, 'minimumActualObservedDates': 3, 'minimumHistoryAgeDays': 30,
        'valuationWindowDays': 30, 'modelFitUsesFutureHistoricalObservations': True,
        'admissionUsesFuturePrices': False, 'dailyEqualReturnChaining': False,
        'historicalRevisions': True, **flags}
    check(all(method.get(key) == value for key, value in semantics.items()),
          'Declared dynamic method semantics differ from the audited equal-initial-amount recipe')
    config, policy_ref = verify_policy(root, payload, report)
    prices, catalog, source_summary = reconstruct_sources(root, payload, report)
    source_complete = (source_summary['priceCollectionComplete'] is True
                       and source_summary['discoveryComplete'] is True
                       and source_summary['pageTraversalComplete'] is True)
    check(source_complete or allow_incomplete_source,
          'Known-universe price collection or declared listing traversal is still incomplete; candidate math cannot activate the index')
    state, state_ref = load_bound_state(payload, report, data_path)
    compare_objects(method.get('selectedPrediction'),
                    {brand: state[brand].get('selectedConfig') for brand in BRANDS},
                    'Declared per-brand predictor recipe')
    check(all(state[brand].get('selectedConfig', {}).get('predictionRule') == 'native-price-anchor'
              and state[brand]['selectedConfig'].get('eligibleForAppliedSelection') is True for brand in BRANDS),
          'The applied predictor failed its required native-quote timing invariant')
    close(method.get('nativeModelMinimumFactorDays'),
          config.get('minimum_model_factor_days') or math.ceil(config['window_days'] / 2),
          'Declared native factor-window minimum support')
    source_day = date_value(payload['sourceAsOf'])
    conditions, entries, reviews = reconstruct_membership(prices, config, source_day)
    summaries = {}
    for brand in BRANDS:
        summaries[brand] = verify_brand(payload, state[brand], prices, catalog, conditions, entries, reviews, config, brand)
    check(summaries['pokemon']['goghIncluded'] is True, 'English Gogh card did not reach the equal-initial-amount basket')
    weekly_count = verify_weekly(payload)
    check(payload.get('dynamicValidation') == report.get('dynamicValidation'), 'Dynamic validation metadata differs')
    gates = report.get('numericalGates')
    check(isinstance(gates, list) and {test.get('id') for test in gates} ==
          {'arithmetic-price-sum', 'divisor-neutral-entry-exit', 'fixed-quantity-roundtrip'}
          and len(gates) == 3 and all(test.get('passed') is True for test in gates),
          'Producer economic gate is absent, unsupported or failed')
    from verify_market_price_index_independent import verify_price_evidence
    evidence_prices = {cid: {'brand': item['brand'], 'values': item['grades']} for cid, item in prices.items()}
    evidence = verify_price_evidence(payload, evidence_prices, report)
    forecast_metadata = verify_forecast_metadata(payload, config, conditions)
    # Collection jobs may replace their checkpoints while the slower numerical
    # audit runs. Recheck every bound input before claiming an exact-source pass.
    verify_fingerprints(root, payload, report)
    return {'schemaVersion': 1, 'reportKind': 'dynamic-card-price-index-independent-verification',
        'status': 'passed' if source_complete else 'candidate', 'checkedAt': datetime.now(JST).isoformat(),
        'dataSha256': sha, 'methodId': METHOD_ID,
        'modelStateRef': state_ref, 'methodPolicy': policy_ref, 'inputFingerprints': payload['inputFingerprints'],
        'calculationOnly': True, 'marketReady': False, 'strictFlags': flags,
        'checksPassed': sum(item['pointFieldsChecked'] for item in summaries.values()) + weekly_count + 6,
        'errors': [], 'sourceSummary': source_summary, 'seriesSummary': summaries, 'priceEvidence': evidence,
        'economicChecks': ['fixed-quantity price round trip', 'neutral entry/verified exit/condition composition',
                           'prior-cutoff native-date eligibility and seasoning', 'fixed grades and equal admission capital per product',
                           'native-JPY PPML normal equations and actual connected components',
                           'actual window medians preserved; missing same-condition anchor prices independently reconstructed',
                           'all daily value/divisor/contributions/breadth/stale shares', 'same daily index weekly sample',
                           'peak >= current and exact daily drawdown'],
        'producerReportedPredictionValidation': payload['dynamicValidation'].get('predictionValidation'),
        'independentlyCheckedForecastTargetsAndActualValues': forecast_metadata,
        'independentlyRecomputedForecastExperiment': False,
        'sourceEvidence': SOURCE_EVIDENCE,
        'limitations': ['Known publicly discoverable all-language singles, not a certified complete historical platform universe.',
                       'API chart amounts do not contain verified per-copy quantities; source price units remain uncertified.',
                       'Missing prices are model estimates; equations passing does not validate nonrandom missing-price accuracy.',
                       'Reference prices are actual trailing medians, not executable portfolio transaction prices.',
                       'Initial operating baseline is 2024, not a literal market return from one-card 2022 archives.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--data', type=Path)
    parser.add_argument('--report', type=Path)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--allow-incomplete-source', action='store_true',
                        help='Reconstruct a checkpoint; proof remains candidate and cannot activate the UI')
    args = parser.parse_args()
    root = args.root.resolve()
    data_path = args.data or root / 'data/market-price-index.json'
    report_path = args.report or data_path.parent / 'market-price-index-validation.json'
    try:
        output = verify(root, data_path, report_path, args.allow_incomplete_source)
    except (AssertionError, KeyError, ValueError, OSError) as exc:
        print(json.dumps({'status': 'failed', 'error': str(exc)}, ensure_ascii=False))
        return 1
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(output, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n', encoding='utf-8')
    print(json.dumps({key: output[key] for key in ('status', 'methodId', 'dataSha256', 'checksPassed', 'seriesSummary')},
                     ensure_ascii=False, separators=(',', ':')))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
