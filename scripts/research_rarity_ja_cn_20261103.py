#!/usr/bin/env python3
"""Replay the bounded JA/CN review from cached public source responses.

No original rarity, image, price, or card identity is modified. HTTP denial is
an error, with no alternate route or access-control workaround. Cached raw
response SHA-256 values remain part of the review provenance.
"""
import argparse
import datetime
import gzip
import hashlib
import html
import json
from pathlib import Path
import re
import unicodedata
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / 'data/collections/sources'


def norm(value):
    return re.sub(r'\s+', '', unicodedata.normalize('NFKC', value))


def download(url, path, body=None):
    if not path.exists():
        request = urllib.request.Request(url, data=json.dumps(body).encode() if body else None,
                                         headers={'Content-Type': 'application/json'} if body else {})
        with urllib.request.urlopen(request, timeout=25) as response:
            path.write_bytes(response.read())
    raw = path.read_bytes()
    return raw, {'url': url, 'method': 'POST' if body else 'GET',
                 **({'requestBody': body} if body else {}),
                 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}


def target_rows():
    ja = []
    for path in sorted(SOURCES.glob('rarity-crossdb-20261101-ja-*.json.gz')):
        with gzip.open(path, 'rt') as handle:
            ja += json.load(handle)['rows']
    with gzip.open(SOURCES / 'rarity-crossdb-20261101-cn-ws-0000.json.gz', 'rt') as handle:
        original_cn = json.load(handle)['rows'][0]['proposals']
    return ja, [row for row in original_cn if row.get('language') == 'zh-CN']


def japanese_name(row):
    return next((ref['sourceNameJa'] for ref in row['observations']
                 if ref.get('provider') == 'Limitless' and ref.get('sourceNameJa')), None)


def item_url(page, position):
    block = page[page.rfind('<li', 0, position):position]
    return next(url for url in re.findall(r'href="([^"]+)"', block) if '/product/' in url)


def record(row, refs, value='None', identity_method='exact-set-number-native-name', **extra):
    return {'brand': 'pokemon', 'setCode': row['setCode'], 'sourceId': row['sourceId'],
            'sourceUrl': row['sourceUrl'], 'name': row['name'], 'number': row['number'],
            'language': row['language'], 'previousStatus': row.get('status', 'source-unlisted'),
            'proposedState': 'reference-unlisted' if value == 'None' else 'reference-grade',
            'canonicalReferenceValue': value, 'publisherOfficial': False,
            'physicalPrintingConfirmed': False, 'manufacturerNoGradeConfirmed': False,
            'identityMethod': identity_method, 'references': refs, **extra}


def build(cache):
    ja, cn = target_rows()
    selected = {(row['setCode'], row['number']): row for row in ja}
    sources, output = [], []
    for page_number in (1, 2, 3):
        url = 'https://www.c-labo-online.jp/product-group/2289' + (f'?page={page_number}' if page_number > 1 else '')
        raw, source = download(url, cache / f'rarity-clabo-s4a-{page_number}.html')
        sources.append(source)
        page = raw.decode()
        assert '[ポケカ]S4A-表記無し(-)' in page
        for match in re.finditer(r'<span class="goods_name">([^<]*)</span>', page):
            title = html.unescape(match[1])
            parsed = re.fullmatch(r'【ポケカ】(.*?)【-】S4A\s+(\d+/\d+)', title)
            assert parsed, title
            native_name, number = parsed.groups()
            row = selected[('S4a', number)]
            plain = re.sub(r'\(R仕様\)$', '', unicodedata.normalize('NFKC', native_name))
            qualifiers = {
                '174/190': ('博士の研究(マグノリア博士/R仕様)', '博士の研究'),
                '176/190': ('ボスの指令(サカキ/R仕様)', 'ボスの指令')}
            reviewed = False
            if number in qualifiers and plain == qualifiers[number][0]:
                plain = qualifiers[number][1]
                reviewed = True
            assert norm(plain) == norm(japanese_name(row)), (number, plain, japanese_name(row))
            ref = {'provider': 'Card Labo', 'url': item_url(page, match.start()),
                   'listSourceUrl': url, 'literal': '表記無し(-)', 'sourceSetCode': 'S4A',
                   'sourceNumber': number, 'sourceNameJa': native_name, 'productTitle': title,
                   'categoryTitle': '[ポケカ]S4A-表記無し(-)', 'sourceSha256': source['sha256'],
                   'semantics': 'explicit-retailer-no-printed-rarity-category',
                   'identity': {'exactSet': True, 'exactFullFraction': True,
                                'nativeNameExactAfterReviewedQualifier': True,
                                'reviewedSubjectQualifier': reviewed},
                   'finishQualifier': 'R仕様' if 'R仕様' in native_name else None}
            output.append(record(row, [ref]))
    assert sum(row['setCode'] == 'S4a' for row in output) == 163
    assert len({row['sourceUrl'] for row in output}) == 163

    energy = {'MF_e001': ('No. 045', '基本草エネルギー', 'Basic Grass Energy'),
              'MF_e002': ('No. 046', '基本炎エネルギー', 'Basic Fire Energy'),
              'MF_e003': ('No. 047', '基本雷エネルギー', 'Basic Lightning Energy'),
              'MF_e004': ('No. 048', '基本超エネルギー', 'Basic Psychic Energy'),
              'MF_e005': ('No. 049', '基本悪エネルギー', 'Basic Darkness Energy')}
    for page_number in (1, 2):
        url = 'https://www.torecaonlyone-shop.com/product-group/419' + (f'?page={page_number}' if page_number > 1 else '')
        path = cache / ('rarity-onlyone-mf.html' if page_number == 1 else 'rarity-onlyone-mf-2.html')
        raw, source = download(url, path)
        sources.append(source)
        page = raw.decode()
        for match in re.finditer(r'<span class="goods_name">([^<]*)</span>', page):
            model_match = re.search(r'model_number_value">([^<]*)<', page[match.end():match.end()+500])
            if not model_match or not model_match[1].startswith('MF_'):
                continue
            model, title = model_match[1], html.unescape(match[1])
            parsed = re.fullmatch(r'(.*?)【(レアリティなし|AR|SAR)】(?:【[^】]*】)?', title)
            assert parsed, title
            native_name, literal = parsed.groups()
            if model in energy:
                number, expected_ja, expected_en = energy[model]
                assert norm(native_name) == norm(expected_ja)
                row = selected[('MF', number)]
                assert row['name'].startswith(expected_en + ' (')
                method = 'named-fixed-set-energy'
            else:
                number = model.removeprefix('MF_') + '/040'
                row = selected[('MF', number)]
                if row['status'] != 'unknown':
                    continue
                assert norm(native_name) == norm(japanese_name(row)), (number, native_name, japanese_name(row))
                method = 'exact-set-local-number-native-name'
            ref = {'provider': 'Toreca Market OnlyOne', 'url': item_url(page, match.start()),
                   'listSourceUrl': url, 'literal': literal, 'sourceSetCode': 'MF',
                   'sourceNumber': model.removeprefix('MF_'), 'sourceNameJa': native_name,
                   'productCode': model, 'productTitle': title, 'sourceSha256': source['sha256'],
                   'semantics': 'explicit-retailer-no-printed-rarity-category' if literal == 'レアリティなし' else 'explicit-retailer-rarity-category',
                   'identity': {'exactSet': True, 'exactNativeName': True,
                                'catalogueNumberIsOrdinal': model in energy,
                                'physicalPrintedNumberClaimed': model not in energy}}
            entry = record(row, [ref], 'None' if literal == 'レアリティなし' else literal,
                           method, catalogueNumberIsOrdinal=model in energy,
                           physicalPrintedRaritySymbolClaimed=False)
            if literal == 'AR':
                entry['proposedState'] = 'reference-candidate'
                entry['applyAutomatically'] = False
                entry['holdReason'] = ('Retailer AR may classify art finish rather than printed rarity. '
                                       'MF042 indexed Toreca Price classifies レアリティなし; '
                                       'both MF041/042 need taxonomy and printed-symbol verification.')
            output.append(entry)
    assert sum(row['setCode'] == 'MF' for row in output) == 47

    ditto_url = 'https://tcgkakaku.e-starbox.com/pc/card?no=053/071/S10B/B'
    raw, source = download(ditto_url, cache / 'rarity-estar-ditto.html')
    sources.append(source)
    ditto_html = raw.decode('utf-8')
    ditto_text = html.unescape(re.sub(r'<[^>]+>', '', ditto_html))
    assert '053/071R(レア)レア仕様' in norm(ditto_text) and 'メタモン' in ditto_text
    output.append(record(selected[('S10b', '053/071')], [{
        'provider': 'e-Starbox / NextOne', 'url': ditto_url,
        'literal': 'R(レア)', 'rawLabel': '053/071 R(レア)レア仕様',
        'sourceSetCode': 'S10B', 'sourceNumber': '053/071', 'sourceNameJa': 'メタモン',
        'finishQualifier': 'レア仕様', 'sourceSha256': source['sha256'],
        'semantics': 'explicit-provider-rarity-distinct-from-finish'}], 'R'))

    api_url = 'https://tcg.mik.moe/api/v3/card/product-detail'
    raw, source = download(api_url, cache / 'rarity-cn-mik-30thC.json', {'setId': '30thC'})
    sources.append(source)
    data = json.loads(raw)['data']
    assert data['setCode'] == '30thC' and len(data['cards']) == 176
    external = {card['cardIndex']: card for card in data['cards']}
    cn_output = []
    for original in cn:
        row = original['sourceFields']
        card = external[row['number']]
        assert card['rarity'] == '无标记'
        exact_name = norm(card['cardName']) == norm(row['name'])
        english_bridge = row['number'] == '149' and row['name'] == '叉字蝠（银河）' and card['cardName'] == '叉字蝠G' and row['nameEn'] == card['nameEn'] == 'Crobat G'
        assert exact_name or english_bridge
        ref = {'provider': 'Cryst’s Cards Database / 第零区观测站',
               'url': 'https://tcg.mik.moe/cards/30thC/' + card['cardIndex'],
               'listSourceUrl': 'https://tcg.mik.moe/cards/30thC',
               'retrievalUrl': api_url, 'method': 'POST', 'requestBody': source['requestBody'],
               'literal': card['rarity'], 'sourceSetCode': card['setCode'],
               'sourceNumber': card['cardIndex'], 'sourceName': card['cardName'],
               'sourceNameEn': card.get('nameEn'), 'sourceSha256': source['sha256'],
               'semantics': 'explicit-provider-no-symbol-category',
               'identity': {'exactSet': True, 'exactNumber': True,
                            'exactChineseName': exact_name, 'reviewedEnglishNameBridge': english_bridge},
               'limitation': 'Provider also calls known Pikachu Rare cards 无标记; known manufacturer grades always take priority.'}
        entry = record(row, [ref], variant=row['variant'], id=row['id'],
                       identity_method='exact-set-number-Chinese-name' if exact_name else 'exact-set-number-reviewed-Crobat-G-name-alias')
        if not exact_name:
            entry['proposedState'] = 'reference-candidate'
            entry['applyAutomatically'] = False
            entry['holdReason'] = 'Chinese native name differs; English-name bridge retained for review only.'
        cn_output.append(entry)
    assert len(cn_output) == 38
    all_rows = output + cn_output
    assert len({(row['language'], row['sourceUrl']) for row in all_rows}) == len(all_rows)
    assert sum(row['proposedState'] == 'reference-grade' for row in all_rows) == 1
    assert sum(row['proposedState'] == 'reference-unlisted' for row in all_rows) == 245
    assert sum(row['proposedState'] == 'reference-candidate' for row in all_rows) == 3
    return {'schemaVersion': 1, 'reviewId': 'rarity-resume-ja-cn-20261103',
            'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'scope': 'Previously unresolved exact Japanese S4a163, MF47, S10b1 and Chinese CN-30TH38 rows',
            'counts': {'inputRows': 249, 'referenceGrade': 1, 'referenceUnlisted': 245, 'heldCandidate': 3,
                       'japaneseReferenceGrade': 1, 'japaneseReferenceUnlisted': 208, 'japaneseHeldCandidate': 2,
                       'chineseReferenceUnlisted': 37, 'chineseHeldCandidate': 1},
            'policy': 'External classifications only; no raw rarity overwritten, no manufacturer no-grade assertion, no inferred C/U/R. Literal category labels retained. Known grades and variant/image/price identities must be preserved.',
            'sourceResponses': sources, 'rows': all_rows,
            'limitations': [
                'Retailer no-printed-rarity categories are external classifications, not manufacturer no-grade conclusions.',
                'MF041/042 retailer AR is held as candidate only; physical rarity symbol is not confirmed, an art-finish convention is possible, and MF042 has a conflicting indexed no-symbol classification.',
                'MF five energy catalogue No.045..049 are ordinals. Identity uses unique set-specific native energy names and fixed deck content, never invented printed numbers.',
                'CN149 is held because the native name differs even though set, number and English name Crobat G match.',
                'Cryst assigns 无标记 to some manufacturer-known Pikachu Rare cards, so only previously blank reviewed CN37 rows are eligible.'],
            'observedButNotAdoptedReferences': [
                {'url': 'https://tcgprice.jp/pokemon/link-10218364/', 'setCode': 'MF', 'number': '042/040',
                 'provider': 'Toreca Price', 'literal': 'レアリティなし', 'retrieval': 'search-index-only',
                 'reason': 'Site returned HTTP403 and search opening was restricted. Conflicting no-symbol taxonomy retained as a limitation, not a fetched per-card classification.'}],
            'remainingJapaneseTargets': [row for row in ja if row['status'] in ('unknown', 'candidate', 'conflict') and (row['setCode'], row['number']) not in {(entry['setCode'], entry['number']) for entry in output if entry['proposedState'] != 'reference-candidate'}],
            'blockedOrUnavailableSources': [
                {'url': 'https://pooka.app/ja/list/set/cards/ja-s4a/Shiny%20Star%20V', 'status': 403, 'notRetriedOrBypassed': True},
                {'url': 'https://tcgprice.jp/pokemon/series-9434320/', 'status': 403, 'notRetriedOrBypassed': True},
                {'url': 'https://www.c-labo-online.jp/product-group/3508', 'status': 404, 'notRetriedOrBypassed': True}]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--cache-dir', type=Path, default=Path('/tmp'))
    args = parser.parse_args()
    report = build(args.cache_dir)
    destination = SOURCES / 'rarity-resume-ja-cn-20261103.json'
    destination.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'file': str(destination), 'counts': report['counts'],
                      'remainingJapaneseTargets': len(report['remainingJapaneseTargets'])}))


if __name__ == '__main__':
    main()
