"""Omit internal index sources from the generated static deployment copy."""
from __future__ import annotations
import argparse
import json
import os
import re
import shutil
import tempfile
from pathlib import Path

MAX_ASSET_BYTES = 25 * 1024 * 1024
MAX_ASSET_FILES = 19_900  # Leave room below Pages' 20,000 asset limit.
SEARCH_INTERNAL_FIELDS = ('priceSource', 'priceCheckedAt', 'priceStatus')


def check_limits(bundle):
    """Check the fully copied deployment without repacking any existing output."""
    files = []
    for path in bundle.rglob('*'):
        if path.is_symlink():
            raise ValueError('Deployment assets must not contain symlinks')
        if path.is_file():
            files.append(path)
    if len(files) > MAX_ASSET_FILES:
        raise ValueError(f'Pages deployment has {len(files)} files; maximum {MAX_ASSET_FILES}')
    oversized = [path.relative_to(bundle).as_posix() for path in files if path.stat().st_size > MAX_ASSET_BYTES]
    if oversized:
        raise ValueError('Pages asset size exceeded: ' + ', '.join(oversized))
    return {'filesIncludingFunctions': len(files), 'maximumFiles': MAX_ASSET_FILES,
            'largestAssetBytes': max((path.stat().st_size for path in files), default=0)}


def pack_card_info(target):
    """Pack the disposable set files while retaining their exact public bodies."""
    source = target / 'tcg-card-info'
    if not source.exists():
        return None
    if source.is_symlink() or not source.is_dir() or source.resolve().parent != target:
        raise ValueError('Refuse card-info sources outside the generated deploy copy')
    packs = {}
    count = 0
    for game in sorted(source.iterdir()):
        if game.is_symlink() or not game.is_dir() or not re.fullmatch(r'[a-z_]+', game.name):
            raise ValueError('Invalid card-info game directory')
        for file in sorted(game.iterdir()):
            if file.is_symlink() or not file.is_file() or not re.fullmatch(r'[0-9a-f]{16}(?:-part[0-9]{2,6})?\.json', file.name):
                raise ValueError('Invalid card-info set file')
            body = file.read_bytes().decode('utf-8')
            data = json.loads(body)
            if data.get('schemaVersion') != 1 or data.get('game') != game.name or data.get('set', {}).get('id') != file.name[:16]:
                raise ValueError('Card-info set identity mismatch')
            packs.setdefault((game.name, file.name[:2]), {})[file.name] = body
            count += 1
    destination = target / 'tcg-card-info-packs'
    if destination.exists():
        raise ValueError('Unexpected preexisting generated card-info packs')
    # Finish and validate every pack before removing any generated set copy.
    with tempfile.TemporaryDirectory(dir=target, prefix='.card-info-packs-') as folder:
        stage = Path(folder)
        for (game, bucket), files in packs.items():
            body = json.dumps({'schemaVersion': 1, 'game': game, 'files': files},
                              ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
            if len(body) > MAX_ASSET_BYTES:
                raise ValueError('Card-info pack exceeds the public asset size limit')
            output = stage / game / (bucket + '.json')
            output.parent.mkdir(exist_ok=True)
            output.write_bytes(body)
        shutil.copytree(stage, destination)
    shutil.rmtree(source)
    return {'setFiles': count, 'packFiles': len(packs), 'fileCountSaved': count - len(packs),
            'originalUrlsPreserved': True, 'originalSourcesModified': False}


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
    parser.add_argument('--check-limits', action='store_true', help='Validate the complete deployment without changing files')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    target = args.data_dir.resolve()
    if (target != (root / '_deploy/data').resolve() or not target.is_dir()
            or target == (root / 'data').resolve()):
        parser.error('Only the generated _deploy/data copy may be pruned')
    if args.check_limits:
        print(json.dumps(check_limits(target.parent)))
        return
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
    card_info = pack_card_info(target)
    # Collector-only history is consumed during builds, never by the browser or
    # runtime handlers. Keep repository evidence; omit only this deployment copy.
    for folder in ('snkrdunk-history', 'official-card-contents'):
        history = target / folder
        if history.exists():
            if history.is_symlink() or not history.is_dir() or history.resolve().parent != target:
                parser.error('Refuse an unsafe collector source cache')
            if any(path.is_symlink() for path in history.rglob('*')):
                parser.error('Collector source cache must not contain symlinks')
            shutil.rmtree(history)
            removed.append(folder + '/')
    print(json.dumps({'publicIndexSourcesOmitted': removed, 'publicSearchCatalogue': catalogue,
                      'publicCardInfoPacks': card_info,
                      'originalSourcesModified': False}))


if __name__ == '__main__':
    main()
