"""Stage exact-source vintage rarity evidence without changing the worktree."""
from datetime import datetime, timezone
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

import collect_vintage_rarity as parser
import materialize_vintage_pokemon_release as materializer

CODES = ('CL1', 'CL2', 'CL3', 'CL4', 'Gym1', 'Gym2', 'DP2', 'DP3', 'DP4-Bd', 'DP5', 'DP6', 'Pt1', 'Pt2', 'Pt3', 'Pt4')
VERSION = '20261104-vintage2'
GRADE = {'Common': 'C', 'Uncommon': 'U', 'Rare': 'R'}


def source_rows(body):
    rows = {}
    for row in parser.Document(body.decode('utf-8')).root.walk():
        if not row.has_class('card-list-item'):
            continue
        children = list(row.walk())
        anchor = parser.one([x for x in children if x.tag == 'a' and x.has_class('card-list-item-name-entry')], 'card anchor')
        url = urllib.parse.urljoin('https://www.tcgcollector.com', anchor.attrs.get('href', ''))
        address = urllib.parse.urlsplit(url)
        match = re.fullmatch(r'/cards/([0-9]+)/[a-z0-9-]+', address.path)
        if (address.scheme != 'https' or address.hostname != 'www.tcgcollector.com' or address.query or address.fragment
                or address.username or address.password or not match or row.attrs.get('data-card-id') != match[1]):
            raise ValueError('Source row identity is not an exact public card URL')
        if url in rows:
            raise ValueError('Duplicate source URL')
        title = parser.normalize(anchor.attrs.get('title', ''))
        if not title:
            raise ValueError('Missing full source title')
        cell = parser.one([x for x in children if x.has_class('card-list-item-rarity-entry')], 'rarity cell')
        symbols = [x for x in cell.walk() if x.tag == 'img' and x.has_class('card-rarity-symbol')]
        values = set()
        for image in symbols:
            labels = {parser.normalize(image.attrs[key]) for key in ('alt', 'title') if image.attrs.get(key)}
            if len(labels) != 1:
                raise ValueError('Conflicting explicit rarity alt/title')
            values.update(labels)
        literal = parser.one(list(values), 'rarity literal') if symbols else parser.normalize(cell.text())
        ordinal = parser.one([x for x in children if x.has_class('card-list-item-number-entry')], 'list number')
        rows[url] = {'name': title, 'sourceId': match[1], 'literal': literal, 'sourceListNumber': parser.normalize(ordinal.text())}
    if not rows:
        raise ValueError('No source rows')
    return rows


def fetch_page(code, base, stage):
    cache = stage / 'source-cache' / (code + '.html')
    url = base + '?displayAs=list&pageSize=300'
    if cache.exists():
        if not 0 < cache.stat().st_size <= parser.MAX_PAGE_BYTES:
            raise ValueError('Invalid source cache size')
        return cache.read_bytes(), json.loads(cache.with_suffix('.json').read_bytes())
    request = urllib.request.Request(url, headers={'User-Agent': 'TCGHUB exact source rarity review/1.0'})
    with urllib.request.urlopen(request, timeout=30) as response:
        final, expected = urllib.parse.urlsplit(response.url), urllib.parse.urlsplit(base)
        if final.scheme != 'https' or final.hostname != expected.hostname or final.path != expected.path:
            raise ValueError('Unreviewed source set redirect')
        if not response.headers.get('Content-Type', '').lower().startswith('text/html'):
            raise ValueError('Source page is not HTML')
        body = response.read(parser.MAX_PAGE_BYTES + 1)
        if not 0 < len(body) <= parser.MAX_PAGE_BYTES:
            raise ValueError('Source page oversized or empty')
    source_rows(body)
    info = {'sourceSetUrl': base, 'sourceRequestUrl': url, 'observedAt': datetime.now(timezone.utc).isoformat(),
            'sha256': hashlib.sha256(body).hexdigest()}
    parser.atomic_write(cache, body)
    parser.atomic_write(cache.with_suffix('.json'), (json.dumps(info, indent=2) + '\n').encode())
    return body, info


def stage_set(code, inventory, review_rows, rows, info):
    entries, held, skipped = {}, [], []
    matched_urls = set()
    aliases = 0
    for card in inventory['cards']:
        original = card.get('url') or card.get('sourceUrl')
        proof = review_rows.get((code, original))
        if not proof or card.get('image') != proof['originalImage'] or card.get('localImage') != proof['localImage'] or card.get('name') != proof['sourceName']:
            held.append({'sourceUrl': original, 'reason': 'current-inventory-does-not-match-committed-image-review'})
            continue
        current_url = proof.get('canonicalSourceUrl') or original
        current_name = proof.get('sourceCurrentName') or proof['sourceName']
        if card.get('currentSourceUrl') != current_url:
            held.append({'sourceUrl': original, 'reason': 'current-source-url-differs-from-committed-proof'})
            continue
        row = rows.get(current_url)
        if not row or row['name'] != parser.normalize(current_name):
            held.append({'sourceUrl': original, 'currentSourceUrl': current_url, 'reason': 'source-url-or-full-title-mismatch'})
            continue
        matched_urls.add(current_url)
        if card.get('rarity'):
            skipped.append({'sourceUrl': original, 'rarity': card['rarity'], 'reason': 'existing-explicit-grade-preserved'})
            continue
        literal = row['literal']
        if literal in ('', '-', '—', 'None', 'Unknown', 'No rarity'):
            held.append({'sourceUrl': original, 'reason': 'source-rarity-blank-or-unlisted', 'rarityStatus': 'unknown-source-blank', 'sourceLiteral': literal})
            continue
        alias = current_url != original or current_name != proof['sourceName']
        aliases += int(alias)
        entries[original] = {'name': card['name'], 'number': card.get('number', ''),
                             'rarity': GRADE.get(literal, literal), 'rarityOriginal': literal, 'rarityStatus': 'source-explicit',
                             'sourceListNumber': row['sourceListNumber'],
                             'verifiedCurrentSourceUrl': current_url, 'verifiedCurrentSourceName': row['name'],
                             'identityReview': {'file': 'config/pokemon-vintage-image-repairs.json.gz',
                                                'sourceId': proof['sourceId'], 'artworkSha256': proof['sha256'],
                                                'method': proof['method'], 'canonicalAliasUsed': alias}}
    member = {'schemaVersion': 1, 'version': VERSION, 'brand': 'pokemon', 'language': 'ja', 'setCode': code,
              'publisherOfficial': False, 'compactIdentity': True, 'observedAt': info['observedAt'],
              'sourceSetUrl': info['sourceSetUrl'], 'sourceHtmlSha256': info['sha256'],
              'source': 'Explicit current TCG Collector list rarity matched only to original card URL/title or the exact committed canonical alias in the verified vintage image review. Original printed-number fields and source card identities are preserved.',
              'cards': entries}
    report = {'code': code, 'inventoryCards': len(inventory['cards']), 'sourceRows': len(rows), 'verified': len(entries),
              'reviewedAliasesUsed': aliases, 'held': held, 'existingGradesPreserved': skipped,
              'sourceRowsOutsideStoredInventory': len(set(rows) - matched_urls)}
    return member, report


def collect(root, stage, codes=CODES):
    root = Path(root).resolve()
    stage = Path(stage).resolve()
    review = materializer.load_review(root)
    review_rows = {(x['setCode'], x['sourceUrl']): x for x in review['images']}
    registry = dict((code, url) for code, _, url in re.findall(r'\("([^"]+)", "([^"]+)", "(https://[^"]+)"\)', (root / 'scripts/fetch_set_cards.py').read_text()))
    bundle = {'schemaVersion': 1, 'bundleVersion': 1, 'cards': {}, 'sets': {}}
    report = {'reviewSHA256': hashlib.sha256((root / materializer.REVIEW).read_bytes()).hexdigest(), 'scope': list(codes), 'sets': [], 'stopped': False}
    for code in codes:
        try:
            inventory = json.loads((root / 'data/cards-by-set' / (code + '.json')).read_bytes())
            replacements = {x.get('sourceReplacementSet') for x in review['images'] if x['setCode'] == code and x.get('sourceReplacementSet')}
            if len(replacements) > 1:
                raise ValueError('More than one reviewed replacement set')
            base = next(iter(replacements)) if replacements else registry[code]
            body, info = fetch_page(code, base, stage)
            member, result = stage_set(code, inventory, review_rows, source_rows(body), info)
            bundle['sets'][code.upper()] = member
            report['sets'].append(result)
        except Exception as error:
            result = {'code': code, 'failed': True, 'errorType': type(error).__name__, 'httpStatus': getattr(error, 'code', None), 'reason': str(error)}
            report['sets'].append(result)
            if isinstance(error, urllib.error.HTTPError) and error.code in (403, 429):
                report['stopped'] = True
                break
        finally:
            parser.atomic_write(stage / 'part-7101.json', (json.dumps(bundle, ensure_ascii=False, indent=2) + '\n').encode())
            parser.atomic_write(stage / 'report.json', (json.dumps(report, ensure_ascii=False, indent=2) + '\n').encode())
        print(json.dumps({k:v for k,v in result.items() if k not in ('held', 'existingGradesPreserved')}), flush=True)
        time.sleep(0.5)
    summary = {'sets': len(bundle['sets']), 'verified': sum(len(x['cards']) for x in bundle['sets'].values()), 'stopped': report['stopped']}
    print(json.dumps(summary), flush=True)
    return summary


if __name__ == '__main__':
    arguments = argparse.ArgumentParser(description=__doc__)
    arguments.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    arguments.add_argument('--output-dir', type=Path)
    arguments.add_argument('--codes', nargs='+', choices=CODES, default=CODES)
    args = arguments.parse_args()
    collect(args.root, args.output_dir or args.root / '.cache/vintage-rarity-additional', args.codes)
