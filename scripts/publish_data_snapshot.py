"""Publish validated JSON atop current main only while every target is unchanged.

Unrelated newer commits are preserved exactly. A changed target is never merged,
reset or overwritten. Only a newly created detached worktree is modified.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

ALLOWED = {'data/market-price-index.json', 'data/market-price-index-model-state.json',
           'data/market-price-index-validation.json', 'data/market-price-index-independent-verification.json',
           'data/chinese-market.json'}


class PublicationError(RuntimeError):
    pass


def git(root, *arguments, check=True):
    result = subprocess.run(['git', '-C', str(root), *arguments], capture_output=True,
                            text=True, encoding='utf-8', errors='replace')
    if check and result.returncode:
        raise PublicationError('git ' + arguments[0] + ' failed: ' + result.stderr.strip()[-1500:])
    return result


def tree_entry(root, revision, name):
    output = git(root, 'ls-tree', '-z', revision, '--', name).stdout
    if not output:
        return None
    rows = output.rstrip('\0').split('\0')
    if len(rows) != 1:
        raise PublicationError('Ambiguous target tree entry: ' + name)
    metadata, path = rows[0].split('\t', 1)
    mode, kind, digest = metadata.split()
    if path != name or kind != 'blob' or mode not in ('100644', '100755'):
        raise PublicationError('Target is not a regular file: ' + name)
    return mode, digest


def publish(root, base, files, message, attempts=3, temp_parent=None):
    root = Path(root).resolve()
    if not re.fullmatch(r'[0-9a-fA-F]{40}', base or '') or not 1 <= attempts <= 3:
        raise PublicationError('Use an exact original commit and at most three push attempts')
    if (len(files) != len(set(files))
            or set(files) not in (ALLOWED - {'data/chinese-market.json'}, {'data/chinese-market.json'})):
        raise PublicationError('Publish the complete four-file verified index set or the single Chinese market snapshot')
    git(root, 'cat-file', '-e', base + '^{commit}')
    snapshots = {}
    original = {name: tree_entry(root, base, name) for name in files}
    for name in files:
        path = root / name
        if path.is_symlink() or not path.resolve().is_relative_to(root) or not path.is_file():
            raise PublicationError('Unsafe or missing generated output: ' + name)
        raw = path.read_bytes()
        json.loads(raw)
        snapshots[name] = raw
    temporary = Path(tempfile.mkdtemp(prefix='tcg-data-publication-', dir=temp_parent or os.environ.get('RUNNER_TEMP'))).resolve()
    for attempt in range(1, attempts + 1):
        git(root, 'fetch', '--no-tags', '--depth=1', 'origin', 'refs/heads/main')
        head = git(root, 'rev-parse', 'FETCH_HEAD').stdout.strip()
        changed = [name for name in files if tree_entry(root, head, name) != original[name]]
        if changed:
            raise PublicationError('Publication stopped: target files changed since collection; preserve those edits and rerun: ' + ', '.join(changed))
        worktree = temporary / ('attempt-' + str(attempt))
        git(root, 'worktree', 'add', '--detach', '--no-checkout', str(worktree), head)
        # Populate the complete latest tree in the index without copying site assets.
        # Commit only this index; absent non-target working files are never staged.
        git(worktree, 'read-tree', head)
        for name, raw in snapshots.items():
            path = worktree / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        git(worktree, 'add', '--', *files)
        staged = set(git(worktree, 'diff', '--cached', '--name-only', '-z').stdout.rstrip('\0').split('\0')) - {''}
        if not staged <= set(files):
            raise PublicationError('Refusing a commit containing unrelated paths')
        if not staged:
            return {'status': 'unchanged', 'commit': head, 'attempt': attempt, 'files': files}
        git(worktree, '-c', 'user.name=github-actions[bot]', '-c',
            'user.email=41898282+github-actions[bot]@users.noreply.github.com',
            '-c', 'commit.gpgsign=false', 'commit', '-m', message)
        outcome = git(worktree, 'push', 'origin', 'HEAD:refs/heads/main', check=False)
        if outcome.returncode == 0:
            return {'status': 'published', 'commit': git(worktree, 'rev-parse', 'HEAD').stdout.strip(),
                    'previousMain': head, 'collectionCommit': base, 'attempt': attempt, 'files': files,
                    'unrelatedCommitsPreserved': True}
        if attempt == attempts:
            raise PublicationError('Normal push failed after bounded retries; no force or merge was attempted: ' + outcome.stderr.strip()[-1500:])
        # Each retry fetches again and checks every target against the original base.
    raise PublicationError('Publication did not complete')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--base', default=os.environ.get('GITHUB_SHA'))
    parser.add_argument('--files', nargs='+', required=True)
    parser.add_argument('--message', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(publish(args.root, args.base, args.files, args.message)))
        return 0
    except (PublicationError, OSError, ValueError) as error:
        print('::error::' + str(error))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
