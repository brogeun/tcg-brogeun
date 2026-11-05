"""Reproduce hash-reviewed vintage Pokemon artwork without changing card identity.

A resumable backfill reads the committed review and downloads only its original
image URLs into a verified persistent cache before patching display paths.
Normal deployment validates the published generation without source requests. Collection numbers, rarity,
market bindings and all other current fields stay untouched. Publication uses the
existing latest-main, exact-blob conflict guard.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import copy
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

REVIEW = 'config/pokemon-vintage-image-repairs.json.gz'
MANIFEST = 'data/pokemon-vintage-image-repairs.json'
CATALOGUE = 'data/japanese-catalog.json'
MAX_IMAGE_BYTES = 3_000_000
MAX_REVIEW_BYTES = 20_000_000
MIN_REQUEST_INTERVAL = 0.25
METHODS = {'exact-source-page-canonical-id-and-title-set',
           'exact-source-page-canonical-id-and-image-alt',
           'exact-existing-pooka-source-image-card-id'}
PT1_METADATA_REPAIR = {
    'originalName': "PlusPower (Galactic's Conquest 084/096)",
    'correctedName': "Level Max (Galactic's Conquest 084/096)",
    'evidence': 'https://www.pokemon-card.com/card-search/details.php/card/21256/regu/',
    'officialNumber': 'DPt1-B 084/096',
}


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def safe_path(root, name):
    if not isinstance(name, str) or not name or '\\' in name or name.startswith('/'):
        raise ValueError('Unsafe reviewed output path')
    parts = name.split('/')
    if any(part in ('', '.', '..') for part in parts):
        raise ValueError('Unsafe reviewed output path')
    root = Path(root).resolve()
    path = root
    for part in parts:
        path = path / part
        if path.is_symlink() or (path.exists() and getattr(path.lstat(), 'st_file_attributes', 0) & 0x400):
            raise ValueError('Reviewed outputs cannot contain links or reparse points')
    if not path.resolve().is_relative_to(root):
        raise ValueError('Reviewed output escapes the checkout')
    return path


def permitted_url(value, host, pattern):
    if not isinstance(value, str):
        raise ValueError('Missing reviewed source URL')
    parsed = urllib.parse.urlsplit(value)
    if (parsed.scheme != 'https' or parsed.hostname != host or parsed.username or parsed.password
            or parsed.port not in (None, 443) or parsed.query or parsed.fragment
            or not re.fullmatch(pattern, parsed.path)):
        raise ValueError('Unexpected reviewed source URL: ' + value)
    return parsed


def source_id(value):
    parsed = urllib.parse.urlsplit(value or '')
    if parsed.hostname == 'pooka.app':
        parsed = permitted_url(value, 'pooka.app', r'/card/(ja-[a-z0-9-]+)/[^/]+/?')
        return parsed.path.split('/')[2]
    parsed = permitted_url(value, 'www.tcgcollector.com', r'/cards/[0-9]+/[^/]+/?')
    return parsed.path.split('/')[2]


def normalize_title(value):
    return re.sub(r'\bNo\.\s*\d+(?=\))', 'No.', str(value).strip())


def reviewed_split_identity(row):
    """Collector merged its old split lists; only the reviewed Dawn Dash map."""
    if row.get('sourceTitleMatch') != 'exact-unique-title-in-reviewed-split-set':
        return False
    original = re.fullmatch(r'(.+) \(Dawn Dash No\. [0-9]+\)', row.get('sourceName', ''))
    current = re.fullmatch(r'(.+) \(Moonlit Pursuit & Dawn Dash No\. [0-9]+\)', row.get('sourceCurrentName', ''))
    return bool(row.get('setCode') == 'DP4-Bd'
                and row.get('sourceReplacementSet') == 'https://www.tcgcollector.com/sets/12146/dawn-dash'
                and re.fullmatch(r'[0-9a-f]{64}', str(row.get('sourceReplacementSetSHA256', '')))
                and re.fullmatch(r'[0-9]+', str(row.get('sourceReplacementId', '')))
                and row.get('canonicalSourceUrl')
                and source_id(row['canonicalSourceUrl']) == row['sourceReplacementId']
                and original and current and original[1] == current[1])


def load_review(root, published=False):
    root = Path(root).resolve()
    path = safe_path(root, MANIFEST if published else REVIEW)
    opener = open if published else gzip.open
    with opener(path, 'rb') as stream:
        raw = stream.read(MAX_REVIEW_BYTES + 1)
    if len(raw) > MAX_REVIEW_BYTES:
        raise ValueError('Oversized artwork review')
    document = json.loads(raw)
    if (not isinstance(document, dict) or document.get('schemaVersion') != 1
            or not isinstance(document.get('images'), list) or not document['images']
            or document.get('errors', [])):
        raise ValueError('Artwork review must be a complete, error-free schema 1 generation')
    identities, outputs = set(), set()
    for row in document['images']:
        if not isinstance(row, dict):
            raise ValueError('Invalid artwork review row')
        code, ident = row.get('setCode'), row.get('sourceId')
        if not isinstance(code, str) or not re.fullmatch(r'[A-Za-z0-9+_-]+', code):
            raise ValueError('Invalid reviewed set code')
        if not isinstance(ident, str) or source_id(row.get('sourceUrl')) != ident:
            raise ValueError('Reviewed source page does not prove its card ID')
        if row.get('method') not in METHODS or not isinstance(row.get('sourceName'), str) or not row['sourceName']:
            raise ValueError('Unsupported artwork verification method or title')
        if row.get('metadataRepair'):
            if (code != 'Pt1' or ident != '26775' or row['metadataRepair'] != PT1_METADATA_REPAIR
                    or row.get('originalSourceName') != PT1_METADATA_REPAIR['originalName']
                    or row['sourceName'] != PT1_METADATA_REPAIR['correctedName']):
                raise ValueError('Unreviewed source metadata correction')
        if row.get('canonicalSourceId') and (not isinstance(row['canonicalSourceId'], str)
                or not re.fullmatch(r'[A-Za-z0-9_-]+', row['canonicalSourceId'])):
            raise ValueError('Invalid existing canonical source ID')
        split_proof = reviewed_split_identity(row)
        if row.get('sourceReplacementSet') and not split_proof:
            raise ValueError('Unreviewed split-set source identity replacement')
        if row.get('canonicalSourceUrl') and source_id(row['canonicalSourceUrl']) != ident and not split_proof:
            raise ValueError('Reviewed canonical page changed its card ID')
        pooka = ident.startswith('ja-')
        if pooka:
            if row['method'] != 'exact-existing-pooka-source-image-card-id':
                raise ValueError('Pooka artwork requires its exact original card ID proof')
            permitted_url(row.get('imageSourceUrl'), 'cdn.pooka.app', '/card/' + re.escape(ident) + r'\.png')
            # The original catalogue can request a small rendition of this same
            # source image. Ignore only that query when proving its exact path.
            original = urllib.parse.urlsplit(row.get('originalImage', ''))
            permitted_url(urllib.parse.urlunsplit(original._replace(query='')), 'cdn.pooka.app', '/card/' + re.escape(ident) + r'\.png')
        else:
            if row['method'] == 'exact-existing-pooka-source-image-card-id':
                raise ValueError('Pooka proof cannot identify a Collector card')
            permitted_url(row.get('imageSourceUrl'), 'static.tcgcollector.com', r'/content/images/(?:[0-9a-f]{2}/){3}[0-9a-f]{64}\.(?:webp|jpg|png)')
        local = row.get('localImage', '')
        prefix = 'pooka-' if pooka else 'tcg-'
        if not isinstance(local, str) or not re.fullmatch('/images/pokemon-vintage/' + re.escape(code) + '/' + re.escape(prefix + ident) + r'\.(?:webp|jpg|png)', local):
            raise ValueError('Artwork output path does not match its reviewed card ID')
        safe_path(root, local[1:])
        if not re.fullmatch(r'[0-9a-f]{64}', str(row.get('sha256', ''))):
            raise ValueError('Missing reviewed artwork hash')
        if (any(type(row.get(field)) is not int for field in ('width', 'height', 'bytes'))
                or row['width'] < 250 or row['height'] < 350
                or not 0.5 <= row['width'] / row['height'] <= 0.9
                or not 0 < row['bytes'] <= MAX_IMAGE_BYTES):
            raise ValueError('Invalid reviewed artwork dimensions or size')
        if row.get('sourceCurrentName') and normalize_title(row['sourceCurrentName']) != normalize_title(row['sourceName']):
            if not split_proof and not (row.get('sourceTitleMatch') == 'basic-energy-title-on-existing-page'
                    and re.fullmatch(r'(?:Grass|Fire|Water|Lightning|Psychic|Fighting|Darkness|Metal) Energy', row['sourceName'])
                    and row['sourceCurrentName'].startswith(row['sourceName'] + ' (')):
                raise ValueError('Reviewed source title no longer matches the original card')
        key = (code.upper(), row['sourceUrl'])
        if key in identities or local in outputs:
            raise ValueError('Duplicate reviewed source card or output path')
        identities.add(key)
        outputs.add(local)
    return document


def image_bytes(body, row):
    from PIL import Image
    if len(body) != row['bytes'] or hashlib.sha256(body).hexdigest() != row['sha256']:
        raise ValueError('Artwork bytes changed since the exact source review: ' + row['localImage'])
    with Image.open(io.BytesIO(body)) as image:
        image.verify()
    with Image.open(io.BytesIO(body)) as image:
        expected = {'WEBP': 'webp', 'JPEG': 'jpg', 'PNG': 'png'}.get(image.format)
        if image.size != (row['width'], row['height']) or expected != row['localImage'].rsplit('.', 1)[1]:
            raise ValueError('Artwork dimensions or format do not match the review')
    return body


def existing_source_ids(row):
    # Older mixed-source inventories retained their original Pooka evidence ID
    # while recording the exact Collector page separately. Keep that reviewed
    # value intact; the source URL, title and original artwork still must match.
    values = {row['sourceId']}
    if row['sourceId'].isdigit():
        values.add('tcgcollector-' + row['sourceId'])
    if row.get('canonicalSourceId'):
        values.add(row['canonicalSourceId'])
    return values


def patch_documents(root, review, validate_only=False):
    contained_identities = {}
    # Older portable backfill bundles have no contents supplement or helper.
    # Require the helper whenever a review exists; never skip its validation.
    if safe_path(root, "data/pokemon-contained-supplements.json").is_file():
        try:
            from pokemon_contained_supplements import reviewed_identities, is_reviewed_card
        except ModuleNotFoundError:
            from scripts.pokemon_contained_supplements import reviewed_identities, is_reviewed_card
        contained_identities = reviewed_identities(root)
    by_code = {}
    for row in review['images']:
        by_code.setdefault(row['setCode'], {})[row['sourceUrl']] = row
    documents = {}
    current_numbers = {}
    for code, rows in by_code.items():
        name = 'data/cards-by-set/' + code + '.json'
        current = read_json(safe_path(root, name))
        if (not isinstance(current, dict) or current.get('brand') != 'pokemon'
                or str(current.get('code', '')).upper() != code.upper()
                or not isinstance(current.get('cards'), list)):
            raise ValueError('Unexpected current set inventory: ' + code)
        patched = copy.deepcopy(current)
        seen = set()
        for card in patched['cards']:
            address = card.get('url') or card.get('sourceUrl')
            row = rows.get(address)
            contained = contained_identities.get((code.upper(), card.get('sourceId')))
            if not row and contained is not None and is_reviewed_card(card, contained):
                continue
            repair = row.get('metadataRepair') if row else None
            names = {row['sourceName'], repair['originalName']} if repair else {row['sourceName']} if row else set()
            if (not row or address in seen or card.get('image') != row['originalImage']
                    or card.get('name') not in names
                    or (card.get('sourceId') and str(card['sourceId']) not in existing_source_ids(row))):
                raise ValueError('Current inventory changed its exact reviewed identity: ' + code)
            apply_metadata_repair(card, row, validate_only)
            if validate_only and any(card.get(field) != row[field] for field in ('localImage', 'imageSourceUrl')):
                raise ValueError('Current inventory is missing reviewed display paths: ' + code)
            current_source = row.get('canonicalSourceUrl') or row['sourceUrl']
            if validate_only and card.get('currentSourceUrl') != current_source:
                raise ValueError('Current inventory is missing the reviewed display source URL: ' + code)
            card['localImage'] = row['localImage']
            card['imageSourceUrl'] = row['imageSourceUrl']
            card['currentSourceUrl'] = current_source
            current_numbers[(code.upper(), address)] = card.get('number')
            seen.add(address)
        if seen != set(rows):
            raise ValueError('Reviewed set inventory is incomplete: ' + code)
        documents[name] = patched
    catalogue = read_json(safe_path(root, CATALOGUE))
    if not isinstance(catalogue, dict) or not isinstance(catalogue.get('cards'), list):
        raise ValueError('Invalid current Japanese catalogue')
    by_source = {(row['setCode'].upper(), row['sourceUrl']): row for row in review['images']}
    patched = copy.deepcopy(catalogue)
    seen = set()
    for card in patched['cards']:
        key = (str(card.get('boxCode') or card.get('setCode') or '').upper(), card.get('sourceUrl') or card.get('url'))
        row = by_source.get(key)
        if not row:
            continue
        allowed_images = {row['originalImage']}
        if row.get('canonicalOriginalImage') or row.get('canonicalSourceId'):
            if card.get('name') != row['sourceName'] or card.get('number') != current_numbers[key]:
                raise ValueError('Canonical source exception changed its exact title or number')
        if row.get('canonicalOriginalImage'):
            allowed_images.add(row['canonicalOriginalImage'])
        allowed_ids = existing_source_ids(row)
        if card.get('image') not in allowed_images or (card.get('sourceId') and str(card['sourceId']) not in allowed_ids):
            raise ValueError('Current catalogue changed its exact reviewed identity')
        apply_metadata_repair(card, row, validate_only)
        if validate_only and any(card.get(field) != row[field] for field in ('localImage', 'imageSourceUrl')):
            raise ValueError('Japanese catalogue is missing reviewed display paths')
        current_source = row.get('canonicalSourceUrl') or row['sourceUrl']
        if validate_only and card.get('currentSourceUrl') != current_source:
            raise ValueError('Japanese catalogue is missing the reviewed display source URL')
        card['localImage'] = row['localImage']
        card['imageSourceUrl'] = row['imageSourceUrl']
        card['currentSourceUrl'] = current_source
        seen.add(key)
    if seen != set(by_source):
        raise ValueError('Japanese catalogue is missing reviewed source cards')
    documents[CATALOGUE] = patched
    if validate_only and read_json(safe_path(root, MANIFEST)) != review:
        raise ValueError('Published artwork manifest does not match the committed review')
    documents[MANIFEST] = review
    return documents


def apply_metadata_repair(card, row, validate_only):
    repair = row.get('metadataRepair')
    if not repair:
        return
    if card.get('name') not in {repair['originalName'], repair['correctedName']} or card.get('number') != '084/096':
        raise ValueError('Reviewed Pt1 correction does not match its exact current card')
    if validate_only and (card.get('name') != repair['correctedName'] or card.get('metadataRepair') != repair
                          or card.get('originalSourceName') != repair['originalName']):
        raise ValueError('Reviewed Pt1 metadata correction has not been applied')
    card['name'] = repair['correctedName']
    card['originalSourceName'] = repair['originalName']
    card['metadataRepair'] = copy.deepcopy(repair)


def release_files(root, review=None):
    """Return the complete validated output generation for atomic publication."""
    root = Path(root).resolve()
    review = review or load_review(root)
    documents = patch_documents(root, review, validate_only=True)
    outputs = list(documents)
    for row in review['images']:
        name = row['localImage'][1:]
        image_bytes(safe_path(root, name).read_bytes(), row)
        outputs.append(name)
    return sorted(outputs)


class RequestPacer:
    """Share conservative request starts across the complete worker pool."""

    def __init__(self):
        self._lock = threading.Lock()
        self._last_started = None

    def open(self, request, stop):
        # Keep header acquisition inside the gate so a delayed worker cannot
        # resume alongside another permitted request and create a new burst.
        # Body reads and byte/hash validation remain outside this lock.
        with self._lock:
            if stop.is_set():
                raise RuntimeError('Source request circuit is open')
            while self._last_started is not None:
                delay = self._last_started + MIN_REQUEST_INTERVAL - time.monotonic()
                if delay <= 0:
                    break
                if stop.wait(delay):
                    raise RuntimeError('Source request circuit is open')
            if stop.is_set():
                raise RuntimeError('Source request circuit is open')
            self._last_started = time.monotonic()
            try:
                return urllib.request.urlopen(request, timeout=30)
            except urllib.error.HTTPError as error:
                # Open the existing denial circuit before releasing queued
                # workers. A denial is never retried or routed elsewhere.
                if error.code in (403, 429):
                    stop.set()
                raise


def download_asset(row, stop, pacer=None):
    if stop.is_set():
        raise RuntimeError('Source request circuit is open')
    address = row['imageSourceUrl']
    expected = urllib.parse.urlsplit(address).hostname
    pacer = pacer or RequestPacer()
    for attempt in range(3):
        if stop.is_set():
            raise RuntimeError('Source request circuit is open')
        request = urllib.request.Request(address, headers={'User-Agent': 'TCGHUB reviewed artwork release/1.0'})
        try:
            with pacer.open(request, stop) as response:
                final = urllib.parse.urlsplit(response.url)
                if final.scheme != 'https' or final.hostname != expected or final.username or final.password:
                    raise ValueError('Artwork redirected outside its reviewed source')
                if not response.headers.get('Content-Type', '').lower().startswith('image/'):
                    raise ValueError('Artwork source returned non-image content')
                body = response.read(MAX_IMAGE_BYTES + 1)
                if len(body) > MAX_IMAGE_BYTES:
                    raise ValueError('Oversized artwork response')
            return image_bytes(body, row)
        except urllib.error.HTTPError as error:
            if error.code in (403, 429):
                stop.set()
                error.add_note('Reviewed artwork source denied: ' + str(row.get('setCode', 'unknown-set')) + '/' + str(row.get('sourceId', 'unknown-card')))
                raise
            if error.code not in (500, 502, 503, 504) or attempt == 2:
                raise
        except (urllib.error.URLError, TimeoutError):
            if attempt == 2:
                raise
        time.sleep(0.5 * (attempt + 1))
    raise RuntimeError('Artwork download did not complete')


class PartialDownloadError(RuntimeError):
    """An incomplete collection whose individually verified cache is retained."""

    def __init__(self, failures, completed):
        self.failures = failures
        self.completed = completed
        super().__init__(f'Artwork collection incomplete: {completed} verified, {len(failures)} pending; saved downloads retained')


def validate_published_references(root, allowed):
    candidates = [safe_path(root, CATALOGUE), *safe_path(root, 'data/cards-by-set').glob('*.json')]
    def references(value):
        if isinstance(value, str) and value.startswith('/images/pokemon-vintage/'):
            yield value
        elif isinstance(value, dict):
            for item in value.values():
                yield from references(item)
        elif isinstance(value, list):
            for item in value:
                yield from references(item)
    for path in candidates:
        if path.is_file() and b'/images/pokemon-vintage/' in path.read_bytes():
            if set(references(read_json(path))) - allowed:
                raise ValueError('Vintage artwork reference exists without a published manifest entry: ' + path.name)


def validate_seeded_artwork(root, review):
    """Recognize exact reviewed seed files without treating them as a release."""
    root = Path(root).resolve()
    source = safe_path(root, 'images/pokemon-vintage')
    if not source.exists():
        return 0
    if not source.is_dir():
        raise ValueError('Vintage artwork seed path must be a directory')
    declared = {row['localImage'][1:]: row for row in review['images']}
    count = 0
    for path in source.rglob('*'):
        name = path.relative_to(root).as_posix()
        safe_path(root, name)
        if path.is_file():
            row = declared.get(name)
            if row is None:
                raise ValueError('Unreviewed vintage artwork seed: ' + name)
            if path.stat().st_size != row['bytes']:
                raise ValueError('Vintage artwork seed size changed: ' + name)
            image_bytes(path.read_bytes(), row)
            count += 1
    return count


def validate_published_release(root):
    """Deploy an existing complete release without contacting pending sources."""
    root = Path(root).resolve()
    manifest = safe_path(root, MANIFEST)
    if manifest.exists():
        # A newer config is pending work, never a reason to discard the last
        # complete generation. Validate the published generation on its own.
        review = load_review(root, published=True)
        validate_published_references(root, {row['localImage'] for row in review['images']})
        files = release_files(root, review)
        return {'status': 'validated-published', 'artworks': len(review['images']), 'files': len(files), 'networkRequests': 0}
    validate_published_references(root, set())
    review = load_review(root)
    seeded = validate_seeded_artwork(root, review)
    return {'status': 'deferred-local-backfill', 'pendingArtworks': len(review['images']),
            'verifiedSeeds': seeded, 'networkRequests': 0, 'publishedDataChanged': False}


_CACHE_WRITE_LOCK = threading.Lock()

def cache_asset(cache, row, body):
    """Checkpoint a digest once; Windows cannot replace a concurrently read file."""
    body = image_bytes(body, row)
    with _CACHE_WRITE_LOCK:
        cache.mkdir(parents=True, exist_ok=True)
        path = safe_path(cache, row['sha256'])
        if path.is_file():
            image_bytes(path.read_bytes(), row)
            return path
        temporary = None
        try:
            with tempfile.NamedTemporaryFile(dir=cache, prefix='.download-', delete=False) as stream:
                temporary = Path(stream.name)
                stream.write(body)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    return path


def run(root, base=None, validate_only=False, workers=4, cache_dir=None, offline=False):
    root = Path(root).resolve()
    if offline:
        if base or validate_only:
            raise ValueError('Offline deployment validation cannot publish or materialize a pending generation')
        return validate_published_release(root)
    review = load_review(root)
    if validate_only:
        files = release_files(root, review)
        return {'status': 'validated-local', 'artworks': len(review['images']), 'files': len(files)}
    # Check every current source identity before making network requests or
    # changing a working file. New rarity or metadata fields remain in this copy.
    documents = patch_documents(root, review)
    cache = Path(cache_dir) if cache_dir is not None else root / '.cache/vintage-artwork'
    if cache.is_symlink():
        raise ValueError('Artwork cache cannot be a symlink')
    cache = cache.resolve()
    sources = {urllib.parse.urlsplit(row['imageSourceUrl']).hostname for row in review['images']}
    circuits = {host: (threading.Event(), RequestPacer()) for host in sources}
    missing = []
    ready = {}
    for row in review['images']:
        path = safe_path(root, row['localImage'][1:])
        if path.is_file():
            image_bytes(path.read_bytes(), row)
        else:
            saved = safe_path(cache, row['sha256'])
            if saved.is_file():
                try:
                    if saved.stat().st_size != row['bytes']:
                        raise ValueError('Cached artwork size changed')
                    image_bytes(saved.read_bytes(), row)
                except (ValueError, OSError):
                    # A torn/corrupt cache is disposable; retain it separately
                    # for diagnosis and redownload only this exact asset.
                    saved.replace(saved.with_name(saved.name + '.corrupt-' + str(time.time_ns())))
                else:
                    ready[row['localImage']] = saved
                    continue
            missing.append(row)
    # Only this cache survives interruption. Public documents and images still
    # change together after the entire reviewed generation has been verified.
    if missing:
        failures = []
        fatal = None
        def collect(row):
            host = urllib.parse.urlsplit(row['imageSourceUrl']).hostname
            stop, pacer = circuits[host]
            body = download_asset(row, stop, pacer)
            return cache_asset(cache, row, body)
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(4, workers))) as pool:
            futures = {pool.submit(collect, row): row for row in missing}
            try:
                for future in concurrent.futures.as_completed(futures):
                    row = futures[future]
                    try:
                        ready[row['localImage']] = future.result()
                        if len(ready) % 50 == 0:
                            print(json.dumps({'artworksCached': len(ready), 'artworksRequired': len(review['images'])}), flush=True)
                    except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, RuntimeError) as error:
                        host = urllib.parse.urlsplit(row['imageSourceUrl']).hostname
                        # Exhausted transient failures also pause their source;
                        # independent hosts keep their own request circuit.
                        if isinstance(error, (urllib.error.URLError, TimeoutError)):
                            if not isinstance(error, urllib.error.HTTPError) or error.code in (403, 429, 500, 502, 503, 504):
                                circuits[host][0].set()
                        if isinstance(error, RuntimeError) and str(error) != 'Source request circuit is open':
                            raise
                        failures.append({'host': host, 'setCode': row['setCode'], 'sourceId': row['sourceId'],
                                         'kind': type(error).__name__, 'httpCode': getattr(error, 'code', None)})
            except BaseException as error:
                for stop, _ in circuits.values():
                    stop.set()
                for future in futures:
                    future.cancel()
                fatal = error
        if fatal is not None:
            raise fatal
        if failures:
            raise PartialDownloadError(failures, len(review['images']) - len(failures))
    # Validate that no source was edited while downloads were in flight.
    if patch_documents(root, review) != documents:
        raise ValueError('Current catalogue changed during artwork materialization')
    prepared = {}
    for name, value in documents.items():
        prepared[name] = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
    for row in review['images']:
        name = row['localImage'][1:]
        output = safe_path(root, name)
        if output.exists():
            image_bytes(output.read_bytes(), row)
            continue
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary_output = output.with_suffix(output.suffix + '.vintage-tmp')
        temporary_output.write_bytes(image_bytes(ready[row['localImage']].read_bytes(), row))
        os.replace(temporary_output, output)
    for name, body in prepared.items():
        output = safe_path(root, name)
        if output.is_file() and output.read_bytes() == body:
            continue
        output.parent.mkdir(parents=True, exist_ok=True)
        temporary_output = output.with_suffix(output.suffix + '.vintage-tmp')
        temporary_output.write_bytes(body)
        os.replace(temporary_output, output)
    files = release_files(root, review)
    if base:
        from publish_data_snapshot import publish
        return publish(root, base, files, 'Materialize reviewed vintage Pokemon artwork display paths', vintage=True)
    return {'status': 'validated-local', 'artworks': len(review['images']), 'assetsReproduced': len(missing), 'files': len(files)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--base', help='Publish safely atop current main using this exact collection commit')
    parser.add_argument('--validate-only', action='store_true')
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--cache-dir', type=Path, help='Persistent verified downloads; resume without repeating successful requests')
    parser.add_argument('--offline', action='store_true', help='Validate the last published generation without source downloads')
    args = parser.parse_args()
    result = run(args.root, args.base, args.validate_only, args.workers, args.cache_dir, args.offline)
    print(json.dumps(result))
    if args.offline and os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as summary:
            summary.write('\nVintage artwork: ' + result['status'] + '. Network requests: 0.\n')
            if result['status'] == 'deferred-local-backfill':
                summary.write('Pending: ' + str(result['pendingArtworks']) + '. Run TCGHUB_Vintage_Backfill.cmd; existing site data retained. This is not a completed image repair.\n')
