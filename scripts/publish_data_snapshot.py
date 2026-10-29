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
import stat
import subprocess
import tempfile

ALLOWED = {'data/market-price-index.json', 'data/market-price-index-model-state.json',
           'data/market-price-index-validation.json', 'data/market-price-index-independent-verification.json',
           'data/chinese-market.json'}
DAILY_NEW_FILES = {'data/update-health.json', 'data/all-cards.json', 'data/cards-meta.json',
    'data/cards-prices.json', 'data/fx-rates.json', 'data/cards-detail.json', 'data/news.json',
    'data/promo-search.json', 'data/anniversary-market.json', 'data/anniversary-audit.json',
    'data/futuristic-market.json', 'data/futuristic-audit.json',
    'data/top10-pokemon.json', 'data/top10-onepiece.json',
    'data/price-pokemon-box.json', 'data/price-pokemon-card.json',
    'data/price-onepiece-box.json', 'data/price-onepiece-card.json',
    'data/cards-by-set/M6a.json', 'data/cards-by-set/MF.json'}
REFERENCE_SEARCH_FILES = {'data/all-cards.json', 'data/cards-meta.json', 'data/cards-prices.json'}
REFERENCE_FILES = {'data/us-market.json', 'data/yuyutei-market.json',
                   'data/mercari-references.json', 'data/snkrdunk-games.json',
                   'data/cards-detail.json', 'data/cards-meta-index.json',
                   'data/reference-market-health.json'} | REFERENCE_SEARCH_FILES | {
    f'data/price-{game}-{kind}.json'
    for game in ('weiss_schwarz', 'union_arena', 'dragon_ball_fusion_world', 'yugioh', 'digimon')
    for kind in ('card', 'box')}


def metadata_bucket_path(name):
    return isinstance(name, str) and re.fullmatch(r'data/cards-meta-index/[0-9]{2}\.json', name) is not None


def reference_path(name):
    """Only reference-collector outputs; configuration and unrelated data stay out."""
    if not isinstance(name, str):
        return False
    if name in REFERENCE_FILES:
        return True
    if metadata_bucket_path(name):
        return True
    if re.fullmatch(r'data/snkrdunk-history/[1-9][0-9]{0,19}\.json', name):
        return True
    if re.fullmatch(
            r'data/snkrdunk-games/(?:weiss_schwarz|union_arena|dragon_ball_fusion_world|yugioh|digimon)-(?:card|box)-[0-9]{1,9}\.json', name):
        return True
    parts = name.split('/')
    sensitive = {'secret', 'secrets', 'credential', 'credentials', 'token', 'tokens',
                 'password', 'passwords', 'private-key', 'private_key'}
    if any(part.rsplit('.', 1)[0].lower() in sensitive or re.match(
            r'(?i)(?:secrets?|credentials?|tokens?|passwords?|private[_-]?keys?)(?:[._-]|$)', part)
            for part in parts):
        return False
    if any(re.search(r'(?i)(?:^|[._-])(?:config|configuration|watchlist)(?:[._-]|$)', part) for part in parts):
        return False
    if any(part in ('.', '..') or '..' in part for part in parts):
        return False
    return bool(re.fullmatch(
        r'data/(?:us-market|yuyutei-market)/(?:[A-Za-z0-9][A-Za-z0-9_.-]*/)*[A-Za-z0-9][A-Za-z0-9_.-]*\.json', name))


def check_reference_file(root, name):
    if not reference_path(name):
        raise PublicationError('Not an allowed reference output: ' + str(name))
    root = Path(root).resolve()
    path = root
    for part in name.split('/'):
        path = path / part
        if path.is_symlink():
            raise PublicationError('Reference outputs cannot contain symlinks: ' + name)
        if path.exists():
            attributes = getattr(path.lstat(), 'st_file_attributes', 0)
            if attributes & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0):
                raise PublicationError('Reference outputs cannot contain reparse points: ' + name)
    if not path.is_file() or not path.resolve().is_relative_to(root):
        raise PublicationError('Unsafe or missing generated reference output (deletions are not published): ' + name)


def reference_files(root, base):
    if not re.fullmatch(r'[0-9a-fA-F]{40}', base or ''):
        raise PublicationError('Reference publication requires the exact collection commit')
    changed = set(git(root, 'diff', '--no-renames', '--name-only', '-z', base, '--').stdout.split('\0'))
    changed.update(git(root, 'ls-files', '--others', '--exclude-standard', '-z').stdout.split('\0'))
    selected = {name for name in changed if reference_path(name)}
    if selected & REFERENCE_SEARCH_FILES:
        # Protect the entire search snapshot against concurrent edits, including
        # unchanged group members; Git will stage only actual byte changes.
        selected.update(REFERENCE_SEARCH_FILES)
    selected = sorted(selected)
    for name in selected:
        check_reference_file(root, name)
    return selected


def reject_non_json_constant(value):
    raise ValueError('Non-JSON numeric constant: ' + value)


def daily_path(name):
    if name in ALLOWED or name in ('data/secrets.json', 'data/credentials.json'):
        return False
    return bool(re.fullmatch(r'data/[A-Za-z0-9][A-Za-z0-9_.-]*\.json', name)
                or re.fullmatch(r'data/history/[1-9][0-9]{0,19}\.json', name)
                or metadata_bucket_path(name)
                or name in ('data/cards-by-set/M6a.json', 'data/cards-by-set/MF.json'))


def daily_files(root, base):
    """Pick generated JSON changes; arbitrary new documents are never added."""
    if not re.fullmatch(r'[0-9a-fA-F]{40}', base or ''):
        raise PublicationError('Daily publication requires the exact collection commit')
    tracked = set(git(root, 'ls-tree', '-r', '--name-only', '-z', base, '--', 'data').stdout.split('\0'))
    changed = set(git(root, 'diff', '--no-renames', '--name-only', '-z', base, '--').stdout.split('\0'))
    changed.update(git(root, 'ls-files', '--others', '--exclude-standard', '-z').stdout.split('\0'))
    selected = sorted(name for name in changed if daily_path(name) and
                      (name in tracked or name in DAILY_NEW_FILES or metadata_bucket_path(name)
                       or re.fullmatch(r'data/history/[1-9][0-9]{0,19}\.json', name)))
    search = {'data/all-cards.json', 'data/cards-meta.json', 'data/cards-prices.json'}
    if set(selected) & search and not search <= set(selected):
        raise PublicationError('Refusing a partial three-file search snapshot')
    return selected


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


def publish(root, base, files, message, attempts=3, temp_parent=None, daily=False, references=False):
    root = Path(root).resolve()
    if not re.fullmatch(r'[0-9a-fA-F]{40}', base or '') or not 1 <= attempts <= 3:
        raise PublicationError('Use an exact original commit and at most three push attempts')
    if daily and references:
        raise PublicationError('Choose exactly one publication mode')
    if daily and set(files) != set(daily_files(root, base)):
        raise PublicationError('Daily output selection changed before publication')
    if references and (len(files) != len(set(files)) or set(files) != set(reference_files(root, base))):
        raise PublicationError('Reference output selection changed before publication')
    if not daily and not references and (len(files) != len(set(files))
            or set(files) not in (ALLOWED - {'data/chinese-market.json'}, {'data/chinese-market.json'})):
        raise PublicationError('Publish the complete four-file verified index set or the single Chinese market snapshot')
    if (daily or references) and not files:
        return {'status': 'unchanged', 'collectionCommit': base, 'files': []}
    git(root, 'cat-file', '-e', base + '^{commit}')
    snapshots = {}
    original = {name: tree_entry(root, base, name) for name in files}
    for name in files:
        if references or metadata_bucket_path(name):
            check_reference_file(root, name)
        path = root / name
        if path.is_symlink() or not path.resolve().is_relative_to(root) or not path.is_file():
            raise PublicationError('Unsafe or missing generated output: ' + name)
        raw = path.read_bytes()
        if references or metadata_bucket_path(name):
            json.loads(raw, parse_constant=reject_non_json_constant)
        else:
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


def prepare_deploy(root, temp_parent=None):
    """Materialize one current-main commit for every bundle and deployment check."""
    root = Path(root).resolve()
    parent = Path(temp_parent or os.environ.get('RUNNER_TEMP') or tempfile.gettempdir()).resolve()
    worktree = parent / 'tcg-deploy-source'
    if worktree.exists() or worktree.is_symlink():
        raise PublicationError('Deployment source already exists; refusing to replace it: ' + str(worktree))
    git(root, 'fetch', '--no-tags', '--depth=1', 'origin', 'refs/heads/main')
    head = git(root, 'rev-parse', 'FETCH_HEAD').stdout.strip()
    git(root, 'worktree', 'add', '--detach', str(worktree), head)
    return {'status': 'prepared', 'source': str(worktree), 'commit': head}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--base', default=os.environ.get('GITHUB_SHA'))
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--files', nargs='+')
    mode.add_argument('--daily', action='store_true')
    mode.add_argument('--references', action='store_true')
    mode.add_argument('--prepare-deploy', action='store_true')
    parser.add_argument('--message')
    args = parser.parse_args()
    try:
        if args.prepare_deploy:
            result = prepare_deploy(args.root)
            environment = os.environ.get('GITHUB_ENV')
            if environment:
                if any('\n' in value or '\r' in value for value in (result['source'], result['commit'])):
                    raise PublicationError('Unsafe deployment environment value')
                with open(environment, 'a', encoding='utf-8') as stream:
                    stream.write('DEPLOY_SOURCE=' + result['source'] + '\nDEPLOY_COMMIT=' + result['commit'] + '\n')
            print(json.dumps(result))
            return 0
        if not args.message:
            parser.error('--message is required for snapshot publication')
        files = (reference_files(args.root.resolve(), args.base) if args.references else
                 daily_files(args.root.resolve(), args.base) if args.daily else args.files)
        print(json.dumps(publish(args.root, args.base, files, args.message, daily=args.daily, references=args.references)))
        return 0
    except (PublicationError, OSError, ValueError) as error:
        print('::error::' + str(error))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
