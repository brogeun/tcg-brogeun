"""Omit internal index sources from the generated static deployment copy."""
from __future__ import annotations
import argparse
import json
import os
import shutil
import tempfile
from pathlib import Path

MAX_ASSET_BYTES = 25 * 1024 * 1024
SEARCH_INTERNAL_FIELDS = ('priceSource', 'priceCheckedAt', 'priceStatus')


def prepare_search_catalogue(target):
    """Compact only the disposable public copy; retain complete repo evidence."""
    path = target / 'all-cards.json'
    if not path.exists():
        return None
    if path.is_symlink() or path.resolve().parent != target:
        raise ValueError('Refuse a search catalogue outside the generated deploy copy')
    original = path.read_bytes()
    payload = json.loads(original)
    if not isinstance(payload, dict) or not isinstance(payload.get('details'), list):
        raise ValueError('Public all-cards.json must contain a details array')
    removed = 0
    for row in payload['details']:
        if not isinstance(row, dict):
            raise ValueError('Invalid public search catalogue row')
        for field in SEARCH_INTERNAL_FIELDS:
            if field in row:
                del row[field]
                removed += 1
    body = (json.dumps(payload, ensure_ascii=False, separators=(',', ':'), allow_nan=False) + '\n').encode('utf-8')
    if len(body) > MAX_ASSET_BYTES:
        raise ValueError('Public all-cards.json remains too large for Cloudflare Pages: '
                         + str(len(body)) + ' bytes; maximum ' + str(MAX_ASSET_BYTES)
                         + '. Catalogue was not truncated; deployment must stop.')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=target, prefix='.all-cards-public-', suffix='.tmp', delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(body)
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()
    return {'rows': len(payload['details']), 'bytesBefore': len(original), 'bytesAfter': len(body),
            'rowDiagnosticFieldsOmitted': removed, 'maximumBytes': MAX_ASSET_BYTES,
            'perProductChecksPreservedIn': 'cards-prices.json'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, default=Path('_deploy/data'))
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    target = args.data_dir.resolve()
    if (target != (root / '_deploy/data').resolve() or not target.is_dir()
            or target == (root / 'data').resolve()):
        parser.error('Only the generated _deploy/data copy may be pruned')
    removed = []
    for pattern in ('card-index-platform-universe*', 'card-index-platform-history*',
                    'market-price-index-live-history*', 'market-price-index-model-state.json'):
        for candidate in target.glob(pattern):
            if candidate.is_file() and not candidate.is_symlink() and candidate.parent == target:
                candidate.unlink()
                removed.append(candidate.name)
    # Only disposable copies inside the explicitly checked deploy output.
    cache = target / '_card-index-source-cache'
    if cache.exists():
        if cache.is_symlink() or cache.resolve().parent != target:
            parser.error('Refuse a source cache outside the generated deploy copy')
        shutil.rmtree(cache)
        removed.append(cache.name + '/')
    catalogue = prepare_search_catalogue(target)
    print(json.dumps({'publicIndexSourcesOmitted': removed, 'publicSearchCatalogue': catalogue,
                      'originalSourcesModified': False}))


if __name__ == '__main__':
    main()
