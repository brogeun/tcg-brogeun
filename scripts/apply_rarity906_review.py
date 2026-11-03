"""Apply bounded reference decisions; raw catalogues and historical reviews stay intact."""
from __future__ import annotations
import copy
import hashlib
import json
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'data/collections/sources'
REVIEW = 'rarity906-review-20261104'
VERSION = '20261104-review906'


def read(path):
    return json.loads(path.read_text())


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')


def slim(value):
    if isinstance(value, dict):
        return {k: slim(v) for k, v in value.items() if k not in ('cachedPath', 'localPath', 'rawRarityMarkup')}
    return [slim(v) for v in value] if isinstance(value, list) else value


def ja_entry(row):
    grade = row['proposedState'] == 'reference-grade'
    proof = {k: slim(v) for k, v in row.items() if k not in (
        'name', 'number', 'sourceUrl', 'sourceId', 'setCode', 'language', 'brand', 'proposedState',
        'canonicalReferenceValue', 'id', 'variant', 'previousStatus')}
    proof.update(schemaVersion=1, kind='external-explicit', exactCardIdentity=True,
                 physicalPrintingConfirmed=False, value=row['canonicalReferenceValue'], reviewId='rarity906-ja-cn-20261104')
    if row['proposedState'] == 'reference-grade':
        proof['resolutionNote'] = '일본판 개별 카드의 Japanese rarity 값을 참고값으로 표시합니다. Secret Rare는 번호가 세트 범위를 넘는 카드의 상위 분류로 함께 기록되며, 두 명칭을 전역 동의어로 바꾸지 않습니다.'
        if row['setCode'].upper() == 'E5':
            proof['resolutionNote'] += ' 이전 세트 목록의 Rare Holo도 남기고, 일본판 개별 카드 필드를 우선했습니다.'
    elif row['setCode'].upper() == 'MF':
        proof['resolutionNote'] = '같은 상품 제목의 AR仕様는 일러스트 사양이며, 별도 명시된 レアリティ表記無し를 외부 DB의 미표기 분류로 표시합니다. 공식 카드 이미지와 세트·이름·전체 번호를 대조했습니다.'
    elif row['language'] == 'zh-CN':
        proof['resolutionNote'] = '원문과 외부 DB의 카드 이미지를 픽셀 단위로 대조했습니다. 공식 149/103 이미지의 갤럭시단 표식도 확인해 （银河）와 G가 같은 카드를 가리킴을 확인했습니다. 외부 DB의 无标记 분류만 반영합니다.'
    else:
        proof['resolutionNote'] = '정확한 일본판 세트·이름·번호가 일치하는 판매처의 レアリティなし 분류를 표시합니다. 공식 이미지의 C는 레귤레이션 표시로, 희귀도 C로 사용하지 않습니다. TCGdex의 Rare Holo 값도 다른 자료로 남깁니다.'
    return {'name': row['name'], 'number': row['number'], 'rarity': row['canonicalReferenceValue'] if grade else '',
            'rarityOriginal': '—', 'rarityStatus': 'reference-explicit' if grade else 'reference-unlisted', 'rarityEvidence': proof}


def main():
    baseline = read(SOURCE / 'rarity906-baseline-20261104.json')
    scope = {(r['language'], r['setCode'].upper(), r['sourceUrl']): r for r in baseline['rows']}
    assert len(scope) == baseline['remaining'] == 906
    proposals, reports = {}, []
    ja_report = 'rarity906-ja-cn-20261104.json'
    reports.append(ja_report)
    for row in read(SOURCE / ja_report)['rows']:
        key = (row['language'], row['setCode'].upper(), row['sourceUrl'])
        proposals[key] = ja_entry(row)
    for prefix, suffix in [('rarity906-en-promos-20261104', '-report.json'),
                           ('rarity906-en-topps-20261104', '-report.json'),
                           ('rarity906-en-decks-20261104', '.json')]:
        reports.append(prefix + suffix)
        bundle = read(SOURCE / (prefix + '-overlay.json'))
        for code, member in bundle['sets'].items():
            assert member['language'] == 'en'
            for url, entry in member['cards'].items():
                key = ('en', code.upper(), url)
                assert key not in proposals, ('duplicate decision', key)
                proposals[key] = copy.deepcopy(entry)
    indexes = {lang: read(SOURCE / f'pokemon-{lang}-rarity-crossdb.json') for lang in ('jp', 'en')}
    cn_path = SOURCE / 'pokemon-cn-rarity-crossdb.json'
    chinese = read(cn_path)
    sets, adopted, deltas = {}, [], Counter()
    for key, entry in sorted(proposals.items()):
        assert key in scope, ('outside bounded remaining scope', key)
        row = scope[key]
        raw_path = ROOT / row['rawFile']
        assert hashlib.sha256(raw_path.read_bytes()).hexdigest() == row['rawFileSha256'], row['rawFile']
        cards = [c for c in read(raw_path)['cards'] if (c.get('sourceUrl') or c.get('url')) == key[2]]
        assert len(cards) == 1
        card = cards[0]
        assert entry['name'] == card['name'] and entry['number'] == card['number'] and not card.get('rarity'), key
        proof = entry['rarityEvidence']
        assert proof['kind'] == 'external-explicit' and proof['exactCardIdentity'] is True
        assert proof['physicalPrintingConfirmed'] is False
        refs = proof['references']
        assert refs and all(r.get('provider') and r.get('literal') and r.get('url', '').startswith('https://') for r in refs)
        if entry['rarityStatus'] == 'reference-unlisted':
            assert not entry['rarity'] and proof['value'] in ('None', 'No Rarity')
            assert all(r['literal'] in ('None', 'No Rarity', '表記無し(-)', '表記無し', 'レアリティなし', 'レアリティ表記無し', '无标记') for r in refs)
            proof['value'] = 'None'
            state = 'reference-unlisted'
        else:
            assert entry['rarityStatus'] == 'reference-explicit' and proof['value'] == entry['rarity']
            assert all(r['literal'] == entry['rarity'] for r in refs)
            state = 'reference-grade'
        identity = proof.get('identity', {})
        for field in ('catalogueNumberIsOrdinal', 'sourceCardLanguage', 'catalogueLanguage', 'catalogueLanguageMismatch'):
            if field in identity and field not in proof:
                proof[field] = identity[field]
        if 'physicalCardLanguage' in identity:
            names = {'English':'en','Italian':'it','Korean':'ko','Spanish':'es','Japanese':'ja','German':'de','French':'fr','Polish':'pl','Portuguese':'pt'}
            proof['sourceCardLanguage'] = names[identity['physicalCardLanguage']]
            proof['catalogueLanguage'] = 'en'
            proof['catalogueLanguageMismatch'] = proof['sourceCardLanguage'] != 'en'
        if proof.get('catalogueNumberIsOrdinal'):
            proof['printedNumberMatchClaimed'] = False
        if proof['reviewId'] == 'rarity906-en-topps-20261104':
            if entry['rarity'] == 'Common':
                proof['resolutionNoteKo'] = '해당 Prize Pack 수록 카드에 대응하는 TCGplayer 상품의 Common 명시값입니다. 일반판·Cosmos Holo 상품이 함께 있는 경우 두 값이 일치함을 확인했습니다. 실제 팩 출처나 홀로 사양을 확정한 값은 아닙니다.'
            elif entry['rarity'] == 'Promo':
                proof['resolutionNoteKo'] = '2010 World Collection의 카드 언어·그림이 일치하는 TCGplayer 상품의 Promo를 참고값으로 표시합니다. Dex의 No Rarity도 함께 남깁니다. 일본어 카드는 파란 배경 판본이며 별도 녹색 판본과 구분했습니다.'
            else:
                proof['resolutionNoteKo'] = '동일 특수 세트의 이름·그림이 일치하는 Dex 카드 페이지에 명시된 No Rarity 분류입니다. 두 목록의 관리 순번이 달라 인쇄 번호 일치를 근거로 삼지 않았습니다. 제조사 무등급 확정은 아닙니다.'
        elif proof['reviewId'] == 'rarity906-en-decks-20261104':
            proof.pop('identityNote', None)
            if entry['rarity'] == 'Promo':
                proof['resolutionNoteKo'] = '동일 Best of Game 카드의 TCGplayer 상품에 명시된 Promo를 참고값으로 표시합니다. TCGdex의 None도 다른 자료로 보존하며 실물에 Promo 기호가 인쇄됐다는 뜻은 아닙니다.'
            else:
                proof['sourceIdentityNote'] = '저장된 My First Battle 카드 그림과 원래 카드 모델의 연결 상품 이미지를 대조했습니다. 현재 다른 그림으로 바뀐 페이지나 잘못 연결된 상품은 근거에서 제외했습니다. 외부 DB의 명시된 미표기 분류만 반영합니다.'
        entry['rarityOriginal'] = card.get('rarityOriginal', '—')
        if key[0] == 'zh-CN':
            entry.update(sourceUrl=key[2], setCode=row['setCode'], cardId=card['id'], sourceId=card['sourceId'], variant=card['variant'])
            chinese['cards'][key[2]] = entry
        else:
            member_key = key[:2]
            if member_key not in sets:
                index = indexes['jp' if key[0] == 'ja' else 'en']
                old_url = index['setShards'].get(key[1])
                if old_url:
                    sets[member_key] = copy.deepcopy(read(ROOT / old_url.split('?')[0].lstrip('/'))['sets'][key[1]])
                else:
                    sets[member_key] = {'schemaVersion':1,'brand':'pokemon','language':key[0], 'setCode':row['setCode'],'compactIdentity':True,'cards':{}}
            sets[member_key]['cards'][key[2]] = entry
        adopted.append({**row, 'proposedState':state, 'canonicalReferenceValue':proof['value'], 'evidenceReview':proof['reviewId']})
        deltas[state] += 1
    # Small independent language bundles avoid a large shared fetch on a card panel.
    number = 6000
    for lang in ('ja', 'en'):
        selected = [(code, member) for (locale, code), member in sorted(sets.items()) if locale == lang]
        for start in range(0, len(selected), 4):
            members = dict(selected[start:start+4])
            name = f'part-{number:04}.json'
            write(SOURCE / 'pokemon-rarity-recheck' / name, {'schemaVersion':1,'bundleVersion':1,'cards':{},'sets':members})
            index = indexes['jp' if lang == 'ja' else 'en']
            for code in members:
                index['setShards'][code] = '/data/collections/sources/pokemon-rarity-recheck/' + name + '?v=' + VERSION
            number += 1
    for lang, index in indexes.items():
        index['version'] = VERSION
        write(SOURCE / f'pokemon-{lang}-rarity-crossdb.json', index)
    chinese['reviewId'] = REVIEW
    write(cn_path, chinese)
    held = {}
    for filename in reports:
        report = read(SOURCE / filename)
        for row in report.get('rows', []) + report.get('held', []) + report.get('withheld', []):
            if row.get('sourceUrl') and row.get('setCode'):
                reason = row.get('reason') or row.get('holdReason')
                if reason:
                    held[(row.get('language', 'en'),row['setCode'].upper(),row['sourceUrl'])] = {'holdReason':reason,'evidenceReview':report['reviewId']}
    remaining_rows = [{**r, **held.get(key, {'holdReason':'No exact edition-specific explicit classification survived the bounded source review.'})} for key, r in scope.items() if key not in proposals]
    counts = Counter(baseline['counts'])
    for row in adopted:
        counts[row['previousState']] -= 1
        counts[row['proposedState']] += 1
    report = {'schemaVersion':1, 'reviewId':REVIEW,'originalScope':3381,'previousReview':'rarity-resume-20261103',
              'previousRemaining':906,'additionalReferenceGrades':deltas['reference-grade'],
              'additionalExplicitNoSymbolReferences':deltas['reference-unlisted'],
              'referenceGrade':counts['reference-grade'],'explicitExternalUnlisted':counts['reference-unlisted'],
              'documentedUnprintedRarity':counts['documented-unprinted'],'referenceConflict':counts['reference-conflict'],
              'noAdoptableClassification':counts['source-unlisted']+counts['unknown'],
              'remainingUnresolvedIncludingConflicts':len(remaining_rows),'languageRemaining':{lang:sum(r['language']==lang for r in remaining_rows) for lang in ('ja','en','zh-CN')},
              'policy':'Counts are original panel rows. Every adoption matches a frozen unresolved source identity. Raw catalogue grades, images, edition, prices and prior evidence files remain intact. External categories do not assert a manufacturer grade or no-grade status.',
              'evidenceReports':['data/collections/sources/'+f for f in reports], 'adoptedRows':adopted,
              'remainingRows':remaining_rows}
    assert len(adopted) + len(remaining_rows) == 906 and sum(counts.values()) == 3381
    write(SOURCE / f'{REVIEW}.json', report)
    print(json.dumps({k:v for k,v in report.items() if k not in ('adoptedRows','remainingRows','policy','evidenceReports')}))


if __name__ == '__main__':
    main()
