"""Retain the exact public collection outputs before any Git publication attempt."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path

from publish_data_snapshot import PublicationError, daily_files


def checkpoint(root, base, destination):
    root, destination = Path(root).resolve(), Path(destination)
    selected = daily_files(root, base)
    snapshots = {}
    for name in selected:
        path = root / name
        if not path.is_file() or path.is_symlink() or not path.resolve().is_relative_to(root):
            raise PublicationError('Unsafe checkpoint output: ' + name)
        for parent in path.parents:
            if parent == root:
                break
            if parent.is_symlink():
                raise PublicationError('Checkpoint cannot follow a symlink: ' + name)
        raw = path.read_bytes()
        json.loads(raw, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
        snapshots[name] = raw
    destination.mkdir(parents=True, exist_ok=False)
    records = []
    for name, raw in snapshots.items():
        path = destination / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
        records.append({'file': name, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
    manifest = {'schemaVersion': 1, 'collectionCommit': base,
        'checkpointedAt': datetime.now(timezone.utc).isoformat(),
        'policy': 'Exact collected bytes; freshness remains the embedded source timestamp.',
        'files': records}
    (destination / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n', encoding='utf-8')
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--base', required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    result = checkpoint(args.root, args.base, args.output)
    print(json.dumps({'collectionCommit': result['collectionCommit'], 'savedFiles': len(result['files'])}))


if __name__ == '__main__':
    main()
