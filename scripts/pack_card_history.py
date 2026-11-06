"""Pack public price histories in the disposable deployment; retain exact source bytes."""
from __future__ import annotations

import argparse
from fnmatch import fnmatchcase
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile

BUCKET_SIZE = 64
MAX_PACK_BYTES = 8 * 1024 * 1024
PACK_DIRECTORY = 'card-history-packs-v1'
RUNTIME_MARKER = "const CARD_HISTORY_MANIFEST = '/data/card-history-packs-v1/manifest.json';"
NAME = re.compile(r'[1-9][0-9]{0,19}\.json')


def encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def digest(body):
    return hashlib.sha256(body).hexdigest()


def records(directory):
    result = {}
    if not directory.exists():
        return result
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError('History directory must be an ordinary directory')
    for path in sorted(directory.iterdir()):
        if path.is_symlink() or not path.is_file() or not NAME.fullmatch(path.name):
            raise ValueError('Unexpected or unsafe public history file')
        raw = path.read_bytes()
        # Validate JSON, but keep whitespace, number spelling, dates and all fields.
        json.loads(raw, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
        body = raw.decode('utf-8')
        if body.encode('utf-8') != raw:
            raise ValueError('History UTF-8 round-trip differs')
        result[path.name] = {'body': body, 'bytes': len(raw), 'sha256': digest(raw)}
    return result


def generation_for(source):
    return digest(encode({'schemaVersion': 1, 'bucketSize': BUCKET_SIZE, 'maximumPackBytes': MAX_PACK_BYTES,
        'files': [[name, value['bytes'], value['sha256']] for name, value in sorted(source.items())]}))


def check_location(root, deploy):
    root, deploy = Path(root).resolve(), Path(deploy)
    expected = root / '_deploy'
    if deploy.is_symlink() or deploy.resolve() != expected or not deploy.is_dir():
        raise ValueError('Only the generated repository _deploy copy may be packed')
    if (root / 'data').is_symlink() or (root / 'data/history').is_symlink():
        raise ValueError('Repository history paths must not follow symlinks')
    for relative in ('data', 'data/history', 'functions', 'functions/_middleware.js', '_routes.json'):
        path = deploy / relative
        if path.is_symlink() or not path.resolve().is_relative_to(expected):
            raise ValueError('Deployment history paths must not follow symlinks')
    return root, expected


def history_route_enabled(routes):
    return '/data/history/*' in routes.get('include', []) and not any(
        pattern.startswith('/data/history/') or fnmatchcase('/data/history/1.json', pattern)
        for pattern in routes.get('exclude', []))


def verify_runtime(root, deploy):
    source = (root / 'functions/_middleware.js').read_bytes()
    published = (deploy / 'functions/_middleware.js').read_bytes()
    if published.decode('utf-8').count(RUNTIME_MARKER) != 1:
        raise ValueError('Expected exactly one history runtime marker')
    if published != source:
        raise ValueError('History runtime differs from the repository source')


def read_packed(destination, generation, source):
    packed, largest = {}, 0
    namespace = destination / generation
    if namespace.is_symlink() or not namespace.is_dir():
        raise ValueError('Missing history generation')
    if {path.name for path in destination.iterdir()} != {generation, 'manifest.json'}:
        raise ValueError('Unexpected history pack generation or artifact')
    for path in sorted(namespace.iterdir()):
        if path.is_symlink() or not path.is_file() or not re.fullmatch(r'(0|[1-9][0-9]*)\.json', path.name):
            raise ValueError('Invalid history pack path')
        raw = path.read_bytes()
        largest = max(largest, len(raw))
        if not 0 < len(raw) <= MAX_PACK_BYTES:
            raise ValueError('History pack exceeds the existing runtime budget')
        pack = json.loads(raw)
        bucket = path.stem
        if (pack.get('schemaVersion') != 1 or pack.get('bucketSize') != BUCKET_SIZE
                or pack.get('bucket') != bucket or not isinstance(pack.get('files'), dict)
                or not isinstance(pack.get('unpacked'), list)):
            raise ValueError('History pack identity differs')
        expected = {name for name in source if str(int(name[:-5]) // BUCKET_SIZE) == bucket}
        names, unpacked = set(pack['files']), pack['unpacked']
        if (len(names) < 2 or len(unpacked) != len(set(unpacked)) or names & set(unpacked)
                or names | set(unpacked) != expected):
            raise ValueError('History pack does not cover its exact source identities')
        for name, entry in pack['files'].items():
            if name in packed or entry != source[name]:
                raise ValueError('Packed history differs from the exact source bytes')
            raw_body = entry['body'].encode('utf-8')
            if len(raw_body) != entry['bytes'] or digest(raw_body) != entry['sha256']:
                raise ValueError('Packed history fingerprint differs')
            packed[name] = entry
    return packed, largest


def summary(source, packed, raw, pack_count, largest, generation):
    return {'schemaVersion': 1, 'generation': generation, 'bucketSize': BUCKET_SIZE,
        'sourceFiles': len(source), 'packedFiles': len(packed), 'unpackedFiles': len(raw),
        'packFiles': pack_count, 'fileCountSaved': len(packed) - pack_count - 1,
        'largestPackBytes': largest, 'sourceBytesPreserved': sum(row['bytes'] for row in source.values()),
        'originalUrlsPreserved': True, 'originalSourcesModified': False}


def verify(root, deploy):
    root, deploy = check_location(root, deploy)
    source = records(root / 'data/history')
    raw = records(deploy / 'data/history')
    destination = deploy / 'data' / PACK_DIRECTORY
    if destination.is_symlink() or not destination.is_dir():
        raise ValueError('Missing history pack directory')
    manifest_path = destination / 'manifest.json'
    if manifest_path.is_symlink():
        raise ValueError('History manifest must not be a symlink')
    manifest = json.loads(manifest_path.read_bytes())
    generation = generation_for(source)
    if manifest.get('generation') != generation:
        raise ValueError('History generation differs from the current source snapshot')
    packed, largest = read_packed(destination, generation, source)
    if (packed.keys() & raw.keys() or packed.keys() | raw.keys() != source.keys()
            or any(source.get(name) != row for name, row in raw.items())):
        raise ValueError('Published histories were lost, changed or duplicated')
    verify_runtime(root, deploy)
    routes = json.loads((deploy / '_routes.json').read_bytes())
    if not history_route_enabled(routes):
        raise ValueError('Original history routes must reach the packed runtime')
    actual = summary(source, packed, raw, len(list((destination / generation).iterdir())), largest, generation)
    if manifest != actual:
        raise ValueError('History publication manifest differs from verified outputs')
    return {'status': 'passed', **actual}


def pack(root, deploy):
    root, deploy = check_location(root, deploy)
    source = records(root / 'data/history')
    copied = records(deploy / 'data/history')
    if copied != source:
        raise ValueError('Generated histories differ from the repository snapshot')
    destination = deploy / 'data' / PACK_DIRECTORY
    if destination.exists():
        raise ValueError('Refuse to overwrite previously generated history packs')
    verify_runtime(root, deploy)
    routes = json.loads((deploy / '_routes.json').read_bytes())
    if not history_route_enabled(routes):
        raise ValueError('Original history routes must reach the packed runtime')
    generation, buckets = generation_for(source), {}
    for name, row in source.items():
        buckets.setdefault(str(int(name[:-5]) // BUCKET_SIZE), {})[name] = row
    with tempfile.TemporaryDirectory(prefix='.history-packs-', dir=deploy / 'data') as folder:
        stage = Path(folder) / PACK_DIRECTORY
        namespace = stage / generation
        namespace.mkdir(parents=True)
        packed = {}
        largest = 0
        for bucket, rows in sorted(buckets.items()):
            eligible = dict(rows)
            while len(eligible) >= 2:
                payload = encode({'schemaVersion': 1, 'bucketSize': BUCKET_SIZE, 'bucket': bucket,
                    'files': eligible, 'unpacked': sorted(set(rows) - set(eligible))})
                if len(payload) <= MAX_PACK_BYTES:
                    (namespace / (bucket + '.json')).write_bytes(payload)
                    largest = max(largest, len(payload))
                    packed.update(eligible)
                    break
                # Keep large histories as original static files, rather than impose
                # a smaller limit on their content or make an oversized runtime pack.
                del eligible[max(eligible, key=lambda name: eligible[name]['bytes'])]
        if not packed:
            return {'status': 'not-needed', 'sourceFiles': len(source), 'fileCountSaved': 0,
                    'originalSourcesModified': False}
        raw = {name: row for name, row in source.items() if name not in packed}
        manifest = summary(source, packed, raw, len(list(namespace.iterdir())), largest, generation)
        (stage / 'manifest.json').write_bytes(encode(manifest) + b'\n')
        verified, _ = read_packed(stage, generation, source)
        if verified != packed or records(deploy / 'data/history') != source:
            raise ValueError('History staging changed before publication')
        # All complete packs are validated before any disposable source is removed.
        os.replace(stage, destination)
        expected = (deploy / 'data/history').resolve()
        for name, row in packed.items():
            path = deploy / 'data/history' / name
            if (path.is_symlink() or (deploy / 'data/history').is_symlink()
                    or path.resolve().parent != expected or not expected.is_relative_to(deploy)
                    or digest(path.read_bytes()) != row['sha256']):
                raise ValueError('Generated history changed before removal')
            path.unlink()
    return verify(root, deploy)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--deploy-dir', type=Path, default=Path('_deploy'))
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    result = (verify if args.verify_only else pack)(root, args.deploy_dir)
    print(json.dumps(result))


if __name__ == '__main__':
    main()
