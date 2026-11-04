"""Recover explicit source rarities for exact, numberless vintage inventories.

Read-only source pages are cached one set at a time. No printed number, price,
artwork, market product or existing card inventory is changed. A denied source
stops the collection; already cached set pages remain available for resumption.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import hashlib
from html.parser import HTMLParser
import json
import os
from pathlib import Path
import re
import tempfile
import time
import urllib.parse
import urllib.request


PAGES = {
    'Neo1': 'https://www.tcgcollector.com/sets/11290/gold-silver-to-a-new-world',
    'Neo2': 'https://www.tcgcollector.com/sets/11266/crossing-the-ruins',
    'Neo3': 'https://www.tcgcollector.com/sets/11173/awakening-legends',
    'Neo4': 'https://www.tcgcollector.com/sets/11252/darkness-and-to-light',

}
DEFAULT_CODES = ('Neo1', 'Neo2', 'Neo3', 'Neo4')
INDEX = 'data/collections/sources/pokemon-jp-rarity-metadata.json'
SHARD = 'data/collections/sources/pokemon-rarity-recheck/part-7100.json'
VERSION = '20261104-vintage1'
MAX_PAGE_BYTES = 4_000_000
VOID = set('area base br col embed hr img input link meta param source track wbr'.split())
GRADE = {'Common': 'C', 'Uncommon': 'U', 'Rare': 'R'}


class Element:
    def __init__(self, tag, attrs=()):
        self.tag, self.attrs, self.children = tag, dict(attrs), []

    def has_class(self, name):
        return name in self.attrs.get('class', '').split()

    def walk(self):
        yield self
        for child in self.children:
            if isinstance(child, Element):
                yield from child.walk()

    def text(self):
        return ''.join(child.text() if isinstance(child, Element) else child for child in self.children)


class Document(HTMLParser):
    def __init__(self, body):
        super().__init__(convert_charrefs=True)
        self.root = Element('document')
        self.stack = [self.root]
        self.feed(body)
        self.close()

    def handle_starttag(self, tag, attrs):
        node = Element(tag, attrs)
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_startendtag(self, tag, attrs):
        self.stack[-1].children.append(Element(tag, attrs))

    def handle_endtag(self, tag):
        for index in range(len(self.stack) - 1, 0, -1):
            if self.stack[index].tag == tag:
                del self.stack[index:]
                break

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def normalize(value):
    return re.sub(r'\s+', ' ', value).strip()


def one(values, description):
    if len(values) != 1:
        raise ValueError('Expected one exact ' + description)
    return values[0]


def parse_rows(body):
    """Use only explicit named source cells, never row position or price text."""
    root = Document(body).root
    rows = {}
    for row in (node for node in root.walk() if node.has_class('card-list-item')):
        members = list(row.walk())
        anchor = one([node for node in members if node.tag == 'a' and node.has_class('card-list-item-name-entry')], 'card source anchor')
        url = urllib.parse.urljoin('https://www.tcgcollector.com', anchor.attrs.get('href', ''))
        parsed = urllib.parse.urlsplit(url)
        ident = re.fullmatch(r'/cards/([0-9]+)/[a-z0-9-]+', parsed.path)
        if (parsed.scheme != 'https' or parsed.hostname != 'www.tcgcollector.com' or parsed.query or parsed.fragment
                or not ident or row.attrs.get('data-card-id') != ident[1]):
            raise ValueError('Source row card ID or original URL changed')
        name = normalize(anchor.attrs.get('title', ''))
        if not name:
            raise ValueError('Source row has no exact full card title')
        cell = one([node for node in members if node.has_class('card-list-item-rarity-entry')], 'rarity cell')
        symbols = [node for node in cell.walk() if node.tag == 'img' and node.has_class('card-rarity-symbol')]
        labels = set()
        for symbol in symbols:
            values = {normalize(symbol.attrs[key]) for key in ('alt', 'title') if symbol.attrs.get(key)}
            if len(values) != 1:
                raise ValueError('Rarity image alt/title disagree')
            labels.update(values)
        literal = one(list(labels), 'explicit rarity label') if symbols else normalize(cell.text())
        if not literal or literal in ('-', '—'):
            raise ValueError('Source rarity is blank; no grade may be invented')
        number = one([node for node in members if node.has_class('card-list-item-number-entry')], 'source list ordinal')
        if url in rows:
            raise ValueError('Source repeats an exact card URL')
        rows[url] = {'name': name, 'rarityOriginal': literal, 'sourceListNumber': normalize(number.text()),
                     'sourceId': ident[1]}
    if not rows:
        raise ValueError('Source list contains no exact card rows')
    return rows


def set_overlay(code, cards, body, observed_at):
    source = parse_rows(body.decode('utf-8'))
    targets = {}
    for card in cards:
        url = card.get('url') or card.get('sourceUrl')
        if not url or url in targets:
            raise ValueError('Inventory source URL is missing or duplicated')
        targets[url] = card
    if set(source) != set(targets):
        raise ValueError('Source list does not contain exactly the current inventory: ' + code)
    entries = {}
    for url, card in targets.items():
        row = source[url]
        if row['name'] != normalize(card.get('name', '')):
            raise ValueError('Source full title no longer matches the exact inventory: ' + code + '/' + row['sourceId'])
        literal = row['rarityOriginal']
        entries[url] = {'name': card['name'], 'number': card.get('number', ''),
                        'rarity': GRADE.get(literal, literal), 'rarityOriginal': literal,
                        'rarityStatus': 'source-explicit', 'sourceListNumber': row['sourceListNumber']}
    return {'schemaVersion': 1, 'version': VERSION, 'brand': 'pokemon', 'language': 'ja',
            'setCode': code, 'publisherOfficial': False, 'compactIdentity': True,
            'observedAt': observed_at, 'sourceSetUrl': PAGES[code],
            'sourceHtmlSha256': hashlib.sha256(body).hexdigest(),
            'source': 'Exact TCG Collector list-mode rarity cell image alt/title; original source URL and full card title match. Source list ordinals are evidence only and never become printed card numbers.',
            'cards': entries}


def atomic_write(path, body):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.rarity-', delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(body)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def source_body(root, code, fetch=False):
    path = root / '.cache/vintage-rarity-source' / (code + '.html')
    if path.is_file():
        if not 0 < path.stat().st_size <= MAX_PAGE_BYTES:
            raise ValueError('Cached source page is oversized or empty')
        return path.read_bytes()
    if not fetch:
        raise ValueError('Missing cached source page: ' + code)
    url = PAGES[code] + '?displayAs=list&pageSize=120'
    request = urllib.request.Request(url, headers={'User-Agent': 'TCGHUB exact source rarity review/1.0'})
    # No denial retry, alternate origin, identity header or authentication.
    with urllib.request.urlopen(request, timeout=30) as response:
        final = urllib.parse.urlsplit(response.url)
        expected = urllib.parse.urlsplit(PAGES[code])
        if final.scheme != 'https' or final.hostname != expected.hostname or final.path != expected.path:
            raise ValueError('Source set redirected away from its exact identity')
        if not response.headers.get('Content-Type', '').lower().startswith('text/html'):
            raise ValueError('Source did not return an HTML card list')
        body = response.read(MAX_PAGE_BYTES + 1)
    if not 0 < len(body) <= MAX_PAGE_BYTES:
        raise ValueError('Source page is oversized or empty')
    # Parse before checkpointing: a generic block/login/error page is not data.
    parse_rows(body.decode('utf-8'))
    atomic_write(path, body)
    return body


def collect(root, codes=DEFAULT_CODES, fetch=False):
    root = Path(root).resolve()
    index_path = root / INDEX
    original_index = index_path.read_bytes()
    index = json.loads(original_index)
    if index.get('schemaVersion') != 1 or index.get('brand') != 'pokemon' or index.get('language') != 'ja':
        raise ValueError('Unexpected current rarity metadata index')
    shard_path = root / SHARD
    shard = json.loads(shard_path.read_bytes()) if shard_path.exists() else {'schemaVersion': 1, 'bundleVersion': 1, 'cards': {}, 'sets': {}}
    observed_at = datetime.now(timezone.utc).isoformat()
    prepared = {}
    for code in codes:
        if code not in PAGES:
            raise ValueError('Unsupported exact vintage set')
        path = root / 'data/cards-by-set' / (code + '.json')
        inventory = json.loads(path.read_bytes())
        if inventory.get('code') != code or inventory.get('brand') != 'pokemon':
            raise ValueError('Unexpected current inventory header')
        body = source_body(root, code, fetch)
        prepared[code.upper()] = set_overlay(code, inventory['cards'], body, observed_at)
        print(json.dumps({'set': code, 'explicitSourceRarities': len(prepared[code.upper()]['cards'])}), flush=True)
        if fetch:
            time.sleep(0.5)
    url = '/' + SHARD + '?v=' + VERSION
    for code, overlay in prepared.items():
        current = index.setdefault('setShards', {}).get(code)
        if current is not None and current != url:
            raise ValueError('An independent rarity shard already covers this set: ' + code)
        shard['sets'][code] = overlay
        index['setShards'][code] = url
    index.setdefault('coverage', {})['numberlessVintageSourceRecheck'] = {
        'sets': len(shard['sets']), 'cards': sum(len(row['cards']) for row in shard['sets'].values()),
        'policy': 'Exact original source URLs/full titles and explicit source rarity only; existing blank printed numbers, card inventories, artwork and market bindings preserved.'}
    if index_path.read_bytes() != original_index:
        raise ValueError('Rarity metadata index changed during collection')
    atomic_write(shard_path, (json.dumps(shard, ensure_ascii=False, indent=2) + '\n').encode('utf-8'))
    # The shared index is stored compactly; retain that form to avoid unrelated
    # formatting churn while adding only this exact set-pointer/coverage patch.
    atomic_write(index_path, (json.dumps(index, ensure_ascii=False, separators=(',', ':')) + '\n').encode('utf-8'))
    return {'sets': len(prepared), 'cards': sum(len(value['cards']) for value in prepared.values()), 'shard': SHARD}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--codes', nargs='+', choices=sorted(PAGES), default=DEFAULT_CODES)
    parser.add_argument('--fetch', action='store_true', help='Fetch missing exact source set pages once; denied sources are not retried')
    args = parser.parse_args()
    print(json.dumps(collect(args.root, args.codes, args.fetch)))
