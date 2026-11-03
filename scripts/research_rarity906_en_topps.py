#!/usr/bin/env python3
"""Replay bounded EN other/Topps rarity review from captured public source fields.

This script never edits raw sets, prices, images or existing rarity shards.
--capture is for the audited TinyFish extraction snapshots retained in /tmp.
Default replay needs only the committed evidence snapshot and original archives.
"""
import argparse
import gzip
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'data/collections/sources'
PREFIX = 'rarity906-en-topps-20261104'
REVIEW = PREFIX
ENERGIES = ['Grass', 'Fire', 'Water', 'Lightning', 'Psychic', 'Fighting', 'Darkness', 'Metal']
PWC_LANGS = ['English', 'Italian', 'Korean', 'Spanish', 'Japanese', 'German', 'French', 'Polish', 'Portuguese']
PWC_DEX_IDS = [1, 2, 3, 4, 5, 7, 8, 9, 10]
SPRITES = {
    'EN-TCG11819': ('images/pokemon-en-sheets/EN-TCG11819-000-1c3647cf74a041.webp', 'a44590d6a67472fe8fa0963dd38178703aec73c6ab78c0f704e0382b61c28b16'),
    'EN-TCG11676': ('images/pokemon-en-sheets/EN-TCG11676-000-e3813f79b10427.webp', 'e797023db64f0a0bcb7c53510730c933bdb67869d53e87c5816675ee62dd0c6f'),
    'EN-TCG11384': ('images/pokemon-en-sheets/EN-TCG11384-000-46fba30e5acde6.webp', '93a3dd259f7f948c4c640d682297bad5279f8dc008467043c5c4e1bb4e01a384'),
}


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write(name, obj):
    (OUT / (PREFIX + name + '.json')).write_text(json.dumps(obj, ensure_ascii=False, indent=2) + '\n')


def recover_extracted_json(text):
    """Undo only observed markdown punctuation escaping and quoted control chars."""
    text = re.sub(r'\\([_*\[\]`])', r'\1', text)
    out, quoted, escape = [], False, False
    for char in text:
        if quoted and ord(char) < 32:
            out.append(json.dumps(char)[1:-1])
            continue
        out.append(char)
        if escape:
            escape = False
            continue
        if char == '\\':
            escape = True
            continue
        if char == '"':
            quoted = not quoted
    return json.loads(''.join(out))


def capture():
    docs, parsed = [], {}
    for name, count, expected_chars, group in [('groups', 220, 42989, None), ('pwc', 22, 22720, 2205), ('prize', 891, 1003135, 22880)]:
        text = Path('/tmp/rarity906-topps-' + name + '-extracted.txt').read_text()
        assert len(text) == expected_chars + 1  # apply_patch persisted one trailing LF
        text = text[:-1]
        obj = recover_extracted_json(text)
        assert obj['success'] and obj['totalItems'] == count and len(obj['results']) == count
        parsed[name] = obj
        docs.append({'id': name, 'url': 'https://tcgcsv.com/tcgplayer/3/' + (str(group) + '/products' if group else 'groups'), 'totalItems': count, 'extractedTextSha256': digest(text.encode()), 'extractedTextCharacters': len(text), 'hashScope': 'Exact TinyFish extracted text, before the two documented JSON syntax repairs; not raw HTTP bytes.'})
    products = [p for p in parsed['pwc']['results'] if 215153 <= p['productId'] <= 215163]
    products += [p for p in parsed['prize']['results'] if re.match(r'^(?:Basic )?(?:Grass|Fire|Water|Lightning|Psychic|Fighting|Darkness|Metal) Energy', p['name'])]
    dex = json.loads(Path('/tmp/rarity906-topps-dex-captured.json').read_text())
    for page in dex:
        page['extractedTextSha256'] = digest(page['text'].encode())
        page['rarityLiteral'] = 'No Rarity' if 'No Rarity' in page['description'] and ('RarityNo Rarity' in page['text'] or 'Rarity No Rarity' in page['text'] or page['url'].endswith('/eyg02-7')) else None
        assert page['rarityLiteral'] == 'No Rarity'
    snapshot = {'schemaVersion': 1, 'reviewId': REVIEW, 'capturedDate': '2026-11-04', 'retrievalMethod': 'TinyFish fetch_content of public JSON and original Dex card pages; no login, proxy or anti-detection configuration.', 'parserRepairs': ['Remove extraction-added backslashes before underscore/asterisk/brackets/backtick only.', 'Escape literal ASCII control characters inside JSON strings; values are not reclassified.'], 'sourceDocuments': docs, 'products': products, 'dexPages': dex, 'rejectedPwcProduct': {'productId': 215163, 'reason': 'Japanese Green alternate printing; original source sprite is blue Japanese artwork.'}, 'officialMembershipSources': [{'url': 'https://www.pokemon.com/static-assets/content-assets/cms2/pdf/trading-card-game/checklist/prize_pack_series_3_web_cardlist_en.pdf', 'scope': 'Series Three basic energies, standard and foil; no printed number stated.'}, {'url': 'https://www.pokemon.com/static-assets/content-assets/cms2/pdf/trading-card-game/checklist/prize_pack_series_4_web_cardlist_en.pdf', 'scope': 'Series Four SVE001-008, standard and foil.'}, {'url': 'https://www.pokemon.com/static-assets/content-assets/cms2/pdf/trading-card-game/checklist/prize_pack_series_5_web_cardlist_en.pdf', 'scope': 'Series Five SVE001-008, standard and foil.'}, {'url': 'https://d1wx537rtdixyy.cloudfront.net/expansions/series9/en-us/P12252_OP_Prize_Packs_Series9_Card_List_EN.pdf', 'scope': 'Series Nine MEE001-008, standard and foil.'}], 'toppsSourceReview': {'url': 'https://collectorita.com/sets/3992/MAIN', 'observedLiteral': 'Unknown', 'sourceSetName': 'Topps Pokémon TV Animation Series 1', 'sourceSetUnknownCards': 101, 'note': 'Different catalogue counts; this is an obstacle and taxonomy check, not an exact card rarity match. Unknown never becomes None.', 'capturedHtmlSha256': digest(Path('/tmp/rarity906_collectorita.html').read_bytes())}}
    write('-evidence', snapshot)


def ext(product, key):
    return next((p['value'] for p in product['extendedData'] if p['name'] == key), None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--capture', action='store_true')
    args = ap.parse_args()
    if args.capture:
        capture()
    evidence_path = OUT / (PREFIX + '-evidence.json')
    evidence = json.loads(evidence_path.read_text())
    products = evidence['products']
    dex = evidence['dexPages']
    originals, archives = [], []
    for p in sorted(OUT.glob('rarity-crossdb-20261101-en-*.json.gz')):
        originals += json.loads(gzip.decompress(p.read_bytes()))['rows']
        archives.append({'path': str(p.relative_to(ROOT)), 'sha256': digest(p.read_bytes())})
    targets = [r for r in originals if r['preferredReferenceStatus'] == 'not-resolved-by-references' and r['productType'] in ('other', 'topps_non_tcg')]
    assert len(targets) == 490
    sets, rows, held = {}, [], []
    for row in targets:
        set_code, name = row['setCode'], row['name']
        raw_set_path = ROOT / 'data/english-sets' / (set_code + '.json')
        raw_set = json.loads(raw_set_path.read_text())
        card = next(c for c in raw_set['cards'] if str(c['sourceId']) == str(row['sourceId']) and c['number'] == row['number'])
        assert card['name'] == name and card['language'] == row['language'] and not card['rarity']
        identity = {'catalogueSetCode': set_code, 'catalogueLanguage': 'en', 'catalogueSourceId': row['sourceId'], 'catalogueNumber': row['number'], 'catalogueSourceUrl': row['sourceUrl'], 'sourceSetJsonSha256': digest(raw_set_path.read_bytes()), 'sourceImageUrl': card.get('sourceImage'), 'physicalPrintingConfirmed': False}
        if set_code in SPRITES:
            identity.update({'reviewedSourceSprite': SPRITES[set_code][0], 'reviewedSourceSpriteSha256': SPRITES[set_code][1]})
        refs, alternatives, value, note = [], [], None, ''
        if set_code == 'EN-TCG11819':
            ordinal = int(re.search(r'(\d+)$', row['number'])[1])
            language = PWC_LANGS[ordinal - 1]
            product = next(p for p in products if p['productId'] == 215152 + ordinal)
            assert product['name'] == 'Pikachu (' + language + ')' and ext(product, 'Number') == 'PW ' + str(ordinal) and ext(product, 'Rarity') == 'Promo'
            page = next(p for p in dex if p['url'] == 'https://dextcg.com/cards/pwt-' + str(PWC_DEX_IDS[ordinal - 1]))
            value = 'Promo'
            identity.update({'physicalCardLanguage': language, 'catalogueNumberIsOrdinal': True, 'fullPrintedNumberMatchClaimed': False, 'referenceProductNumber': ext(product, 'Number'), 'identityMethod': '2010 World Collection, source sprite language and unique artwork, exact language-specific product; blue Japanese art excludes Green215163.'})
            refs = [product_ref(product, 'pwc', evidence)]
            alternatives = [dex_ref(page)]
            note = 'Exact TCGplayer product explicit Promo is preferred by deployed external-reference policy; Dex explicitly says No Rarity. Both classifications are retained. No printed Promo symbol or manufacturer grade is claimed.'
        elif set_code in ('EN-TCG11384', 'EN-TCG11676'):
            prefix = 'eyg02-' if set_code == 'EN-TCG11384' else 'tmb-'
            pages = [p for p in dex if p['url'].split('/')[-1].startswith(prefix) and p['title'].split(' - ')[0] == name]
            if len(pages) == 1:
                value = 'No Rarity'
                refs = [dex_ref(pages[0])]
                identity.update({'catalogueNumberIsOrdinal': True, 'fullPrintedNumberMatchClaimed': False, 'identityMethod': 'Exact named English special set and unique card name, original source sprite review; catalogue ordinal is not mapped as a printed card number.'})
                note = 'Dex original card record explicitly classifies No Rarity. This is an external classification; no manufacturer no-grade assertion. Dex catalogue order differs from the original catalogue.'
            else:
                held.append(hold(row, 'Six basic energy cards are absent from Dex Tropical Mega Battle set17. No transfer from Japanese VS or generic energy printing.', identity))
                continue
        elif 'Prize Pack Series' in row['catalogueSetName']:
            energy = next(e for e in ENERGIES if e + ' Energy' in name)
            series = {'One': 1, 'Two': 2, 'Three': 3, 'Four': 4, 'Five': 5, 'Six': 6, 'Seven': 7, 'Eight': 8, 'Nine': 9}[row['catalogueSetName'].split()[-1]]
            if series <= 3:
                expected = energy + ' Energy (Prize Pack Series ' + str(series) + ')' + (' (Cosmos Holo)' if series == 3 else '')
                chosen = [p for p in products if p['name'] == expected]
                identity.update({'catalogueNumberIsOrdinal': True, 'fullPrintedNumberMatchClaimed': False})
            else:
                mee = series >= 8
                number = row['number']
                expected = 'Basic ' + energy + ' Energy - ' + ('MEE ' if mee else '') + number
                chosen = [p for p in products if p['name'] in (expected, expected + ' (Cosmos Holo)')]
                assert len(chosen) == 2 and all(ext(p, 'Number') == number for p in chosen)
                assert ('Mega Evolution Energies' if mee else 'Scarlet & Violet Energies') in name
                identity.update({'fullPrintedNumberMatchClaimed': True, 'referenceExpansion': 'MEE' if mee else 'SVE'})
            assert chosen and all(p['groupId'] == 22880 for p in chosen)
            literals = {ext(p, 'Rarity') for p in chosen}
            refs = [product_ref(p, 'prize', evidence) for p in chosen]
            identity.update({'identityMethod': 'Original Prize Pack series membership plus exact stamped Prize Pack provider product, energy type and edition/number. Generic unstamped or WC products are excluded.', 'packProvenanceConfirmed': False, 'physicalFinishConfirmed': False, 'referenceProductFinish': 'Cosmos Holo only' if series == 3 else 'Provider product finish unspecified' if series <= 2 else 'Separate standard and Cosmos Holo products agree'})
            if literals != {'Common'}:
                held.append({**hold(row, 'Provider outlier: exact Series Three Cosmos Holo Lightning product537920 says Promo, while seven sibling energies say Common. Target finish is unspecified; held for independent review.', identity), 'candidateReferences': refs})
                continue
            value = 'Common'
            note = 'TCGplayer explicit Common for exact Prize Pack stamped energy product. For numbered reprints, both standard and Cosmos Holo product literals agree. Same stamped card appears in multiple series; physical pack provenance and finish are not asserted.'
        else:
            held.append(hold(row, 'No exact Topps card-level literal rarity or explicit no-rarity classification found. Collectorita lists Unknown; Pokemon TCGplayer group inventory has no matching Topps set. Non-game taxonomy and foil/title are not rarity evidence.', identity))
            continue
        assert value and refs
        status = 'reference-unlisted' if value == 'No Rarity' else 'reference-explicit'
        item = {'name': name, 'number': row['number'], 'rarity': '' if value == 'No Rarity' else value, 'rarityOriginal': '—', 'rarityStatus': status, 'rarityEvidence': {'schemaVersion': 1, 'kind': 'external-explicit', 'exactCardIdentity': True, 'physicalPrintingConfirmed': False, 'manufacturerNoGradeConfirmed': False, 'value': value, 'references': refs, 'otherReferences': alternatives, 'identity': identity, 'resolutionNote': note, 'reviewId': REVIEW}}
        sets.setdefault(set_code, {'schemaVersion': 1, 'brand': 'pokemon', 'language': 'en', 'setCode': set_code, 'compactIdentity': True, 'cards': {}})['cards'][row['sourceUrl']] = item
        rows.append({**{k: row[k] for k in ('setCode', 'sourceId', 'sourceUrl', 'name', 'number', 'language', 'catalogueSetName', 'productType')}, 'preferredReferenceValue': value, 'preferredReferenceStatus': status, 'refs': refs, 'otherReferences': alternatives, 'identity': identity, 'resolutionNote': note})
    assert len(rows) == 104 and len(held) == 386
    counts = dict(Counter(r['preferredReferenceValue'] for r in rows))
    assert counts == {'Common': 71, 'No Rarity': 24, 'Promo': 9}, counts
    write('-overlay', {'schemaVersion': 1, 'bundleVersion': 1, 'reviewId': REVIEW, 'cards': {}, 'sets': sets})
    write('-report', {'schemaVersion': 1, 'reviewId': REVIEW, 'scope': 490, 'adoptable': 104, 'countsByLiteral': counts, 'remaining': 386, 'remainingByReason': {'Topps unknown': 379, 'Tropical energy absent from exact source': 6, 'Prize SeriesThree Lightning metadata outlier': 1}, 'sourceEvidence': {'path': str(evidence_path.relative_to(ROOT)), 'sha256': digest(evidence_path.read_bytes())}, 'sourceArchives': archives, 'policy': 'Additive external reference overlay only. Raw rarity, prices, images and original identity stay unchanged. No blank-field, title, foil or non-game inference; no grade copied from generic unstamped/WC/Japanese editions.', 'rows': rows, 'held': held})
    print(json.dumps({'adoptable': len(rows), 'remaining': len(held), 'counts': counts}))


def product_ref(product, doc_id, evidence):
    doc = next(d for d in evidence['sourceDocuments'] if d['id'] == doc_id)
    return {'provider': 'TCGplayer (via TCGCSV products metadata)', 'url': product['url'], 'literal': ext(product, 'Rarity'), 'productId': product['productId'], 'sourceProductName': product['name'], 'sourceNumber': ext(product, 'Number'), 'sourceImageUrl': product['imageUrl'], 'groupId': product['groupId'], 'sourceModifiedOn': product['modifiedOn'], 'metadataUrl': doc['url'], 'metadataExtractedTextSha256': doc['extractedTextSha256']}


def dex_ref(page):
    return {'provider': 'Dex - for TCG Collectors', 'url': page['url'], 'literal': page['rarityLiteral'], 'sourceTitle': page['title'], 'sourceDescription': page['description'], 'sourceExtractedTextSha256': page['extractedTextSha256']}


def hold(row, reason, identity):
    return {**{k: row[k] for k in ('setCode', 'sourceId', 'sourceUrl', 'name', 'number', 'language', 'catalogueSetName', 'productType')}, 'reason': reason, 'identity': identity}


if __name__ == '__main__':
    main()
