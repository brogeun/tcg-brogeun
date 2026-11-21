"""Use the pinned collector with recoverable login and public trade diagnostics.

This companion never reads browser storage or credentials. It observes only the
public trade objects passed to the installed collector's existing validators.
Every original validator still runs and every failure is propagated unchanged.
"""
from __future__ import annotations

from collections import Counter
from contextlib import contextmanager
import argparse
import hashlib
from datetime import datetime
import json
import re
from pathlib import Path
import shutil
import sys
import uuid

ROOT = Path(__file__).resolve().parents[1]
RELEASE = ROOT / 'releases' / 'b0e54cce5e680d8310206beb74fd57646b81cf89' / 'scripts'
RUNTIME_RELEASE = ROOT / 'recovery' / 'runtime-release.json'
if RUNTIME_RELEASE.is_file():
    _runtime = json.loads(RUNTIME_RELEASE.read_bytes())
    _reference = _runtime.get('source_ref', '')
    if not re.fullmatch(r'[0-9a-f]{40}', _reference):
        raise RuntimeError('Configured recovery release reference is invalid')
    RELEASE = ROOT / 'releases' / _reference / 'scripts'
    for _name in ('collect_kream_promos.py', 'run_kream_local.py', 'setup_kream_session.py'):
        _expected = _runtime.get('hashes', {}).get(_name, '').lower()
        if not re.fullmatch(r'[0-9a-f]{64}', _expected) or hashlib.sha256((RELEASE / _name).read_bytes()).hexdigest() != _expected:
            raise RuntimeError('Configured recovery release verification failed')
ROW_FIELDS = (
    'date', 'option', 'price_krw', 'express_shipping', 'date_raw',
    'date_from_relative_label', 'date_precision', 'source_rank',
    'product_id', 'source_url',
)


def public_rows(rows):
    return [{key: row[key] for key in ROW_FIELDS if key in row} for row in rows]


def install_observers(runner, evidence, emit):
    collector = runner.collector
    original_validate = collector.validate_new_rows
    original_collect = collector.collect
    original_parse = collector.parse_row
    fetch_function = 'load_baseline' if callable(getattr(runner, 'load_baseline', None)) else 'fetch_baseline'
    original_fetch = getattr(runner, fetch_function)
    active = {'id': None}

    def save(name, value):
        collector.replace_file(evidence / name, collector.encoded(value))

    def validate(old, rows):
        ident = old['id']
        if ident not in collector.IDS:
            raise ValueError('Unexpected product in diagnostic evidence')
        previous = Counter(collector.signature(row) for row in old['rows'])
        observed = Counter(collector.signature(row) for row in rows)
        missing = previous - observed
        summary = {
            'product_id': ident,
            'previous_rows': len(old['rows']),
            'observed_rows': len(rows),
            'missing_previous_rows': sum(missing.values()),
            'order_violations': sum(a['date'] < b['date'] for a, b in zip(rows, rows[1:])),
            'missing_by_option': {
                option: sum(count for signature, count in missing.items() if signature[1] == option)
                for option in {signature[1] for signature in missing}
            },
        }
        # Save the received public snapshot even when completeness validation fails.
        save(ident + '-observed.json', {
            'schemaVersion': 1, 'complete': False, 'diagnostic_only': True,
            **summary, 'rows': public_rows(rows),
        })
        try:
            result = original_validate(old, rows)
        except Exception:
            save(ident + '-validation.json', {'passed': False, **summary})
            emit('trade_validation_failed', **summary)
            raise
        save(ident + '-validation.json', {'passed': True, **summary})
        return result

    def parse(raw, anchor):
        try:
            return original_parse(raw, anchor)
        except Exception as error:
            ident = active['id']
            if ident in collector.IDS:
                save(ident + '-row-parse-failure.json', {
                    'diagnostic_only': True, 'product_id': ident,
                    'error_type': type(error).__name__,
                    'row': {key: raw[key] for key in ('date_raw', 'option', 'price', 'express_shipping') if key in raw},
                })
            emit('trade_row_parse_failed', product_id=ident, error_type=type(error).__name__)
            raise

    def collect(page, card, old):
        active['id'] = card['id']
        try:
            data = original_collect(page, card, old)
        except Exception as error:
            emit('product_diagnostic_failed', product_id=card['id'],
                 error_type=type(error).__name__)
            raise
        save(card['id'] + '-validated.json', collector.pack_history(data))
        emit('validated_product_checkpoint_saved', product_id=card['id'], rows=len(data['rows']))
        return data

    def fetch(api, root, *args, **kwargs):
        result = original_fetch(api, root, *args, **kwargs)
        baseline = result[0] if isinstance(result, tuple) else result
        for name in runner.FILES:
            target = evidence / 'baseline' / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(root / name, target)
        save('baseline-reference.json', baseline)
        return result

    collector.validate_new_rows = validate
    collector.collect = collect
    collector.parse_row = parse
    setattr(runner, fetch_function, fetch)

    def restore():
        collector.validate_new_rows = original_validate
        collector.collect = original_collect
        collector.parse_row = original_parse
        setattr(runner, fetch_function, original_fetch)

    return restore


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--scheduled', action='store_true')
    args = parser.parse_args()
    sys.path.insert(0, str(RELEASE))
    import run_kream_local as runner
    from kream_recovery_control import RecoveryController

    timestamp = datetime.now(runner.collector.KST).strftime('%Y%m%dT%H%M%S')
    evidence = ROOT / 'recovery' / ('collection-' + timestamp + '-' + uuid.uuid4().hex[:8])
    evidence.mkdir()
    log_path = evidence / 'diagnostic.log'
    recovery_log = ROOT / 'logs' / 'recovery.log'
    live_status_path = ROOT / 'recovery' / 'live-status.json'
    completed_products = set()
    publication = {'requested': False}
    failure = {}
    live_status = {'schemaVersion': 1, 'state': 'starting',
                   'requires_owner_action': False, 'evidence_directory': evidence.name}
    lock_state = {'owned': False, 'acquired': False}

    def emit(code, **details):
        line = json.dumps({'at': datetime.now(runner.collector.KST).isoformat(),
                           'code': code, **details}, ensure_ascii=True, separators=(',', ':'))
        print(line, flush=True)
        with log_path.open('a', encoding='utf-8') as log:
            log.write(line + '\n')
        with recovery_log.open('a', encoding='utf-8') as log:
            log.write(line + '\n')
        if code in ('github_baseline_verified', 'cached_baseline_used', 'authenticated_history_verified'):
            failure.clear()
        if code in ('github_request_failed_detail', 'failure_classified'):
            failure.update(code=details.get('failure_code'), operation=details.get('operation'),
                           retry_after_seconds=details.get('retry_after_seconds', 0))
        elif code in ('publication_deferred', 'github_scheduled_retry_wait', 'github_retry_deferred'):
            failure.update(code=details.get('failure_code'),
                           retry_after_seconds=details.get('retry_after_seconds', failure.get('retry_after_seconds', 0)))
        elif code.startswith('github_') and code not in (
                'github_request_started', 'github_public_read_fallback', 'github_request_completed',
                'github_baseline_verified', 'github_baseline_cache_unavailable'):
            if 'retry' not in code:
                failure.update(code=code, operation=details.get('operation', failure.get('operation')),
                               retry_after_seconds=details.get('retry_after_seconds', 0))
        if code == 'publication_requested':
            publication['requested'] = True
            failure.clear()
        if not lock_state['acquired']:
            return
        if not lock_state['owned'] and live_status_path.is_file():
            current_status = json.loads(live_status_path.read_bytes())
            if current_status.get('evidence_directory') != evidence.name:
                return
        if code in ('validated_product_checkpoint_saved', 'product_checkpoint_reused'):
            completed_products.add(details['product_id'])
        if code in ('starting_collection', 'fetching_immutable_baseline'):
            live_status.update(state='fetching_baseline', requires_owner_action=False)
        elif code in ('github_baseline_verified', 'cached_baseline_used'):
            live_status.update(state='baseline_ready', requires_owner_action=False)
        elif code == 'opening_dedicated_edge_profile':
            live_status.update(state='opening_browser', requires_owner_action=False)
        elif code == 'waiting_for_owner_phone_login':
            live_status.update(state='waiting_for_phone_login', requires_owner_action=True)
        elif code == 'phone_login_request_status':
            live_status.update(phone_request_status=details['status'])
        elif code == 'chat_verification_bridge_ready':
            live_status.update(chat_code_relay_ready=details['accepts_code'])
        elif code == 'chat_verification_code_received':
            live_status.update(state='submitting_chat_code', requires_owner_action=False,
                               code_request_id=details['request_id'])
        elif code == 'chat_verification_code_submitted':
            needs_review = details['status'] != 'code_submitted'
            live_status.update(state='waiting_for_login_form_review' if needs_review else 'verifying_chat_code',
                               requires_owner_action=needs_review,
                               code_submission_status=details['status'])
            if needs_review:
                live_status['chat_code_relay_ready'] = False
        elif code == 'chat_verification_code_rejected':
            live_status.update(state='waiting_for_phone_login', requires_owner_action=True,
                               code_submission_status='code_rejected')
        elif code == 'owner_wait_expired':
            live_status.update(state='stopped_wait_expired', requires_owner_action=True,
                               browser_kept_open=False)
        elif code == 'partial_generation_validated':
            live_status.update(state='publishing_verified_partial', collection_status='partial',
                               requires_owner_action=False, retained_products=details['retained_products'])
        elif code == 'waiting_for_source_review':
            live_status.update(state='waiting_for_source_review', requires_owner_action=True)
        elif code == 'github_scheduled_retry_wait':
            live_status.update(state='waiting_for_github_retry', requires_owner_action=False,
                               next_attempt=details['next_attempt'],
                               retry_after_seconds=details['retry_after_seconds'])
        elif code in ('pending_generation_saved', 'saved_generation_resumed'):
            live_status.update(state='prices_saved_pending_publication', requires_owner_action=False,
                               pending_generation=details['generation'], saved_trades=details['trades'])
        elif code in ('github_auth_required', 'github_forbidden'):
            live_status.update(state='github_access_required', requires_owner_action=True,
                               owner_action_service='github')
        elif code in ('authenticated_history_verified', 'resuming_after_owner_login',
                      'owner_requested_source_retry', 'validated_product_checkpoint_saved'):
            live_status.update(state='collecting', requires_owner_action=False)
        elif code == 'diagnostic_collection_finished':
            success_state = 'publication_requested' if details.get('publication_requested') else 'already_collected_today'
            live_status.update(state=success_state if details['exit_code'] == 0 else 'failed',
                               requires_owner_action=bool(details['exit_code'] and live_status.get('requires_owner_action')),
                               exit_code=details['exit_code'])
        if failure.get('code'):
            live_status.update(failure_code=failure['code'], failure_operation=failure.get('operation'),
                               retry_after_seconds=failure.get('retry_after_seconds', 0))
        else:
            live_status.pop('failure_code', None)
            live_status.pop('failure_operation', None)
        live_status.update(updated_at=datetime.now(runner.collector.KST).isoformat(),
                           last_code=code, completed_products=sorted(completed_products))
        runner.collector.replace_file(live_status_path, runner.collector.encoded(live_status))

    previous_log = ROOT / 'logs' / 'latest.log'
    if previous_log.is_file():
        shutil.copyfile(previous_log, evidence / 'previous-collection.log')
    restore = install_observers(runner, evidence, emit)
    original_generation = runner.collect_generation
    controller = RecoveryController(runner, ROOT, emit)
    runner.collect_generation = controller.collect_generation
    original_lock = runner.profile_lock

    @contextmanager
    def tracked_lock(path):
        with original_lock(path):
            lock_state.update(owned=True, acquired=True)
            emit('runner_profile_lock_acquired')
            try:
                yield
            finally:
                lock_state['owned'] = False

    runner.profile_lock = tracked_lock
    try:
        emit('diagnostic_collection_started', evidence_directory=evidence.name)
        # The installed runner still owns the lock, fixed profile, original
        # validators, immutable baseline, data-only upload and publish dispatch.
        # Recoverable waits run inside its browser lifetime, before finally closes it.
        arguments = ['--run', '--state-root', str(ROOT),
                     '--gh-path', r'C:\Program Files\GitHub CLI\gh.exe']
        if args.scheduled:
            arguments.append('--scheduled')
        result = (runner.main(arguments, event_hook=emit) if getattr(runner, 'RUNNER_EVENT_HOOK', False)
                  else runner.main(arguments))
        emit('diagnostic_collection_finished', exit_code=result,
             publication_requested=result == 0 and (controller.generation_entered or publication['requested']))
        return result
    finally:
        runner.profile_lock = original_lock
        runner.collect_generation = original_generation
        restore()


if __name__ == '__main__':
    raise SystemExit(main())
