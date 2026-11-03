"""Reproduce hash-reviewed vintage Pokemon artwork without changing card identity.

CI reads the committed gzip review, downloads only its original image URLs and
patches display paths onto the current inventories. Collection numbers, rarity,
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


def load_review(root):
    root = Path(root).resolve()
    with gzip.open(safe_path(root, REVIEW), 'rb') as stream:
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


def run(root, base=None, validate_only=False, workers=4):
    root = Path(root).resolve()
    review = load_review(root)
    if validate_only:
        files = release_files(root, review)
        return {'status': 'validated-local', 'artworks': len(review['images']), 'files': len(files)}
    # Check every current source identity before making network requests or
    # changing a working file. New rarity or metadata fields remain in this copy.
    documents = patch_documents(root, review)
    stop = threading.Event()
    pacer = RequestPacer()
    missing = []
    for row in review['images']:
        path = safe_path(root, row['localImage'][1:])
        if path.is_file():
            image_bytes(path.read_bytes(), row)
        else:
            missing.append(row)
    # All downloads remain temporary until the complete generation succeeds.
    # A blocked source, changed byte hash, or missing card leaves current data and
    # images unchanged. Four workers also bound concurrent requests after a stop.
    with tempfile.TemporaryDirectory(prefix='pokemon-vintage-release-') as temporary:
        stage = Path(temporary)
        def collect(row):
            body = download_asset(row, stop, pacer)
            path = stage / row['localImage'][1:]
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(body)
            return row['localImage']
        if missing:
            with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, min(4, workers))) as pool:
                for index, _ in enumerate(pool.map(collect, missing), 1):
                    if index % 200 == 0:
                        print(json.dumps({'artworksDownloaded': index, 'artworksRequired': len(missing)}), flush=True)
        # Validate that no source was edited while downloads were in flight.
        if patch_documents(root, review) != documents:
            raise ValueError('Current catalogue changed during artwork materialization')
        prepared = {}
        for name, value in documents.items():
            prepared[name] = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
        for row in missing:
            name = row['localImage'][1:]
            output = safe_path(root, name)
            if output.exists():
                image_bytes(output.read_bytes(), row)
                continue
            output.parent.mkdir(parents=True, exist_ok=True)
            temporary_output = output.with_suffix(output.suffix + '.vintage-tmp')
            temporary_output.write_bytes((stage / name).read_bytes())
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
    args = parser.parse_args()
    print(json.dumps(run(args.root, args.base, args.validate_only, args.workers)))
