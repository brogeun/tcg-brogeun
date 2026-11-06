"""Read-only, resumable audit of all registered TCG Hub inventories and covers.

The source tree, network availability and official completeness are separate
claims. No price, artwork identity or completeness is inferred from a count.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import pathlib
import re
import subprocess
import urllib.parse


def save(path, value):
    path = pathlib.Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temp.replace(path)


class Audit:
    def __init__(self, root):
        self.root = pathlib.Path(root).resolve()
        self.cache = {}
        self.rows = []
        self.issues = []
        self.tracked = set(subprocess.check_output(
            ['git', '-C', str(self.root), 'ls-tree', '-r', '--name-only', 'HEAD'],
            text=True, encoding='utf-8').splitlines())
        self.commit = subprocess.check_output(['git', '-C', str(self.root), 'rev-parse', 'HEAD'], text=True).strip()

    def load(self, rel, default=None):
        rel = str(rel).lstrip('/')
        path = (self.root / rel).resolve()
        if self.root not in path.parents:
            raise ValueError('Path escapes source: ' + rel)
        if rel not in self.cache:
            if not path.is_file():
                return default
            self.cache[rel] = json.loads(path.read_text(encoding='utf-8-sig'))
        return self.cache[rel]

    def image(self, image):
        if not image:
            return 'missing'
        if str(image).startswith(('https://', 'http://')):
            return 'remote-needs-probe'
        rel = urllib.parse.unquote(str(image).split('?')[0]).lstrip('/')
        if rel in self.tracked:
            return 'source-present'
        return 'source-missing'

    def problem(self, row, kind, details, severity='error'):
        self.issues.append({'group': row['group'], 'id': row['id'], 'code': row.get('code'),
                            'kind': kind, 'severity': severity, 'details': details})

    def cards(self, rel):
        queue = [rel]
        visited = set()
        result = []
        while queue:
            name = queue.pop(0).lstrip('/')
            if name in visited:
                raise ValueError('Repeated inventory/shard path: ' + name)
            visited.add(name)
            doc = self.load(name)
            if not isinstance(doc, dict) or not isinstance(doc.get('cards'), list):
                raise ValueError('Missing/invalid inventory: ' + name)
            result.extend(doc['cards'])
            queue.extend(doc.get('shards') or [])
        return result, sorted(visited)

    def add(self, group, entry, cards, files, *, cover=None, declared=None, official=False):
        row = {'group': group, 'id': str(entry.get('id') or entry.get('code')),
               'code': entry.get('code'), 'name': entry.get('name'),
               'declaredCards': declared, 'cards': len(cards), 'inventoryFiles': files,
               'officialMembershipComplete': bool(official),
               'coverage': entry.get('coverage') or ('source-declared-complete' if entry.get('complete') else 'not-independently-confirmed'),
               'release': entry.get('officialReleaseDate') or entry.get('release') or entry.get('releasedAt'),
               'image': cover if cover is not None else entry.get('boxImage') or entry.get('image'),
               'priceProductId': str(entry.get('boxId') or entry.get('coverProductId') or ''),
               'sourceUrl': entry.get('officialSourceUrl') or entry.get('sourceUrl') or entry.get('url')}
        row['imageStatus'] = self.image(row['image'])
        row['cardImageStatus'] = dict(collections.Counter(self.image(c.get('localImage') or c.get('image') or c.get('thumbnailUrl')) for c in cards))
        row['numbersMissing'] = sum(not (c.get('number') or c.get('fullCardNumber') or c.get('printedNumber') or c.get('unprintedNumber') or c.get('numberNotApplicable')) for c in cards)
        row['catalogSources'] = dict(collections.Counter(c.get('catalogSource', 'catalogue') for c in cards))
        if declared is not None and declared != len(cards):
            self.problem(row, 'inventory-count-mismatch', {'declared': declared, 'actual': len(cards)})
        if not cards:
            future = str(row.get('release') or '')[:10].replace('.', '-') > '2026-11-06'
            unpublished = row['coverage'] in ['official-not-published', 'release-pending']
            self.problem(row, 'upcoming-unpublished' if future and unpublished else 'empty-inventory', row['coverage'], 'pending' if future and unpublished else 'error')
        if row['imageStatus'] in ['missing', 'source-missing']:
            self.problem(row, 'cover-' + row['imageStatus'], row['image'])
        if row['cardImageStatus'].get('missing') or row['cardImageStatus'].get('source-missing'):
            self.problem(row, 'card-artwork-source-missing', row['cardImageStatus'])
        identities = [str(c.get('id') or c.get('sourceId') or c.get('fullId') or c.get('sourceUrl') or c.get('url') or '') for c in cards]
        duplicates = {k: v for k, v in collections.Counter(identities).items() if k and v > 1}
        if duplicates:
            self.problem(row, 'duplicate-card-identity', duplicates)
        if not official:
            self.problem(row, 'official-completeness-unconfirmed', row['coverage'], 'review')
        self.rows.append(row)
        return row

    def run(self):
        # Registered legacy card-info tiles, including recent One Piece additions.
        script = r"const fs=require('fs'),vm=require('vm');const s=fs.readFileSync('index.html','utf8');const m=s.match(/const CARDINFO\s*=\s*([\s\S]*?\n});/);if(!m)throw Error('CARDINFO not found');const data=vm.runInNewContext('('+m[1]+')',{}, {timeout:1000});const art=require('./assets/japanese-set-artwork.js');for(const row of data.pokemon)row.image=art.image(row,row.image||'/images/sets/'+row.code+'.jpg');process.stdout.write(JSON.stringify(data));"
        legacy = json.loads(subprocess.check_output(['node', '-e', script], cwd=self.root, text=True, encoding='utf-8'))
        old_op = {s['code']: s for s in legacy.get('onepiece', [])}
        for entry in self.load('data/onepiece-official-manifest.json')['sets']:
            old = old_op.get(entry['code'])
            old_op[entry['code']] = {**entry, **(old or {}), 'image': old.get('image') if old else entry.get('image') or '/assets/onepiece-promo-cover.svg'}
        legacy['onepiece'] = list(old_op.values())
        jp = self.load('data/japanese-catalog.json')
        jp_by_code = {s['code']: s for s in jp['sets']}
        for brand in ['pokemon', 'onepiece']:
            sets = {s['code']: s for s in legacy.get(brand, [])}
            if brand == 'pokemon':
                for code, entry in jp_by_code.items():
                    sets[code] = {**entry, **sets.get(code, {})}
            else:
                for path in (self.root / 'data/cards-by-set').glob('*.json'):
                    if re.match(r'^(OP|EB|PRB|ST)\d+', path.stem):
                        sets.setdefault(path.stem, {'code': path.stem, 'name': path.stem})
            for code, entry in sets.items():
                rel = entry.get('sourceFile') or 'data/cards-by-set/' + entry.get('fileCode', code) + '.json'
                doc = self.load(rel, {})
                try:
                    cards, files = self.cards(rel)
                except ValueError as error:
                    cards, files = [], [rel]
                row = self.add(brand + '-ja', entry, cards, files,
                    declared=doc.get('cardCount', jp_by_code.get(code, {}).get('cardCount')),
                    cover=entry.get('image') or '/images/sets/' + code + '.jpg',
                    official=doc.get('officialComplete') is True)
                row['officialCards'] = doc.get('officialCardCount')
                row['reviewedSupplementCards'] = len([c for c in cards if c.get('inclusionSource') or c.get('membershipEvidence')])

        art = self.load('data/english-set-images.json', {}).get('sets', {})
        us = {s['code']: s for s in self.load('data/us-market.json', {}).get('sets', [])}
        for entry in self.load('data/english-catalog.json')['sets']:
            code = entry['code']
            rel = 'data/english-sets/' + code + '.json'
            doc = self.load(rel, {})
            try:
                cards, files = self.cards(rel)
            except ValueError:
                cards, files = [], [rel]
            covers = art.get(code, {}).get('sources', [])
            packaging = [c for c in covers if c.get('kind') not in ['logo', 'set-logo', 'symbol']]
            selected = (packaging or covers or [{}])[0]
            row = self.add('pokemon-en', entry, cards, files,
                cover=selected.get('image') or entry.get('image'), declared=entry.get('cardCount'), official=False)
            row['sourceDeclaredComplete'] = doc.get('complete')
            row['coverKind'] = selected.get('kind') or 'unclassified'
            row['sealedCoverSources'] = packaging
            row['marketPriceCoverage'] = us.get(code, {})
            if not packaging:
                self.problem(row, 'packaging-photo-unavailable', 'Only a logo/symbol or no sealed-product source', 'review')

        chinese = self.load('data/chinese-market.json', {})
        for entry in self.load('data/chinese-catalog.json')['sets']:
            rel = 'data/chinese-sets/' + entry['code'] + '.json'
            try:
                cards, files = self.cards(rel)
            except ValueError:
                cards, files = [], [rel]
            row = self.add('pokemon-zh', entry, cards, files, declared=entry.get('cardCount'))
            row['marketPriceCoverage'] = chinese.get('sets', {}).get(entry['code'], {})
            row['boxPriceSource'] = chinese.get('boxes', {}).get(entry['code'])

        for group in ['chiikawa', 'riftbound']:
            for entry in self.load('data/' + group + '-catalog.json')['sets']:
                self.add(group, entry, entry.get('cards', []), ['data/' + group + '-catalog.json'], declared=entry.get('cardCount'))

        catalog = self.load('data/tcg-card-info.json')
        for game in catalog['games']:
            by_id = {s['id']: s for s in game['sets']}
            loaded = {}
            for entry in game['sets']:
                try:
                    cards, files = self.cards(entry['file'])
                    loaded[entry['id']] = (cards, files)
                    if len(cards) != entry['cardCount']:
                        self.issues.append({'group': game['id'], 'id': entry['id'], 'code': entry.get('code'), 'kind': 'source-set-count-mismatch', 'severity': 'error', 'details': {'expected': entry['cardCount'], 'actual': len(cards)}})
                except ValueError as error:
                    self.issues.append({'group': game['id'], 'id': entry['id'], 'kind': 'source-set-missing', 'severity': 'error', 'details': str(error)})
            for box in game.get('boxes', []):
                main, related, files = {}, {}, set()
                supplements = set(str(x) for x in box.get('marketCardIds', []))
                related_sets = set(box.get('relatedSetIds', []))
                member_ids = dict.fromkeys(box.get('setIds', []) + box.get('marketSetIds', []) + box.get('relatedSetIds', []))
                problems = []
                for identity in member_ids:
                    if identity not in loaded or by_id.get(identity, {}).get('sourceGame') != box['sourceGame']:
                        problems.append(identity)
                        continue
                    cards, paths = loaded[identity]
                    files.update(paths)
                    for card in cards:
                        if card.get('game') != box['sourceGame']:
                            problems.append(str(card.get('id')))
                        if (box.get('officialCatalogueComplete') or box.get('officialMembershipComplete')) and card.get('catalogSource') == 'SNKRDUNK' and str(card.get('id')) not in supplements:
                            continue
                        (related if identity in related_sets else main)[str(card.get('id'))] = card
                row = self.add(game['id'], box, list(main.values()), sorted(files), declared=box.get('cardCount'), official=box.get('officialCatalogueComplete') or box.get('officialMembershipComplete'))
                row['relatedCards'] = len(related)
                row['officialCards'] = box.get('officialCardCount')
                row['marketSupplementCards'] = box.get('marketSupplementCount', 0)
                row['priceProductId'] = box['id'].removeprefix('BOX:')
                if problems:
                    self.problem(row, 'broken-box-membership', problems)

        # Preserve separate marketplace product identities instead of merging editions.
        markets = {}
        market_by_code = {}
        all_cards = self.load('data/all-cards.json', {})
        details = all_cards.get('details', [])
        for product in details:
            if product.get('kind') == 'box':
                markets[str(product['id'])] = product
        for brand in ['pokemon', 'onepiece', 'weiss_schwarz', 'union_arena', 'dragon_ball_fusion_world', 'yugioh', 'digimon']:
            for rel in ['data/price-' + brand + '-box.json', 'data/manual-boxes-' + brand + '.json', 'data/snkrdunk-games/' + brand + '-box.json']:
                for product in self.load(rel, {}).get('products', []):
                    key = str(product['id'])
                    markets[key] = {**markets.get(key, {}), **{k: v for k, v in product.items() if v is not None}}
                    if product.get('code'):
                        market_by_code[(brand, product['code'])] = key
        for row in self.rows:
            brand = {'pokemon-ja': 'pokemon', 'onepiece-ja': 'onepiece'}.get(row['group'])
            key = row['priceProductId'] or market_by_code.get((brand, row['code']), '')
            row['priceProductId'] = key
            product = markets.get(key)
            if product is None:
                row['boxPriceStatus'] = 'unlinked-market-product' if row['group'] not in ['pokemon-en', 'pokemon-zh'] else 'separate-provider-see-coverage'
            else:
                amounts = {k: product.get(k) for k in ['minPrice', 'lastPrice', 'price'] if isinstance(product.get(k), (int, float)) and product[k] > 0}
                row['boxPriceStatus'] = 'snapshot-quote' if amounts else ('source-confirms-no-listings' if product.get('priceStatus') == 'no-listings' else 'linked-no-snapshot-quote')
                row['boxQuote'] = {'amounts': amounts, 'currency': product.get('currency'), 'kind': product.get('priceKind'), 'observedAt': product.get('priceCheckedAt') or product.get('fetchedAt'), 'url': product.get('url')}
            if row['boxPriceStatus'] in ['unlinked-market-product', 'linked-no-snapshot-quote']:
                self.problem(row, 'box-price-' + row['boxPriceStatus'], {'productId': key}, 'review')
        return {'schemaVersion': 1, 'sourceCommit': self.commit, 'observedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
                'method': 'All registered catalogues, every linked inventory shard, exact production box-member selection; no live-price or official-completeness claim from counts.',
                'rows': self.rows, 'issues': self.issues, 'summary': self.summary(),
                'limits': ['Official membership flags are audited source declarations, not a fresh manufacturer scrape.',
                           'Images with source-present still require production HTTP decoding.',
                           'Snapshot prices are not guaranteed current quotes.',
                           'NIKKE is a view over Weiss Schwarz and must not be added to unique-game totals.']}

    def summary(self):
        out = {}
        for group in dict.fromkeys(r['group'] for r in self.rows):
            rows = [r for r in self.rows if r['group'] == group]
            issues = [i for i in self.issues if i['group'] == group]
            out[group] = {'products': len(rows), 'cardMemberships': sum(r['cards'] for r in rows),
                          'empty': sum(not r['cards'] for r in rows),
                          'coverStatus': dict(collections.Counter(r['imageStatus'] for r in rows)),
                          'priceStatus': dict(collections.Counter(r['boxPriceStatus'] for r in rows)),
                          'issues': dict(collections.Counter(i['kind'] for i in issues))}
        return out


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    audit = Audit(args.root)
    report = audit.run()
    save(args.output, report)
    print(json.dumps({'sourceCommit': report['sourceCommit'], 'summary': report['summary'], 'issues': dict(collections.Counter(i['severity'] for i in report['issues']))}))
