"""Keep public catalogue facts/proofs; omit raw rules, HTML and local caches."""
import argparse
import gzip
import json
from pathlib import Path

TOP = ('schemaVersion', 'game', 'language', 'source', 'sourceUrl', 'fetchedAt', 'complete',
       'expectedProducts', 'rarityCoverageComplete', 'exactParallelRarityComplete',
       'classificationComplete', 'metadataComplete', 'coverage', 'limits', 'inventoryProvenance',
       'futureProducts', 'boxMappings', 'incompleteMarketBoxes', 'navigationCoverageComplete',
       'imageBaseUrl', 'imageBaseEvidence', 'totalCards', 'sourcePageCount')
TOP += ('limitations', 'evidenceType', 'inventoryComplete', 'allMarketBoxesMapped',
        'allPackMembershipComplete', 'coverageScope', 'printingInventoryComplete',
        'numberCompleteness', 'allPrintingsNumbered', 'numberCompletenessDefinition')
PRODUCT = ('id', 'name', 'code', 'kind', 'url', 'sourceUrl', 'fetchedAt', 'complete', 'cardCount',
           'expectedCardCount', 'expectedMemberCount', 'memberCount', 'officialCardCount',
           'printingCount', 'membershipComplete', 'numberCompleteness', 'allPrintingsNumbered',
           'rarityComplete', 'classificationComplete', 'exactParallelRarityComplete',
           'sourceCountMethod', 'sourceSha256', 'provenance', 'isAggregate', 'isBonus',
           'marketBoxIds', 'reviewedBoxIds', 'codeSource', 'codeSourceUrls', 'codeVerified',
           'releasedAt', 'releaseDate', 'edition', 'sourceNativeProductId', 'sourceNativeProductIds',
           'isDerivedProduct', 'idSource', 'membershipMethod', 'independentlyDeclaredCount',
           'excludedCardIds', 'excludedRarities', 'exclusions', 'originalCardCount',
           'officialNoticeImageUrl', 'officialNoticeImageSha256', 'officialNoticeUrl',
           'officialNoticeSha256', 'sourceProvenance', 'coreCardIds', 'relatedCardIds',
           'includedBonusIds', 'packMembershipComplete', 'advertisedTypeCount', 'advertisedCounts',
           'inclusionEvidence', 'metadataCoverage')
PRODUCT += ('printedSetCodes', 'membershipSemantics', 'productPageUrl', 'productPageTitle',
            'advertisedPackSpecifications', 'advertisedRarityCounts', 'actualNormalPrintingCount',
            'actualParallelPrintingCount', 'officialParallelFlagCounts', 'artVariantGroups',
            'normalConceptTypeCount', 'parallelConceptTypeCount', 'packSpecificationMatch',
            'packVerificationMethod', 'relatedMarketBoxIds', 'editionEvidence',
            'printingInventoryComplete', 'numberLookupComplete', 'membershipRarityRowCount', 'codes',
            'rosterBaseNumbers', 'rosterProvenance', 'unchangedPrintingsNotice', 'expectedPackTypes',
            'officialNoticeImageSha256Representation', 'otherGameBoxBonus')
CARD = ('id', 'number', 'name', 'rarity', 'rarityId', 'rarityLabel', 'image', 'url', 'variant',
        'cardId', 'artworkId', 'sourceCardNo', 'sourceNativeProductId', 'numberStatus',
        'numberOrigin', 'numberProvenance', 'numberVerified', 'printedNumberSource',
        'printingSourceUrl', 'printingSourceSha256', 'rarityStatus', 'rarityOrigin',
        'rarityFilter', 'rarityProvenance', 'rarityNotApplicable', 'rarityNotApplicableOrigin',
        'classificationSources', 'detailProvenance', 'cardType', 'acquisition', 'productInfoUrls',
        'legacyIds', 'inclusionRole', 'inclusionEvidence')
CARD += ('variation', 'parallelParam', 'isParallel', 'picture', 'sourceRarity',
         'artworkVerified', 'membershipArtworkId', 'membershipRarityIds', 'printedNumber',
         'printingFetchedAt', 'sourcePrintingIndexes')


def select(data, fields):
    return {key: data[key] for key in fields if key in data}


def prepare(data, previous=None):
    output = select(data, TOP)
    output['expectedProducts'] = len(data['products'])
    if data.get('game') == 'weiss_schwarz':
        for future in output.get('futureProducts', []):
            evidence = future.get('nativeInventoryEvidence', {})
            if evidence.get('matchingBoosterExpansionIds') == [] and future.get('announcementEvidence'):
                future.update(cardInventoryPublished=False, fetchFailed=False,
                              marketBoxId=future['marketBoxIds'][0],
                              announcementProvenance={'url': future['url'], **future['announcementEvidence']})
    reviewed = {str(p['id']): p for p in (previous or {}).get('products', [])}
    for field in ('products', 'derivedProducts'):
        if field not in data:
            continue
        output[field] = []
        for product in data[field]:
            item = select(product, PRODUCT)
            item['cards'] = [select(card, CARD) for card in product['cards']]
            if data.get('game') == 'weiss_schwarz':
                codes = product.get('printedSetCodes', [])
                if len(codes) == 1:
                    item['code'] = codes[0]
                for card, source in zip(item['cards'], product['cards']):
                    card['url'] = source.get('url') or source['sourceUrl']
                    card['rarity'] = (card.get('rarity') or '').strip()
                if field == 'derivedProducts' and 'derivedFromOfficialId' in product:
                    proof = product['editionEvidence']
                    item.update(isDerivedProduct=True, edition='second',
                                sourceNativeProductId='ws-jp:' + str(product['derivedFromOfficialId']),
                                reviewedBoxIds=product['marketBoxIds'],
                                membershipMethod='official-native-inventory-minus-explicit-first-print-only-AGR',
                                excludedCardIds=proof['excludedNativeCardIds'],
                                officialNoticeUrl=proof['sourceUrl'],
                                officialNoticeSha256=proof['provenance']['extractedTextSha256'])
            old = reviewed.get(str(product['id'])) if field == 'products' else None
            if old:
                if [str(c['id']) for c in old['cards']] != [str(c['id']) for c in product['cards']]:
                    raise ValueError('Cannot retain a reviewed mapping across changed native membership')
                for key in ('marketBoxIds', 'reviewedBoxIds', 'codeSource', 'codeSourceUrls', 'codeVerified'):
                    if key in old and key not in item:
                        item[key] = old[key]
            output[field].append(item)
    return output


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--base', type=Path, help='Retain reviewed product mappings from the current published source')
    args = parser.parse_args()
    raw = args.input.read_bytes()
    data = json.loads(gzip.decompress(raw) if args.input.suffix == '.gz' else raw)
    previous = None
    if args.base:
        previous_raw = args.base.read_bytes()
        previous = json.loads(gzip.decompress(previous_raw) if args.base.suffix == '.gz' else previous_raw)
    output = prepare(data, previous)
    body = (json.dumps(output, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n').encode()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = args.output.with_name(args.output.name + '.tmp')
    temporary.write_bytes(gzip.compress(body, compresslevel=9, mtime=0) if args.output.suffix == '.gz' else body)
    temporary.replace(args.output)
    print(json.dumps({'game': output['game'], 'products': len(output['products']),
                      'nativePrintings': sum(len(p['cards']) for p in output['products']),
                      'outputBytes': args.output.stat().st_size}))


if __name__ == '__main__':
    main()
