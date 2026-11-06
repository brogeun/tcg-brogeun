"""Refresh registered sealed-product asks beyond the 30-item featured list.

Only exact existing product IDs or one unambiguous Japanese One Piece product
code may be linked. A completed category traversal is not a stock assertion
for an absent SKU. Every page is checkpointed before continuing.
"""
from __future__ import annotations

import argparse
import copy
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

from refresh_search_prices import PublicClient, RefreshError, fx_basis, listing_price


def atomic_json(path, value, pretty=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False,
        indent=2 if pretty else None, separators=None if pretty else (',', ':'), allow_nan=False) + '\n', encoding='utf-8')
    os.replace(temporary, path)


def canonical_onepiece_code(row):
    number = str(row.get('productNumber') or '').upper()
    match = re.fullmatch(r'(?:OPC-TCG-|OPTCG-)?(OP|EB|PRB|ST)-?(\d{2})', number)
    title = str(row.get('name') or '')
    if not match or not re.search(r'ONE\s*PIECE|ワンピース', title, re.I) or re.search(r'NO\s*SHRINK|NO\s*WRAP|CASE|BONUS\s*PACK|ENGLISH|\[EN\]|CHINESE|KOREAN|海外|英語|韓国|中国', title, re.I):
        return None
    if not re.search(r'\bBOX\b|\bDECK\b|ボックス|デッキ', title, re.I):
        return None
    return match[1] + match[2]


def collect(client, brand, checkpoint, max_pages=500, resume=False):
    state = {'brand': brand, 'nextPage': 1, 'complete': False, 'rows': {}, 'pages': 0}
    if resume and checkpoint.is_file():
        saved = json.loads(checkpoint.read_text(encoding='utf-8'))
        age = datetime.now(timezone.utc) - datetime.fromisoformat(saved['checkedAt'])
        if saved.get('brand') == brand and 0 <= age.total_seconds() <= 21600:
            state = saved
    if state['complete']:
        return state
    for page in range(state['nextPage'], state['nextPage'] + max_pages):
        payload = client.get_category(brand, 14, 'new', page, 100)
        rows = payload.get('tradingCards') if isinstance(payload, dict) else None
        if not isinstance(rows, list) or len(rows) > 100:
            raise RefreshError('Invalid sealed-product response')
        if page == 1 and not rows:
            raise RefreshError('Unexpected empty known-brand sealed catalogue')
        additions = {}
        for row in rows:
            if not isinstance(row, dict):
                raise RefreshError('Invalid sealed-product row')
            identity = str(row.get('id') or '')
            if not re.fullmatch(r'[1-9]\d{0,19}', identity) or not row.get('name'):
                raise RefreshError('Sealed product lacks identity')
            if row.get('brandId') not in (None, brand) or row.get('categoryId') not in (None, 14, '14'):
                raise RefreshError('Sealed product brand/category mismatch')
            additions[identity] = row
        if rows and not set(additions).difference(state['rows']):
            raise RefreshError('Repeated sealed-product page; previous snapshots retained')
        state['rows'].update(additions)
        state.update(nextPage=page + 1, pages=page, complete=not rows,
                     checkedAt=datetime.now(timezone.utc).isoformat())
        atomic_json(checkpoint, state)
        print(json.dumps({'brand': brand, 'page': page, 'products': len(state['rows']), 'complete': state['complete']}), flush=True)
        if state['complete']:
            return state
    raise RefreshError('Sealed-product page budget exhausted; resume from saved cursor')


def merge_manual(document, observed, basis, now, brand, official_codes=(), reviewed_links=()):
    result = copy.deepcopy(document)
    rows = result.setdefault('products', [])
    by_id = {}
    for row in rows:
        identity = str(row.get('id') or '')
        if not re.fullmatch(r'[1-9]\d{0,19}', identity) or identity in by_id:
            raise RefreshError('Duplicate/invalid registered box identity')
        by_id[identity] = row
    added = []
    for link in reviewed_links:
        if link.get('brand') != brand:
            continue
        identity, code = str(link.get('id') or ''), link.get('code')
        if identity in by_id or any(row.get('code') == code for row in rows):
            continue
        source = observed.get(identity)
        if (not source or link.get('language') != 'ja' or
                link.get('verification') != 'reviewed-product-code-title-release' or
                source.get('name') != link.get('sourceName') or
                source.get('productNumber') != link.get('sourceProductNumber') or
                source.get('releasedAt') != link.get('sourceRelease') or
                not re.search(r'\bBOX\b', source['name'], re.I)):
            raise RefreshError('Reviewed sealed-product evidence changed: ' + str(code))
        row = {'id': identity, 'code': code, 'name': source['name'], 'kind': 'box',
               'currency': 'USD', 'productNumber': source['productNumber'],
               'image': source.get('thumbnailUrl'), 'url': link['sourceUrl'],
               'identityEvidence': copy.deepcopy(link)}
        rows.append(row)
        by_id[identity] = row
        added.append({'code': code, 'id': identity})
    if brand == 'onepiece':
        existing_codes = {row.get('code') for row in rows}
        candidates = {}
        for identity, source in observed.items():
            code = canonical_onepiece_code(source)
            if code and identity not in by_id:
                candidates.setdefault(code, []).append(source)
        for code in official_codes:
            matches = candidates.get(code, [])
            if code in existing_codes or len(matches) != 1:
                continue
            source = matches[0]
            identity = str(source['id'])
            row = {'id': identity, 'name': source['name'], 'code': code,
                   'kind': 'box', 'currency': 'USD', 'productNumber': source.get('productNumber'),
                   'image': source.get('thumbnailUrl'), 'url': 'https://snkrdunk.com/en/trading-cards/' + identity,
                   'identityEvidence': {'method': 'unique-exact-japanese-product-code',
                       'productNumber': source['productNumber'], 'sourceName': source['name'],
                       'sourceCategory': 14, 'checkedAt': now}}
            rows.append(row)
            by_id[identity] = row
            added.append({'code': code, 'id': identity})
    counts = {'registered': len(rows), 'available': 0, 'no-listings': 0, 'price-unavailable': 0, 'not-observed': 0}
    for identity, row in by_id.items():
        source = observed.get(identity)
        if source is None:
            # No fabricated stock result or refreshed quote timestamp.
            counts['not-observed'] += 1
            continue
        price, original_currency = listing_price(source, basis)
        stock = source.get('listingCount')
        zero = stock in (0, '0')
        if price is not None and zero:
            raise RefreshError('Positive sealed-product ask with zero listings')
        status = 'available' if price is not None else 'no-listings' if zero else 'price-unavailable'
        row.update(lastPrice=price, currency='USD', priceStatus=status,
                   priceKind='listing-ask', priceCheckedAt=now,
                   priceSource={'type': 'lowest_listing_ask', 'condition': 'sealed',
                       'originalPrice': source.get('minPrice'), 'originalCurrency': original_currency,
                       'categoryId': 14, 'order': 'new', 'listingCount': stock})
        counts[status] += 1
    result.update(count=len(rows), boxQuoteRefresh={'checkedAt': now, 'counts': counts,
        'addedLinks': added, 'featuredListLimitApplies': False,
        'absencePolicy': 'An unobserved product retains its previous quote and observation date; absence is not zero stock.'})
    return result, counts, added


def run(root, checkpoint_dir, client=None, max_pages=500, resume=False):
    root, checkpoint_dir = Path(root), Path(checkpoint_dir)
    now = datetime.now(timezone.utc)
    basis = fx_basis(json.loads((root / 'data/fx-rates.json').read_bytes()), now)
    client = client or PublicClient(max_seconds=1200)
    states = {brand: collect(client, brand, checkpoint_dir / (brand + '.json'), max_pages, resume)
              for brand in ['pokemon', 'onepiece']}
    originals, documents, report = {}, {}, {}
    official_codes = [s['code'] for s in json.loads((root / 'data/onepiece-official-manifest.json').read_bytes())['sets']
                      if re.fullmatch(r'(OP|EB|PRB|ST)\d{2}', s['code'])]
    review_path = root / 'config/registered-box-market-links.json'
    reviewed_links = json.loads(review_path.read_bytes()).get('links', []) if review_path.is_file() else []
    for brand in ['pokemon', 'onepiece']:
        name = 'manual-boxes-' + brand + '.json'
        originals[name] = (root / 'data' / name).read_bytes()
        documents[name], counts, added = merge_manual(json.loads(originals[name]), states[brand]['rows'], basis, states[brand]['checkedAt'], brand, official_codes, reviewed_links)
        report[brand] = {'counts': counts, 'addedLinks': added, 'sourcePages': states[brand]['pages'], 'observedSourceProducts': len(states[brand]['rows'])}
    # Stage the exact original bytes for a recoverable rollback before promotion.
    stage = Path(tempfile.mkdtemp(prefix='registered-box-quotes-', dir=checkpoint_dir))
    for name, raw in originals.items():
        (stage / name).write_bytes(raw)
    replaced = []
    try:
        for name in documents:
            if (root / 'data' / name).read_bytes() != originals[name]:
                raise RefreshError('Registered boxes changed during collection: ' + name)
        for name, document in documents.items():
            if (root / 'data' / name).read_bytes() != originals[name]:
                raise RefreshError('Registered boxes changed before promotion: ' + name)
            atomic_json(root / 'data' / name, document, pretty=True)
            replaced.append(name)
    except Exception:
        for name in reversed(replaced):
            (root / 'data' / name).write_bytes(originals[name])
        raise
    receipt = {'source': 'SNKRDUNK public category-14', 'checkedAt': now.isoformat(),
               'brands': report, 'sourceTraversalComplete': True, 'snapshotPriceIsCompletedSale': False,
               'currencyNormalization': basis, 'previousSHA256': {name: hashlib.sha256(raw).hexdigest() for name, raw in originals.items()}}
    atomic_json(checkpoint_dir / 'receipt.json', receipt)
    print(json.dumps(receipt), flush=True)
    return receipt


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--checkpoint-dir', type=Path)
    parser.add_argument('--max-pages', type=int, default=500)
    parser.add_argument('--resume', action='store_true')
    args = parser.parse_args()
    if not 1 <= args.max_pages <= 2000:
        parser.error('max-pages must be 1..2000')
    run(args.root, args.checkpoint_dir or args.root / '.cache/registered-box-quotes', max_pages=args.max_pages, resume=args.resume)
