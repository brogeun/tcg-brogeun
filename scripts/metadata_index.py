"""Bounded legacy metadata index plus complete numeric-ID lookup buckets."""
from __future__ import annotations

import json
import os
import re
import tempfile
from pathlib import Path

from game_registry import ADDITIONAL_GAMES, normalize_brand

ROOT_LIMIT_BYTES = 20 * 1024 * 1024
BUCKET_LIMIT_BYTES = 20 * 1024 * 1024


def metadata_bucket(card_id):
    value = str(card_id)
    if not re.fullmatch(r'[1-9]\d{0,19}', value):
        raise ValueError('Metadata ID must be an original positive numeric product ID')
    return value[-2:].zfill(2)


def _read(path):
    if not path.exists():
        return {}
    value = json.loads(path.read_bytes())
    if not isinstance(value, dict):
        raise ValueError('Metadata index must be an object: ' + str(path))
    for key, row in value.items():
        metadata_bucket(key)
        if not isinstance(row, dict):
            raise ValueError('Metadata row must be an object: ' + key)
    return value


def load_metadata_index(data_dir):
    """Read the compatible root plus every retained bucket, including unknown games."""
    data_dir = Path(data_dir)
    value = _read(data_dir / 'cards-meta-index.json')
    directory = data_dir / 'cards-meta-index'
    for path in sorted(directory.glob('*.json')) if directory.exists() else []:
        if not re.fullmatch(r'\d{2}\.json', path.name):
            raise ValueError('Unexpected metadata bucket filename: ' + path.name)
        rows = _read(path)
        if any(metadata_bucket(key) + '.json' != path.name for key in rows):
            raise ValueError('Metadata ID stored in the wrong bucket: ' + path.name)
        value.update(rows)
    return value


def _encoded(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def _replace(path, raw):
    if path.exists() and path.read_bytes() == raw:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix=path.name + '.', suffix='.tmp', delete=False) as handle:
            temporary = Path(handle.name)
            handle.write(raw)
        json.loads(temporary.read_bytes())
        os.replace(temporary, path)
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def publish_metadata_index(data_dir, updates, root_limit_bytes=ROOT_LIMIT_BYTES):
    """Never discard a previous row; constrain only the compatible root overlay.

    Buckets are complete and written before root metadata, so a newly admitted
    root row always has its fallback available. Existing legacy/unknown records
    receive first priority in the root. New games remain in buckets even after
    the flat index reaches its bounded overlay size.
    """
    data_dir = Path(data_dir)
    root_path = data_dir / 'cards-meta-index.json'
    old_root = _read(root_path)
    complete = load_metadata_index(data_dir)
    for key, row in updates.items():
        metadata_bucket(key)
        if not isinstance(row, dict):
            raise ValueError('Metadata row must be an object: ' + key)
        complete[key] = {**complete.get(key, {}), **row}
    buckets = {}
    for key, row in complete.items():
        buckets.setdefault(metadata_bucket(key), {})[key] = row
    encoded = {}
    for bucket, rows in buckets.items():
        raw = _encoded(rows)
        if len(raw) > BUCKET_LIMIT_BYTES:
            raise ValueError('Metadata bucket exceeds safe asset size: ' + bucket)
        encoded[bucket] = raw
    legacy = [key for key in old_root if normalize_brand(complete[key].get('brand')) not in ADDITIONAL_GAMES]
    legacy_ids = set(legacy)
    optional = dict.fromkeys([*old_root, *sorted(complete, key=int)])
    root, used = {}, 2
    for key in [*legacy, *(key for key in optional if key not in legacy_ids)]:
        fragment_bytes = len(_encoded(key)) + 1 + len(_encoded(complete[key]))
        required_bytes = fragment_bytes + bool(root)
        if used + required_bytes > root_limit_bytes:
            if key in legacy_ids:
                raise ValueError('Existing legacy metadata exceeds bounded root size')
            continue
        root[key] = complete[key]
        used += required_bytes
    # Complete every bucket before replacing the legacy-compatible entry point.
    for bucket, raw in encoded.items():
        _replace(data_dir / 'cards-meta-index' / (bucket + '.json'), raw)
    root_raw = _encoded(root)
    _replace(root_path, root_raw)
    return {'totalCount': len(complete), 'rootCount': len(root), 'rootBytes': len(root_raw), 'bucketCount': len(buckets)}
