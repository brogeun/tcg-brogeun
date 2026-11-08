"""Keep independently reviewed artwork without changing marketplace identities."""
import argparse
import json
from functools import lru_cache
from pathlib import Path


@lru_cache(maxsize=8)
def load_bindings(root):
    path = Path(root) / 'config/reviewed-market-card-images.json'
    if not path.exists():
        return {}
    doc = json.loads(path.read_text(encoding='utf-8'))
    if doc.get('schemaVersion') != 1:
        raise ValueError('Invalid reviewed market artwork schema')
    result = {}
    for row in doc['bindings']:
        key = (row['game'], str(row['productId']))
        if key in result or not row['image'].startswith('https://'):
            raise ValueError('Invalid or duplicate reviewed artwork identity')
        if row['sourceUrl'] != 'https://snkrdunk.com/apparels/' + key[1]:
            raise ValueError('Reviewed artwork product URL disagrees with ID')
        if '[' + row['number'] + ']' not in row['name']:
            raise ValueError('Reviewed artwork printed number disagrees with name')
        result[key] = row
    for row in doc.get('setCovers', []):
        result[('set', row['setId'])] = row
    return result


def repair_record(record, bindings, context_game=None):
    cover = bindings.get(('set', str(record.get('id') or '')))
    if cover and record.get('name') == cover['name'] and record.get('image') == cover['oldImage']:
        record['image'] = cover['image']
        return 1
    game = record.get('game') or record.get('brand') or context_game
    pid = str(record.get('snkrdunkId') or record.get('id') or '')
    row = bindings.get((game, pid))
    if not row:
        return 0
    fields = [key for key in ('image', 'thumbnailUrl', 'sourceThumbUrl', 'fallbackImage')
              if record.get(key) == row['oldImage']]
    if not fields:
        return 0  # Retain any newer, independently restored source image.
    official_market_name = record.get('snkrProduct', {}).get('name') if record.get('officialProductId') else None
    if record.get('name') != row['name'] and official_market_name != row['name']:
        raise ValueError('Artwork name/finish identity changed: ' + pid)
    if record.get('fullCardNumber', row['number']) != row['number']:
        raise ValueError('Artwork printed number changed: ' + pid)
    if record.get('rarity', row['rarity']) != row['rarity']:
        raise ValueError('Artwork rarity changed: ' + pid)
    for key in fields:
        record[key] = row['image']
    return len(fields)


def repair_payload(payload, bindings, context_game=None):
    count = 0
    if isinstance(payload, dict):
        context_game = payload.get('game') or payload.get('brand') or context_game
        count += repair_record(payload, bindings, context_game)
        for value in payload.values():
            count += repair_payload(value, bindings, context_game)
    elif isinstance(payload, list):
        for value in payload:
            count += repair_payload(value, bindings, context_game)
    return count


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path('.'))
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    config = json.loads((args.root / 'config/reviewed-market-card-images.json').read_text(encoding='utf-8'))
    bindings = load_bindings(args.root)
    total = 0
    for rel in config['targetFiles']:
        path = args.root / rel
        doc = json.loads(path.read_text(encoding='utf-8'))
        changed = repair_payload(doc, bindings)
        serialized = json.dumps(doc, ensure_ascii=False, separators=(',', ':'))
        if any(row['oldImage'] in serialized for row in config['bindings']):
            raise ValueError('Unreviewed stale artwork reference remains in ' + rel)
        total += changed
        if changed and not args.verify_only:
            path.write_text(serialized, encoding='utf-8')
    if args.verify_only and total:
        raise SystemExit(f'{total} reviewed artwork fields reverted')
    print(json.dumps({'repairedFields': total, 'bindings': len(bindings), 'verifyOnly': args.verify_only}))


if __name__ == '__main__':
    main()
