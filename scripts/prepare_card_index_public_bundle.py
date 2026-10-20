"""Omit internal index sources from the generated static deployment copy."""
from __future__ import annotations
import argparse
import json
import shutil
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', type=Path, default=Path('_deploy/data'))
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    target = args.data_dir.resolve()
    if target != (root / '_deploy/data').resolve() or not target.is_dir():
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
    print(json.dumps({'publicIndexSourcesOmitted': removed, 'originalSourcesModified': False}))


if __name__ == '__main__':
    main()
