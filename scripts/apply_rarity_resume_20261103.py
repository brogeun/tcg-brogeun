"""Materialize reviewed references without changing upstream cards or quotes."""
from __future__ import annotations
import copy
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'data/collections/sources'
REVIEW = 'rarity-resume-ja-cn-20261103'


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')


def main():
    report = read(SOURCE / f'{REVIEW}.json')
    assert report['counts']['referenceGrade'] == 1 and report['counts']['referenceUnlisted'] == 245
    index_path = SOURCE / 'pokemon-jp-rarity-crossdb.json'
    index, sets = read(index_path), {}
    chinese = {'schemaVersion': 1, 'brand': 'pokemon', 'language': 'zh-CN', 'reviewId': REVIEW,
               'cards': {}, 'publisherOfficial': False, 'physicalPrintingConfirmed': False}
    totals = Counter()
    for row in report['rows']:
        state, locale = row['proposedState'], row['language']
        if state not in ('reference-grade', 'reference-unlisted', 'reference-candidate'):
            continue
        if locale == 'zh-CN' and state != 'reference-unlisted':
            continue  # CN149's native name is not an exact match.
        code = row['setCode'].upper()
        filename = 'chinese-sets/CN-30TH' if locale == 'zh-CN' else 'cards-by-set/' + row['setCode']
        cards = read(ROOT / f'data/{filename}.json')['cards']
        matched = [c for c in cards if (c.get('sourceUrl') or c.get('url')) == row['sourceUrl']]
        assert len(matched) == 1, row['sourceUrl']
        card = matched[0]
        assert card['name'] == row['name'] and card['number'] == row['number']
        assert not card.get('rarity'), 'Never replace a preexisting rarity'
        source_id = card.get('sourceId')
        if source_id is None:
            identity = re.fullmatch(r'https://www\.tcgcollector\.com/cards/([0-9]+)/[^/]+', row['sourceUrl'])
            assert identity
            source_id = identity[1]
        assert str(source_id) == row['sourceId']
        assert row['references'] and all(ref['url'].startswith('https://') for ref in row['references'])
        proof = {'schemaVersion': 1, 'kind': 'external-candidate' if state == 'reference-candidate' else 'external-explicit',
                 'exactCardIdentity': True, 'physicalPrintingConfirmed': False, 'manufacturerNoGradeConfirmed': False,
                 'value': row['canonicalReferenceValue'], 'identityMethod': row['identityMethod'],
                 'reviewId': REVIEW, 'references': copy.deepcopy(row['references'])}
        for key in ('catalogueNumberIsOrdinal', 'physicalPrintedRaritySymbolClaimed', 'holdReason'):
            if key in row:
                proof[key] = row[key]
        entry = {'name': row['name'], 'number': row['number'],
                 'rarity': row['canonicalReferenceValue'] if state == 'reference-grade' else '',
                 'rarityOriginal': card.get('rarityOriginal', '—'),
                 'rarityStatus': 'reference-explicit' if state == 'reference-grade' else state, 'rarityEvidence': proof}
        if locale == 'zh-CN':
            assert row['id'] == card['id'] and row['variant'] == card['variant']
            entry.update(sourceUrl=row['sourceUrl'], setCode=row['setCode'], cardId=card['id'],
                         sourceId=card['sourceId'], variant=card['variant'])
            chinese['cards'][row['sourceUrl']] = entry
        else:
            if code not in sets:
                previous_url = index['setShards'].get(code)
                if previous_url:
                    sets[code] = copy.deepcopy(read(ROOT / previous_url.split('?')[0].lstrip('/'))['sets'][code])
                else:
                    sets[code] = {'schemaVersion': 1, 'brand': 'pokemon', 'language': 'ja',
                                  'setCode': row['setCode'], 'compactIdentity': True, 'cards': {}}
            old = sets[code]['cards'].get(row['sourceUrl'])
            assert old is None or old['rarityEvidence']['reviewId'] == REVIEW, 'Preserve previous classifications'
            sets[code]['cards'][row['sourceUrl']] = entry
        totals[(locale, state)] += 1
    assert sum(totals.values()) == 248 and len(chinese['cards']) == 37
    write(SOURCE / 'pokemon-rarity-recheck/part-5000.json', {'schemaVersion': 1, 'bundleVersion': 1, 'cards': {}, 'sets': sets})
    for code in sets:
        index['setShards'][code] = '/data/collections/sources/pokemon-rarity-recheck/part-5000.json?v=20261104-resume1'
    index['version'] = '20261104-resume1'
    write(index_path, index)
    write(SOURCE / 'pokemon-cn-rarity-crossdb.json', chinese)
    summary = {'schemaVersion': 1, 'reviewId': 'rarity-resume-20261103', 'originalScope': 3381,
               'previousReview': 'rarity-crossdb-20261101', 'additionalReferenceGrades': 1,
               'additionalExplicitNoSymbolReferences': 245, 'additionalReviewedCandidates': 2,
               'referenceGrade': 852, 'explicitExternalUnlisted': 1614, 'documentedUnprintedRarity': 9,
               'referenceConflict': 14, 'noAdoptableClassification': 892, 'remainingUnresolvedIncludingConflicts': 906,
               'languageRemaining': {'ja': 7, 'en': 898, 'zh-CN': 1}, 'englishEditionMismatchCandidatesHeld': 26,
               'policy': 'Original panel rows, not unique physical cards. References never overwrite raw rarity or prove a manufacturer no-grade category. MF AR and CN149 are held. Previous frozen evidence is preserved.',
               'evidenceReports': [f'data/collections/sources/{REVIEW}.json', 'data/collections/sources/rarity-resume-en-20261103.json']}
    assert sum(summary[k] for k in ('referenceGrade','explicitExternalUnlisted','documentedUnprintedRarity','referenceConflict','noAdoptableClassification')) == 3381
    write(SOURCE / 'rarity-resume-20261103.json', summary)
    print(json.dumps({'applied': 246, 'candidateEvidence': 2, 'cn': 37, 'unresolved': 906}))


if __name__ == '__main__':
    main()
