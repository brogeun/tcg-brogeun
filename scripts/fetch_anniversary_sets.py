"""Read the two requested TCG Collector sets; emit an apply_patch data update.

Usage: python scripts/fetch_anniversary_sets.py --patch
No files are written and no prices are inferred. Unnumbered energies retain
the source's display ordinal, but never use it as a printed market number.
"""
import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin

import requests
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parents[1]
SETS = {
    'M6a': ('30주년 셀레브레이션', 'https://www.tcgcollector.com/sets/11823/30th-celebration', 176),
    'MF': ('30주년 프리미엄 덱 세트 에브이·블래키', 'https://www.tcgcollector.com/sets/11822/30th-celebration-premium-deck-set-espeon-and-umbreon', 49),
}


def parse_set(html, code, name, url, minimum):
    soup = BeautifulSoup(html, 'html.parser')
    cards, ids = [], set()
    for item in soup.select('.card-image-grid-item'):
        link = item.select_one('a.card-image-grid-item-link')
        img = item.select_one('img.card-image-grid-item-image')
        number = item.select_one('.card-image-grid-item-info-overlay-number')
        cid = item.get('data-card-id')
        if not cid or cid in ids or not link or not img or not number:
            raise ValueError(f'{code}: duplicate or incomplete source card')
        ids.add(cid)
        label = number.get_text(strip=True)
        image = img.get('src', '')
        missing = 'default-card-image' in image or not image
        rarity = item.select_one('img.card-rarity-symbol')
        cards.append({
            'sourceId': cid, 'number': label, 'name': img.get('alt') or link.get('title') or label,
            'image': '' if missing else image,
            'imageStatus': 'pending' if missing else 'available',
            'unprintedNumber': label.startswith('No.'),
            'rarity': rarity.get('alt', '') if rarity else '',
            'url': urljoin(url, link['href']),
        })
    if len(cards) < minimum:
        raise ValueError(f'{code}: only {len(cards)} cards; expected at least {minimum}; refusing partial data')
    return {'code': code, 'name': name, 'brand': 'pokemon', 'source': 'tcgcollector.com',
            'sourceUrl': url, 'fetchedAt': datetime.now(timezone.utc).isoformat(),
            'cardCount': len(cards), 'pendingImageCount': sum(c['imageStatus']=='pending' for c in cards),
            'cards': cards}


def fetch_sets():
    result = {}
    with requests.Session() as session:
        for code, (name, url, minimum) in SETS.items():
            response = session.get(url, params={'setCardCountMode':'anyCardVariant', 'displayAs':'images', 'pageSize':300}, timeout=30)
            response.raise_for_status()
            result[code] = parse_set(response.text, code, name, url, minimum)
    return result


def make_patch(data, root=ROOT):
    lines = ['*** Begin Patch']
    for code, payload in data.items():
        relative = f'data/cards-by-set/{code}.json'
        path = root / relative
        content = json.dumps(payload, ensure_ascii=False, indent=2)
        if path.exists():
            lines += [f'*** Update File: {relative}', '@@']
            lines += ['-'+line for line in path.read_text(encoding='utf-8').splitlines()]
        else:
            lines += [f'*** Add File: {relative}']
        lines += ['+'+line for line in content.splitlines()]
    return '\n'.join(lines+['*** End Patch'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--patch', action='store_true')
    args = parser.parse_args()
    data = fetch_sets()
    print(make_patch(data) if args.patch else json.dumps({k:{'cards':v['cardCount'], 'pendingImages':v['pendingImageCount']} for k,v in data.items()}, ensure_ascii=False))
