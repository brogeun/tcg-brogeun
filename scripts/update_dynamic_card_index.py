"""Refresh dated sources, stage and independently verify, then promote locally.

An incomplete refresh or failed verification leaves the last verified home
dataset intact. No Git operation, deployment or external write is performed.
"""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

PUBLIC_FILES = ['market-price-index-model-state.json', 'market-price-index-independent-verification.json',
                'market-price-index-validation.json', 'market-price-index.json']
SOURCE_CACHE = 'data/_card-index-source-cache'
REQUIRED_SCRIPTS = ['build_market_price_index.py', 'dynamic_card_price_index.py',
                    'refresh_market_price_index_source.py', 'refresh_card_index_platform_source.py',
                    'build_dynamic_market_index.py', 'verify_dynamic_card_price_index.py',
                    'verify_market_price_index_independent.py', 'activate_dynamic_card_index_validation.py']
BASELINE_INPUTS = ['data/cards-meta.json', 'data/market-price-index-dynamic-policy.json',
                   'data/market-price-index-live-history-20261011.json',
                   'data/market-price-index-live-history-20261012.json',
                   'data/card-index-platform-universe-20261012.json.gz',
                   'data/card-index-platform-history-20261012.json.gz']


def data_reference(root, name):
    if not isinstance(name, str) or not name:
        raise ValueError('A required index source reference is missing')
    path = (root / name).resolve()
    if not path.is_relative_to(root / 'data') or path == root / 'data':
        raise ValueError('Index source reference must stay inside data: ' + name)
    return path


def preflight(root):
    """Fail before any request when packaged dependencies or bound archives are absent."""
    active = json.loads((root / 'data/market-price-index.json').read_bytes())
    prior = active.get('sourceSummary', {})
    required = [root / 'scripts' / name for name in REQUIRED_SCRIPTS]
    required += [data_reference(root, name) for name in BASELINE_INPUTS]
    required += [root / 'data' / name for name in PUBLIC_FILES]
    policy = json.loads((root / 'data/market-price-index-dynamic-policy.json').read_bytes())
    required.append(data_reference(root, policy.get('scope', {}).get('exclusionsSourcePath')))
    required += [data_reference(root, prior.get('universeSourcePath')),
                 data_reference(root, prior.get('liveCollection', {}).get('sourcePath'))]
    missing = sorted({path.relative_to(root).as_posix() for path in required if not path.is_file()})
    if missing:
        raise FileNotFoundError('Index inputs/cache are incomplete; last verified index retained: ' + ', '.join(missing))
    for name, expected in [(prior['universeSourcePath'], prior.get('universeSourceSha256')),
                           (prior['liveCollection']['sourcePath'], prior['liveCollection'].get('sourceSha256'))]:
        if not expected or hashlib.sha256(data_reference(root, name).read_bytes()).hexdigest() != expected:
            raise ValueError('Restored archive differs from the verified index: ' + name)
    # The existing active set must still be a matched, verified set before refresh.
    raw = (root / 'data/market-price-index.json').read_bytes()
    digest = hashlib.sha256(raw).hexdigest()
    report = json.loads((root / 'data/market-price-index-validation.json').read_bytes())
    proof_raw = (root / 'data/market-price-index-independent-verification.json').read_bytes()
    proof = json.loads(proof_raw)
    state = root / 'data/market-price-index-model-state.json'
    if (report.get('status') != 'passed' or proof.get('status') != 'passed'
            or report.get('dataSha256') != digest or proof.get('dataSha256') != digest
            or report.get('independentAudit', {}).get('sha256') != hashlib.sha256(proof_raw).hexdigest()
            or active.get('modelStateRef', {}).get('sha256') != hashlib.sha256(state.read_bytes()).hexdigest()):
        raise ValueError('Active index files are not a matched verified set; refresh stopped')
    return {'status': 'passed', 'filesChecked': len(set(required)),
            'sourceAsOf': active.get('sourceAsOf'), 'networkRequests': 0}


def prune_source_cache(root):
    """Keep only the current pair in the disposable Actions cache, never baseline archives."""
    cache = (root / SOURCE_CACHE).resolve()
    if not cache.is_relative_to(root / 'data') or cache == root / 'data':
        raise ValueError('Unsafe source cache directory')
    active = json.loads((root / 'data/market-price-index.json').read_bytes())
    prior = active['sourceSummary']
    keep = {data_reference(root, prior['universeSourcePath']),
            data_reference(root, prior['liveCollection']['sourcePath'])}
    if any(path.parent != cache or not path.is_file() for path in keep):
        raise ValueError('Current index is not bound to a complete generated cache pair')
    for pattern in ('card-index-platform-universe-*.json.gz', 'card-index-platform-history-*.json.gz'):
        for path in cache.glob(pattern):
            if path.resolve() not in keep:
                path.unlink()
    return {'status': 'passed', 'retainedSources': sorted(path.relative_to(root).as_posix() for path in keep)}


def promote_verified_files(stage, root, stamp):
    """Prepare old and new bytes first, and restore a partially replaced set."""
    names = PUBLIC_FILES
    replacements, replaced = [], []
    for name in names:
        target = root / 'data' / name
        temporary = stage / ('activate-' + stamp + '-' + name)
        backup = stage / ('previous-' + stamp + '-' + name) if target.exists() else None
        if backup is not None:
            backup.write_bytes(target.read_bytes())
        temporary.write_bytes((stage / name).read_bytes())
        replacements.append((temporary, target, backup))
    try:
        for temporary, target, backup in replacements:
            os.replace(temporary, target)
            replaced.append((target, backup))
    except OSError as replacement_error:
        restore_errors = []
        for target, backup in reversed(replaced):
            try:
                if backup is None:
                    target.unlink()
                else:
                    os.replace(backup, target)
            except OSError as restore_error:
                restore_errors.append(str(restore_error))
        if restore_errors:
            raise RuntimeError('Index replacement and restoration failed; preserved backup files need recovery: '
                               + '; '.join(restore_errors)) from replacement_error
        raise RuntimeError('Index replacement failed; the previous active files were restored') from replacement_error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--workers', type=int, default=4)
    parser.add_argument('--preflight-only', action='store_true')
    parser.add_argument('--prune-source-cache', action='store_true')
    args = parser.parse_args()
    root = args.root.resolve()
    if args.prune_source_cache:
        print(json.dumps(prune_source_cache(root)))
        return 0
    check = preflight(root)
    if args.preflight_only:
        print(json.dumps(check))
        return 0
    if not 1 <= args.workers <= 4:
        parser.error('Daily index refresh uses 1..4 workers')
    stamp = datetime.now(timezone(timedelta(hours=9))).strftime('%Y%m%d-%H%M%S') + '-' + uuid.uuid4().hex[:8]
    (root / SOURCE_CACHE).mkdir(parents=True, exist_ok=True)
    universe = SOURCE_CACHE + '/card-index-platform-universe-' + stamp + '.json.gz'
    history = SOURCE_CACHE + '/card-index-platform-history-' + stamp + '.json.gz'
    log = 'artifacts/card-index-platform-source-' + stamp + '.jsonl'
    stage = root / 'artifacts' / ('card-index-update-' + stamp)
    stage.mkdir(parents=True, exist_ok=False)
    active_path = root / 'data/market-price-index.json'
    active = json.loads(active_path.read_bytes()) if active_path.is_file() else {}
    prior = active.get('sourceSummary', {})
    refresh = [sys.executable, '-B', 'scripts/refresh_card_index_platform_source.py',
               '--workers', str(args.workers), '--universe-output', universe,
               '--history-output', history, '--log-output', log]
    prior_history = prior.get('liveCollection', {}).get('sourcePath')
    prior_universe = prior.get('universeSourcePath')
    for archive in dict.fromkeys(['data/card-index-platform-universe-20261012.json.gz', prior_universe]):
        refresh += ['--archive-universe', archive]
    for archive in dict.fromkeys(['data/card-index-platform-history-20261012.json.gz', prior_history]):
        refresh += ['--archive-history', archive]
    def run(command):
        environment = os.environ.copy()
        environment.setdefault('OPENBLAS_NUM_THREADS', '1')
        outcome = subprocess.run(command, cwd=root, check=False, env=environment)
        if outcome.returncode:
            raise RuntimeError('Refresh or verification failed; the last verified active index was preserved')
    run(refresh)
    run([sys.executable, '-B', 'scripts/build_dynamic_market_index.py',
         '--universe', universe, '--platform-history', history, '--output-dir', str(stage)])
    run([sys.executable, '-B', 'scripts/verify_dynamic_card_price_index.py',
         '--data', str(stage / 'market-price-index.json'),
         '--output', str(stage / 'market-price-index-independent-verification.json')])
    run([sys.executable, '-B', 'scripts/activate_dynamic_card_index_validation.py', '--data-dir', str(stage)])
    # Write every replacement before switching any active file. The UI checks
    # the matched hashes and refuses to display a mixed set during replacement.
    promote_verified_files(stage, root, stamp)
    print(json.dumps({'status': 'passed', 'sourceUniverse': universe, 'sourceHistory': history,
                      'stagedAudit': str(stage.relative_to(root)), 'deployed': False}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
