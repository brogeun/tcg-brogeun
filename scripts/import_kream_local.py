"""Import only validated price JSON from an owner's local data commit.

Run trusted main-branch code. Never check out or execute the submitted commit.
The ordinary snapshot publisher performs the final concurrent-write lease.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timedelta
import json
from pathlib import Path
import re
import subprocess
import tempfile

try:
    from scripts.collect_kream_promos import (IDS, KST, unpack_history, pack_history, validate_bundle,
                                             validate_new_rows, replace_file, PARTIAL_FIELDS)
except ModuleNotFoundError:
    from collect_kream_promos import (IDS, KST, unpack_history, pack_history, validate_bundle,
                                     validate_new_rows, replace_file, PARTIAL_FIELDS)

FILES = ('data/korean-promos.json', 'data/korean-promos-health.json') + tuple(
    'data/korean-promos/' + ident + '.json' for ident in IDS)
CHANGING_CARD = {'collected_count', 'counts_by_exact_option', 'last_observed_at',
                 'snapshot_started_at', 'earliest_date', 'latest_date', 'version',
                 'latest_price_by_option'}
CHANGING_HISTORY = {'rows', 'collected_count', 'counts_by_exact_option', 'last_observed_at',
                    'snapshot_started_at', 'earliest_date', 'latest_date', 'target_count',
                    'complete'}
ROW_KEYS = {'date', 'date_raw', 'date_precision', 'date_from_relative_label', 'option',
            'price_krw', 'express_shipping', 'source_rank', 'product_id', 'source_url'}


class ImportErrorSafe(ValueError):
    pass


def reject(message='Local KREAM generation failed validation; prior prices retained.'):
    raise ImportErrorSafe(message)


def git(root, *args):
    result = subprocess.run(['git', '-C', str(root), *args], capture_output=True)
    if result.returncode:
        reject()
    return result.stdout


def object_entry(root, ref, path):
    record = git(root, 'ls-tree', '-z', ref, '--', path).decode('utf-8').rstrip('\0')
    if not record:
        reject()
    metadata, found = record.split('\t')
    mode, kind, sha = metadata.split()
    if found != path or mode != '100644' or kind != 'blob':
        reject()
    return sha


def strict_json(raw):
    def pairs(entries):
        result = {}
        for key, value in entries:
            if key in result:
                reject()
            result[key] = value
        return result
    def constant(_):
        reject()
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)


def stamp(value):
    if not isinstance(value, str):
        reject()
    result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if result.tzinfo is None:
        reject()
    return result


def static(document, changing):
    return {key: value for key, value in document.items() if key not in changing}


def validate_candidate(baseline, candidate, now=None):
    """Validate one whole generation, preserving static metadata and duplicates."""
    now = now or datetime.now(KST)
    old_manifest = validate_bundle(baseline)
    manifest = validate_bundle(candidate)
    old_manifest = strict_json((baseline / FILES[0]).read_bytes())
    manifest = strict_json((candidate / FILES[0]).read_bytes())
    if static(old_manifest, {'cards', 'last_success_at', 'collected_trade_count', 'refresh'}) != static(
            manifest, {'cards', 'last_success_at', 'collected_trade_count', 'refresh'}):
        reject()
    health = strict_json((candidate / FILES[1]).read_bytes())
    partial = health.get('status') == 'partial'
    expected_health = {'schemaVersion', 'status', 'last_attempt_at', 'last_success_at', 'trades'}
    if partial:
        expected_health.update(PARTIAL_FIELDS)
    if (set(health) != expected_health
            or health['schemaVersion'] != 1 or health['status'] not in ('success', 'partial')
            or health['trades'] != manifest['collected_trade_count']):
        reject()
    success = stamp(manifest['last_success_at'])
    attempted = stamp(health['last_attempt_at'])
    completed = stamp(health['completed_at']) if partial else success
    if partial:
        if success != stamp(old_manifest['last_success_at']) or attempted <= success:
            reject()
    elif success <= stamp(old_manifest['last_success_at']):
        reject()
    if (not now - timedelta(days=1) <= attempted <= completed <= now + timedelta(minutes=5)
            or completed - attempted > timedelta(hours=3)):
        reject()
    expected_refresh = {key:value for key,value in old_manifest['refresh'].items() if key not in PARTIAL_FIELDS}
    expected_refresh.update(status=health['status'],
                            last_attempt_at=health['last_attempt_at'])
    if partial:
        expected_refresh.update({key:health[key] for key in PARTIAL_FIELDS})
    if manifest['refresh'] != expected_refresh:
        reject()
    for old_card, card in zip(old_manifest['cards'], manifest['cards']):
        if static(old_card, CHANGING_CARD) != static(card, CHANGING_CARD):
            reject()
        name = card['file'].lstrip('/')
        if partial and card['id'] not in health['completed_product_ids']:
            if old_card != card or (baseline / name).read_bytes() != (candidate / name).read_bytes():
                reject('A failed product must retain its previous catalogue and history exactly.')
            continue
        old = unpack_history(strict_json((baseline / name).read_bytes()))
        packed = strict_json((candidate / name).read_bytes())
        data = unpack_history(packed)
        # Generated packs have no unused dictionaries, ignored columns, or
        # coerced flag values in which unrelated private content could hide.
        if packed.get('rowEncoding') != 'indexed-v1' or packed != pack_history(data):
            reject()
        if static(old, CHANGING_HISTORY) != static(data, CHANGING_HISTORY):
            reject()
        validate_new_rows(old, data['rows'])
        if not attempted <= stamp(data['snapshot_started_at']) <= stamp(data['last_observed_at']) <= completed:
            reject()
        if partial and stamp(data['last_observed_at']) <= stamp(old['last_observed_at']):
            reject('A completed product needs a newer verified source observation.')
        if data['target_count'] != len(data['rows']):
            reject()
        latest = {}
        for index, row in enumerate(data['rows']):
            if (set(row) != ROW_KEYS or row['source_rank'] != index
                    or row['product_id'] != card['id'] or row['source_url'] != card['source_url']
                    or row['date_precision'] != 'day'
                    or type(row['express_shipping']) is not bool
                    or type(row['date_from_relative_label']) is not bool
                    or not isinstance(row['date_raw'], str) or len(row['date_raw']) > 128
                    or not isinstance(row['option'], str) or len(row['option']) > 128
                    or row['date'] > stamp(data['last_observed_at']).astimezone(KST).date().isoformat()):
                reject()
            latest.setdefault(row['option'], {'date': row['date'], 'price_krw': row['price_krw']})
        if (card['latest_price_by_option'] != latest or card['earliest_date'] != data['rows'][-1]['date']
                or card['latest_date'] != data['rows'][0]['date']):
            reject()
        for key in ('collected_count', 'counts_by_exact_option', 'last_observed_at',
                    'snapshot_started_at', 'earliest_date', 'latest_date'):
            if card[key] != data[key]:
                reject()
    return manifest


def import_generation(root, source_commit, source_base):
    root = Path(root).resolve()
    if any(not re.fullmatch(r'[0-9a-f]{40}', value or '') for value in (source_commit, source_base)):
        reject()
    parents = git(root, 'show', '-s', '--format=%P', source_commit).decode().strip().split()
    if parents != [source_base]:
        reject()
    names = set(git(root, 'diff', '--no-renames', '--name-only', '-z', source_base,
                    source_commit, '--').decode().rstrip('\0').split('\0')) - {''}
    if not names or not names <= set(FILES):
        reject()
    payloads = {}
    for name in FILES:
        # Protect all nine baseline blobs, even unchanged group members.
        if object_entry(root, source_base, name) != object_entry(root, 'HEAD', name):
            reject('KREAM baseline changed while the PC collected; rerun to retain those changes.')
        object_entry(root, source_commit, name)
        raw = git(root, 'show', source_commit + ':' + name)
        if not raw or len(raw) > 8 * 1024 * 1024:
            reject()
        strict_json(raw)
        payloads[name] = raw
    with tempfile.TemporaryDirectory(prefix='kream-local-import-') as temporary:
        candidate = Path(temporary)
        for name, raw in payloads.items():
            path = candidate / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
        manifest = validate_candidate(root, candidate)
    backups = {name: (root / name).read_bytes() for name in FILES}
    try:
        for name, raw in payloads.items():
            replace_file(root / name, raw)
    except Exception:
        for name, raw in backups.items():
            replace_file(root / name, raw)
        raise
    return {'cards': len(IDS), 'trades': manifest['collected_trade_count'], 'valid': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--source-commit', required=True)
    parser.add_argument('--source-base', required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(import_generation(args.root, args.source_commit, args.source_base)))
        return 0
    except Exception as error:
        print(str(error) if isinstance(error, ImportErrorSafe) else
              'Local KREAM generation failed validation; prior prices retained.')
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
