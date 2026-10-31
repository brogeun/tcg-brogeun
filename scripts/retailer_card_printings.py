"""Physical finish evidence from direct retailer SKUs, separate from native rows.

Retailer prices are deliberately outside this input and output schema. Matching a
printed number to a normal card does not establish the foil's market price.
"""
import gzip
import json
import re
from urllib.parse import urlparse

try:
    from official_card_contents import encoded, key_for, load_sources, norm
except ModuleNotFoundError:
    from scripts.official_card_contents import encoded, key_for, load_sources, norm


def retailer_url(value, kind):
    parsed = urlparse(str(value or ''))
    pattern = r'/product/\d+' if kind == 'product' else r'/data/c-labo/.+'
    return (parsed.scheme == 'https' and parsed.netloc == 'www.c-labo-online.jp'
            and not parsed.query and not parsed.fragment and re.fullmatch(pattern, parsed.path))


def validate_retailer_card(card, entry):
    sku = str(card.get('retailerProductId') or '')
    if (card.get('catalogSource') != 'VERIFIED_RETAILER' or card.get('game') != 'weiss_schwarz'
            or card.get('language') != 'ja' or not sku.isdigit()
            or card.get('id') != 'retailer:c-labo:' + sku
            or card.get('sourceUrl') != 'https://www.c-labo-online.jp/product/' + sku
            or not retailer_url(card.get('sourceUrl'), 'product')
            or card.get('referenceNativeProductId') != entry.get('referenceNativeProductId')
            or (card.get('nativeCounterpartVerified') is True and not card.get('referenceNativeCardId'))
            or (card.get('nativeCounterpartVerified') is False and card.get('referenceNativeCardId'))
            or not card.get('fullCardNumber')
            or card.get('finish') != 'foil' or card.get('priceLookupPolicy') != 'exact-finish-required'
            or any(k in card for k in ('snkrProduct', 'snkrdunkId', 'marketBinding', 'minPrice', 'price', 'currency'))
            or (card.get('image') and not retailer_url(card['image'], 'image'))):
        raise ValueError('Invalid retailer physical printing identity')


def augment_retailer(root, manifest, outputs):
    path = root / 'data/retailer-printings/weiss_schwarz.json.gz'
    if not path.exists():
        return
    data = json.loads(gzip.decompress(path.read_bytes()))
    if data.get('schemaVersion') != 1 or data.get('game') != 'weiss_schwarz' or data.get('source') != 'c-labo':
        raise ValueError('Invalid retailer source identity')
    native = {str(p['id']): p for p in load_sources(root)['weiss_schwarz']['products']}
    game = next(g for g in manifest['games'] if g['id'] == 'weiss_schwarz')
    seen = set()
    for group in data['products']:
        pid = group['nativeProductId']
        parent = native[pid]
        parents = {str(c['id']): c for c in parent['cards']}
        rows = []
        for source in group['supplementalPrintings']:
            original = parents.get(str(source.get('nativeCardId')))
            paired = source.get('nativeNumberNameMatch') is True
            prefixes = {norm(c['number']).rsplit('-', 1)[0] for c in parents.values() if c.get('number')}
            if (source.get('finish') != 'foil'
                    or (paired and (not original or norm(source['cardNumber']) != norm(original['number'])
                        or re.sub(r'\s+', '', norm(source['name'])) != re.sub(r'\s+', '', norm(original['name']))))
                    or (not paired and (source.get('nativeCardId') or norm(source['cardNumber']).rsplit('-', 1)[0] not in prefixes))
                    or not re.search(r'\(foil\)', source.get('sourceTitle', ''), re.I)
                    or source['nativeProductId'] != pid or source['id'] in seen):
                raise ValueError('Retailer number/name/finish proof mismatch')
            row = {'id': source['id'], 'catalogSource': 'VERIFIED_RETAILER',
                   'retailerProductId': source['sourceProductId'], 'name': source['name'],
                   'fullCardNumber': source['cardNumber'], 'numberStatus': 'printed',
                   'rarity': source['sourceDeclaredRarity'], 'rarityStatus': 'printed',
                   'game': 'weiss_schwarz', 'language': 'ja', 'finish': 'foil',
                   'variant': 'foil', 'image': source.get('image') or '',
                   'sourceUrl': source['sourceUrl'], 'sourcePackTitle': parent['name'],
                   'referenceNativeProductId': pid, 'nativeCounterpartVerified': paired,
                   'referenceNativeCardId': str(original['id']) if paired else None,
                   'priceLookupPolicy': 'exact-finish-required',
                   'sourceDeclaredRarity': source['sourceDeclaredRarity'],
                   'nativeDeclaredRarity': (original.get('rarity') or '') if paired else '',
                   'raritySourceDisagreement': paired and source['sourceDeclaredRarity'] != original.get('rarity'),
                   'finishEvidence': source['finishEvidence']}
            rows.append(row)
            seen.add(row['id'])
        if not rows:
            continue
        key = key_for('retailer-printings', 'weiss_schwarz', pid)
        entry = {'id': key, 'name': parent['name'] + ' · 실물 포일 판본',
                 'sourceGame': 'weiss_schwarz', 'referenceNativeProductId': pid,
                 'language': 'ja', 'coverage': 'verified-retailer-printings',
                 'officialComplete': False, 'inclusionScope': 'related-printing',
                 'cardCount': len(rows), 'file': '/data/tcg-card-info/weiss_schwarz/' + key + '.json'}
        for row in rows:
            validate_retailer_card(row, entry)
        payload = {'schemaVersion': 1, 'game': 'weiss_schwarz', 'sourceGame': 'weiss_schwarz',
                   'set': entry, 'generatedAt': manifest['generatedAt'], 'officialComplete': False,
                   'source': 'Direct retailer physical printing evidence; no retailer prices', 'cards': rows}
        if len(encoded(payload)) >= 3_700_000:
            raise ValueError('Retailer printing asset exceeds budget')
        outputs.append((root / entry['file'].lstrip('/'), payload))
        game['sets'].append(entry)
        for box in game['boxes']:
            if pid not in box.get('officialProductIds', []):
                continue
            box.setdefault('relatedSetIds', []).append(key)
            box['relatedCardCount'] = box.get('relatedCardCount', 0) + len(rows)
            box['retailerPrintingCount'] = len(rows)
            box['relatedLabel'] = '프로모·실물 판본' if len(box['relatedSetIds']) > 1 else '실물 포일 판본'
        # Link only exact native identities; no fabricated manufacturer IDs.
        targets = {r['referenceNativeCardId']: r for r in rows if r['nativeCounterpartVerified']}
        for _, payload in outputs:
            if payload['set'].get('officialProductId') != pid:
                continue
            for row in payload['cards']:
                target = targets.get(row.get('officialCardId'))
                if target:
                    row.setdefault('finishVariants', []).append({'id': target['id'],
                        'number': target['fullCardNumber'], 'rarity': target['rarity'], 'source': 'retailer'})
    game['setCount'] = len(game['sets'])
    game['cardCount'] = sum(s['cardCount'] for s in game['sets'])
    manifest['retailerPrintingEvidence'] = {'source': 'c-labo', 'verifiedFoilRows': len(seen),
        'scope': 'Related physical finish variants; category alone does not prove sealed inclusion',
        'pricesImported': 0}
