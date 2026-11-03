#!/usr/bin/env python3
"""Verify the eight bounded JA/CN decisions from cached primary responses.

This research writes only its new evidence JSON files. It does not alter source
grades, catalogue identities, images, price references, or running code. Cache
bytes are never fetched through alternative routes after an access denial.
"""
import argparse
import copy
import datetime
import gzip
import hashlib
import html
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / 'data/collections/sources'
PREFIX = 'rarity906-ja-cn-20261104'


def load_json(path):
    return json.loads(path.read_text())


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def cached(cache, key, suffix='html', encoding='utf-8'):
    path = cache / f'rarity906-{key}.{suffix}'
    raw = path.read_bytes()
    return raw, raw.decode(encoding) if suffix == 'html' else None


def text_only(value):
    return ' '.join(html.unescape(re.sub(r'<[^>]+>', ' ', value)).split())


def proof_json(cache, temporary, durable):
    path = cache / temporary
    if not path.exists():
        path = SOURCES / durable
    return load_json(path)


def base_row(original, state, value):
    return {key: original[key] for key in ['setCode', 'sourceId', 'sourceUrl', 'number', 'name', 'language']} | {
        'brand': 'pokemon', 'proposedState': state, 'canonicalReferenceValue': value,
        'publisherOfficial': False, 'physicalPrintingConfirmed': False,
        'manufacturerNoGradeConfirmed': False, 'rawFieldsUnchanged': True,
        'confidence': 'high for this bounded source classification; no blanket physical-grade claim'}


def manufacturer_proof(cache, key, number, native_name, official_id, image_url):
    page_raw, page = cached(cache, key)
    assert native_name in page
    assert '/'.join(number.split('/')) in text_only(page).replace(' / ', '/') or all(part in page for part in number.split('/'))
    image_raw, _ = cached(cache, key, 'jpg')
    assert image_url.removeprefix('https://www.pokemon-card.com') in page
    return {'provider': 'Pokémon / official Japanese card database',
            'url': f'https://www.pokemon-card.com/card-search/details.php/card/{official_id}',
            'sourceSha256': sha(page_raw), 'sourceNameJa': native_name,
            'sourceNumber': number, 'publisherOfficial': True,
            'imageUrl': image_url, 'imageSha256': sha(image_raw),
            'imageInspected': True, 'printedNumberVisuallyVerified': number,
            'visualObservation': 'Exact manufacturer front has the stated name, set and fraction; no rarity symbol is printed next to the card number.',
            'meaning': 'A documented printed-symbol observation, not a manufacturer no-rarity classification.'}


def build(cache):
    old_ja = []
    for path in sorted(SOURCES.glob('rarity-crossdb-20261101-ja-*.json.gz')):
        with gzip.open(path, 'rt') as handle:
            old_ja.extend(json.load(handle)['rows'])
    targets = {(row['setCode'], row['number']): row for row in old_ja}
    ereader = proof_json(cache, 'rarity906-ereader-findings.json', PREFIX + '-ereader.json')
    cnproof = proof_json(cache, 'rarity906-cn149-proof.json', PREFIX + '-cn149.json')
    rows = []

    # Japanese-specific direct fields and the same provider's taxonomy explain
    # the Secret Rare family without inventing a global rarity synonym.
    taxonomy = ereader['taxonomyEvidence']
    taxonomy_raw = Path(taxonomy['cachedPath']).read_bytes()
    assert sha(taxonomy_raw) == taxonomy['sourceSha256']
    assert b'Crystal' in taxonomy_raw and b'Super Rare' in taxonomy_raw
    for raw_entry in ereader['rows']:
        entry = copy.deepcopy(raw_entry)
        original = targets[(entry['setCode'], entry['number'])]
        for key in ['sourceId', 'sourceUrl', 'name', 'number', 'language']:
            assert entry[key] == original[key]
        for reference in entry['references']:
            raw = Path(reference['cachedPath']).read_bytes()
            assert sha(raw) == reference['sourceSha256']
            assert reference['rawRarityMarkup'].strip() in raw.decode()
            assert reference['field'] == 'Japanese rarity'
            assert reference['literal'] == 'SuperRare Holo'
        entry['resolutionNote'] = (
            'Exact per-card Japanese rarity field is preferred over a broader secret-numbered family. '
            'The provider defines Japanese Crystal cards as Super Rare while also including them in the '
            'Secret Rare family by numbering. All prior labels remain separate audited observations; no global alias is installed.')
        if entry['setCode'] == 'e5':
            entry['resolutionNote'] += ' The older set-list Rare Holo value differs from this exact Japanese card field; the direct Japanese field is more specific.'
        for observation in entry['otherReferences']:
            observation['dimension'] = observation.pop('typedFacet')
            observation['preferenceReason'] = 'Specific Japanese per-card field plus provider taxonomy is used for this card only.'
        entry['taxonomyEvidence'] = taxonomy
        entry['rawFieldsUnchanged'] = True
        rows.append(entry)

    # LEAD's same product title explicitly separates AR finish from no printed
    # rarity. The manufacturer's exact front and full-illustration product
    # wording support that distinction; AR is retained rather than erased.
    product_raw, product_html = cached(cache, 'mf-product')
    for number, native, official_id, key, image_url in [
        ('041/040', 'ビクティニ', '50591', 'mf041', 'https://www.pokemon-card.com/assets/images/card_images/large/MF/050591_P_BIKUTEINI.jpg'),
        ('042/040', 'ゼラオラ', '50592', 'mf042', 'https://www.pokemon-card.com/assets/images/card_images/large/MF/050592_P_ZERAORA.jpg')]:
        original = targets[('MF', number)]
        raw, lead = cached(cache, 'lead-' + key)
        title = html.unescape(re.search(r'<title>(.*?)</title>', lead, re.S)[1])
        assert number in title and native in title and '【AR仕様】' in title and '(レアリティ表記無し)' in title
        assert native + '（フルイラスト）' in html.unescape(product_html)
        entry = base_row(original, 'reference-unlisted', 'None')
        entry['previousStatus'] = 'reference-candidate'
        entry['identityMethod'] = 'exact-Japanese-manufacturer-name-set-full-fraction-and-native-retailer-title'
        entry['references'] = [{
            'provider': 'Toreca Shop LEAD. / Yahoo! Shopping',
            'url': f'https://store.shopping.yahoo.co.jp/lead-netstore/mf162609tt{number[:3]}.html',
            'literal': 'レアリティ表記無し', 'sourceSetCode': 'MF',
            'sourceNumber': number, 'sourceNameJa': native, 'productTitle': title,
            'finishLiteral': 'AR仕様', 'sourceSha256': sha(raw),
            'semantics': 'explicit-retailer-no-printed-rarity-in-same-title-as-AR-finish'}]
        entry['otherReferences'] = [{
            'provider': 'Toreca Market OnlyOne',
            'url': 'https://www.torecaonlyone-shop.com/product/' + ('16386' if key == 'mf041' else '16387'),
            'literal': 'AR', 'dimension': 'retailer-art-finish-taxonomy',
            'preferenceReason': 'Same exact LEAD product explicitly says AR仕様 and no rarity printed; manufacturer uses full illustration and its front has no AR symbol.'}]
        entry['manufacturerEvidence'] = manufacturer_proof(cache, key, number, native, official_id, image_url)
        entry['manufacturerProductEvidence'] = {
            'url': 'https://www.30th.pokemon-card.com/product/mf',
            'sourceSha256': sha(product_raw), 'literal': native + '（フルイラスト）',
            'dimension': 'illustration-treatment'}
        entry['resolutionNote'] = 'AR仕様 describes the illustration treatment here; the same exact retailer product explicitly says レアリティ表記無し. The manufacturer calls the card full illustration, and its exact front has no printed AR symbol. The AR observation is retained as finish metadata, not converted into a physical rarity grade.'
        rows.append(entry)

    # Both normal and holo listings explicitly belong to the retailer's
    # no-rarity category. Therefore the old Rare Holo outlier is not silently
    # transferred from finish to a printed rarity claim.
    original = targets[('SM12a', '012/173')]
    entry = base_row(original, 'reference-unlisted', 'None')
    entry['previousStatus'] = 'reference-candidate'
    entry['identityMethod'] = 'exact-manufacturer-name-set-fraction-and-both-native-retailer-normal-holo-categories'
    entry['references'] = []
    for key, suffix in [('fullahead-bounsweet-normal', ''), ('fullahead-bounsweet-holo', '(キラ)')]:
        raw, page = cached(cache, key, encoding='euc-jp')
        breadcrumb = next(block for block in re.findall(r'<ul id="M_topicPath\d+">(.*?)</ul>', page, re.S)
                          if '/shopbrand/rarity/' in block)
        assert 'レアリティなし' in breadcrumb and '/shopbrand/rarity-non/' in breadcrumb
        assert 'PK-SM12a-012 アマカジ' + suffix in text_only(breadcrumb)
        canonical = re.search(r'<link rel="canonical" href="([^"]+)"', page)[1]
        entry['references'].append({
            'provider': 'Pokémon Card Fullahead', 'url': canonical,
            'literal': 'レアリティなし', 'sourceSetCode': 'SM12a',
            'sourceNumber': '012/173', 'sourceNameJa': 'アマカジ',
            'productCode': 'PK-SM12a-012', 'sourceSha256': sha(raw),
            'productSubtype': 'holo' if suffix else 'normal',
            'categoryBreadcrumb': text_only(breadcrumb),
            'semantics': 'explicit-per-item-rarity-category-not-global-navigation'})
    entry['manufacturerEvidence'] = manufacturer_proof(cache, 'sm12a012', '012/173', 'アマカジ', '37216',
        'https://www.pokemon-card.com/assets/images/card_images/large/SM12a/037216_P_AMAKAJI.jpg')
    entry['manufacturerEvidence']['regulationMarkWarning'] = 'The bordered C before the fraction is the regulation mark, not Common rarity; no rarity symbol follows012/173.'
    entry['otherReferences'] = [{'provider': ref['provider'], 'url': ref.get('sourceUrl'),
        'literal': ref.get('literal'), 'sourceSha256': ref.get('sourceSha256'),
        'repositoryCommit': ref.get('repositoryCommit'), 'dimension': 'legacy-provider-rarity-label',
        'preferenceReason': 'Kept as the original provider observation; explicit no-symbol categories cover both normal and holo, and manufacturer front independently confirms no printed rarity.'}
        for ref in original['observations'] if ref.get('literal') not in (None, '', '—')]
    entry['resolutionNote'] = 'Exact Fullahead normal and holo products both explicitly belong to レアリティなし. The official SM12a012/173 front has no printed rarity symbol; its boxed C is the regulation mark. The historical TCGdex Rare Holo literal remains auditable and is not treated as a manufacturer printed grade.'
    rows.append(entry)

    # Resolve only this exact Chinese alias with pixel-identical source/provider
    # artwork, exact manufacturer number and the Galactic insignia/caption.
    from PIL import Image
    decoded = []
    for key in ['original', 'cryst']:
        source = cnproof['sources'][key]
        raw = Path(source['localPath']).read_bytes()
        assert sha(raw) == source['sha256']
        with Image.open(source['localPath']) as image:
            rgba = image.convert('RGBA')
            assert list(rgba.size) == cnproof['imageIdentity']['dimensions']
            decoded.append(rgba.tobytes())
    assert decoded[0] == decoded[1]
    assert sha(decoded[0]) == cnproof['imageIdentity']['decodedRGBAsha256']
    official = cnproof['sources']['official']
    assert sha(Path(official['localPath']).read_bytes()) == official['sha256']
    provider = cnproof['provider']
    detail_raw = (cache / 'rarity906-cn149-mik-detail.json').read_bytes()
    assert sha(detail_raw) == provider['responseSha256']
    entry = base_row(cnproof['target'], 'reference-unlisted', 'None')
    entry.update({key: cnproof['target'][key] for key in ['id', 'variant']})
    entry['previousStatus'] = 'reference-candidate'
    entry['identityMethod'] = cnproof['decision']['identityMethod']
    entry['references'] = [{
        'provider': provider['name'], 'url': provider['url'],
        'retrievalUrl': provider['retrievalUrl'], 'method': provider['method'],
        'requestBody': provider['requestBody'], 'literal': provider['literalRarity'],
        'sourceSetCode': provider['setCode'], 'sourceNumber': provider['cardIndex'],
        'sourceName': provider['literalName'], 'sourceSha256': provider['responseSha256'],
        'semantics': 'explicit-provider-no-symbol-category-after-exact-image-identity-proof'}]
    entry['imageIdentityEvidence'] = cnproof['imageIdentity']
    entry['manufacturerEvidence'] = official
    entry['nameDifference'] = cnproof['nameDifference']
    entry['resolutionNote'] = 'The catalogue and Cryst artwork have identical decoded RGBA pixels. Exact manufacturer149/103 artwork shows the Galactic insignia and 银河队的宝可梦 caption, proving the bounded （银河）/G naming difference denotes this same printing. Only its explicit external 无标记 classification is adopted; no general alias or manufacturer no-grade claim is created.'
    rows.append(entry)

    assert len(rows) == 8
    assert len({(row['language'], row['sourceUrl']) for row in rows}) == 8
    assert sum(row['proposedState'] == 'reference-grade' for row in rows) == 4
    assert sum(row['proposedState'] == 'reference-unlisted' for row in rows) == 4
    report = {'schemaVersion': 1, 'reviewId': PREFIX,
        'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
        'scope': 'Exact seven remaining Japanese rows and one CN149 identity hold from the906 review.',
        'counts': {'reviewed': 8, 'referenceGrade': 4, 'referenceUnlisted': 4,
                   'manufacturerGradeOverwrites': 0, 'globalAliasesCreated': 0},
        'policy': 'Bounded exact-source decisions only. Preserve original grades, images, variants, price joins and all conflicting literals. Printed-symbol absence is not a manufacturer no-grade classification. Secret-numbered family, art finish and native rarity are different facets.',
        'rows': rows,
        'limitations': ['Provider classifications remain external references.',
            'Manufacturer front review concerns the exact displayed model; it does not certify every physical edition or finish.',
            'No blanket SuperRareHolo=SecretRare or Galactic-name alias is created.',
            'Toresia and CardRush direct downloads returned403; those hosts were not retried or bypassed.'],
        'validation': {'allSourceCacheHashesVerified': True, 'cnDecodedPixelIdentityRechecked': True,
            'exactManufacturerFrontsVisuallyReviewed': ['MF041/040', 'MF042/040', 'SM12a012/173', 'CN-30TH149/103'],
            'rawDataFilesModified': False}}
    return report, ereader, cnproof


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache-dir', type=Path, default=Path('/tmp'))
    args = parser.parse_args()
    report, ereader, cnproof = build(args.cache_dir)
    for suffix, value in [('', report), ('-ereader', ereader), ('-cn149', cnproof)]:
        destination = SOURCES / (PREFIX + suffix + '.json')
        destination.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'file': str(SOURCES / (PREFIX + '.json')), 'counts': report['counts']}))


if __name__ == '__main__':
    main()
