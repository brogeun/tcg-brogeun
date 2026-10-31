"""Merge verified manufacturer product lists without using prices as inventory.

Market sets remain immutable for existing links and quote regression checks.
Official product membership, market printing supplements and pending sources
have separate coverage fields. A product code is never inferred from card order.
"""
from __future__ import annotations

import hashlib
import gzip
import json
import re
import unicodedata
from collections import defaultdict
from urllib.parse import urlparse

HOSTS = {
    'weiss_schwarz': {'ws-tcg.com', 'www.ws-tcg.com'},
    'union_arena': {'www.unionarena-tcg.com', 'unionarena-tcg.com'},
    'dragon_ball_fusion_world': {'www.dbs-cardgame.com', 'dbs-cardgame.com'},
    'digimon': {'digimoncard.com', 'www.digimoncard.com'},
    'yugioh': {'www.db.yugioh-card.com', 'www.yugioh-card.com'},
}
CODE_PATTERNS = {
    'union_arena': r'(?:UA[0-9]+(?:BT|ST|DC)|EX[0-9]+BT|PC[0-9]+BT)',
    'dragon_ball_fusion_world': r'(?:FB|FS|SB|ST)[0-9]{2}',
    'digimon': r'(?:BT|EX|ST|RB|LM|AD|TS)[0-9]{1,3}',
}


def norm(value):
    return unicodedata.normalize('NFKC', str(value or '')).strip().upper()


def printed_number(value, game):
    number = norm(value)
    if game == 'union_arena':
        number = re.sub(r'^((?:UA[0-9]+(?:BT|ST|DC)|EX[0-9]+BT|PC[0-9]+BT))-', r'\1/', number)
    return number


def code_key(value, game=None):
    code = re.sub(r'[^A-Z0-9]', '', norm(value))
    if game == 'digimon':
        match = re.fullmatch(r'([A-Z]+)0*([0-9]+)', code)
        if match:
            code = match[1] + str(int(match[2]))
    return code


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n').encode()


def key_for(*parts):
    return hashlib.sha256(encoded(parts)).hexdigest()[:16]


def official_url(value, game):
    parsed = urlparse(str(value or ''))
    return parsed.scheme == 'https' and parsed.hostname in HOSTS[game] and not parsed.username and not parsed.password


def load_sources(root):
    sources = {}
    for game in HOSTS:
        path = root / 'data/official-card-contents' / (game + '.json')
        if not path.exists():
            path = path.with_suffix('.json.gz')
            if not path.exists():
                continue
        data = json.loads(gzip.decompress(path.read_bytes()) if path.suffix == '.gz' else path.read_bytes())
        if data.get('game') != game or not official_url(data.get('sourceUrl'), game) or not data.get('fetchedAt'):
            raise ValueError('Invalid official source identity: ' + game)
        products = data.get('products')
        if not isinstance(products, list):
            raise ValueError('Missing official product inventory: ' + game)
        seen = set()
        for product in products:
            pid = str(product.get('id') or '')
            if not pid or pid in seen or not official_url(product.get('url'), game):
                raise ValueError('Invalid/duplicate official product: ' + game + '/' + pid)
            seen.add(pid)
            cards = product.get('cards')
            if not isinstance(cards, list) or not isinstance(product.get('complete'), bool):
                raise ValueError('Invalid official membership coverage: ' + pid)
            if not product['complete']:
                continue
            expected = product.get('expectedCardCount', product.get('cardCount', len(cards)))
            if not cards or expected != len(cards) or product.get('problems'):
                raise ValueError('Official product count/integrity failure: ' + pid)
            identities = set()
            for card in cards:
                identity = str(card.get('id') or '')
                if not identity or identity in identities or not card.get('name') or not official_url(card.get('url'), game):
                    raise ValueError('Invalid official printing identity: ' + pid + '/' + identity)
                # Printed codes may be explicitly unavailable; do not invent them.
                if card.get('image') and not official_url(card['image'], game):
                    raise ValueError('Nonmanufacturer card image: ' + pid)
                identities.add(identity)
        if data.get('complete') and data.get('expectedProducts', len(products)) != len(products):
            raise ValueError('Incomplete official product inventory: ' + game)
        sources[game] = data
    return sources


def market_bindings(rows, official_rows):
    """Only bind unique exact number/rarity/variant candidates in this product.

    A normal printing is distinguishable from a parallel. Numbered parallel
    ranks are not guessed from marketplace stars; ambiguous artwork stays open.
    """
    market, native = defaultdict(list), defaultdict(list)
    for row in rows:
        number, rarity = printed_number(row.get('fullCardNumber'), row['game']), norm(row.get('rarity'))
        marker = str(row.get('name') or '').split('[', 1)[0]
        parallel = bool(re.search(r'[★☆*]|\b(?:SP-|parallel|alternate|manga)\b', marker, re.I) or row.get('variant'))
        if row['game'] == 'yugioh':
            parallel = False  # Official rarity labels are not artwork ranks.
        core = re.sub(r'[★☆*]', '', rarity)
        if number and core:
            market[(number, core, parallel)].append(row)
    for row in official_rows:
        number, rarity = printed_number(row.get('fullCardNumber'), row['game']), norm(row.get('rarity'))
        if number and rarity:
            parallel = row['game'] != 'yugioh' and row.get('variant') not in ('', 'base', None)
            native[(number, rarity, parallel)].append(row)
    bound = set()
    for signature, cards in native.items():
        candidates = market.get(signature, [])
        if len(cards) != 1 or len(candidates) != 1:
            continue
        row, source = cards[0], candidates[0]
        if source['id'] in bound:
            continue
        row['snkrdunkId'] = str(source['id'])
        row['snkrProduct'] = source['snkrProduct']
        row['marketBinding'] = {
            'verified': True, 'method': 'exact-product-number-rarity-unique-variant',
            'game': row['game'], 'fullCardNumber': row['fullCardNumber'],
            'officialProductId': row['officialProductId'], 'officialCardId': row['officialCardId'],
            'snkrdunkId': str(source['id']),
        }
        bound.add(source['id'])
    return bound


def validate_official_card(card, entry):
    if (card.get('catalogSource') != 'OFFICIAL' or card.get('language') != 'ja'
            or card.get('officialProductId') != entry.get('officialProductId')
            or not card.get('officialCardId') or not str(card.get('id')).startswith('official:' + card['game'] + ':')
            or not official_url(card.get('sourceUrl'), card['game'])):
        raise ValueError('Official printing identity mismatch')
    product = card.get('snkrProduct')
    if product is None:
        if card.get('snkrdunkId') or card.get('marketBinding'):
            raise ValueError('Official price binding without market product')
        return
    receipt = card.get('marketBinding') or {}
    if (receipt.get('verified') is not True or receipt.get('method') != 'exact-product-number-rarity-unique-variant'
            or receipt.get('game') != card['game'] or receipt.get('officialProductId') != card['officialProductId']
            or receipt.get('officialCardId') != card['officialCardId']
            or receipt.get('fullCardNumber') != card.get('fullCardNumber')
            or str(receipt.get('snkrdunkId')) != str(card.get('snkrdunkId'))
            or str(product.get('id')) != str(card.get('snkrdunkId'))
            or printed_number(product.get('fullCardNumber'), card['game']) != printed_number(card.get('fullCardNumber'), card['game'])
            or product.get('brand') != card['game']):
        raise ValueError('Official market binding identity mismatch')


def augment(root, manifest, outputs):
    sources = load_sources(root)  # Validate every input before publication.
    if not sources:
        return
    payloads = {payload['set']['id']: [] for _, payload in outputs}
    for _, payload in outputs:
        payloads[payload['set']['id']].extend(payload['cards'])
    source_stats = {}
    for game in manifest['games']:
        view = game['id']
        source_games = ('weiss_schwarz', 'union_arena') if view == 'nikke' else (view,)
        entries = {entry['id']: entry for entry in game['sets']}
        for source_game in source_games:
            data = sources.get(source_game)
            if not data:
                continue
            products = {str(p['id']): p for p in data['products']}
            by_code = defaultdict(list)
            for product in products.values():
                code = code_key(product.get('code'), source_game)
                if not product.get('isAggregate') and re.fullmatch(CODE_PATTERNS.get(source_game, r'(?!)'), code):
                    by_code[code].append(product)
            matched = defaultdict(list)
            legacy_ids = {box['id']: list(box['setIds']) for box in game['boxes']}
            box_entries, box_numbers, box_codes, box_bound = defaultdict(list), defaultdict(set), defaultdict(set), defaultdict(set)
            for box in game['boxes']:
                if box['sourceGame'] != source_game:
                    continue
                # Explicit links are reviewed against manufacturer product identity.
                exact = [p for p in products.values() if box['id'] in p.get('marketBoxIds', [])]
                candidates = exact or by_code.get(code_key(box.get('code'), source_game), [])
                if not candidates or (not exact and len(candidates) != 1):
                    if data.get('complete') and str(box.get('releasedAt') or '')[:10] > manifest['generatedAt'][:10]:
                        box['coverage'] = 'release-pending'
                    continue
                product = candidates[0]
                box['officialSourceUrl'] = product['url']
                box['officialProductId'] = str(product['id'])
                box['officialExpectedPackTypes'] = product.get('expectedPackTypes', {}).get('total')
                box['officialMembershipComplete'] = False
                if any(not p['complete'] or p.get('isAggregate') for p in candidates):
                    box['coverage'] = 'official-list-unavailable'
                    continue
                for product in candidates:
                    matched[str(product['id'])].append(box)
            for pid, boxes in matched.items():
                product = products[pid]
                if view == 'nikke' and not any(re.search(r'(?:^|[/_-])NIK(?:[/_-]|$)', str(c.get('number') or ''), re.I) for c in product['cards']):
                    continue
                rows = []
                for native in product['cards']:
                    row = {'id': 'official:' + source_game + ':' + key_for(pid, str(native['id'])),
                           'catalogSource': 'OFFICIAL', 'officialProductId': pid, 'officialCardId': str(native['id']),
                           'name': native['name'], 'fullCardNumber': native.get('number') or '',
                           'rarity': native.get('rarity') or '', 'rarityLabel': native.get('rarityLabel') or '',
                           'variant': native.get('variant') or '', 'fullId': str(native['id']),
                           'game': source_game, 'language': 'ja', 'image': native.get('image') or '',
                           'sourceUrl': native['url'], 'sourcePackTitle': product['name'],
                           'setCode': product.get('code') or '', 'releasedAt': product.get('releasedAt')}
                    rows.append(row)
                legacy = {row['id']: row for box in boxes for sid in legacy_ids[box['id']] for row in payloads[sid]}
                bound = market_bindings(list(legacy.values()), rows)
                key = key_for('official', view, source_game, pid)
                entry = {'id': key, 'name': product['name'], 'code': product.get('code') or '',
                         'sourceGame': source_game, 'sourcePackTitle': product['name'], 'language': 'ja',
                         'packageKind': product.get('kind') or 'unspecified', 'officialProductId': pid,
                         'officialSourceUrl': product['url'], 'sourceAsOf': data['fetchedAt'],
                         'coverage': 'official-product-list', 'officialComplete': True, 'cardCount': len(rows),
                         'file': '/data/tcg-card-info/' + view + '/' + key + '.json',
                         'image': boxes[0].get('image') or '', 'coverType': 'box',
                         'releasedAt': product.get('releasedAt')}
                base = {'schemaVersion': 1, 'game': view, 'sourceGame': source_game, 'set': entry,
                        'generatedAt': manifest['generatedAt'], 'source': data['source'], 'officialComplete': True}
                chunks, chunk, size = [], [], len(encoded(base)) + 4096
                for row in rows:
                    cost = len(encoded(row)) + 1
                    if chunk and size + cost > 3_700_000:
                        chunks.append(chunk)
                        chunk, size = [], len(encoded(base)) + 4096
                    if size + cost > 3_700_000:
                        raise ValueError('Official printing exceeds asset budget')
                    chunk.append(row)
                    size += cost
                chunks.append(chunk)
                parts = [entry['file'].replace('.json', '-part' + str(i).zfill(2) + '.json') for i in range(2, len(chunks) + 1)]
                for index, chunk in enumerate(chunks):
                    path = entry['file'] if index == 0 else parts[index - 1]
                    outputs.append((root / path.lstrip('/'), {**base, 'cards': chunk, **({'shards': parts} if index == 0 and parts else {})}))
                game['sets'].append(entry)
                official_numbers = {printed_number(row['fullCardNumber'], source_game) for row in rows if row['fullCardNumber']}
                for box in boxes:
                    box_entries[box['id']].append(entry)
                    box_numbers[box['id']].update(official_numbers)
                    box_bound[box['id']].update(bound)
                    if source_game == 'yugioh' and (product.get('codeVerified') or product.get('codeSource') in (
                            'official per-card printing number', 'official manufacturer product page identifier')) and product.get('code'):
                        box_codes[box['id']].add(norm(product['code']))
            for box in game['boxes']:
                selected = box_entries.get(box['id'])
                if not selected:
                    continue
                old_ids, bid = legacy_ids[box['id']], box['id']
                extras = sorted({row['id'] for sid in old_ids for row in payloads[sid]
                                 if row['id'] not in box_bound[bid]
                                 and (printed_number(row['fullCardNumber'], source_game) in box_numbers[bid]
                                      or any(norm(row['fullCardNumber']).startswith(code + '-JP') for code in box_codes[bid]))})
                total = sum(s['cardCount'] for s in selected)
                box.update({'setIds': [s['id'] for s in selected], 'marketSetIds': old_ids if extras else [], 'marketCardIds': extras,
                            'officialProductIds': [s['officialProductId'] for s in selected],
                            'officialCardCount': total, 'marketSupplementCount': len(extras),
                            'cardCount': total + len(extras), 'officialMembershipComplete': True,
                            'officialComplete': not extras, 'coverage': 'official-product-list'})
            if view != 'nikke':
                source_stats[source_game] = {'sourceUrl': data['sourceUrl'], 'fetchedAt': data['fetchedAt'],
                                            'inventoryComplete': data.get('complete', False),
                                            'productsCollected': len(products),
                                            'productsWithVerifiedMembership': sum(bool(p['complete']) for p in products.values()),
                                            'boxesMatched': len(box_entries),
                                            'unknownPrintedNumberRows': sum(not c.get('number') for p in products.values() if p['complete'] for c in p['cards']),
                                            'unknownRarityRows': sum(not c.get('rarity') for p in products.values() if p['complete'] for c in p['cards']),
                                            'officialCardRows': sum(len(p['cards']) for p in products.values() if p['complete'])}
        game['setCount'] = len(game['sets'])
        game['cardCount'] = sum(s['cardCount'] for s in game['sets'])
    manifest['source'] = 'Official manufacturer product lists + SNKRDUNK catalog'
    manifest['officialSources'] = source_stats
    manifest['semantics'] = 'Official product membership where verified; retained marketplace printings are labelled separately. Unavailable sources remain partial.'
