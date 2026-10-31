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
from collections import Counter, defaultdict
from urllib.parse import urlparse

HOSTS = {
    'weiss_schwarz': {'ws-tcg.com', 'www.ws-tcg.com'},
    'union_arena': {'www.unionarena-tcg.com', 'unionarena-tcg.com'},
    'dragon_ball_fusion_world': {'www.dbs-cardgame.com', 'dbs-cardgame.com'},
    'digimon': {'digimoncard.com', 'www.digimoncard.com'},
    'yugioh': {'www.db.yugioh-card.com', 'www.yugioh-card.com'},
}
PREVIEW_HOSTS = {game: hosts | ({'yu-gi-oh.jp'} if game == 'yugioh' else set())
                 for game, hosts in HOSTS.items()}
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


def metadata_state(card, field):
    status = str(card.get(field + 'Status') or '').replace('-', '_')
    if field == 'number' and status == 'not_listed_by_manufacturer':
        status = 'unprinted'
    allowed = {'verified', 'unavailable', 'unprinted' if field == 'number' else 'not_applicable'}
    if status and status not in allowed:
        raise ValueError('Unknown official metadata status: ' + status)
    value = card.get(field)
    status = status or ('verified' if value else 'unavailable')
    if (status == 'verified' and not value) or (status in ('unprinted', 'not_applicable') and value):
        raise ValueError('Official metadata value/status mismatch')
    return status


def published_previews(future, game):
    """Publisher assets are evidence of previews, not a fabricated card roster."""
    previews = future.get('previews', {})
    def safe(value):
        parsed = urlparse(str(value or ''))
        return (parsed.scheme == 'https' and parsed.hostname in PREVIEW_HOSTS[game]
                and not parsed.username and not parsed.password)
    images, names = [], []
    seen = set()
    for item in previews.get('images', []):
        if item.get('containsUnselectedCells') or item.get('notAnIndividualCard'):
            continue
        if not safe(item.get('image')) or not safe(item.get('url')):
            raise ValueError('Invalid manufacturer preview image')
        if item['image'] in seen:
            raise ValueError('Duplicate manufacturer preview image')
        seen.add(item['image'])
        images.append({k: item[k] for k in ('image', 'url', 'alt', 'group', 'assetRole') if k in item})
    for item in previews.get('cardNames', []):
        if not item.get('name') or not safe(item.get('sourceUrl')):
            raise ValueError('Invalid manufacturer preview name')
        names.append({k: item[k] for k in ('name', 'sourceUrl', 'theme') if k in item})
    if previews.get('publishedNameCount', len(names)) != len(names):
        raise ValueError('Published name count includes image-only or unrevealed cards')
    return {'images': images, 'cardNames': names,
            **{k: previews[k] for k in ('announcedBasePreviewCount', 'declaredBaseCount', 'unpublishedBaseCount') if k in previews}}


def reviewed_editions(data, game):
    """An edition is the exact native inventory minus documented exclusions."""
    native = {str(p['id']): p for p in data['products']}
    editions = []
    for product in data.get('derivedProducts', []):
        if not product.get('marketBoxIds'):
            continue
        if product.get('membershipMethod') == 'official-explicit-number-roster-with-unchanged-printings':
            validate_reprint_roster(product, native, game)
            editions.append(product)
            continue
        if product.get('membershipMethod') in (
                'manufacturer-native-inventory-minus-explicit-retailer-reprint-AGR-exclusion',
                'manufacturer-native-core-inventory-minus-explicit-reprint-box-bonus-exclusion'):
            validate_documented_reprint(product, native, game)
            editions.append(product)
            continue
        base = native.get(str(product.get('sourceNativeProductId')))
        ws_rule = game == 'weiss_schwarz' and product.get('membershipMethod') == 'official-native-inventory-minus-explicit-first-print-only-AGR'
        notice_valid = (official_url(product.get('officialNoticeUrl'), game)
                        and re.fullmatch(r'[0-9a-f]{64}', product.get('officialNoticeSha256') or '')) if ws_rule else (
                        official_url(product.get('officialNoticeImageUrl'), game)
                        and re.fullmatch(r'[0-9a-f]{64}', product.get('officialNoticeImageSha256') or ''))
        if (not base or product.get('isDerivedProduct') is not True or product.get('edition') != 'second'
                or (not ws_rule and product.get('membershipMethod') != 'official-native-inventory-minus-explicit-second-edition-serial-AP-exclusions')
                or set(product.get('marketBoxIds', [])) != set(product.get('reviewedBoxIds', []))
                or not notice_valid):
            raise ValueError('Unverified derived edition: ' + str(product.get('id')))
        excluded = set(product.get('excludedCardIds', []))
        originals = {str(c['id']): c for c in base['cards']}
        members = {str(c['id']): c for c in product['cards']}
        if not excluded or not excluded <= originals.keys() or members.keys() != originals.keys() - excluded:
            raise ValueError('Edition does not match the explicit exclusions')
        identity = ('id', 'number', 'name', 'rarity', 'image', 'url', 'variant', 'numberStatus', 'rarityStatus')
        if any(any(c.get(k) != originals[cid].get(k) for k in identity) for cid, c in members.items()):
            raise ValueError('Edition alters a retained native printing')
        if ws_rule:
            proof = product.get('editionEvidence', {})
            if (set(map(str, proof.get('excludedNativeCardIds', []))) != excluded
                    or set(proof.get('excludedLiteralNumbers', [])) != {originals[cid]['number'] for cid in excluded}
                    or any(norm(originals[cid].get('rarity')) != 'AGR' for cid in excluded)
                    or product.get('packSpecificationMatch', {}).get('total') != len(members)
                    or proof.get('sourceUrl') != product['officialNoticeUrl']
                    or proof.get('provenance', {}).get('extractedTextSha256') != product['officialNoticeSha256']):
                raise ValueError('Edition exclusion has no explicit first-print rarity proof')
        else:
            proofs = {str(p['id']): p for p in product.get('exclusions', [])}
            if set(proofs) != excluded or any(p.get('visualMatchVerified') is not True for p in proofs.values()):
                raise ValueError('Edition exclusion has no exact artwork proof')
        editions.append(product)
    return editions


def public_proof(proof, host, path_pattern):
    parsed = urlparse(str(proof.get('url') or ''))
    return (parsed.scheme == 'https' and parsed.hostname == host
            and not parsed.username and not parsed.password
            and re.fullmatch(path_pattern, parsed.path)
            and re.fullmatch(r'[0-9a-f]{64}', proof.get('sha256') or ''))


def validate_documented_reprint(product, native, game):
    """Confirm the roster separately from an unproved finish/price equivalence."""
    base = native.get(str(product.get('sourceNativeProductId')))
    if (game != 'weiss_schwarz' or not base or product.get('isDerivedProduct') is not True
            or product.get('edition') != 'reprint' or not product.get('marketBoxIds')
            or set(product['marketBoxIds']) != set(product.get('reviewedBoxIds', []))
            or not official_url(product.get('url'), game)
            or product.get('allowInheritedMarketBindings') is not False):
        raise ValueError('Invalid documented reprint identity')
    originals = {str(c['id']): c for c in base['cards']}
    members = {str(c['id']): c for c in product['cards']}
    excluded = set(map(str, product.get('excludedCardIds', [])))
    identity = ('id', 'number', 'name', 'rarity', 'image', 'url', 'variation', 'parallelParam', 'isParallel')
    if (not excluded or not excluded <= originals.keys()
            or members.keys() != originals.keys() - excluded
            or len(members) != len(product['cards'])
            or any(any(c.get(k) != originals[cid].get(k) for k in identity) for cid, c in members.items())
            or Counter(c['rarity'] for c in members.values()) != product.get('advertisedRarityCounts')
            or product.get('expectedPackTypes') != {
                'normal': sum(c.get('isParallel') is False for c in members.values()),
                'parallel': sum(c.get('isParallel') is True for c in members.values()), 'total': len(members)}):
        raise ValueError('Documented reprint changes native roster facts')
    evidence = product.get('editionEvidence', {})
    if product['membershipMethod'].endswith('AGR-exclusion'):
        retailer = evidence.get('retailerProduct', {})
        policy = evidence.get('publisherAGRPolicy', {})
        if (any(originals[cid]['rarity'] != 'AGR' for cid in excluded)
                or retailer.get('explicitExcludedRarities') != ['AGR']
                or retailer.get('rarityCounts') != product['advertisedRarityCounts']
                or not re.fullmatch(r'[0-9]{13}', retailer.get('jan') or '')
                or not public_proof(retailer.get('provenance', {}), 'item.rakuten.co.jp', r'/amiami/card-[0-9]+/')
                or not public_proof(policy.get('provenance', {}), 'prtimes.jp', r'/main/html/rd/p/[0-9]+\.000014827\.html')):
            raise ValueError('Missing explicit reprint AGR exclusion proof')
    else:
        exclusion = evidence.get('confirmedManufacturerReprintExclusion', {})
        shipment = evidence.get('publisherReprintAnnouncement', {})
        if (set(map(str, exclusion.get('excludedCardIds', []))) != excluded
                or any(originals[cid]['rarity'] != 'PR' for cid in excluded)
                or not public_proof(exclusion.get('provenance', {}), 'ws-tcg.com', r'/products/bp_sby/')
                or not public_proof(shipment.get('provenance', {}), 'x.com', r'/wstcg/status/[0-9]+')):
            raise ValueError('Missing manufacturer reprint bonus exclusion proof')


def validate_reprint_roster(product, native, game):
    """Project an explicit publisher roster; never select rows to fit a count."""
    parents = product.get('sourceNativeProductIds', [])
    proof = product.get('rosterProvenance', {})
    notice = product.get('unchangedPrintingsNotice', {})
    if (game != 'weiss_schwarz' or product.get('isDerivedProduct') is not True
            or product.get('edition') != 'reprint' or not parents or len(set(parents)) != len(parents)
            or any(pid not in native for pid in parents)
            or set(product.get('marketBoxIds', [])) != set(product.get('reviewedBoxIds', []))
            or not official_url(product.get('officialNoticeUrl'), game)
            or not official_url(product.get('officialNoticeImageUrl'), game)
            or proof.get('sourceUrl') != product['officialNoticeImageUrl']
            or not re.fullmatch(r'[0-9a-f]{64}', proof.get('sha256') or '')
            or proof.get('sha256') != product.get('officialNoticeImageSha256')
            or set(notice.get('fieldsExplicitlyCovered', [])) != {'card number', 'card text', 'card illustration', 'card finish'}):
        raise ValueError('Unverified publisher reprint roster')
    numbers = product.get('rosterBaseNumbers', [])
    if not numbers or len(numbers) != len(set(numbers)):
        raise ValueError('Invalid publisher roster numbers')
    originals, origins = {}, {}
    for pid in parents:
        for card in native[pid]['cards']:
            match = re.fullmatch(r'([A-Za-z0-9]+/[A-Za-z0-9]+-[0-9]{3})(?:[A-Z]+)?', card['number'])
            if match and match[1] in numbers and norm(card.get('rarity')) not in ('PR', 'PR+'):
                cid = str(card['id'])
                if cid in originals:
                    raise ValueError('Ambiguous native parent printing')
                originals[cid], origins[cid] = card, pid
    members = {str(c['id']): c for c in product['cards']}
    identity = ('id', 'number', 'name', 'rarity', 'image', 'url', 'variation', 'parallelParam', 'isParallel')
    if (members.keys() != originals.keys() or len(members) != len(product['cards'])
            or any(any(c.get(k) != originals[cid].get(k) for k in identity)
                   or c.get('sourceNativeProductId') != origins[cid] for cid, c in members.items())
            or set(numbers) != {c['number'] for c in members.values() if not c.get('isParallel')}
            or Counter(c['rarity'] for c in members.values()) != product.get('advertisedRarityCounts')
            or product.get('expectedPackTypes') != {'normal': len(numbers),
                'parallel': sum(c.get('isParallel') is True for c in members.values()), 'total': len(members)}):
        raise ValueError('Reprint differs from the explicit publisher roster')


def supplement_matches(number, official_numbers, game):
    number = printed_number(number, game)
    if number in official_numbers:
        return True
    # Keep explicitly labelled marketplace artwork qualifiers as pending
    # printings; never bind them to the unqualified official printing.
    qualifier = re.fullmatch(r'(.+)\s+E[0-9]+', number) if game == 'weiss_schwarz' else None
    return bool(qualifier and qualifier[1] in official_numbers)


def rarity_key(value, game):
    value = norm(value)
    return value.replace('*', '★') if game == 'union_arena' else re.sub(r'[★☆*]', '', value)


def inclusion_groups(product):
    """Keep manufacturer-associated promos, without claiming pack inclusion."""
    if 'coreCardIds' not in product:
        return [(False, product['cards'])]
    core = set(map(str, product['coreCardIds']))
    related = set(map(str, product.get('relatedCardIds', [])))
    bonus = set(map(str, product.get('includedBonusIds', [])))
    ids = {str(c['id']) for c in product['cards']}
    if core & related or not bonus <= related or core | related != ids:
        raise ValueError('Invalid official inclusion partition: ' + str(product['id']))
    # A documented included bonus belongs in the product; other associated
    # promos remain available in a separate catalogue section.
    main = core | bonus
    return [(False, [c for c in product['cards'] if str(c['id']) in main]),
            (True, [c for c in product['cards'] if str(c['id']) in related - bonus])]


def emit_official_set(root, outputs, manifest, view, source_game, pid, product, data, boxes, rows, related=False):
    key = key_for('official-related' if related else 'official', view, source_game, pid)
    overseas = related and any(r.get('distributionEdition') == 'overseas' for r in rows)
    related_label = '프로모·해외 유통판' if overseas else '관련 프로모'
    entry = {'id': key, 'name': product['name'] + (' · ' + related_label if related else ''),
             'code': product.get('code') or '', 'sourceGame': source_game,
             'sourcePackTitle': product['name'], 'language': 'ja',
             'packageKind': product.get('kind') or 'unspecified', 'officialProductId': pid,
             'officialSourceUrl': product['url'], 'sourceAsOf': data['fetchedAt'],
             'coverage': 'official-product-list', 'officialComplete': True, 'cardCount': len(rows),
             'file': '/data/tcg-card-info/' + view + '/' + key + '.json',
             'image': boxes[0].get('image') or '', 'coverType': 'box',
             'releasedAt': product.get('releasedAt'),
             'inclusionScope': ('related-edition' if overseas else 'related-promo') if related else 'product',
             'relatedLabel': related_label if related else '',
             'packMembershipComplete': product.get('packMembershipComplete', True)}
    entry['metadataCoverage'] = {'unknownNumbers': sum(r['numberStatus'] == 'unavailable' for r in rows),
                                 'unprintedNumbers': sum(r['numberStatus'] == 'unprinted' for r in rows),
                                 'unknownRarities': sum(r['rarityStatus'] == 'unavailable' for r in rows),
                                 'rarityNotApplicable': sum(r['rarityStatus'] == 'not_applicable' for r in rows)}
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
    return entry


def load_sources(root):
    try:
        from catalogue_resolutions import apply_resolutions
    except ModuleNotFoundError:
        from scripts.catalogue_resolutions import apply_resolutions
    sources = {}
    for game in HOSTS:
        path = root / 'data/official-card-contents' / (game + '.json')
        if not path.exists():
            path = path.with_suffix('.json.gz')
            if not path.exists():
                continue
        data = json.loads(gzip.decompress(path.read_bytes()) if path.suffix == '.gz' else path.read_bytes())
        data = apply_resolutions(root, data)
        if data.get('game') != game or not official_url(data.get('sourceUrl'), game) or not data.get('fetchedAt'):
            raise ValueError('Invalid official source identity: ' + game)
        products = data.get('products')
        if not isinstance(products, list):
            raise ValueError('Missing official product inventory: ' + game)
        seen = set()
        for product in products + reviewed_editions(data, game):
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
            native_ids = {str(c.get('id')) for c in cards}
            for card in cards:
                identity = str(card.get('id') or '')
                if not identity or identity in identities or not card.get('name') or not official_url(card.get('url'), game):
                    raise ValueError('Invalid official printing identity: ' + pid + '/' + identity)
                # Printed codes may be explicitly unavailable; do not invent them.
                if card.get('image') and not official_url(card['image'], game):
                    raise ValueError('Nonmanufacturer card image: ' + pid)
                metadata_state(card, 'number')
                metadata_state(card, 'rarity')
                if (card.get('foilNativeCardIds') and (len(card['foilNativeCardIds']) != len(set(card['foilNativeCardIds']))
                        or not set(map(str, card['foilNativeCardIds'])) <= native_ids)):
                    raise ValueError('Invalid existing native foil references')
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
    market, native, market_core, native_core = (defaultdict(list) for _ in range(4))
    for row in rows:
        number, rarity = printed_number(row.get('fullCardNumber'), row['game']), norm(row.get('rarity'))
        marker = str(row.get('name') or '').split('[', 1)[0]
        parallel = bool(re.search(r'[★☆*]|\b(?:SP-|parallel|alternate|manga)\b', marker, re.I) or row.get('variant'))
        if row['game'] in ('yugioh', 'weiss_schwarz'):
            parallel = False  # Official rarity labels are not artwork ranks.
        core = rarity_key(rarity, row['game'])
        if number and core:
            market[(number, core, parallel)].append(row)
            market_core[(number, re.sub(r'[★☆*]', '', core), parallel)].append(row)
    for row in official_rows:
        if row.get('distributionEdition') == 'overseas':
            continue
        number, rarity = printed_number(row.get('fullCardNumber'), row['game']), norm(row.get('rarity'))
        if number and rarity:
            parallel = row['game'] not in ('yugioh', 'weiss_schwarz') and row.get('variant') not in ('', 'base', None)
            native[(number, rarity_key(rarity, row['game']), parallel)].append(row)
            native_core[(number, re.sub(r'[★☆*]', '', rarity), parallel)].append(row)
    bound = set()
    for signature, cards in native.items():
        candidates = market.get(signature, [])
        if len(cards) == 1 and not candidates and cards[0]['game'] == 'union_arena' and cards[0].get('rarityOrigin') != 'official-detail':
            core = (signature[0], re.sub(r'[★☆*]', '', signature[1]), signature[2])
            if len(native_core[core]) == 1:
                candidates = market_core.get(core, [])
        if len(cards) != 1 or len(candidates) != 1:
            continue
        row, source = cards[0], candidates[0]
        if source['id'] in bound:
            continue
        row['snkrdunkId'] = str(source['id'])
        row['snkrProduct'] = source['snkrProduct']
        if source.get('image'):
            row['fallbackImage'] = source['image']
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
    metadata_state({'number': card['fullCardNumber'], 'numberStatus': card.get('numberStatus')}, 'number')
    metadata_state({'rarity': card.get('rarity'), 'rarityStatus': card.get('rarityStatus')}, 'rarity')
    aliases = card.get('aliases', [])
    if not isinstance(aliases, list) or len(set(aliases)) != len(aliases) or any(not isinstance(a, str) or not a.startswith('official:' + card['game'] + ':') for a in aliases):
        raise ValueError('Invalid official printing aliases')
    product = card.get('snkrProduct')
    if product is None:
        if card.get('snkrdunkId') or card.get('marketBinding'):
            raise ValueError('Official price binding without market product')
        return
    receipt = card.get('marketBinding') or {}
    method = receipt.get('method')
    inherited = receipt.get('derivationMethod') == 'verified-unchanged-native-reprint'
    if (receipt.get('verified') is not True or method != 'exact-product-number-rarity-unique-variant'
            or receipt.get('derivationMethod') not in (None, 'verified-unchanged-native-reprint')
            or (inherited and (receipt.get('sourceNativeProductId') != card.get('printingFamilyId')
                               or receipt.get('sourceNativeProductId') == card['officialProductId']
                               or receipt.get('sourceOfficialCardId') != card['officialCardId']))
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
            products = {str(p['id']): p for p in data['products'] + reviewed_editions(data, source_game)}
            by_code = defaultdict(list)
            for product in products.values():
                code = code_key(product.get('code'), source_game)
                if not product.get('isAggregate') and not product.get('isDerivedProduct') and re.fullmatch(CODE_PATTERNS.get(source_game, r'(?!)'), code):
                    by_code[code].append(product)
            matched = defaultdict(list)
            official_rows = []
            legacy_ids = {box['id']: list(box['setIds']) for box in game['boxes']}
            box_entries, box_related, box_numbers, box_codes, box_bound = defaultdict(list), defaultdict(list), defaultdict(set), defaultdict(set), defaultdict(set)
            for box in game['boxes']:
                if box['sourceGame'] != source_game:
                    continue
                pending = next((p for p in data.get('futureProducts', []) if p.get('marketBoxId') == box['id']), None)
                if pending and pending.get('cardInventoryPublished') is False and pending.get('fetchFailed') is False:
                    box['coverage'] = 'official-not-published'
                    box['officialSourceUrl'] = pending.get('announcementProvenance', {}).get('url')
                    box['officialMembershipComplete'] = False
                    box['officialReleaseDate'] = pending.get('releaseDate')
                    box['publicationCheckedAt'] = pending.get('checkedAt')
                    box['previews'] = published_previews(pending, source_game)
                    continue
                # Explicit links are reviewed against manufacturer product identity.
                exact = [p for p in products.values() if box['id'] in p.get('marketBoxIds', [])]
                related_editions = [p for p in products.values() if box['id'] in p.get('relatedMarketBoxIds', [])]
                if related_editions and not exact:
                    box.update(coverage='official-edition-unverified', officialMembershipComplete=False,
                               officialSourceUrl=related_editions[0].get('productPageUrl') or related_editions[0]['url'])
                    continue
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
                           'numberStatus': metadata_state(native, 'number'), 'rarityStatus': metadata_state(native, 'rarity'),
                           'rarityOrigin': native.get('rarityOrigin') or '',
                           'inclusionRole': native.get('inclusionRole') or 'product',
                           'variant': native.get('variant') or '', 'fullId': str(native['id']),
                           'printingFamilyId': str(native.get('sourceNativeProductId') or product.get('sourceNativeProductId') or pid),
                           'game': source_game, 'language': 'ja', 'image': native.get('image') or '',
                           'sourceUrl': native['url'], 'sourcePackTitle': product['name'],
                           'setCode': product.get('code') or '', 'releasedAt': product.get('releasedAt')}
                    if native.get('distributionEdition'):
                        row['distributionEdition'] = native['distributionEdition']
                        if native['distributionEdition'] == 'overseas':
                            row['priceLookupPolicy'] = 'exact-region-required'
                    if native.get('availableFinishes'):
                        row['availableFinishes'] = native['availableFinishes']
                    if native.get('foilNativeCardIds'):
                        targets = {str(c['id']): c for c in product['cards']}
                        row['finishVariants'] = [{'id': 'official:' + source_game + ':' + key_for(pid, str(cid)),
                                                   'number': targets[str(cid)]['number'], 'rarity': targets[str(cid)]['rarity']}
                                                  for cid in native['foilNativeCardIds']]
                    aliases = ['official:' + source_game + ':' + key_for(pid, str(old)) for old in native.get('legacyIds', [])]
                    if aliases:
                        row['aliases'] = sorted(set(aliases) - {row['id']})
                    rows.append(row)
                legacy = {row['id']: row for box in boxes for sid in legacy_ids[box['id']] for row in payloads[sid]}
                bound = market_bindings(list(legacy.values()), rows)
                official_rows.extend(rows)
                grouped = inclusion_groups(product)
                core_ids = {str(c['id']) for c in grouped[0][1]}
                core_rows = [r for r in rows if r['officialCardId'] in core_ids]
                entry = emit_official_set(root, outputs, manifest, view, source_game, pid, product, data, boxes, core_rows)
                game['sets'].append(entry)
                if len(grouped) > 1 and grouped[1][1]:
                    related_rows = [r for r in rows if r['officialCardId'] not in core_ids]
                    related_entry = emit_official_set(root, outputs, manifest, view, source_game, pid, product, data, boxes, related_rows, related=True)
                    game['sets'].append(related_entry)
                    for box in boxes:
                        box_related[box['id']].append(related_entry)
                official_numbers = {printed_number(row['fullCardNumber'], source_game) for row in core_rows if row['fullCardNumber']}
                for box in boxes:
                    box_entries[box['id']].append(entry)
                    box_numbers[box['id']].update(official_numbers)
                    box_bound[box['id']].update(bound)
                    if source_game == 'yugioh' and (product.get('codeVerified') or product.get('codeSource') in (
                            'official per-card printing number', 'official manufacturer product page identifier')) and product.get('code'):
                        box_codes[box['id']].add(norm(product['code']))
            # A base pack and its bonus component can share a printed code and
            # rarity. One marketplace SKU cannot prove both physical printings.
            owners = defaultdict(list)
            for row in official_rows:
                if row.get('snkrdunkId'):
                    owners[row['snkrdunkId']].append(row)
            same_print = lambda row: (row['printingFamilyId'], row['officialCardId'], row['fullCardNumber'], row['rarity'], row['variant'], row['image'])
            ambiguous = {identity for identity, rows in owners.items() if len({same_print(r) for r in rows}) > 1}
            for identity in ambiguous:
                for row in owners[identity]:
                    for field in ('snkrdunkId', 'snkrProduct', 'marketBinding', 'fallbackImage'):
                        row.pop(field, None)
            for bound in box_bound.values():
                bound.difference_update(ambiguous)
            # The publisher has explicitly verified these reprints retain the
            # identical native artwork/finish. Reuse only an unambiguous native
            # parent's existing SKU; never search another product by number.
            native_quotes = defaultdict(list)
            for row in official_rows:
                if row.get('snkrdunkId') and row['officialProductId'] == row['printingFamilyId']:
                    native_quotes[same_print(row)].append(row)
            for row in official_rows:
                if (row.get('snkrdunkId') or not products[row['officialProductId']].get('isDerivedProduct')
                        or products[row['officialProductId']].get('allowInheritedMarketBindings') is False):
                    continue
                donors = native_quotes.get(same_print(row), [])
                if len(donors) != 1:
                    continue
                donor = donors[0]
                for field in ('snkrdunkId', 'snkrProduct', 'fallbackImage'):
                    if field in donor:
                        row[field] = donor[field]
                row['marketBinding'] = {**donor['marketBinding'],
                    'derivationMethod': 'verified-unchanged-native-reprint',
                    'officialProductId': row['officialProductId'],
                    'sourceNativeProductId': donor['officialProductId'],
                    'sourceOfficialCardId': donor['officialCardId']}
                for box in matched[row['officialProductId']]:
                    box_bound[box['id']].add(row['snkrdunkId'])
            for box in game['boxes']:
                selected = box_entries.get(box['id'])
                if not selected:
                    continue
                old_ids, bid = legacy_ids[box['id']], box['id']
                selected_products = [products[s['officialProductId']] for s in selected]
                excluded_numbers = {printed_number(c['number'], source_game) for p in selected_products
                                    for c in p.get('exclusions', []) if c.get('number')}
                extras = sorted({row['id'] for sid in old_ids for row in payloads[sid]
                                 if row['id'] not in box_bound[bid]
                                 and printed_number(row['fullCardNumber'], source_game) not in excluded_numbers
                                 and (supplement_matches(row['fullCardNumber'], box_numbers[bid], source_game)
                                      or any(norm(row['fullCardNumber']).startswith(code + '-JP') for code in box_codes[bid]))})
                total = sum(s['cardCount'] for s in selected)
                box.update({'setIds': [s['id'] for s in selected], 'marketSetIds': old_ids if extras else [], 'marketCardIds': extras,
                            'officialProductIds': [s['officialProductId'] for s in selected],
                            'officialCardCount': total, 'marketSupplementCount': len(extras),
                            'cardCount': total + len(extras),
                            'relatedSetIds': [s['id'] for s in box_related[bid]],
                            'relatedCardCount': sum(s['cardCount'] for s in box_related[bid]),
                            'relatedLabel': '프로모·해외 유통판' if any(s.get('inclusionScope') == 'related-edition' for s in box_related[bid]) else '관련 프로모',
                            'officialCatalogueComplete': True,
                            'officialMembershipComplete': all(p.get('packMembershipComplete', True) for p in selected_products),
                            'officialComplete': not extras and all(p.get('packMembershipComplete', True) for p in selected_products), 'coverage': 'official-product-list'})
                box['metadataCoverage'] = {field: sum(s['metadataCoverage'][field] for s in selected)
                                           for field in ('unknownNumbers', 'unprintedNumbers', 'unknownRarities', 'rarityNotApplicable')}
                box['inventoryAuditStates'] = sorted({p.get('sourceStatusReason') for p in selected_products if p.get('sourceStatusReason')})
            if view != 'nikke':
                source_stats[source_game] = {'sourceUrl': data['sourceUrl'], 'fetchedAt': data['fetchedAt'],
                                            'inventoryComplete': data.get('complete', False),
                                            'productsCollected': len(products),
                                            'nativeProductsCollected': len(data['products']),
                                            'reviewedEditions': sum(p.get('isDerivedProduct', False) for p in products.values()),
                                            'productsWithVerifiedMembership': sum(bool(p['complete']) for p in products.values()),
                                            'boxesMatched': len(box_entries),
                                            'productsWithVerifiedPackSpecifications': sum(p.get('packMembershipComplete') is True for p in products.values()),
                                            'unknownPrintedNumberRows': sum(metadata_state(c, 'number') == 'unavailable' for p in products.values() if p['complete'] for c in p['cards']),
                                            'unknownRarityRows': sum(metadata_state(c, 'rarity') == 'unavailable' for p in products.values() if p['complete'] for c in p['cards']),
                                            'unprintedNumberRows': sum(metadata_state(c, 'number') == 'unprinted' for p in products.values() if p['complete'] for c in p['cards']),
                                            'rarityNotApplicableRows': sum(metadata_state(c, 'rarity') == 'not_applicable' for p in products.values() if p['complete'] for c in p['cards']),
                                            'officialCardRows': sum(len(p['cards']) for p in products.values() if p['complete'])}
        game['setCount'] = len(game['sets'])
        game['cardCount'] = sum(s['cardCount'] for s in game['sets'])
    manifest['source'] = 'Official manufacturer product lists + SNKRDUNK catalog'
    manifest['officialSources'] = source_stats
    manifest['semantics'] = 'Official product membership where verified; retained marketplace printings are labelled separately. Unavailable sources remain partial.'
