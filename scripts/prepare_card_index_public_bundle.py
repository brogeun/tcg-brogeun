"""Omit internal index sources from the generated static deployment copy."""
from __future__ import annotations
import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import tempfile
from pathlib import Path

MAX_ASSET_BYTES = 25 * 1024 * 1024
MAX_ASSET_FILES = 19_900  # Leave room below Pages' 20,000 asset limit.
MAX_VINTAGE_PACK_BYTES = 8 * 1024 * 1024
VINTAGE_BUCKET_SIZE = 64
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
            packs.setdefault((game.name, file.name[:1]), {})[file.name] = body
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


def pack_vintage_images(target):
    """Pack only reviewed artwork in the disposable deployment, preserving URLs."""
    manifest = target / 'pokemon-vintage-image-repairs.json'
    source = target.parent / 'images/pokemon-vintage'
    if not manifest.exists() and not source.exists():
        return None
    if not manifest.exists():
        # Exact, reviewed raw files can be seeded ahead of a complete backfill.
        # They are inputs, not a published generation. Omit only the disposable
        # deploy copies after checking both their hashes and absent public refs.
        import materialize_vintage_pokemon_release as vintage
        review = vintage.load_review(target.parent.parent)
        vintage.validate_published_references(target.parent, set())
        count = vintage.validate_seeded_artwork(target.parent, review)
        shutil.rmtree(source)
        return {'status': 'deferred-local-backfill', 'verifiedSeedsOmitted': count,
                'originalSourcesModified': False}
    if (manifest.is_symlink() or not manifest.is_file() or source.is_symlink()
            or (target.parent / 'images').is_symlink() or not source.is_dir()
            or not source.resolve().is_relative_to(target.parent)
            or source.resolve().parent != (target.parent / 'images').resolve()):
        raise ValueError('Vintage artwork requires its exact generated manifest and directory')
    review = json.loads(manifest.read_text(encoding='utf-8'))
    if review.get('schemaVersion') != 1 or not isinstance(review.get('images'), list) or not review['images'] or review.get('errors', []):
        raise ValueError('Vintage artwork review is incomplete')
    actual = set()
    for file in source.rglob('*'):
        if file.is_symlink():
            raise ValueError('Vintage artwork cannot contain symlinks')
        if file.is_file():
            actual.add(file.relative_to(target.parent).as_posix())
    packs, declared = {}, set()
    types = {'webp': 'image/webp', 'jpg': 'image/jpeg', 'png': 'image/png'}
    for row in review['images']:
        local = row.get('localImage')
        match = re.fullmatch(r'/images/pokemon-vintage/([A-Za-z0-9+_-]+)/(tcg-([0-9]+)|pooka-(ja-[a-z0-9-]+))\.(webp|jpg|png)', str(local))
        if not match or match[1] != row.get('setCode') or (match[3] or match[4]) != row.get('sourceId'):
            raise ValueError('Vintage artwork path does not match its reviewed source identity')
        name = local[1:]
        if name in declared:
            raise ValueError('Duplicate reviewed vintage artwork path')
        declared.add(name)
        path = target.parent / name
        if not path.resolve().is_relative_to(source.resolve()) or not path.is_file() or path.is_symlink():
            raise ValueError('Missing or unsafe reviewed vintage artwork')
        body = path.read_bytes()
        if not 0 < len(body) <= 3_000_000 or len(body) != row.get('bytes') or hashlib.sha256(body).hexdigest() != row.get('sha256'):
            raise ValueError('Vintage artwork bytes differ from the verified source review')
        bucket = str(int(match[3]) // VINTAGE_BUCKET_SIZE) if match[3] else 'pooka'
        encoded = base64.b64encode(body).decode('ascii')
        if base64.b64decode(encoded, validate=True) != body:
            raise ValueError('Vintage artwork base64 round-trip failed')
        packs.setdefault((match[1], bucket), {})[path.name] = {
            'contentType': types[match[5]], 'sha256': row['sha256'],
            'bytes': len(body), 'data': encoded,
        }
    if actual != declared:
        raise ValueError('Unreviewed or missing files in the vintage artwork deployment copy')
    destination = target / 'pokemon-vintage-packs-v2'
    if destination.exists():
        raise ValueError('Unexpected preexisting vintage artwork packs')
    largest = 0
    with tempfile.TemporaryDirectory(dir=target, prefix='.vintage-image-packs-') as folder:
        stage = Path(folder)
        for (code, bucket), files in sorted(packs.items()):
            body = json.dumps({'schemaVersion': 2, 'bucketSize': VINTAGE_BUCKET_SIZE, 'setCode': code, 'bucket': bucket, 'files': files},
                              ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
            if len(body) > min(MAX_ASSET_BYTES, MAX_VINTAGE_PACK_BYTES):
                raise ValueError('Vintage artwork pack exceeds the public runtime asset budget')
            largest = max(largest, len(body))
            output = stage / code / (bucket + '.json')
            output.parent.mkdir(exist_ok=True)
            output.write_bytes(body)
        # Source images are removed only after every complete pack was written.
        shutil.copytree(stage, destination)
    shutil.rmtree(source)
    return {'artworkFiles': len(declared), 'packFiles': len(packs),
            'fileCountSaved': len(declared) - len(packs), 'largestPackBytes': largest,
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
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--check-limits', action='store_true', help='Validate the complete deployment without changing files')
    mode.add_argument('--pack-vintage-images', action='store_true', help='Pack reviewed images after the complete disposable deployment copy exists')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    target = args.data_dir.resolve()
    if (target != (root / '_deploy/data').resolve() or not target.is_dir()
            or target == (root / 'data').resolve()):
        parser.error('Only the generated _deploy/data copy may be pruned')
    if args.check_limits:
        print(json.dumps(check_limits(target.parent)))
        return
    if args.pack_vintage_images:
        print(json.dumps({'publicVintageImagePacks': pack_vintage_images(target), 'originalSourcesModified': False}))
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
    # Images are copied later in the workflow. Their reviewed packs are prepared
    # by the final post-copy pass before checking the complete asset budget.
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
