"""Build an all-language SNKRDUNK index with fixed virtual quantities.

Legacy histories remain read-only. Public chart snapshots overlay positive
matching condition/date observations; absent days never erase prior records.
"""
from __future__ import annotations

import argparse
import gzip
import json
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path

import build_market_price_index as source

UNIVERSE = 'data/card-index-platform-universe-20261012.json'
PLATFORM_HISTORY = 'data/card-index-platform-history-20261012.json'
POLICY = 'data/market-price-index-dynamic-policy.json'


def single_catalog(rows):
    groups = defaultdict(list)
    for row in rows:
        if isinstance(row, dict):
            groups[str(row.get('id'))].append(row)
    return {cid: values[0] for cid, values in groups.items()
            if cid.isdigit() and len(values) == 1 and values[0].get('brand') in source.BRANDS
            and str(values[0].get('kind', '')).casefold() in source.SINGLE_KINDS}


def load_inputs(root=source.ROOT, universe=None, platform_history=None):
    root = Path(root).resolve()
    if universe is None and platform_history is None:
        stable = ('data/card-index-platform-universe.json', 'data/card-index-platform-history.json')
        universe, platform_history = stable if all((root / key).is_file() for key in stable) else (UNIVERSE, PLATFORM_HISTORY)
    if universe is None or platform_history is None:
        raise ValueError('Select the universe and its bound history together')
    fingerprints, counters = {}, Counter()
    def read(key):
        path = (root / key).resolve()
        if not path.is_relative_to(root):
            raise ValueError('Input path escapes selected source directory')
        raw = path.read_bytes()
        fingerprints[path.relative_to(root).as_posix()] = source.digest(raw)
        return json.loads(gzip.decompress(raw) if path.suffix == '.gz' else raw)
    old_catalog = read('data/cards-meta.json')
    old_admitted = single_catalog(old_catalog['cards'])
    discovery = read(universe)
    if (discovery.get('reportKind') != 'card-index-platform-universe'
            or discovery.get('source') != 'SNKRDUNK'
            or discovery.get('catalogReference', {}).get('sha256') != fingerprints['data/cards-meta.json']):
        raise ValueError('Platform-universe provenance differs from catalog')
    discovered = single_catalog(discovery['products'])
    admitted = {**old_admitted, **discovered}
    cutoff = datetime.now(source.JST).date()
    products = {}
    for path in sorted((root / 'data/history').glob('*.json')):
        counters['historyFilesRead'] += 1
        try:
            payload = read(path.relative_to(root).as_posix())
        except (ValueError, UnicodeError):
            counters['invalidHistoryFiles'] += 1
            continue
        cid = path.stem
        if cid not in admitted or not isinstance(payload, dict) or str(payload.get('id')) != cid:
            continue
        grades = source.extract(payload, cutoff, counters)
        if grades:
            products[cid] = {'brand': admitted[cid]['brand'], 'grades': grades}
    snapshots = []
    for key in ['data/market-price-index-live-history-20261011.json',
                'data/market-price-index-live-history-20261012.json', platform_history]:
        payload = read(key)
        if key != platform_history and payload.get('targetFingerprint') != fingerprints['data/cards-meta.json']:
            snapshots.append({'sourcePath': key, 'sourceSha256': fingerprints[key],
                              'skipped': 'catalog-fingerprint-changed', 'complete': False})
            continue
        if key == platform_history and (payload.get('universeFingerprint') != fingerprints[universe]
                                        or payload.get('universePath') != universe):
            raise ValueError('Platform history is not bound to the selected universe')
        # Earlier snapshots certified the then Japanese-language catalog only.
        # Their completeness assertion is evaluated against that exact scope.
        scope = ({cid: row for cid, row in old_admitted.items() if not source.foreign(row)}
                 if key != platform_history else admitted)
        result = source.merge_live_overlay(payload, scope, products,
                                            fingerprints['data/cards-meta.json'], cutoff, counters)
        result.update(sourcePath=key, sourceSha256=fingerprints[key])
        snapshots.append(result)
    # Public single-card listings can contain confirmed mixed-card sets.
    # Finish checking the entire retrieved source before applying explicit
    # product-type corrections; a price gap is never an exclusion reason.
    retrieved = dict(admitted)
    exclusion_summary = {'sourcePath': None, 'sourceSha256': None,
                         'excludedProducts': 0, 'productIds': []}
    policy = read(POLICY)
    exclusion_path = policy.get('scope', {}).get('exclusionsSourcePath')
    if exclusion_path:
        exclusions = read(exclusion_path)
        if (exclusions.get('schemaVersion') != 1
                or exclusions.get('reportKind') != 'card-index-platform-scope-exclusions'
                or exclusions.get('source') != 'SNKRDUNK'
                or not isinstance(exclusions.get('exclusions'), list)):
            raise ValueError('Invalid explicit single-card scope corrections')
        seen = set()
        for item in exclusions['exclusions']:
            cid = item.get('productId')
            if (cid not in retrieved or cid in seen
                    or item.get('reason') != 'verified-not-single'
                    or item.get('appliesTo') != 'all-observed-history'
                    or not isinstance(item.get('evidence'), str) or not item['evidence'].strip()
                    or not str(item.get('evidenceUrl', '')).startswith('https://snkrdunk.com/')
                    or date.fromisoformat(item['verifiedAt']) > cutoff):
                raise ValueError('Unsubstantiated single-card scope exclusion')
            seen.add(cid)
            admitted.pop(cid)
            products.pop(cid, None)
        exclusion_summary = {'sourcePath': exclusion_path,
                             'sourceSha256': fingerprints[exclusion_path],
                             'excludedProducts': len(seen), 'productIds': sorted(seen, key=int)}
    all_days = [day for product in products.values() for history in product['grades'].values() for day in history]
    if not all_days:
        raise ValueError('No positive condition-specific observations')
    return products, max(all_days), fingerprints, {
        **dict(counters), 'catalogAsOf': old_catalog.get('fetchedAt'),
        'retrievedCatalogProducts': len(retrieved),
        'retrievedCatalogProductsByBrand': {brand: sum(row['brand'] == brand for row in retrieved.values()) for brand in source.BRANDS},
        'admittedCatalogProducts': len(admitted),
        'admittedCatalogProductsByBrand': {brand: sum(row['brand'] == brand for row in admitted.values()) for brand in source.BRANDS},
        'savedPriceProducts': len(products), 'printedLanguages': 'all',
        'sourceSnapshots': snapshots, 'liveCollection': snapshots[-1],
        'platformDiscovery': discovery.get('discovery', {}),
        'universeSourcePath': universe, 'universeSourceSha256': fingerprints[universe],
        'scopeExclusions': exclusion_summary,
        'sourceNormalization': {'timezone': 'Asia/Tokyo', 'backfillV2LegacyShiftDays': 1},
        'excludedDailySalesHistoryContract': True, 'latest60CacheMixed': False,
        'observationCutoffDate': cutoff.isoformat(),
        'firstSourceDate': min(all_days).isoformat(),
    }, admitted


def weekly_sample(series, as_of, base_date):
    last_sunday = as_of - timedelta(days=(as_of.weekday() + 1) % 7)
    output = {}
    for brand, original in series.items():
        points = []
        for daily in original['points']:
            day = date.fromisoformat(daily['date'])
            if day > last_sunday or (day != base_date and day.weekday() != 6):
                continue
            point = dict(daily)
            point.update(periodStart=max(base_date, day - timedelta(days=6)).isoformat(),
                         periodEnd=day.isoformat(), dailyReturn=None,
                         weeklyReturn=((point['value'] / points[-1]['value'] - 1) * 100
                                       if points and source.positive(point['value']) and source.positive(points[-1]['value'])
                                       and day - date.fromisoformat(points[-1]['date']) == timedelta(days=7) else None))
            points.append(point)
        output[brand] = {**original, 'points': points, 'lastCalculatedDate': points[-1]['date']}
    return output, last_sunday.isoformat()


def build(root=source.ROOT, universe=None, platform_history=None, progress=None):
    from dynamic_card_price_index import build_dynamic_index
    products, as_of, fingerprints, summary, catalog = load_inputs(root, universe, platform_history)
    root = Path(root).resolve()
    policy_raw = (root / POLICY).read_bytes()
    policy = json.loads(policy_raw)
    fingerprints[POLICY] = source.digest(policy_raw)
    ref = {'path': POLICY, 'sha256': fingerprints[POLICY], 'version': policy['version'],
           'configurationFrozen': True, 'constituentConditionsFrozenOnAdmission': True}
    current_day = date.fromisoformat(summary['observationCutoffDate'])
    calculated = build_dynamic_index(products, as_of, current_day=current_day,
                                     catalog=catalog, config=policy['config'], progress=progress)
    series, method = calculated['series'], calculated['methodology']
    base_date = date.fromisoformat(method['baseDate'])
    weekly, week_end = weekly_sample(series, as_of, base_date)
    weekly_method = {**method, 'id': method['id'] + '-weekly-sample', 'frequency': 'weekly',
                     'aggregation': 'completed Sundays sampled from the exact daily index'}
    for item in weekly.values():
        item['methodology'] = weekly_method
    evidence = source.build_price_evidence(products, series, as_of)
    evidence_checks = source.validate_price_evidence(evidence, series, as_of)
    validation = calculated['validation']
    payload = {
        'schemaVersion': 1, 'reportKind': 'market-price-index', 'generatedAt': datetime.now(source.JST).isoformat(),
        'source': 'SNKRDUNK', 'currency': 'JPY', 'targetLanguage': 'all',
        'sourceAsOf': as_of.isoformat(), 'baseDate': base_date.isoformat(), 'baseValue': 100,
        'methodology': method, 'strictFlags': source.STRICT_FLAGS, 'referenceOnly': True,
        'currentJSTDate': current_day.isoformat(), 'todayIncomplete': as_of == current_day,
        'defaultFrequency': 'daily', 'frequencyOptions': ['daily', 'weekly'],
        'weeklyMethodology': weekly_method, 'latestCompleteWeekEnd': week_end,
        'series': series, 'weeklySeries': weekly, 'sourceSummary': summary,
        'inputFingerprints': fingerprints, 'methodPolicy': ref,
        'modelState': calculated['modelState'], 'dynamicValidation': validation,
        'priceEvidenceMethodology': {**source.PRICE_EVIDENCE_METHOD,
                                     'peakSelection': 'highest applied dynamic daily index on or after baseline'},
        'priceEvidence': evidence,
        'limitations': [
            'All printed languages are eligible; products lacking the past-only price-evidence gate are not silently assigned prices.',
            'Virtual quantities define price weights, not circulating quantities or market capitalization.',
            'Membership changes are linked with a neutral divisor; missing observations alone never remove a holding.',
            'Recorded chart amounts have no independently verified per-copy quantity normalization.',
            'A current catalog does not prove recovery of delisted historical products; no historical-universe completeness claim.',
            'Current-day observations are provisional; source corrections may revise prior calculations.',
        ],
        'methodSources': [
            {'title': 'S&P index mathematics and continuity adjustment', 'url': 'https://www.spglobal.com/spdji/en/methodology/article/index-mathematics-methodology/'},
            {'title': 'SNKRDUNK multiple-copy card listings', 'url': 'https://snkrdunk.com/information/244'},
        ],
    }
    state = payload.pop('modelState')
    encode = lambda value: (json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n').encode('utf-8')
    state_raw = encode(state)
    payload['modelStateRef'] = {'file': 'market-price-index-model-state.json', 'sha256': source.digest(state_raw)}
    raw = encode(payload)
    gates = validation.get('economicGates', [])
    if not gates or not all(gate.get('passed') is True for gate in gates):
        raise ValueError('Dynamic economic invariants failed')
    report = {
        'schemaVersion': 1, 'reportKind': 'market-price-index-validation', 'status': 'candidate',
        'checkedAt': datetime.now(source.JST).isoformat(), 'sourceAsOf': as_of.isoformat(),
        'dataSha256': source.digest(raw), 'methodId': method['id'], 'weeklyMethodId': weekly_method['id'],
        'calculationOnly': True, 'marketReady': False, 'strictFlags': source.STRICT_FLAGS,
        'inputFingerprints': fingerprints, 'numericalGates': gates, 'methodPolicy': ref,
        'modelStateRef': payload['modelStateRef'], 'dynamicValidation': validation,
        'priceEvidenceMethodId': source.PRICE_EVIDENCE_METHOD['id'], 'priceEvidenceChecks': evidence_checks,
        'checksPassed': len(gates) + len(evidence_checks), 'errors': [], 'defaultFrequency': 'daily',
        'currentJSTDate': current_day.isoformat(), 'todayIncomplete': as_of == current_day,
        'latestCompleteWeekEnd': week_end, 'liveCollection': summary['liveCollection'],
        'validationMeaning': 'Candidate until independent reconstruction verifies every daily value and membership decision.',
    }
    return payload, raw, report, state_raw


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=source.ROOT)
    parser.add_argument('--universe')
    parser.add_argument('--platform-history')
    parser.add_argument('--output-dir', type=Path)
    args = parser.parse_args()
    payload, raw, report, state_raw = build(args.root, args.universe, args.platform_history,
                                          progress=lambda message: print(message, flush=True))
    output = args.output_dir or args.root / 'data'
    output.mkdir(parents=True, exist_ok=True)
    (output / 'market-price-index.json').write_bytes(raw)
    (output / 'market-price-index-model-state.json').write_bytes(state_raw)
    (output / 'market-price-index-validation.json').write_text(json.dumps(report, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n', encoding='utf-8')
    print(json.dumps({'status': 'candidate', 'sourceAsOf': payload['sourceAsOf'],
                      'method': payload['methodology']['id'],
                      'series': {brand: {'latest': item['points'][-1], 'diagnostics': item['diagnostics']}
                                 for brand, item in payload['series'].items()}}, ensure_ascii=False))


if __name__ == '__main__':
    main()
