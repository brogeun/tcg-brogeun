"""Anonymous, checkpointed SNKRDUNK collection for explicit game identities.

Public category listing asks are refreshed for every discovered product. Current
A/PSA10/PSA9 chips and historical charts have independent budgets and timestamps.
No cookies, browser automation, paid proxy or invented zero-price observations.
"""
from __future__ import annotations

import argparse
import copy
import html as html_module
import json
import math
import os
import re
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from game_registry import (ADDITIONAL_GAMES, GAME_REGISTRY, RECOGNITION_GAME_IDS, infer_brand_from_product_number, ip_tags,
                           normalize_brand, price_filename, product_in_scope, select_brands)
from refresh_search_prices import fx_basis, listing_price, promote_documents, RefreshError
from metadata_index import load_metadata_index, publish_metadata_index

CONDITIONS = {'raw': 18, 'psa10': 22, 'psa9': 23}
BASE = 'https://snkrdunk.com'
UTC = timezone.utc

class CollectionError(RuntimeError):
    pass

class BudgetExhausted(CollectionError):
    pass

class PhaseBudgetExhausted(BudgetExhausted):
    pass

class SourceStopped(CollectionError):
    pass

def stamp():
    return datetime.now(UTC).isoformat()

def positive(value):
    return type(value) in (int, float) and math.isfinite(value) and value > 0

def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + '.', suffix='.tmp', delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(raw)
        json.loads(temporary.read_bytes())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)

def read_json(path, default):
    return json.loads(path.read_bytes()) if path.exists() else copy.deepcopy(default)

class PublicClient:
    def __init__(self, delay=.25, max_seconds=7200, opener=urllib.request.urlopen,
                 clock=time.monotonic, sleep=time.sleep):
        if delay < .1 or not 1 <= max_seconds <= 21600:
            raise ValueError('Use delay >=0.1 and runtime 1..21600 seconds')
        self.delay, self.max_seconds = delay, max_seconds
        self.opener, self.clock, self.sleep = opener, clock, sleep
        self.started, self.last_request, self.requests = clock(), None, 0
        self.phase_deadline = None

    def set_phase(self, seconds=None):
        self.phase_deadline = None if seconds is None else self.clock() + max(.01, seconds)

    def remaining(self):
        left = self.max_seconds - (self.clock() - self.started)
        if left <= 0:
            raise BudgetExhausted('Runtime budget reached; collected checkpoints retained')
        if self.phase_deadline is not None:
            phase_left = self.phase_deadline - self.clock()
            if phase_left <= 0:
                raise PhaseBudgetExhausted('Per-stream/phase budget reached; checkpoint retained')
            left = min(left, phase_left)
        return left

    def exhausted(self, message):
        if self.phase_deadline is not None and self.phase_deadline < self.started + self.max_seconds:
            return PhaseBudgetExhausted(message)
        return BudgetExhausted(message)

    def get(self, url, json_response=True):
        if not url.startswith(BASE + '/'):
            raise CollectionError('Only the original SNKRDUNK host is allowed')
        for attempt in range(2):
            left = self.remaining()
            wait = max(0, self.delay - (self.clock() - self.last_request)) if self.last_request is not None else 0
            if left <= wait:
                raise self.exhausted('Runtime/phase budget reached before next request')
            self.sleep(wait)
            self.remaining()
            request = urllib.request.Request(url, headers={
                'User-Agent': 'TCGHUB-game-prices/1.0 (+https://tcghub.kr)',
                'Accept': 'application/json' if json_response else 'text/html,application/xhtml+xml',
                'Accept-Language': 'ja-JP,ja;q=0.9,en;q=0.8',
                'Referer': BASE + '/',
            })
            self.requests += 1
            self.last_request = self.clock()
            try:
                with self.opener(request, timeout=min(20, self.remaining())) as response:
                    if not response.geturl().startswith(BASE + '/'):
                        raise SourceStopped('Unexpected source redirect')
                    if response.getcode() != 200:
                        raise CollectionError('Unexpected HTTP status ' + str(response.getcode()))
                    raw = response.read(8_000_001)
                    if len(raw) > 8_000_000:
                        raise CollectionError('Source response exceeds 8MB limit')
                text = raw.decode('utf-8')
                return json.loads(text) if json_response else text
            except urllib.error.HTTPError as error:
                if error.code in (403, 429):
                    raise SourceStopped(f'HTTP {error.code}; no access bypass attempted') from error
                if error.code < 500 or attempt:
                    raise CollectionError('Source HTTP ' + str(error.code)) from error
            except (urllib.error.URLError, TimeoutError, OSError) as error:
                if attempt:
                    raise CollectionError('Source transport error: ' + type(error).__name__) from error
            if self.remaining() <= 1:
                raise self.exhausted('Runtime/phase budget reached during retry')
            self.sleep(1)
        raise CollectionError('Request attempts exhausted')

def parse_native_listing(item):
    """A formatted currency and numeric amount must agree before exposing an ask."""
    value = item.get('minPrice')
    display = str(item.get('minPriceFormat') or '').strip()
    currency = None
    match = re.fullmatch(r'(US\s*\$|USD|\$|[¥￥₩])\s*([\d,]+(?:\.\d+)?)(?:~)?', display)
    if match:
        currency = 'JPY' if match[1] in ('¥', '￥') else 'KRW' if match[1] == '₩' else 'USD'
        if item.get('currency') is not None and item['currency'] != currency:
            raise CollectionError('Declared and formatted listing currencies disagree')
        amount = float(match[2].replace(',', ''))
        if positive(value) and math.isclose(float(value), amount, abs_tol=.011, rel_tol=0):
            return {'amount': value, 'currency': currency}
    if value in (None, '', 0):
        return None
    raise CollectionError('Listing price and explicit currency display disagree')

def normalize_product(item, brand, kind, checked_at, basis):
    cid = str(item.get('id') or '')
    if not re.fullmatch(r'[1-9]\d*', cid) or not isinstance(item.get('name'), str) or not item['name'].strip():
        raise CollectionError('Missing numeric product ID or name')
    declared = normalize_brand(item.get('brandId') or item.get('brand')) or infer_brand_from_product_number(item.get('productNumber'))
    if declared and declared != brand:
        raise CollectionError('Listing product belongs to a different game')
    native = parse_native_listing(item)
    normalized = None
    status = 'no-listings' if not native else 'available'
    if native:
        try:
            normalized, _ = listing_price(item, basis)
        except (RefreshError, KeyError, TypeError):
            # A native verified ask remains useful when conversion evidence is absent.
            status = 'native-currency-only'
    count = item.get('listingCount')
    if count is not None:
        if not re.fullmatch(r'\d+\+?', str(count)):
            raise CollectionError('Invalid listing count')
        count = str(count) if str(count).endswith('+') else int(count)
    if count == 0 and native:
        raise CollectionError('Conflicting available ask and zero listing count')
    if not native and count not in (0, None):
        status = 'price-unavailable'
    code = str(item.get('productNumber') or '')
    return {
        'id': cid, 'name': str(item['name']).strip(), 'brand': brand, 'kind': kind,
        'recognitionGameId': RECOGNITION_GAME_IDS[brand],
        'language': declared_language(item),
        'code': code, 'productNumber': code,
        'image': item.get('thumbnailUrl'), 'thumbnailUrl': item.get('thumbnailUrl'),
        'releasedAt': item.get('releasedAt'), 'url': BASE + '/apparels/' + cid,
        'ipTags': ip_tags(item), 'minPrice': normalized, 'currency': 'USD',
        'listingCount': count, 'priceCheckedAt': checked_at, 'priceStatus': status,
        'catalogAsk': {**(native or {'amount': None, 'currency': None}),
                       'kind': 'lowest_listing_ask', 'condition': 'unspecified',
                       'checkedAt': checked_at, 'sourceUrl': BASE + '/apparels/' + cid},
        'priceSource': {'source': 'SNKRDUNK', 'type': 'listing-ask',
                        'condition': 'unspecified', 'sourceCurrency': native['currency'] if native else None},
    }

def declared_language(item):
    language = str(item.get('language') or item.get('lang') or '').lower()
    known = {'jp':'ja', 'ja':'ja', 'japanese':'ja', 'en':'en', 'english':'en', 'ko':'ko', 'kr':'ko', 'zh':'zh', 'cn':'zh'}
    if language in known:
        return known[language]
    name = str(item.get('name') or '')
    if re.search(r'\[(?:EN|ENG)\]|English (?:Edition|Version)|英語版', name, re.I):
        return 'en'
    if re.search(r'\[(?:JP|JPN)\]|Japanese (?:Edition|Version)|日本語版', name, re.I):
        return 'ja'
    return 'unknown'

def classified_kind(item, requested):
    name = str(item.get('name') or '')
    has_card_number = bool(re.search(r'\[[^\]]*(?:\d+\s*/\s*\d+|[-/][A-Z]{0,4}\d{2,4}[A-Z]*)\]', name, re.I))
    hard_box = bool(re.search(r'\bBOX\b|ボックス|\b(?:TRIAL|STARTER)\s+DECK\b|スターターデッキ', name, re.I))
    if hard_box and not has_card_number:
        return 'box'
    if has_card_number and not hard_box:
        return 'card'
    return requested

def collect_listing(client, brand, kind, basis, per_page=100, max_pages=2000, start_page=1):
    source_brand = GAME_REGISTRY[brand]['source_brand']
    category = 25 if kind == 'card' else 14
    found, fingerprints, source_ids, out_of_scope = {}, set(), set(), 0
    # This is a per-run page budget, not a permanent source-page ceiling.
    # A retained cursor past 2000 must continue rather than silently stall.
    last_page = start_page + max_pages - 1
    for page in range(start_page, last_page + 1):
        url = BASE + '/en/v1/trading-cards?' + urllib.parse.urlencode({
            'brandId': source_brand, 'categoryId': category, 'page': page,
            'perPage': per_page, 'order': 'new'})
        try:
            payload = client.get(url)
        except PhaseBudgetExhausted as error:
            return found, {'complete': False, 'pages': page - 1, 'startedPage': start_page, 'terminal': 'phase-budget',
                           'outOfScope': out_of_scope, 'stoppedReason': str(error)}
        except BudgetExhausted as error:
            return found, {'complete': False, 'pages': page - 1, 'terminal': 'runtime-budget',
                           'outOfScope': out_of_scope, 'stoppedReason': str(error)}
        if not isinstance(payload, dict) or not isinstance(payload.get('tradingCards'), list):
            raise CollectionError('Listing schema lacks tradingCards array')
        rows = payload['tradingCards']
        if len(rows) > per_page:
            raise CollectionError('Source returned more than requested page size')
        if not rows:
            if kind == 'card' and start_page == 1 and page == 1:
                raise CollectionError('Unexpected empty known-game card catalogue; previous records retained')
            return found, {'complete': True, 'pages': page, 'startedPage': start_page, 'terminal': 'empty-page', 'outOfScope': out_of_scope}
        fingerprint = tuple(str(row.get('id')) for row in rows)
        if fingerprint in fingerprints or not set(fingerprint).difference(source_ids):
            return found, {'complete': False, 'pages': page, 'terminal': 'repeated-page', 'outOfScope': out_of_scope}
        fingerprints.add(fingerprint)
        source_ids.update(fingerprint)
        checked_at = stamp()
        for item in rows:
            if not isinstance(item, dict):
                raise CollectionError('Invalid listing row')
            if not product_in_scope(brand, item):
                out_of_scope += 1
                continue
            if classified_kind(item, kind) != kind:
                out_of_scope += 1
                continue
            product = normalize_product(item, brand, kind, checked_at, basis)
            found[product['id']] = product
        print(f'[snkr] {brand}/{kind} page={page} products={len(found)}', flush=True)
        if len(rows) < per_page:
            # Confirm an explicit terminal page; a short response alone is not proof.
            continue
    return found, {'complete': False, 'pages': last_page, 'startedPage': start_page, 'terminal': 'page-budget', 'outOfScope': out_of_scope}

def parse_grade_chips(text, expected_id=None):
    checked, output = set(), {}
    by_condition = {value: key for key, value in CONDITIONS.items()}
    records = []
    if expected_id is not None:
        wanted = f'/v2/products/{expected_id}/size-chips'
        for script in re.findall(r'<script[^>]*>([\s\S]*?)</script>', text, re.I):
            if 'size-chips' not in script or '.push(' not in script:
                continue
            try:
                document, _ = json.JSONDecoder().raw_decode(script[script.find('.push(') + 6:])
            except (ValueError, TypeError):
                continue
            for query in document.get('queries', []) if isinstance(document, dict) else []:
                if not isinstance(query, dict):
                    continue
                key = query.get('queryKey', [])
                state = query.get('state', {})
                if not isinstance(state, dict):
                    continue
                response = state.get('data', {})
                if not isinstance(response, dict):
                    continue
                if isinstance(key, list) and key and key[0] == wanted and state.get('status') == 'success' and response.get('status') == 200:
                    chips = response.get('data', {}).get('chips')
                    if isinstance(chips, list):
                        records.extend(chips)
        if not records:
            raise CollectionError('No grade response bound to the requested product ID')
    else:
        # Pure parser fixtures/older saved data without a product URL may use flat chips.
        for obj in re.findall(r'\{[^{}]{0,1200}"conditionId":(?:18|22|23)[^{}]{0,1200}\}', text):
            try:
                records.append(json.loads(obj))
            except ValueError:
                continue
    for obj in records:
        condition = obj.get('conditionId') if isinstance(obj, dict) else None
        if condition not in by_condition:
            continue
        amount = obj.get('usedMinPrice')
        absent = obj.get('hasListing') is False
        if amount is None:
            if absent:
                checked.add(condition)
                candidate = {'currency': 'JPY', 'availability': 'no-listing', 'price_kind': 'lowest_listing_ask'}
                if by_condition[condition] in output and output[by_condition[condition]] != candidate:
                    raise CollectionError('Conflicting duplicate grade states')
                output[by_condition[condition]] = candidate
            continue
        if type(amount) not in (int, float) or not math.isfinite(amount) or amount < 0:
            raise CollectionError('Invalid grade listing price')
        value = amount
        if (absent and value > 0) or (value > 0 and obj.get('hasListing') is not True):
            raise CollectionError('Conflicting grade listing availability')
        checked.add(condition)
        count = obj.get('listingCount')
        if count is not None and (type(count) is not int or count < 0 or count == 0 and value > 0):
            raise CollectionError('Invalid grade listing count')
        quote = {'currency': 'JPY', 'availability': 'listed' if value > 0 else 'no-listing',
                 'price_kind': 'lowest_listing_ask', 'live_source': 'snkrdunk usedMinPrice'}
        if value > 0:
            quote['lowest_ask'] = value
        if count is not None:
            quote['active_count'] = count
        if by_condition[condition] in output and output[by_condition[condition]] != quote:
            raise CollectionError('Conflicting duplicate grade states')
        output[by_condition[condition]] = quote
    if checked != set(by_condition):
        raise CollectionError('Incomplete official condition chips; previous quote retained')
    return output

def parse_chart(payload):
    points = payload.get('points') if isinstance(payload, dict) else None
    if not isinstance(points, list):
        raise CollectionError('Grade chart lacks points array')
    output = []
    for point in points:
        if not isinstance(point, list) or len(point) < 2 or type(point[0]) not in (int, float) or not math.isfinite(point[0]) or type(point[1]) not in (int, float) or not math.isfinite(point[1]):
            raise CollectionError('Invalid grade chart point')
        if point[1] > 0:
            output.append([point[0], point[1]])
    return sorted(output)

def _catalog_rows(path):
    document = read_json(path, {'products': []})
    rows = document.get('products')
    if not isinstance(rows, list):
        raise CollectionError('Existing price file has malformed products: ' + str(path))
    rows = list(rows)
    for url in document.get('shards', []):
        if not isinstance(url, str) or not re.fullmatch(r'/data/snkrdunk-games/[a-z_]+-(?:card|box)-\d{4}\.json', url):
            raise CollectionError('Unsafe existing source shard path')
        part = read_json(path.parent / url.removeprefix('/data/'), None)
        if not isinstance(part, dict) or not isinstance(part.get('products'), list):
            raise CollectionError('Existing source shard is unavailable')
        if part.get('brand') != document.get('brand') or part.get('kind') != document.get('kind'):
            raise CollectionError('Existing source shard game/kind mismatch')
        rows.extend(part['products'])
    output = {}
    for row in rows:
        if not isinstance(row, dict) or not re.fullmatch(r'[1-9]\d*', str(row.get('id') or '')):
            raise CollectionError('Existing source product ID is malformed')
        cid = str(row['id'])
        if cid in output:
            raise CollectionError('Duplicate product ID in source shards')
        output[cid] = row
    if document.get('totalCount') is not None and document['totalCount'] != len(output):
        raise CollectionError('Existing source shard total count mismatch')
    return output

def fair_queue(products, chosen, timestamp_key):
    """Round-robin games, oldest checked product first within each game."""
    queues = {brand: sorted((row for row in products.values() if row.get('kind') == 'card' and row.get('brand') == brand),
                             key=lambda row: (row.get(timestamp_key) or '', int(row['id']))) for brand in chosen}
    result = []
    for index in range(max((len(rows) for rows in queues.values()), default=0)):
        for brand in chosen:
            if index < len(queues[brand]):
                result.append(queues[brand][index])
    return result

def publish(data_dir, products, streams, chosen, summary, merge_shared=True, merge_new_search=False):
    shared_names = ('all-cards.json', 'cards-meta.json', 'cards-prices.json')
    original = {name: (data_dir / name).read_bytes() if (data_dir / name).exists() else None for name in shared_names} if merge_shared else {}
    catalog_path = data_dir / 'all-cards.json'
    catalog = read_json(catalog_path, {'details': []}) if merge_shared else None
    previous = {str(row['id']): row for row in catalog.get('details', []) if isinstance(row, dict) and row.get('id')} if merge_shared else {}
    metadata_path = data_dir / 'cards-meta-index.json'
    metadata = load_metadata_index(data_dir) if merge_shared else {}
    if not isinstance(metadata, dict):
        raise CollectionError('Existing metadata index must be an object')
    detail_path = data_dir / 'cards-detail.json'
    detail = read_json(detail_path, {'cards': {}}) if merge_shared else {'cards': {}}
    if not isinstance(detail.get('cards'), dict):
        raise CollectionError('Existing card detail index must contain a cards object')
    # Validate ownership before the first file replacement, not halfway through publication.
    for cid, item in products.items():
        if item.get('brand') not in chosen or item.get('kind') not in ('card', 'box'):
            raise CollectionError('Unexpected game or kind in publication batch')
        for old in (previous.get(cid), metadata.get(cid)):
            if not old:
                continue
            old_brand = old.get('brand')
            if old_brand and (normalize_brand(old_brand) or old_brand) != item['brand']:
                raise CollectionError('Shared product ID conflicts with existing brand: ' + cid)
            if old.get('kind') and old['kind'] != item['kind']:
                raise CollectionError('Shared product ID conflicts with existing product kind: ' + cid)
    manifest_path = data_dir / 'snkrdunk-games.json'
    previous_manifest = read_json(manifest_path, {'games': []})
    games = {row['id']: row for row in previous_manifest.get('games', []) if isinstance(row, dict) and row.get('id') in GAME_REGISTRY}
    now = stamp()
    for brand in chosen:
        own = {kind: [row for row in products.values() if row.get('brand') == brand and row.get('kind') == kind] for kind in ('card', 'box')}
        for kind, rows in own.items():
            rows.sort(key=lambda row: int(row['id']))
            collection = streams.get(brand + ':' + kind, {})
            snapshot = {
                'ok': True, 'schemaVersion': 1, 'brand': brand, 'kind': kind,
                'source': 'SNKRDUNK', 'currency': 'USD', 'fetchedAt': now,
                'count': len(rows), 'totalCount': len(rows), 'collection': collection, 'products': rows}
            if len(json.dumps(snapshot, ensure_ascii=False, separators=(',', ':')).encode('utf-8')) > 12 * 1024 * 1024:
                snapshot['products'] = rows[:500]
                snapshot['count'] = len(snapshot['products'])
                snapshot['shards'] = []
                for offset in range(500, len(rows), 500):
                    shard_name = f'{brand}-{kind}-{offset // 500:04d}.json'
                    chunk = rows[offset:offset + 500]
                    atomic_json(data_dir / 'snkrdunk-games' / shard_name, {
                        'schemaVersion': 1, 'brand': brand, 'kind': kind, 'source': 'SNKRDUNK',
                        'count': len(chunk), 'products': chunk})
                    snapshot['shards'].append('/data/snkrdunk-games/' + shard_name)
            atomic_json(data_dir / price_filename(brand, kind), snapshot)
        checked = [row for row in own['card'] if row.get('gradeCheckedAt')]
        games[brand] = {
            'id': brand, 'label': GAME_REGISTRY[brand]['label'], 'sourceBrand': GAME_REGISTRY[brand]['source_brand'],
            'recognitionGameId': RECOGNITION_GAME_IDS[brand],
            'cardUrl': '/data/' + price_filename(brand, 'card'), 'boxUrl': '/data/' + price_filename(brand, 'box'),
            'cardCount': len(own['card']), 'boxCount': len(own['box']),
            'listingComplete': all(streams.get(brand + ':' + kind, {}).get('complete') is True for kind in ('card', 'box')),
            'listingCollectedAt': max((row.get('priceCheckedAt') or '' for row in own['card'] + own['box']), default=None),
            'gradeCheckedCount': len(checked), 'gradeCheckedThisRun': sum(row.get('gradeRunId') == summary['runId'] for row in checked),
            'gradeAvailableCount': sum(any(positive(value.get('lowest_ask')) for value in row.get('grades', {}).values()) for row in own['card']),
            'chartReferenceCount': sum(any(positive(value.get('chart_latest_price')) for value in row.get('grades', {}).values()) for row in own['card']),
            'ipFilters': ['nikke'] if brand in ('weiss_schwarz', 'union_arena') else [],
        }
    atomic_json(manifest_path, {'schemaVersion': 1, 'source': 'SNKRDUNK', 'fetchedAt': now,
                               'collection': summary, 'games': [games[key] for key in GAME_REGISTRY if key in games]})
    if not merge_shared:
        return
    # Existing product IDs are never reassigned to another game or product kind.
    for cid, item in products.items():
        old = previous.get(cid)
        if old is None and not merge_new_search:
            continue  # New game records stay complete in the separately paged source feed.
        compact_keys = ('id', 'name', 'brand', 'kind', 'productNumber', 'thumbnailUrl', 'releasedAt',
                        'recognitionGameId', 'language', 'ipTags', 'minPrice', 'currency',
                        'listingCount', 'priceCheckedAt', 'priceStatus', 'priceSource')
        previous[cid] = {**(old or {}), **{key: item.get(key) for key in compact_keys}}
    details = [previous[key] for key in sorted(previous, key=lambda value: (not value.isdigit(), int(value) if value.isdigit() else value))]
    old_groups = catalog.get('byBrand', {})
    group_keys = dict.fromkeys([*old_groups, *GAME_REGISTRY,
                                *(str(row.get('brand')) for row in details if row.get('brand'))])
    groups = {}
    for brand in group_keys:
        matching = [row['id'] for row in details if row.get('brand') == brand]
        groups[brand] = list(dict.fromkeys([*(old_groups.get(brand, []) if normalize_brand(brand) is None else []), *matching]))
    catalog.update(details=details, cards=[row['id'] for row in details if row.get('kind', 'card') == 'card'],
                   boxes=[row['id'] for row in details if row.get('kind') == 'box'], all=[row['id'] for row in details],
                   byBrand=groups,
                   multiGameRefresh={'completedAt': now, **summary})
    meta_fields = ('id', 'name', 'productNumber', 'thumbnailUrl', 'releasedAt', 'brand', 'kind', 'ipTags')
    meta_previous = read_json(data_dir / 'cards-meta.json', {})
    meta_previous.update(cards=[{key: row.get(key) for key in meta_fields} for row in details], multiGameRefreshAt=now)
    price_previous = read_json(data_dir / 'cards-prices.json', {'prices': {}})
    price_map = price_previous.setdefault('prices', {})
    for cid, row in products.items():
        if cid not in previous:
            continue
        price_map[cid] = [row.get('minPrice'), row.get('currency', 'USD'), row.get('listingCount'), row.get('priceCheckedAt'), row.get('priceStatus', 'unverified')]
    price_previous.update(priceArrayFields=['minPrice', 'currency', 'listingCount', 'priceCheckedAt', 'priceStatus'], multiGameRefreshAt=now)
    search_changed = merge_new_search or any(cid in previous for cid in products)
    if search_changed:
        promote_documents(data_dir, {'all-cards.json': catalog, 'cards-meta.json': meta_previous,
                                     'cards-prices.json': price_previous}, original)
    detail_cards = detail.setdefault('cards', {})
    for cid, row in products.items():
        if row.get('gradeCheckedAt'):
            old = detail_cards.get(cid, {})
            detail_cards[cid] = {**old, 'id': cid, 'brand': row['brand'], 'kind': row['kind'],
                                 'grades': row.get('grades', {}), 'fetchedAt': row['gradeCheckedAt'],
                                 'gradeStatus': row.get('gradeStatus'), 'source': 'SNKRDUNK official condition chips'}
    detail.update(ok=True, count=len(detail_cards), multiGameRefreshAt=now)
    atomic_json(detail_path, detail)
    for cid, row in products.items():
        metadata[cid] = {**metadata.get(cid, {}), 'name': row['name'],
                         'code': row.get('code') or row.get('productNumber'),
                         'brand': row['brand'], 'kind': row['kind'],
                         'recognitionGameId': row.get('recognitionGameId')}
    publish_metadata_index(data_dir, metadata)

def run(args, client=None):
    data_dir = Path(args.data_dir)
    chosen = select_brands(args.brands, ADDITIONAL_GAMES)
    client = client or PublicClient(args.delay, args.max_seconds)
    basis = None
    try:
        basis = fx_basis(read_json(data_dir / 'fx-rates.json', {}), datetime.now(UTC))
    except (RefreshError, ValueError, OSError):
        pass
    products = {}
    prior_streams = {}
    for brand in chosen:
        for kind in ('card', 'box'):
            price_path = data_dir / price_filename(brand, kind)
            prior_streams[brand + ':' + kind] = read_json(price_path, {}).get('collection', {})
            for cid, row in _catalog_rows(price_path).items():
                products[cid] = row
    summary = {'runId': stamp(), 'startedAt': stamp(), 'currentGradeBudget': args.grade_limit,
               'historyBudget': args.history_limit, 'gradeChecks': 0, 'historyChecks': 0,
               'gradeFailures': 0, 'historyFailures': 0, 'listingFailures': 0, 'status': 'running',
               'catalogAsksAreConditionUnspecified': True, 'historicalChartsAreNotListingAsks': True,
               'sharedSearchScope': 'append-new-explicit-opt-in' if getattr(args, 'merge_new_search', False) else 'existing-shared-ids-only',
               'continuationRun': getattr(args, 'continue_listing', False), 'skipCurrentGrades': getattr(args, 'skip_grades', False),
               'skipListing': getattr(args, 'skip_listing', False)}
    streams = {}
    stopped = None
    def accept_rows(rows):
        for cid, fresh in rows.items():
            old = products.get(cid, {})
            if old and (old.get('brand') != fresh['brand'] or old.get('kind') != fresh['kind']):
                raise CollectionError('Product ID changes game or product kind')
            products[cid] = {**old, **fresh}

    def set_phase(seconds=None):
        if hasattr(client, 'set_phase'):
            client.set_phase(seconds)

    try:
        for brand in chosen:
            for kind in ('card', 'box'):
                previous_stream = prior_streams.get(brand + ':' + kind, {})
                if getattr(args, 'skip_listing', False) or kind not in getattr(args, 'kinds', 'card,box').split(','):
                    streams[brand + ':' + kind] = previous_stream
                    continue
                start_page = 1
                stream_seconds = args.max_seconds * .4 / len(chosen) * (.85 if kind == 'card' else .15)
                set_phase(stream_seconds)
                if getattr(args, 'continue_listing', False):
                    if previous_stream.get('complete') is True:
                        streams[brand + ':' + kind] = previous_stream
                        set_phase()
                        continue
                    if previous_stream.get('terminal') in ('page-budget', 'runtime-budget', 'phase-budget'):
                        start_page = int(previous_stream.get('pages', 0)) + 1
                elif previous_stream.get('complete') is False and previous_stream.get('terminal') in ('page-budget', 'runtime-budget', 'phase-budget') and previous_stream.get('pages', 0) >= 5:
                    # Always check the newest products today, then continue the
                    # retained older-page traversal instead of restarting forever.
                    try:
                        front_rows, front = collect_listing(client, brand, kind, basis, args.per_page, min(5, args.max_pages))
                    except (BudgetExhausted, SourceStopped):
                        raise
                    except (CollectionError, ValueError, UnicodeError) as error:
                        front_rows, front = {}, {**previous_stream, 'complete': False, 'terminal': 'source-error', 'error': str(error)}
                        summary['listingFailures'] += 1
                    accept_rows(front_rows)
                    if front.get('complete'):
                        start_page = 0
                        rows, stream = {}, front
                    elif front.get('terminal') in ('runtime-budget', 'phase-budget', 'source-error'):
                        start_page = 0
                        rows, stream = {}, {**front, 'pages': previous_stream.get('pages', 0)}
                    else:
                        start_page = int(previous_stream.get('pages', 0)) + 1
                try:
                    if start_page:
                        rows, stream = collect_listing(client, brand, kind, basis, args.per_page, args.max_pages, start_page)
                except (BudgetExhausted, SourceStopped):
                    raise
                except (CollectionError, ValueError, UnicodeError) as error:
                    rows, stream = {}, {**previous_stream, 'complete': False, 'terminal': 'source-error', 'error': str(error)}
                    summary['listingFailures'] += 1
                finally:
                    set_phase()
                stream['checkedAt'] = stamp()
                accept_rows(rows)
                streams[brand + ':' + kind] = stream
                publish(data_dir, products, streams, chosen, summary, not args.no_shared, getattr(args, 'merge_new_search', False))
                if stream.get('terminal') == 'runtime-budget':
                    raise BudgetExhausted(stream['stoppedReason'])
        queue = [] if getattr(args, 'skip_grades', False) else fair_queue(products, chosen, 'gradeCheckedAt')
        if args.grade_limit:
            queue = queue[:args.grade_limit]
        history_reserve = args.max_seconds * .25 if args.history_limit else 0
        if hasattr(client, 'remaining'):
            set_phase(max(.1, client.remaining() - history_reserve))
        for index, row in enumerate(queue, 1):
            cid = row['id']
            try:
                grades = parse_grade_chips(client.get(BASE + '/apparels/' + cid, json_response=False), cid)
                for grade, quote in grades.items():
                    for key in ('chart_latest_price', 'chart_latest_at', 'chart_price_kind'):
                        if key in row.get('grades', {}).get(grade, {}):
                            quote[key] = row['grades'][grade][key]
                row.update(grades=grades, gradeCheckedAt=stamp(), gradeStatus='checked', gradeRunId=summary['runId'])
                summary['gradeChecks'] += 1
            except PhaseBudgetExhausted:
                summary['gradePhaseStatus'] = 'time-budget-reached-history-reserved'
                break
            except (BudgetExhausted, SourceStopped):
                raise
            except (CollectionError, ValueError, UnicodeError) as error:
                row.update(gradeStatus='previous-retained-after-error', gradeLastError=str(error), gradeLastAttemptAt=stamp())
                summary['gradeFailures'] += 1
            if index % args.checkpoint_every == 0:
                publish(data_dir, products, streams, chosen, summary, not args.no_shared, getattr(args, 'merge_new_search', False))
        set_phase()
        history_queue = fair_queue(products, chosen, 'historyCheckedAt')[:args.history_limit]
        for index, row in enumerate(history_queue, 1):
            cid = row['id']
            try:
                grades = {}
                for grade, condition in CONDITIONS.items():
                    url = BASE + f'/v1/apparels/{cid}/sales-chart/used?range=all&salesChartOptionId={condition}'
                    grades[grade] = parse_chart(client.get(url))
                fresh_counts = {grade: len(points) for grade, points in grades.items()}
                previous_history = read_json(data_dir / 'snkrdunk-history' / (cid + '.json'), {})
                for grade, points in grades.items():
                    prior_points = parse_chart({'points': previous_history.get('grades', {}).get(grade, [])})
                    merged_points = {point[0]: point for point in prior_points}
                    merged_points.update({point[0]: point for point in points})
                    grades[grade] = [merged_points[key] for key in sorted(merged_points)]
                checked_at = stamp()
                atomic_json(data_dir / 'snkrdunk-history' / (cid + '.json'), {
                    'schemaVersion': 1, 'id': cid, 'brand': row['brand'], 'currency': 'JPY',
                    'source': 'SNKRDUNK grade-filtered sales-chart', 'updatedAt': checked_at, 'grades': grades,
                    'latestSourcePointCounts': fresh_counts,
                    'emptyChartMeans': 'no observed trades, not zero price'})
                row['historyCheckedAt'] = checked_at
                row['historyUrl'] = '/data/snkrdunk-history/' + cid + '.json'
                for grade, points in grades.items():
                    if points:
                        quote = row.setdefault('grades', {}).setdefault(grade, {'currency': 'JPY'})
                        quote.update(chart_latest_price=points[-1][1], chart_latest_at=points[-1][0], chart_price_kind='recorded_trade_chart')
                summary['historyChecks'] += 1
            except (BudgetExhausted, SourceStopped):
                raise
            except (CollectionError, ValueError, UnicodeError) as error:
                row.update(historyLastError=str(error), historyLastAttemptAt=stamp())
                summary['historyFailures'] += 1
            if index % args.checkpoint_every == 0:
                publish(data_dir, products, streams, chosen, summary, not args.no_shared, getattr(args, 'merge_new_search', False))
        summary['status'] = 'checkpointed-partial' if summary.get('gradePhaseStatus') or summary['listingFailures'] else 'completed-requested-budgets'
    except (BudgetExhausted, SourceStopped) as error:
        stopped = error
        summary.update(status='checkpointed-partial', stoppedReason=str(error))
    except Exception as error:
        summary.update(status='failed-checkpoint-retained', stoppedReason=type(error).__name__ + ': ' + str(error))
        publish(data_dir, products, streams, chosen, summary, not args.no_shared, getattr(args, 'merge_new_search', False))
        raise
    finally:
        summary.update(finishedAt=stamp(), requests=client.requests,
                       listingStreamsComplete=all(streams.get(brand + ':' + kind, {}).get('complete') is True for brand in chosen for kind in ('card', 'box')),
                       productCount=len(products), gradeTotalChecked=sum(bool(row.get('gradeCheckedAt')) for row in products.values()))
        publish(data_dir, products, streams, chosen, summary, not args.no_shared, getattr(args, 'merge_new_search', False))
    print(json.dumps(summary, ensure_ascii=False), flush=True)
    return 1 if isinstance(stopped, SourceStopped) else 0

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, default=Path(__file__).resolve().parents[1] / 'data')
    parser.add_argument('--brands', default=','.join(ADDITIONAL_GAMES))
    parser.add_argument('--per-page', type=int, default=100)
    parser.add_argument('--max-pages', type=int, default=2000)
    parser.add_argument('--grade-limit', type=int, default=1500, help='Current grade-chip checks per run; explicit 0 means all queued cards, subject to the reserved history time')
    parser.add_argument('--skip-grades', action='store_true', help='Explicit metadata/listing-only continuation without current grade requests')
    parser.add_argument('--continue-listing', action='store_true', help='Continue retained incomplete traversal; default daily runs always refresh from page 1')
    parser.add_argument('--skip-listing', action='store_true', help='Current grade/history-only maintenance using the retained catalogue')
    parser.add_argument('--kinds', default='card,box', help='Listing streams: card, box, or card,box')
    parser.add_argument('--history-limit', type=int, default=500, help='Independent full-history product budget with reserved runtime')
    parser.add_argument('--max-seconds', type=int, default=7200)
    parser.add_argument('--delay', type=float, default=.25)
    parser.add_argument('--checkpoint-every', type=int, default=100)
    parser.add_argument('--no-shared', action='store_true', help='Only write per-game outputs and manifest')
    parser.add_argument('--merge-new-search', action='store_true', help='Opt in to adding new game rows to the legacy search bundle; validate asset size before use')
    args = parser.parse_args(argv)
    if not 1 <= args.per_page <= 100 or not 1 <= args.max_pages <= 2000 or args.grade_limit < 0 or args.history_limit < 0 or args.checkpoint_every < 1 or not set(args.kinds.split(',')) <= {'card','box'}:
        parser.error('Invalid positive collection bounds')
    try:
        return run(args)
    except (CollectionError, OSError, ValueError) as error:
        print('SNKRDUNK game collection failed: ' + str(error), flush=True)
        return 1

if __name__ == '__main__':
    raise SystemExit(main())
