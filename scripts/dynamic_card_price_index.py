"""Equal initial amount, divisor-adjusted card reference index.

This pure module does not read/write files or decide printed-language scope.
Each admitted product receives one virtual initial monetary unit, split across
its then-eligible conditions. Quantities stay fixed; entries and exits change the divisor
at the same valuation prices. Missing prices are labelled model estimates.
"""
from __future__ import annotations

import bisect
import hashlib
import math
import re
import statistics
from collections import defaultdict
from datetime import date, timedelta
from functools import lru_cache

import numpy as np
from scipy import sparse
from scipy.sparse.csgraph import connected_components

METHOD_ID = 'dynamic-equal-initial-amount-card-basket-v1'
METHOD_IDS = {'one-each': 'dynamic-price-weighted-card-basket-v1',
              'equal-amount-fixed': METHOD_ID,
              'equal-amount-monthly': 'dynamic-monthly-equal-amount-card-basket-v1'}
BRANDS = ('pokemon', 'onepiece')
GRADES = ('raw', 'psa10')
GROUPINGS = ('global', 'grade', 'grade_price', 'grade_set')
PREDICTION_RULES = ('window-price-anchor', 'native-price-anchor')
TRAINING_REPRESENTATIONS = {'window-price-anchor': 'rolling-window', 'native-price-anchor': 'native-daily'}
WEIGHTINGS = ('one-each', 'equal-amount-fixed', 'equal-amount-monthly')
EXIT_REASONS = ('verified-not-single', 'verified-out-of-scope', 'verified-market-deletion')
DEFAULT_CONFIG = {
    'base_date': '2024-01-01', 'window_days': 30, 'eligibility_window_days': 30,
    'minimum_observations': 3, 'seasoning_days': 30,
    'review_frequency': 'monthly', 'condition_policy': 'split-fixed',
    'weighting': 'equal-amount-fixed', 'grouping': 'grade_price', 'grouping_by_brand': {},
    'prediction_rule': 'native-price-anchor', 'prediction_rule_by_brand': {},
    'training_representation': None, 'minimum_model_factor_days': None,
    'minimum_group_products': 10, 'stale_after_days': 90,
    'validate_holdouts': True, 'holdout_days': (30, 90, 365),
    'development_seeds': (0,), 'validation_seeds': (19, 23),
    'candidate_groupings': ('global', 'grade_price', 'grade_set'),
    'candidate_prediction_rules': PREDICTION_RULES,
    'select_prediction': True, 'exit_events': (),
}


def positive(value):
    return type(value) in (int, float) and math.isfinite(value) and value > 0


def _date(value):
    if type(value) is date:
        return value
    if isinstance(value, str):
        return date.fromisoformat(value)
    raise ValueError('Expected an ISO date or datetime.date')


def _catalog_map(catalog):
    if catalog is None:
        return {}
    if isinstance(catalog, dict) and 'cards' in catalog:
        catalog = catalog['cards']
    if isinstance(catalog, list):
        return {str(x['id']): x for x in catalog if isinstance(x, dict) and 'id' in x}
    return {str(k): v for k, v in catalog.items()}


def _set_code(card):
    for key in ('setId', 'setCode', 'set'):
        if isinstance(card.get(key), str) and card[key]:
            return card[key]
    match = re.search(r'\[([A-Za-z]{1,5}(?:\d{1,3}[A-Za-z]?)?(?:-[A-Za-z]{1,2})?)', str(card.get('name', '')))
    return match.group(1) if match else 'unknown'


def checked_config(config=None):
    supplied = config or {}
    if set(supplied) - set(DEFAULT_CONFIG):
        raise ValueError('Unsupported dynamic index configuration fields')
    out = {**DEFAULT_CONFIG, **supplied}
    out['base_date'] = _date(out['base_date'])
    for key in ('window_days', 'eligibility_window_days', 'minimum_observations',
                'seasoning_days', 'minimum_group_products', 'stale_after_days'):
        if type(out[key]) is not int or out[key] < 1:
            raise ValueError('Dynamic index integer settings must be positive')
    if out['window_days'] not in (1, 7, 14, 30):
        raise ValueError('Unsupported valuation window')
    if out['review_frequency'] != 'monthly':
        raise ValueError('Only monthly membership review is supported')
    if out['condition_policy'] not in ('split-fixed', 'raw-preferred'):
        raise ValueError('Unsupported product condition policy')
    if out['weighting'] not in WEIGHTINGS or out['grouping'] not in GROUPINGS:
        raise ValueError('Unsupported quantity policy or model grouping')
    if (not isinstance(out['grouping_by_brand'], dict) or set(out['grouping_by_brand']) - set(BRANDS)
            or any(value not in GROUPINGS for value in out['grouping_by_brand'].values())):
        raise ValueError('Unsupported brand-specific prediction grouping')
    out['grouping_by_brand'] = dict(out['grouping_by_brand'])
    if out['prediction_rule'] not in PREDICTION_RULES:
        raise ValueError('Unsupported missing-price prediction rule')
    if (not isinstance(out['prediction_rule_by_brand'], dict)
            or set(out['prediction_rule_by_brand']) - set(BRANDS)
            or any(x not in PREDICTION_RULES for x in out['prediction_rule_by_brand'].values())):
        raise ValueError('Unsupported brand-specific missing-price rule')
    out['prediction_rule_by_brand'] = dict(out['prediction_rule_by_brand'])
    if out['training_representation'] not in (None, 'rolling-window', 'native-daily'):
        raise ValueError('Unsupported model price representation')
    if out['minimum_model_factor_days'] is None:
        out['minimum_model_factor_days'] = math.ceil(out['window_days'] / 2)
    if (type(out['minimum_model_factor_days']) is not int
            or not 1 <= out['minimum_model_factor_days'] <= out['window_days']):
        raise ValueError('Invalid native model window coverage minimum')
    if (not out['candidate_prediction_rules']
            or any(x not in PREDICTION_RULES for x in out['candidate_prediction_rules'])):
        raise ValueError('Unsupported candidate missing-price rule')
    out['candidate_prediction_rules'] = tuple(dict.fromkeys(out['candidate_prediction_rules']))
    for key in ('validate_holdouts', 'select_prediction'):
        if type(out[key]) is not bool:
            raise ValueError('Validation and selection flags must be booleans')
    for key in ('holdout_days', 'development_seeds', 'validation_seeds'):
        if any(type(x) is not int or x < (1 if key == 'holdout_days' else 0) for x in out[key]):
            raise ValueError('Invalid validation dates/seeds')
        out[key] = tuple(out[key])
    if set(out['development_seeds']) & set(out['validation_seeds']):
        raise ValueError('Development and final validation seeds must differ')
    if not out['candidate_groupings'] or any(x not in GROUPINGS for x in out['candidate_groupings']):
        raise ValueError('Unsupported candidate prediction grouping')
    out['candidate_groupings'] = tuple(dict.fromkeys(out['candidate_groupings']))
    exits = []
    for item in out['exit_events']:
        if (not isinstance(item, dict) or set(item) != {'productId', 'effectiveDate', 'reason', 'evidence'}
                or item['reason'] not in EXIT_REASONS or not isinstance(item['evidence'], str)
                or not item['evidence'].strip()):
            raise ValueError('An exit needs explicit verified reason and evidence')
        exits.append({**item, 'productId': str(item['productId']), 'effectiveDate': _date(item['effectiveDate'])})
    if len({x['productId'] for x in exits}) != len(exits):
        raise ValueError('An explicitly exited product cannot have multiple exit events')
    out['exit_events'] = exits
    if not out['select_prediction'] and out['training_representation'] is not None:
        for brand in BRANDS:
            rule = out['prediction_rule_by_brand'].get(brand, out['prediction_rule'])
            if TRAINING_REPRESENTATIONS[rule] != out['training_representation']:
                raise ValueError('Locked training representation and prediction rule differ')
    return out


def clean_products(products, source_as_of):
    """Reject invalid prices; caller, not this module, owns source contracts."""
    output = {}
    for cid, item in sorted(products.items(), key=lambda x: str(x[0])):
        if str(cid) in output:
            raise ValueError('Duplicate source product identifier after normalization')
        if item.get('brand') not in BRANDS:
            continue
        histories = {}
        for grade, history in item.get('grades', {}).items():
            if grade not in GRADES:
                continue
            good = {_date(d): float(p) for d, p in history.items() if positive(p) and _date(d) <= source_as_of}
            if good:
                ds = sorted(good)
                histories[grade] = {'dates': ds, 'prices': [good[d] for d in ds]}
        if histories:
            output[str(cid)] = {'brand': item['brand'], 'grades': histories}
    return output


def observed_price(history, day, window_days):
    ds = history['dates']
    left = bisect.bisect_left(ds, day - timedelta(days=window_days - 1))
    right = bisect.bisect_right(ds, day)
    if right <= left:
        return None, None, 0
    return statistics.median(history['prices'][left:right]), ds[right - 1], right - left


def eligible_grades(product, cutoff, config):
    grades = []
    for grade in GRADES:
        if grade not in product['grades']:
            continue
        history = product['grades'][grade]
        if (cutoff - history['dates'][0]).days < config['seasoning_days']:
            continue
        _, _, count = observed_price(history, cutoff, config['eligibility_window_days'])
        if count >= config['minimum_observations']:
            grades.append(grade)
    if config['condition_policy'] == 'raw-preferred' and grades:
        return ['raw'] if 'raw' in grades else ['psa10']
    return grades


def membership_plan(products, source_as_of, config):
    """Eligibility uses only facts at the prior-day cutoff; grades are pinned."""
    base = config['base_date']
    reviews = [base]
    cursor = date(base.year + (base.month == 12), base.month % 12 + 1, 1)
    while cursor <= source_as_of:
        reviews.append(cursor)
        cursor = date(cursor.year + (cursor.month == 12), cursor.month % 12 + 1, 1)
    admitted, events = {}, defaultdict(list)
    excluded_forever = {x['productId']: x['effectiveDate'] for x in config['exit_events']}
    for day in reviews:
        cutoff = day - timedelta(days=1)
        for cid, product in products.items():
            if cid in admitted or (cid in excluded_forever and day >= excluded_forever[cid]):
                continue
            grades = eligible_grades(product, cutoff, config)
            if not grades:
                continue
            conditions = []
            for grade in grades:
                p0, source_day, count = observed_price(product['grades'][grade], cutoff, config['eligibility_window_days'])
                entry_price, _, _ = observed_price(product['grades'][grade], day, config['window_days'])
                capital_weight = 1 / len(grades)
                if config['weighting'] != 'one-each' and entry_price is None:
                    raise ValueError('Initial monetary allocation requires an actual effective-date valuation window')
                quantity = capital_weight if config['weighting'] == 'one-each' else capital_weight / entry_price
                conditions.append({'id': cid + ':' + grade, 'productId': cid, 'grade': grade,
                    'referencePrice': p0, 'referenceSourceDate': source_day.isoformat(),
                    'eligibilityObservedDays': count, 'initialCapitalWeight': capital_weight,
                    'entryPrice': entry_price, 'initialQuantity': quantity,
                    'firstObservedDate': product['grades'][grade]['dates'][0].isoformat(),
                    'admissionDate': day.isoformat()})
            admitted[cid] = {'brand': product['brand'], 'grades': grades,
                             'admissionDate': day, 'conditions': conditions}
            events[day].append(cid)
    return admitted, events, reviews


def make_price_panel(products, admitted, brand, source_as_of, config, catalog=None):
    base = config['base_date']
    dates = [base + timedelta(days=i) for i in range((source_as_of - base).days + 1)]
    card_map = _catalog_map(catalog)
    exit_dates = {x['productId']: x['effectiveDate'] for x in config['exit_events']}
    records, by_product = [], {}
    for cid, member in admitted.items():
        if member['brand'] != brand:
            continue
        by_product[cid] = []
        for record in member['conditions']:
            row = {**record, **products[cid]['grades'][record['grade']],
                   'setCode': _set_code(card_map.get(cid, {})),
                   'exitDate': exit_dates.get(cid).isoformat() if cid in exit_dates else None}
            by_product[cid].append(len(records))
            records.append(row)
    values = np.full((len(records), len(dates)), np.nan)
    source_dates = np.zeros(values.shape, dtype=np.int32)
    for i, record in enumerate(records):
        for j, day in enumerate(dates):
            if record['exitDate'] is not None and day > _date(record['exitDate']):
                continue
            price, latest, _ = observed_price(record, day, config['window_days'])
            if price is not None:
                values[i, j] = price / record['referencePrice']
                source_dates[i, j] = latest.toordinal()
    weights = np.array([r['initialQuantity'] * r['referencePrice'] for r in records])
    native_start = base - timedelta(days=max(config['window_days'], config['eligibility_window_days']))
    native_dates = [native_start + timedelta(days=i) for i in range((source_as_of - native_start).days + 1)]
    native_values = np.full((len(records), len(native_dates)), np.nan)
    for i, record in enumerate(records):
        left = bisect.bisect_left(record['dates'], native_start)
        right = bisect.bisect_right(record['dates'], source_as_of)
        for k in range(left, right):
            day = record['dates'][k]
            if record['exitDate'] is not None and day > _date(record['exitDate']):
                continue
            native_values[i, (day - native_start).days] = record['prices'][k] / record['referencePrice']
    return {'brand': brand, 'dates': dates, 'records': records, 'byProduct': by_product,
            'values': values, 'sourceDates': source_dates, 'weights': weights, 'config': config,
            'nativeDates': native_dates, 'nativeValues': native_values}


def fit_sparse_ppml(values, weights, tolerance=1e-10, maximum_iterations=10000):
    """Incomplete-panel PPML with each connected date component identified.

    Normalized prices with weights q*referencePrice equal the native-currency
    score equations for fixed virtual quantities q. No unobserved price enters
    the fit, including at admission. Components are never joined by zero fill.
    """
    valid = np.isfinite(values)
    if np.any(valid & (values <= 0)) or len(values) != len(weights) or np.any(weights <= 0):
        raise ValueError('Invalid positive-price PPML input')
    if not len(values) or np.any(~valid.any(axis=1)):
        raise ValueError('Every model condition needs an actual observation')
    active = np.flatnonzero(valid.any(axis=0))
    rows, columns = np.nonzero(valid[:, active])
    mask = sparse.csr_matrix((np.ones(len(rows)), (rows, columns)), shape=(len(values), len(active)))
    target = sparse.csr_matrix((values[rows, active[columns]], (rows, columns)), shape=mask.shape)
    graph = sparse.bmat([[None, mask], [mask.T, None]], format='csr')
    count, labels = connected_components(graph, directed=False)
    row_components = labels[:len(values)]
    column_components = labels[len(values):]
    row_y = np.asarray(target.sum(axis=1)).ravel()
    column_y = np.asarray(target.T @ weights).ravel()
    alpha, factors = np.ones(len(values)), np.ones(len(active))
    anchors = {component: int(np.flatnonzero(column_components == component)[0]) for component in set(column_components)}
    for iteration in range(maximum_iterations):
        previous = factors.copy()
        alpha = row_y / (mask @ factors)
        factors = column_y / (mask.T @ (weights * alpha))
        for component, anchor in anchors.items():
            scale = factors[anchor]
            factors[column_components == component] /= scale
            alpha[row_components == component] *= scale
        change = float(np.max(np.abs(np.log(factors / previous))))
        if change < tolerance:
            break
    else:
        raise ValueError('Dynamic incomplete-panel PPML did not converge')
    if not np.all(np.isfinite(alpha)) or np.any(alpha <= 0) or not np.all(np.isfinite(factors)) or np.any(factors <= 0):
        raise ValueError('Invalid positive-price model coefficients')
    row_score = row_y - alpha * (mask @ factors)
    date_score = column_y - factors * (mask.T @ (weights * alpha))
    residual = max(float(np.max(np.abs(row_score)) / max(1., float(row_y.max()))),
                   float(np.max(np.abs(date_score)) / max(1., float(column_y.max()))))
    if residual > 1e-8:
        raise ValueError('PPML score residual exceeds tolerance')
    full_factors = np.full(values.shape[1], np.nan)
    full_components = np.full(values.shape[1], -1, dtype=np.int32)
    full_factors[active] = factors
    full_components[active] = column_components
    return {'alpha': alpha, 'factors': full_factors, 'components': full_components,
            'diagnostics': {'converged': True, 'iterations': iteration + 1,
                'componentCount': int(count), 'fittedConditions': len(values),
                'fittedObservations': int(valid.sum()), 'fittedDates': len(active),
                'unidentifiedDates': values.shape[1] - len(active), 'relativeScoreResidual': residual}}


def _labels(panel, grouping):
    labels = []
    for r in panel['records']:
        tier = bisect.bisect_right((5000, 20000, 100000), r['referencePrice'])
        labels.append('all' if grouping == 'global' else r['grade'] if grouping == 'grade' else
                      r['grade'] + ':price:' + str(tier) if grouping == 'grade_price' else
                      r['grade'] + ':set:' + r['setCode'])
    return labels


def fit_prediction_model(panel, values=None, grouping='grade_price', global_fit=None,
                         representation='rolling-window'):
    if representation not in ('rolling-window', 'native-daily'):
        raise ValueError('Unsupported model price representation')
    values = panel['nativeValues' if representation == 'native-daily' else 'values'] if values is None else values
    global_fit = global_fit or fit_sparse_ppml(values, panel['weights'])
    labels = _labels(panel, grouping)
    fitted, diagnostics, row_alpha = {}, {}, np.empty(len(labels))
    for label in sorted(set(labels)):
        ix = np.array([i for i, x in enumerate(labels) if x == label], dtype=int)
        products = {panel['records'][i]['productId'] for i in ix}
        use_global = grouping == 'global' or len(products) < panel['config']['minimum_group_products']
        global_fallback = use_global and grouping != 'global'
        result = global_fit if use_global else fit_sparse_ppml(values[ix], panel['weights'][ix])
        row_alpha[ix] = result['alpha'][ix] if use_global else result['alpha']
        fitted[label] = {'factors': result['factors'], 'components': result['components'], 'globalFallback': global_fallback}
        diagnostics[label] = {**result['diagnostics'], 'products': len(products), 'globalFallback': global_fallback}
    return {'global': global_fit, 'groups': fitted, 'labels': labels,
            'alpha': row_alpha, 'grouping': grouping, 'diagnostics': diagnostics,
            'representation': representation,
            'dates': panel['nativeDates'] if representation == 'native-daily' else panel['dates']}


def _factor_ratio(model, label, current, anchor):
    group = model['groups'][label]
    f, component = group['factors'], group['components']
    global_f, global_c = model['global']['factors'], model['global']['components']
    if np.isfinite(f[current]) and np.isfinite(f[anchor]) and component[current] == component[anchor]:
        return f[current] / f[anchor], 'group-anchor'
    # During a thin group's current gap, preserve its identified movement up to
    # the latest observed group date, then apply the current global movement.
    if np.isfinite(f[anchor]) and np.isfinite(global_f[current]):
        available = np.flatnonzero(np.isfinite(f[anchor:current + 1])) + anchor
        last = int(available[-1]) if len(available) else anchor
        if (component[last] == component[anchor] and np.isfinite(global_f[last])
                and global_c[last] == global_c[current]):
            return f[last] / f[anchor] * global_f[current] / global_f[last], 'group-gap-global-anchor'
    if (np.isfinite(global_f[current]) and np.isfinite(global_f[anchor])
            and global_c[current] == global_c[anchor]):
        return global_f[current] / global_f[anchor], 'disconnected-group-global-anchor'
    return None, 'unidentified'


def _factor_ratio_vector(model, label, anchor):
    """The same connected ratio priority as _factor_ratio, vectorized."""
    group = model['groups'][label]
    f, component = group['factors'], group['components']
    g, gc = model['global']['factors'], model['global']['components']
    ratio = np.full(len(f), np.nan)
    reason = np.full(len(f), -1, dtype=np.int8)
    if np.isfinite(g[anchor]):
        okay = np.isfinite(g) & (gc == gc[anchor])
        ratio[okay] = g[okay] / g[anchor]
        reason[okay] = 3
    if np.isfinite(f[anchor]):
        same = np.isfinite(f) & (component == component[anchor])
        ratio[same] = f[same] / f[anchor]
        reason[same] = 1 if group['globalFallback'] else 0
        indices = np.arange(len(f), dtype=np.int32)
        latest = np.maximum.accumulate(np.where(np.isfinite(f), indices, -1))
        ix = np.maximum(latest, 0)
        gaps = (~np.isfinite(f) & (latest >= anchor) & (component[ix] == component[anchor])
                & np.isfinite(g) & np.isfinite(g[ix]) & (gc == gc[ix]))
        ratio[gaps] = f[ix[gaps]] / f[anchor] * g[gaps] / g[ix[gaps]]
        reason[gaps] = 2
    ratio[:anchor] = np.nan
    reason[:anchor] = -1
    return ratio, reason


def predict_native_prices(panel, model, values=None, native_values=None):
    """Forecast a missing valuation window from a correctly timed native quote.

    For every supported day d in the target trailing window, compute the
    connected factor ratio J(d)/J(last SAME-condition actual quote date).
    Median those ratios, then multiply by that exact native quote amount.
    This never dates an old quote at the end of the window it merely survived.
    """
    values = panel['values'] if values is None else values
    native_values = panel['nativeValues'] if native_values is None else native_values
    prices = np.full(values.shape, np.nan)
    anchors = np.full(values.shape, -1, dtype=np.int32)
    ages = np.zeros(values.shape, dtype=np.int32)
    fallback = np.zeros(values.shape, dtype=np.int8)
    coverage = np.zeros(values.shape, dtype=np.int16)
    native_group_coverage = np.zeros(values.shape, dtype=np.int16)
    first_native = model['dates'][0]
    window = panel['config']['window_days']
    minimum = panel['config']['minimum_model_factor_days']
    @lru_cache(maxsize=128)
    def cached_window_summary(label, anchor):
        ratios, reasons = _factor_ratio_vector(model, label, anchor)
        medians = np.full(len(ratios), np.nan)
        counts = np.zeros(len(ratios), dtype=np.int16)
        native_counts = np.zeros(len(ratios), dtype=np.int16)
        global_used = np.zeros(len(ratios), dtype=np.int8)
        if len(ratios) - anchor - 1 < window:
            return medians, counts, native_counts, global_used
        target = np.lib.stride_tricks.sliding_window_view(ratios[anchor + 1:], window)
        reason_windows = np.lib.stride_tricks.sliding_window_view(reasons[anchor + 1:], window)
        finite = np.isfinite(target) & (target > 0)
        amount = finite.sum(axis=1)
        first = anchor + window
        counts[first:] = amount
        native_counts[first:] = np.sum(finite & (reason_windows == 0), axis=1)
        global_used[first:] = np.any(finite & (reason_windows > 0), axis=1)
        supported_rows = np.flatnonzero(amount >= minimum)
        if len(supported_rows):
            # Never introduce zeros for unidentifiable days, and do not call
            # nanmedian on all-unknown windows.
            supported = np.where(finite[supported_rows], target[supported_rows], np.nan)
            medians[first + supported_rows] = np.nanmedian(supported, axis=1)
        return medians, counts, native_counts, global_used
    for i, record in enumerate(panel['records']):
        quote_columns = np.flatnonzero(np.isfinite(native_values[i]))
        for j, day in enumerate(panel['dates']):
            if record['exitDate'] is not None and day > _date(record['exitDate']):
                continue
            if np.isfinite(values[i, j]):
                prices[i, j] = values[i, j] * record['referencePrice']
                continue
            current = (day - first_native).days
            position = bisect.bisect_right(quote_columns, current) - 1
            if position < 0:
                continue
            anchor = int(quote_columns[position])
            anchors[i, j] = anchor
            ages[i, j] = (day - model['dates'][anchor]).days
            medians, counts, native_counts, global_used = cached_window_summary(model['labels'][i], anchor)
            supported = int(counts[current])
            coverage[i, j] = supported
            native_group_coverage[i, j] = native_counts[current]
            fallback[i, j] = global_used[current]
            if supported < minimum:
                continue
            anchor_amount = native_values[i, anchor] * record['referencePrice']
            prices[i, j] = anchor_amount * float(medians[current])
    model['forecastWindowCoverage'] = coverage
    model['forecastNativeGroupCoverage'] = native_group_coverage
    model['predictionRule'] = 'native-price-anchor'
    return prices, anchors, ages, fallback


def predict_prices(panel, model, values=None, source_dates=None, native_values=None):
    if model.get('representation') == 'native-daily':
        return predict_native_prices(panel, model, values, native_values)
    values = panel['values'] if values is None else values
    source_dates = panel['sourceDates'] if source_dates is None else source_dates
    prices = np.full(values.shape, np.nan)
    anchors = np.full(values.shape, -1, dtype=np.int32)
    ages = np.zeros(values.shape, dtype=np.int32)
    fallback = np.zeros(values.shape, dtype=np.int8)
    for i, record in enumerate(panel['records']):
        last = None
        for j, day in enumerate(panel['dates']):
            if np.isfinite(values[i, j]):
                prices[i, j] = values[i, j] * record['referencePrice']
                last = j
                anchors[i, j] = j
                continue
            if last is None:
                continue
            ratio, reason = _factor_ratio(model, model['labels'][i], j, last)
            if ratio is None:
                continue
            prices[i, j] = values[i, last] * record['referencePrice'] * ratio
            anchors[i, j] = last
            ages[i, j] = day.toordinal() - int(source_dates[i, last])
            fallback[i, j] = int(reason != 'group-anchor')
    model['forecastWindowCoverage'] = np.isfinite(prices).astype(np.int16)
    model['forecastNativeGroupCoverage'] = np.isfinite(prices).astype(np.int16)
    model['predictionRule'] = 'window-price-anchor'
    return prices, anchors, ages, fallback


def blackout_values(panel, product_ids, duration):
    start = panel['dates'][-1] - timedelta(days=duration - 1)
    boundary = bisect.bisect_left(panel['dates'], start)
    values, sources = panel['values'].copy(), panel['sourceDates'].copy()
    for cid in product_ids:
        for i in panel['byProduct'][cid]:
            record = panel['records'][i]
            cutoff = bisect.bisect_left(record['dates'], start)
            hidden = {'dates': record['dates'][:cutoff], 'prices': record['prices'][:cutoff]}
            values[i, boundary:] = np.nan
            sources[i, boundary:] = 0
            for j in range(boundary, min(len(panel['dates']), boundary + panel['config']['window_days'] - 1)):
                if record.get('exitDate') is not None and panel['dates'][j] > _date(record['exitDate']):
                    continue
                price, latest, _ = observed_price(hidden, panel['dates'][j], panel['config']['window_days'])
                if price is not None:
                    values[i, j] = price / record['referencePrice']
                    sources[i, j] = latest.toordinal()
    return values, sources


def blackout_native_values(panel, product_ids, duration):
    hidden = panel['nativeValues'].copy()
    start = panel['dates'][-1] - timedelta(days=duration - 1)
    boundary = bisect.bisect_left(panel['nativeDates'], start)
    rows = [i for cid in product_ids for i in panel['byProduct'][cid]]
    hidden[np.ix_(rows, np.arange(boundary, hidden.shape[1]))] = np.nan
    return hidden


def holdout_metrics(panel, product_ids, predicted):
    rows = [i for cid in product_ids for i in panel['byProduct'][cid]
            if np.isfinite(panel['values'][i, -1])]
    actual = np.array([panel['values'][i, -1] * panel['records'][i]['referencePrice'] for i in rows])
    estimate = predicted[rows, -1]
    quantities = np.array([panel['records'][i]['initialQuantity'] for i in rows])
    identified = np.isfinite(estimate) & (estimate > 0)
    if not len(rows):
        return {'heldoutProducts': len(product_ids), 'heldoutKnownConditions': 0, 'identifiedConditions': 0}
    if not np.all(identified):
        return {'heldoutProducts': len(product_ids), 'heldoutKnownConditions': len(rows),
                'identifiedConditions': int(identified.sum()), 'unidentified': True}
    total = float(np.sum(quantities * actual))
    complete_errors = []
    for cid in product_ids:
        ix = panel['byProduct'][cid]
        if np.all(np.isfinite(panel['values'][ix, -1])):
            a = sum(panel['records'][i]['initialQuantity'] * panel['records'][i]['referencePrice'] * panel['values'][i, -1] for i in ix)
            p = sum(panel['records'][i]['initialQuantity'] * predicted[i, -1] for i in ix)
            complete_errors.append(abs(p / a - 1) * 100)
    return {'heldoutProducts': len(product_ids), 'heldoutKnownConditions': len(rows),
            'identifiedConditions': len(rows), 'unidentified': False,
            'conditionMedianAbsPctError': float(np.median(np.abs(estimate / actual - 1)) * 100),
            'productMedianAbsPctError': statistics.median(complete_errors) if complete_errors else None,
            'valueBiasPct': (float(np.sum(quantities * estimate)) / total - 1) * 100,
            'valueAbsoluteErrorPct': float(np.sum(quantities * np.abs(estimate - actual))) / total * 100,
            'actualValueJPY': total, 'estimatedValueJPY': float(np.sum(quantities * estimate))}


def validation_partition(brand, product_id):
    """Stable whole-product split made without inspecting prices or returns."""
    key = ('dynamic-card-index-validation-v1:' + brand + ':' + str(product_id)).encode('utf-8')
    return 'development' if hashlib.sha256(key).digest()[0] % 2 == 0 else 'validation'


def select_prediction_candidate(candidates, groupings, rules):
    """Prediction-date correctness is a prerequisite, not a score tradeoff."""
    usable = [item for item in candidates if item['selectionScore'] is not None
              and item.get('eligibleForAppliedSelection', False)]
    if not usable:
        raise ValueError('No date-aligned predictor passed development identification')
    return min(usable, key=lambda item: (item['selectionScore'], groupings.index(item['grouping']),
                                        rules.index(item['predictionRule'])))


def historical_surge_drawdown_products(panel, product_ids):
    """Final-only stress targets: actual low before peak, then a correction.

    Each path uses pinned conditions and economic quantities from admission.
    A missing condition makes that day's path unavailable, never a zero or a
    change in weights. Earlier prices before product admission are excluded.
    """
    end = panel['dates'][-1]
    start = end - timedelta(days=29)
    native_boundary = bisect.bisect_left(panel['nativeDates'], start)
    output = []
    for cid in sorted(product_ids):
        ix = panel['byProduct'][cid]
        admission = _date(panel['records'][ix[0]]['admissionDate'])
        if (admission >= start or not np.all(np.isfinite(panel['values'][ix, -1]))
                or any(not np.isfinite(panel['nativeValues'][i, :native_boundary]).any() for i in ix)):
            continue
        actual = panel['values'][ix]
        dates_okay = np.array([day >= admission for day in panel['dates']])
        good = np.flatnonzero(np.all(np.isfinite(actual), axis=0) & dates_okay)
        if len(good) < 2:
            continue
        q_ref = np.array([panel['records'][i]['initialQuantity'] * panel['records'][i]['referencePrice'] for i in ix])
        path = np.sum(q_ref[:, None] * actual[:, good], axis=0)
        peak_index = int(np.argmax(path))
        low_index = int(np.argmin(path[:peak_index + 1]))
        peak, low, now = float(path[peak_index]), float(path[low_index]), float(path[-1])
        multiple = peak / low
        if multiple < 10 or now / peak > .8:
            continue
        output.append({'productId': cid, 'admissionDate': admission.isoformat(),
            'pathStartDate': panel['dates'][good[0]].isoformat(), 'pathActualWindowPoints': len(good),
            'troughDate': panel['dates'][good[low_index]].isoformat(),
            'peakDate': panel['dates'][good[peak_index]].isoformat(),
            'troughValueJPY': low, 'peakValueJPY': peak, 'currentValueJPY': now,
            'peakMultiple': multiple, 'drawdownPct': (now / peak - 1) * 100})
    return output


def validate_prediction_models(panel, groupings, seeds, durations=(30,), tails=False, declines=False, progress=None,
                               phase='development', prediction_rules=('window-price-anchor',)):
    if phase not in ('development', 'validation'):
        raise ValueError('Invalid prediction validation phase')
    end = panel['dates'][-1]
    # Late entrants cannot be assessed as if they had a pre-blackout anchor.
    all_ids = sorted(cid for cid in panel['byProduct'] if validation_partition(panel['brand'], cid) == phase)
    cases, case_details = [], {}
    for duration in durations:
        if (end - panel['dates'][0]).days <= duration + panel['config']['window_days']:
            continue
        start = end - timedelta(days=duration - 1)
        ids = [cid for cid in all_ids
               if all(_date(panel['records'][i]['admissionDate']) < start
                      and np.any(np.isfinite(panel['values'][i, :bisect.bisect_left(panel['dates'], start)]))
                      for i in panel['byProduct'][cid])
               and any(np.isfinite(panel['values'][i, -1]) for i in panel['byProduct'][cid])]
        for seed in seeds:
            if ids:
                rng = np.random.default_rng(seed + 901)
                selected = sorted(rng.choice(ids, max(1, len(ids) // 5), replace=False).tolist())
                cases.append(('blackout-' + str(duration), seed, duration, selected))
    complete = [cid for cid in all_ids if all(np.isfinite(panel['values'][i, -1]) for i in panel['byProduct'][cid])]
    can_tail = (end - panel['dates'][0]).days > 60
    if tails and can_tail:
        for multiple in (5, 10):
            ids = [cid for cid in complete if (
                       sum(panel['records'][i]['initialQuantity'] * panel['records'][i]['referencePrice'] * panel['values'][i, -1]
                           for i in panel['byProduct'][cid]) /
                       sum(panel['records'][i]['initialQuantity'] * (panel['records'][i]['entryPrice'] or panel['records'][i]['referencePrice'])
                           for i in panel['byProduct'][cid])) >= multiple
                   and _date(panel['records'][panel['byProduct'][cid][0]]['admissionDate']) < end - timedelta(days=60)]
            if ids:
                cases.append(('tail-' + str(multiple), None, 30, ids))
    if declines and can_tail:
        start90 = max(0, len(panel['dates']) - 90)
        ids = []
        for cid in complete:
            ix = panel['byProduct'][cid]
            actual = panel['values'][ix, start90:]
            good = np.all(np.isfinite(actual), axis=0)
            if np.any(good):
                q = np.array([panel['records'][i]['initialQuantity'] * panel['records'][i]['referencePrice'] for i in ix])
                path = np.sum(q[:, None] * actual[:, good], axis=0)
                now = sum(q[k] * panel['values'][i, -1] for k, i in enumerate(ix))
                if now / float(path.max()) <= .7:
                    ids.append(cid)
        if ids:
            cases.append(('recent-decline-at-least-30pct', None, 30, ids))
    if phase == 'validation' and declines and can_tail:
        stress = historical_surge_drawdown_products(panel, all_ids)
        if stress:
            kind = 'historical-surge-then-drawdown'
            cases.append((kind, None, 30, [item['productId'] for item in stress]))
            case_details[kind] = {
                'stressSelectionRule': 'final product partition only; actual complete pinned-condition q-price path since admission; first maximum divided by first preceding minimum >=10, current/peak<=0.8; current actual complete and every condition has a native quote before the 30-day blackout',
                'stressProducts': stress}
    if not prediction_rules or any(x not in PREDICTION_RULES for x in prediction_rules):
        raise ValueError('Unsupported candidate missing-price rule')
    results = {(group, rule): [] for group in groupings for rule in prediction_rules}
    for kind, seed, duration, ids in cases:
        hidden, sources = blackout_values(panel, ids, duration)
        hidden_native = blackout_native_values(panel, ids, duration)
        if np.any(~np.isfinite(hidden).any(axis=1)):
            continue
        global_fits = {}
        for rule in prediction_rules:
            representation = TRAINING_REPRESENTATIONS[rule]
            training = hidden_native if representation == 'native-daily' else hidden
            if np.any(~np.isfinite(training).any(axis=1)):
                raise ValueError('Native blackout removed every available condition observation')
            if representation not in global_fits:
                global_fits[representation] = fit_sparse_ppml(training, panel['weights'])
        for group in groupings:
            for rule in prediction_rules:
                representation = TRAINING_REPRESENTATIONS[rule]
                if progress:
                    progress(panel['brand'] + ': ' + kind + '/' + str(seed) + '/' + group + '/' + rule)
                training = hidden_native if representation == 'native-daily' else hidden
                model = fit_prediction_model(panel, training, group, global_fits[representation], representation)
                predicted, _, _, _ = predict_prices(panel, model, hidden, sources, hidden_native)
                results[(group, rule)].append({'kind': kind, 'seed': seed, 'durationDays': duration,
                    'usedForPredictorSelection': phase == 'development',
                    'independentFromSelection': phase == 'validation',
                    'productPartition': phase, 'heldoutProductIds': ids,
                    **case_details.get(kind, {}), **holdout_metrics(panel, ids, predicted)})
    output = []
    for (group, rule), tests in results.items():
        good = [x for x in tests if not x.get('unidentified') and 'valueAbsoluteErrorPct' in x]
        score = (statistics.mean(x['valueAbsoluteErrorPct'] + .25 * x['conditionMedianAbsPctError'] for x in good)
                 if good and len(good) == len(tests) else None)
        output.append({'grouping': group, 'predictionRule': rule,
                       'trainingRepresentation': TRAINING_REPRESENTATIONS[rule],
                       'phase': phase, 'selectionScore': score if phase == 'development' else None,
                       'validationErrorScore': score if phase == 'validation' else None,
                       'tests': tests, 'selectionUsesIndexMagnitude': False,
                       'eligibleForAppliedSelection': rule == 'native-price-anchor',
                       'ineligibilityReason': None if rule == 'native-price-anchor' else 'temporal-anchor-invariant-failed',
                       'tailTestsReusedFromDevelopment': False,
                       'partitionProducts': len(all_ids),
                       'partitionRule': 'sha256(dynamic-card-index-validation-v1:brand:productId) first byte parity; development even, final validation odd',
                       'independenceMeaning': 'development and final held-out target product IDs are disjoint; shared archived market context and retrospective fits, not external future validation',
                       'tailThresholdMeaning': 'product sum(initialQuantity * current actual price) divided by sum(initialQuantity * actual admission-window entryPrice); equal-amount-fixed initial sum is one monetary unit',
                       'missingTailThresholds': [multiple for multiple in (5, 10) if tails and
                            not any(x['kind'] == 'tail-' + str(multiple) for x in tests)]})
    return output


def neutral_divisor(old_value, new_value, old_divisor):
    if not all(positive(x) for x in (old_value, new_value, old_divisor)):
        raise ValueError('Neutral divisor requires positive old/new basket valuation')
    return old_divisor * new_value / old_value


def _native_breadth(products, brand, day, basket_ids, held_grades=None):
    now, prev = {}, {}
    for cid in basket_ids:
        product = products[cid]
        for grade, history in product['grades'].items():
            if held_grades is not None and grade not in held_grades[cid]:
                continue
            ds = history['dates']
            j = bisect.bisect_left(ds, day)
            if j < len(ds) and ds[j] == day:
                now[(cid, grade)] = history['prices'][j]
            j = bisect.bisect_left(ds, day - timedelta(days=1))
            if j < len(ds) and ds[j] == day - timedelta(days=1):
                prev[(cid, grade)] = history['prices'][j]
    matched = defaultdict(list)
    for key in now.keys() & prev.keys():
        matched[key[0]].append(now[key] / prev[key])
    relatives = [statistics.mean(x) for x in matched.values()]
    up = sum(x > 1 and not math.isclose(x, 1, abs_tol=1e-12, rel_tol=0) for x in relatives)
    down = sum(x < 1 and not math.isclose(x, 1, abs_tol=1e-12, rel_tol=0) for x in relatives)
    current_ids = {cid for cid, _ in now}
    return {'sourceObservedProducts': len(current_ids), 'sourceObservedConditions': len(now),
            'matchedProducts': len(matched), 'matchedConditions': len(now.keys() & prev.keys()),
            'up': up, 'down': down, 'flat': len(relatives) - up - down,
            'newObservedProducts': len(current_ids - {cid for cid, _ in prev}),
            'unpairedProducts': len(current_ids) - len(matched)}


def aggregate_series(panel, model, prices, anchors, ages, fallback, products, admitted, entry_events,
                     review_dates, config, current_day=None):
    records, dates = panel['records'], panel['dates']
    by_product = panel['byProduct']
    holdings, divisor, points, reviews = {}, None, [], []
    exits = defaultdict(list)
    for event in config['exit_events']:
        exits[event['effectiveDate']].append(event)
    review_set = set(review_dates)
    admission_rows = {cid: by_product[cid] for cid in by_product}
    for j, day in enumerate(dates):
        old_holdings = dict(holdings)
        old_known = all(np.isfinite(prices[i, j]) for i in holdings)
        old_value = float(sum(q * prices[i, j] for i, q in holdings.items())) if holdings and old_known else None
        entering = [cid for cid in entry_events.get(day, []) if cid in by_product]
        leaving = [event for event in exits.get(day, []) if event['productId'] in {records[i]['productId'] for i in holdings}]
        review = day in review_set or bool(leaving)
        if review:
            proposed = dict(holdings)
            for event in leaving:
                for i in admission_rows[event['productId']]:
                    proposed.pop(i, None)
            for cid in entering:
                for i in admission_rows[cid]:
                    if not np.isfinite(prices[i, j]) or prices[i, j] <= 0:
                        raise ValueError('New constituent has no identifiable valuation at effective date')
                    proposed[i] = records[i]['initialQuantity']
            if config['weighting'] == 'equal-amount-monthly' and day in review_set:
                for i in proposed:
                    if not np.isfinite(prices[i, j]):
                        raise ValueError('Cannot redistribute quantities at unknown price')
                    proposed[i] = records[i]['initialCapitalWeight'] / prices[i, j]
            change = proposed != holdings
            if change:
                if holdings and old_value is None:
                    raise ValueError('Composition cannot change when prior basket value is unknown')
                if not proposed:
                    raise ValueError('Verified exits would remove the complete basket')
                new_value = float(sum(q * prices[i, j] for i, q in proposed.items()))
                previous_divisor = divisor
                if divisor is None:
                    if day != config['base_date']:
                        raise ValueError('Baseline basket empty; choose an explicit supported baseline')
                    divisor = new_value / 100
                else:
                    divisor = neutral_divisor(old_value, new_value, divisor)
                holdings = proposed
                old_level = old_value / previous_divisor if previous_divisor is not None else 100.
                new_level = new_value / divisor
                if not math.isclose(old_level, new_level, rel_tol=1e-11, abs_tol=1e-10):
                    raise ValueError('Membership/quantity review moved the index at unchanged prices')
                old_observed = (float(sum(q * prices[i, j] for i, q in old_holdings.items()
                                  if np.isfinite(panel['values'][i, j]))) if old_holdings else None)
                new_observed = float(sum(q * prices[i, j] for i, q in holdings.items()
                                         if np.isfinite(panel['values'][i, j])))
                reviews.append({'effectiveDate': day.isoformat(), 'cutoff': (day - timedelta(days=1)).isoformat(),
                    'initial': previous_divisor is None, 'entrants': entering, 'exits': leaving,
                    'oldValue': old_value, 'newValue': new_value,
                    'divisorBefore': previous_divisor, 'divisorAfter': divisor,
                    'oldObservedValue': old_observed,
                    'oldEstimatedValue': old_value - old_observed if old_value is not None else None,
                    'oldEstimatedValueSharePct': (old_value - old_observed) / old_value * 100 if old_value else None,
                    'newObservedValue': new_observed, 'newEstimatedValue': new_value - new_observed,
                    'newEstimatedValueSharePct': (new_value - new_observed) / new_value * 100,
                    'priceLevelBeforeReview': old_level, 'priceLevelAfterReview': new_level,
                    'holdings': [{'conditionId': records[i]['id'], 'quantity': q} for i, q in sorted(holdings.items())]})
        if not holdings or divisor is None:
            raise ValueError('No eligible baseline basket for ' + panel['brand'])
        valid = all(np.isfinite(prices[i, j]) for i in holdings)
        actual = np.isfinite(panel['values'][:, j])
        observed_rows = [i for i in holdings if actual[i]]
        estimated_rows = [i for i in holdings if not actual[i]]
        observed_value = float(sum(holdings[i] * prices[i, j] for i in observed_rows))
        estimated_value = float(sum(holdings[i] * prices[i, j] for i in estimated_rows)) if valid else None
        total = observed_value + estimated_value if valid else None
        value = total / divisor if valid else None
        basket_ids = {records[i]['productId'] for i in holdings}
        held_grades = defaultdict(set)
        for i in holdings:
            held_grades[records[i]['productId']].add(records[i]['grade'])
        observed_ids = {records[i]['productId'] for i in observed_rows}
        complete_ids = {cid for cid in basket_ids if all(actual[i] for i in by_product[cid] if i in holdings)}
        stale_rows = [i for i in estimated_rows if ages[i, j] > config['stale_after_days']]
        stale_value = sum(holdings[i] * prices[i, j] for i in stale_rows) if valid else None
        product_values = defaultdict(float)
        if valid:
            for i, q in holdings.items():
                product_values[records[i]['productId']] += q * prices[i, j]
        point = {'date': day.isoformat(), 'value': value, 'logIndex': math.log(value / 100) if value else None,
            'dailyReturn': (value / points[-1]['value'] - 1) * 100 if points and value and points[-1]['value'] else None,
            'valueSum': total, 'divisor': divisor, 'priceChangeBeforeReviewPct':
                (old_value / (points[-1]['valueSum']) - 1) * 100 if points and old_value and points[-1]['valueSum'] else None,
            'provisional': day == current_day, 'componentId': 1,
            'status': 'fully-observed-basket' if valid and not estimated_rows else 'actual-and-estimated-basket' if valid else 'unidentified-basket-price',
            'observedContribution': observed_value / divisor,
            'estimatedContribution': estimated_value / divisor if valid else None,
            'observedValueSharePct': observed_value / total * 100 if valid else None,
            'estimatedValueSharePct': estimated_value / total * 100 if valid else None,
            'staleEstimatedValueSharePct': stale_value / total * 100 if valid else None,
            'observedProducts': len(observed_ids), 'observedConditions': len(observed_rows),
            'fullyObservedProducts': len(complete_ids), 'estimatedProducts': len(basket_ids - complete_ids),
            'estimatedConditions': len(estimated_rows), 'basketProducts': len(basket_ids), 'basketConditions': len(holdings),
            'fixedBasketProducts': len(basket_ids), 'fixedBasketConditions': len(holdings),
            'newlyAdmittedProducts': len(entering), 'verifiedExitProducts': len(leaving),
            'fallbackEstimatedConditions': sum(bool(fallback[i, j]) for i in estimated_rows),
            'estimatedFactorWindowDays': config['window_days'] if model['representation'] == 'native-daily' else 1,
            'minimumEstimatedFactorSupportDays': min(int(model['forecastWindowCoverage'][i, j]) for i in estimated_rows) if estimated_rows else None,
            'medianEstimatedFactorSupportDays': statistics.median(int(model['forecastWindowCoverage'][i, j]) for i in estimated_rows) if estimated_rows else None,
            'minimumEstimatedNativeGroupSupportDays': min(int(model['forecastNativeGroupCoverage'][i, j]) for i in estimated_rows) if estimated_rows else None,
            'medianEstimatedSourceAgeDays': statistics.median(ages[i, j].item() for i in estimated_rows) if estimated_rows and valid else None,
            'maxEstimatedSourceAgeDays': max(ages[i, j].item() for i in estimated_rows) if estimated_rows and valid else None,
            'top10ProductValueSharePct': sum(sorted(product_values.values(), reverse=True)[:10]) / total * 100 if valid else None,
            **_native_breadth(products, panel['brand'], day, basket_ids, held_grades)}
        point['upRatio'] = point['up'] / point['matchedProducts'] if point['matchedProducts'] else None
        point['pairCoverageRatio'] = point['matchedProducts'] / point['sourceObservedProducts'] if point['sourceObservedProducts'] else None
        points.append(point)
    known = [p for p in points if p['value'] is not None]
    peak = max(known, key=lambda p: p['value'])
    current = known[-1]
    diagnostics = {**model['global']['diagnostics'], 'fittedProducts': len(by_product), 'baseComponentId': 1,
        'baseBasketProducts': points[0]['basketProducts'], 'baseBasketConditions': points[0]['basketConditions'],
        'currentBasketProducts': current['basketProducts'], 'currentBasketConditions': current['basketConditions'],
        'currentEstimatedValueSharePct': current['estimatedValueSharePct'],
        'grouping': model['grouping'], 'predictionRule': model['predictionRule'],
        'trainingRepresentation': model['representation'],
        'groupDiagnostics': model['diagnostics'], 'groupingUsesAdmissionReferencePrice': True,
        'fittedObservationsMeaning': ('actual same-condition native date prices, without rolling-window repetition; not transaction count'
            if model['representation'] == 'native-daily' else 'actual trailing-window median summaries; not transaction count'),
        'estimatedPricesAreObservations': False, 'allConstituentPricesCurrentlyIdentified': points[-1]['value'] is not None,
        'latestSourceDate': dates[-1].isoformat(), 'peak': {'date': peak['date'], 'value': peak['value']},
        'drawdownPct': (current['value'] / peak['value'] - 1) * 100,
        'membershipReviewCount': len(reviews), 'scheduledMonthlyReviews': len(review_dates),
        'divisorUsesEstimatedReviewPrices': any((x['oldEstimatedValueSharePct'] or 0) > 1e-10 for x in reviews),
        'maxReviewOldEstimatedValueSharePct': max((x['oldEstimatedValueSharePct'] or 0) for x in reviews),
        'samplingConfidenceValidated': False}
    series = {'brand': panel['brand'], 'label': '포켓몬' if panel['brand'] == 'pokemon' else '원피스',
        'baseDate': dates[0].isoformat(), 'baseValue': 100., 'valuationWindowDays': config['window_days'],
        'firstCalculatedDate': known[0]['date'], 'lastCalculatedDate': current['date'],
        'firstRecordedDate': min(d for r in records for d in r['dates']).isoformat(),
        'lastRecordedDate': max(d for r in records for d in r['dates']).isoformat(),
        'todayIncomplete': dates[-1] == current_day, 'availableProducts': len(by_product),
        'diagnostics': diagnostics, 'points': points}
    state = {'brand': panel['brand'], 'sourceAsOf': dates[-1].isoformat(), 'baseDate': dates[0].isoformat(),
        'dates': [d.isoformat() for d in dates], 'valuationWindowDays': config['window_days'],
        'modelDates': [d.isoformat() for d in model['dates']],
        'trainingRepresentation': model['representation'], 'predictionRule': model['predictionRule'],
        'minimumModelFactorDays': config['minimum_model_factor_days'],
        'conditions': [{k: r[k] for k in ('id', 'productId', 'grade', 'admissionDate', 'referencePrice',
            'referenceSourceDate', 'eligibilityObservedDays', 'firstObservedDate', 'initialCapitalWeight',
            'entryPrice', 'initialQuantity', 'setCode', 'exitDate')} |
            {'groupId': model['labels'][i], 'alpha': float(model['alpha'][i])} for i, r in enumerate(records)],
        'globalFactors': [float(x) if np.isfinite(x) else None for x in model['global']['factors']],
        'globalComponents': model['global']['components'].tolist(),
        'groupFactors': {g: [float(x) if np.isfinite(x) else None for x in m['factors']] for g, m in model['groups'].items()},
        'groupComponents': {g: m['components'].tolist() for g, m in model['groups'].items()},
        'groupUsesGlobalFallback': {g: m['globalFallback'] for g, m in model['groups'].items()},
        'reviews': reviews, 'reviewDates': [d.isoformat() for d in review_dates],
        'config': {k: (v.isoformat() if type(v) is date else v) for k, v in config.items() if k != 'exit_events'},
        'exitEvents': [{**x, 'effectiveDate': x['effectiveDate'].isoformat()} for x in config['exit_events']],
        'anchorRule': ('last SAME-condition native quote amount times median of identifiable connected factor ratios for every calendar date in the target trailing window, each ratio anchored at that actual native quote date; preserve actual target-window medians'
            if model['representation'] == 'native-daily' else 'last preceding actual trailing-window median of the SAME condition times current/anchor group factor ratio; actual current window always overrides; never copy peer-grade price'),
        'factorWindowSupportMeaning': 'identifiable connected factor-ratio calendar days in the target window; group gaps may use disclosed connected global factors, not invented own-condition prices',
        'fallbackRule': 'same connected group component first; group gap uses last group movement then connected global movement; disconnected group uses connected global ratio; otherwise unknown',
        'anchorAgeMeaning': ('days since the exact last SAME-condition native quote; factor anchor is that native quote date'
            if model['representation'] == 'native-daily' else 'days since the latest native observation inside the last actual window; factor anchor is that window end'),
        'fitWeightRule': 'actual economic initialQuantity times prior-cutoff referencePrice; normalized price score equals fixed virtual-quantity native-currency PPML score',
        'historicalRevisions': True}
    return series, state


def economic_gates():
    old_d = 1.
    entry_d = neutral_divisor(100, 1100, old_d)
    exit_d = neutral_divisor(1100, 100, entry_d)
    return [
        {'id': 'arithmetic-price-sum', 'passed': math.isclose((1000 + 100) / 2, 550.), 'example': 'two equal initial prices: one 10x and one flat -> 5.5x before reviews'},
        {'id': 'divisor-neutral-entry-exit', 'passed': math.isclose(1100 / entry_d, 100 / old_d) and math.isclose(100 / exit_d, 100 / old_d)},
        {'id': 'fixed-quantity-roundtrip', 'passed': math.isclose((300 + 100) / 2, 200.) and math.isclose((100 + 100) / 2, 100.)},
    ]


def build_dynamic_index(products, source_as_of, current_day=None, catalog=None, config=None, progress=None):
    cfg = checked_config(config)
    as_of = _date(source_as_of)
    current_day = _date(current_day) if current_day is not None else None
    if as_of < cfg['base_date'] or (current_day is not None and as_of > current_day):
        raise ValueError('Invalid source/baseline/current date ordering')
    prepared = clean_products(products, as_of)
    admitted, entries, review_dates = membership_plan(prepared, as_of, cfg)
    if not admitted:
        raise ValueError('No supported baseline/new membership')
    series, states, development, validation = {}, {}, {}, {}
    for brand in BRANDS:
        if not any(x['brand'] == brand and x['admissionDate'] == cfg['base_date'] for x in admitted.values()):
            raise ValueError('No eligible initial constituents for ' + brand)
        if progress:
            progress(brand + ': building actual trailing-window price panel')
        panel = make_price_panel(prepared, admitted, brand, as_of, cfg, catalog)
        grouping = cfg['grouping_by_brand'].get(brand, cfg['grouping'])
        prediction_rule = cfg['prediction_rule_by_brand'].get(brand, cfg['prediction_rule'])
        development[brand] = []
        selection_performed = False
        if cfg['select_prediction'] and cfg['validate_holdouts']:
            development[brand] = validate_prediction_models(panel, cfg['candidate_groupings'], cfg['development_seeds'],
                tails=True, progress=progress, prediction_rules=cfg['candidate_prediction_rules'])
            winner = select_prediction_candidate(development[brand], cfg['candidate_groupings'],
                                                 cfg['candidate_prediction_rules'])
            grouping, prediction_rule = winner['grouping'], winner['predictionRule']
            selection_performed = True
        if progress:
            progress(brand + ': fitting selected ' + grouping + '/' + prediction_rule + ' predictor')
        representation = TRAINING_REPRESENTATIONS[prediction_rule]
        model = fit_prediction_model(panel, grouping=grouping, representation=representation)
        prices, anchors, ages, fallback = predict_prices(panel, model)
        item, state = aggregate_series(panel, model, prices, anchors, ages, fallback,
            prepared, admitted, entries, review_dates, cfg, current_day)
        state['selectedConfig'] = {'grouping': grouping, 'predictionRule': prediction_rule,
            'trainingRepresentation': representation,
            'selectedUsingHeldoutError': selection_performed, 'selectionUsesIndexMagnitude': False,
            'eligibleForAppliedSelection': prediction_rule == 'native-price-anchor'}
        series[brand], states[brand] = item, state
        validation[brand] = (validate_prediction_models(panel, (grouping,), cfg['validation_seeds'],
            cfg['holdout_days'], tails=True, declines=True, progress=progress, phase='validation',
            prediction_rules=(prediction_rule,))[0] if cfg['validate_holdouts'] else
            {'grouping': grouping, 'predictionRule': prediction_rule, 'trainingRepresentation': representation,
             'tests': [], 'notRun': True})
    method = {
        'id': METHOD_IDS[cfg['weighting']],
        'name': '스니덩 카드 동일 초기금액 참고지수' if cfg['weighting'] == 'equal-amount-fixed' else '스니덩 카드 가상 보유 참고지수',
        'baseDate': cfg['base_date'].isoformat(),
        'baseValue': 100., 'frequency': 'daily', 'currency': 'JPY', 'valuationWindowDays': cfg['window_days'],
        'fixedBasket': False, 'fixedQuantitiesBetweenReviews': True, 'weighting': cfg['weighting'],
        'conditionPolicy': cfg['condition_policy'], 'observationsOnly': False, 'quantityWeights': False,
        'carryDays': 0, 'maximumProducts': None, 'membershipGate': 'prior-cutoff actual price availability and seasoning',
        'printedLanguageRestriction': None, 'scopeFilteringOwnedByLoader': True,
        'membershipReview': 'monthly first calendar day; cutoff previous day',
        'eligibilityWindowDays': cfg['eligibility_window_days'], 'minimumActualObservedDates': cfg['minimum_observations'],
        'minimumHistoryAgeDays': cfg['seasoning_days'], 'conditionAdditionPolicy': 'none: conditions fixed at first product admission',
        'priceAbsenceCausesDeletion': False, 'exitPolicy': 'only explicitly verified scope/deletion event with evidence',
        'formula': 'V(t)=sum(q_i*p_i(t)); I(t)=V(t)/D(t). For equal-amount-fixed, q_i=1/(K*p_i(effective admission date)), allocating 1/K initial amount to each of K pinned conditions. At entry/verified exit: D_new=D_old*V_new(t)/V_old(t) using identical effective-date prices. Previously admitted quantities stay fixed.',
        'productQuantityMeaning': ('one virtual initial monetary unit per product, split 1/K across K eligible condition grades; buy q=1/(K*actual admission-window price) and keep q fixed; not physical circulating supply'
            if cfg['weighting'] != 'one-each' else 'one virtual card per product, split 1/K across K eligible condition grades at admission; a virtual mix, not traded quantity'),
        'existingQuantitiesReassignedAtReview': cfg['weighting'] == 'equal-amount-monthly',
        'virtualQuantityWeights': True,
        'priceDefinition': 'median of actual positive SAME-condition prices in the trailing valuation window; absent windows use explicitly labelled own-condition-anchor model estimates',
        'predictionRule': 'brand-specific locked native-price-anchor or window-price-anchor; selected only by price blackout error',
        'selectedPrediction': {b: states[b]['selectedConfig'] for b in BRANDS},
        'predictorSelectionPrerequisite': 'native quote and factor anchor dates must match; window-price-anchor is a diagnostic benchmark only because it fails the temporal-anchor invariant',
        'nativeModelMinimumFactorDays': cfg['minimum_model_factor_days'],
        'modelTrainingIncludesBaselinePriorWindow': True,
        'baselineSelection': 'explicit 2024-01-01 operating baseline; earliest archived one-card days are not a broad market baseline',
        'historicalRevisions': True, 'modelFitUsesFutureHistoricalObservations': True,
        'divisorMayUseEstimatedExistingHoldingPrices': True,
        'currentEstimatedShareIncludesHistoricalDivisorUncertainty': False,
        'admissionUsesFuturePrices': False, 'dailyEqualReturnChaining': False,
        'priceUnitVerified': False, 'languageVerified': False, 'representativeMarketIndex': False,
        'statisticalConfidenceValidated': False, 'marketCapitalizationIndex': False,
        'sourceQuantityAvailable': False, 'referenceOnly': True,
    }
    report = {'methodId': method['id'], 'numericalValidationComplete': True,
        'predictionValidationRun': cfg['validate_holdouts'],
        'predictionSelectionFrozen': not cfg['select_prediction'],
        'statisticalConfidenceValidated': False, 'representativeMarketIndex': False,
        'economicGates': economic_gates(), 'predictionDevelopment': development,
        'predictionValidation': validation, 'sourceAsOf': as_of.isoformat(),
        'admittedProducts': {b: len([x for x in admitted.values() if x['brand'] == b]) for b in BRANDS},
        'sourceProducts': {b: len([x for x in prepared.values() if x['brand'] == b]) for b in BRANDS},
        'sourceWithoutEligibleMembership': {b: len([cid for cid, x in prepared.items() if x['brand'] == b and cid not in admitted]) for b in BRANDS},
        'nullPriceDays': {b: sum(p['value'] is None for p in s['points']) for b, s in series.items()},
        'requiresEstimateRiskDisclosure': True, 'errors': []}
    for item in series.values():
        item['methodology'] = method
    return {'methodology': method, 'series': series, 'validation': report, 'modelState': states}
