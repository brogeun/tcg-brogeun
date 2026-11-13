"""One resumable original-price intake on the owner's fixed computer.

No GitHub credentials or upstream relay are used. Source-wide and listing waits
remain in canonical data. The resulting receipt is published by the existing
authenticated original-observation workflow, separately from source collection.
"""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import threading
import time
import urllib.request

import collect_yuyutei_market as market
import yuyutei_observations as delivery

LIVE_MANIFEST = 'https://tcghub.kr/data/yuyutei-market.json'
REQUEST_BUDGET = 250


@contextmanager
def exclusive(path):
    with path.open('a+b') as handle:
        if handle.seek(0, 2) == 0:
            handle.write(b'0')
            handle.flush()
        handle.seek(0)
        if sys.platform == 'win32':
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            handle.seek(0)
            if sys.platform == 'win32':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def live_manifest():
    request = urllib.request.Request(LIVE_MANIFEST, headers={
        'User-Agent': 'TCGHUB-Verification/1.0', 'Accept': 'application/json'})
    # No retry, cookies, browser impersonation, proxy or alternate upstream.
    with urllib.request.urlopen(request, timeout=25) as response:
        if response.headers.get_content_type() != 'application/json':
            raise ValueError('Public price manifest is not JSON')
        doc = json.loads(response.read(1_000_001))
    if doc.get('source') != 'yuyutei':
        raise ValueError('Unexpected public price source')
    return doc


def disproved_provider_hold(block, published, denied_urls):
    # Two listing denials can open a local circuit. An authenticated import of
    # later original listings is positive evidence that the whole site is up.
    latest = published.get('lastImport') or {}
    return (block.get('scope') == 'provider' and block.get('httpStatus') == 403
            and block.get('retryAfterPolicy') == 'conservative_default'
            and block.get('sourceUrl') in denied_urls
            and bool(block.get('observedAt'))
            and latest.get('source') == 'original_yuyutei_set_listings'
            and latest.get('outcome') == 'imported'
            and latest.get('observationsApplied', 0) > 0
            and latest.get('sourceAsOf', '') > block['observedAt'])


def inherit_waits(local, published):
    listings = local.get('listingCooldowns', []) + published.get('listingCooldowns', [])
    denied_urls = {v['sourceUrl'] for v in listings
                   if market.RateLimiter.listing_only(v)}
    for key in ('cooldown', 'discoveryCooldown'):
        waits = [v for v in (local.get(key), published.get(key)) if v]
        if key == 'cooldown':
            waits = [v for v in waits if not disproved_provider_hold(v, published, denied_urls)]
        local[key] = max(waits, key=lambda v: v['nextEligibleAt']) if waits else None
    waits = {}
    for row in local.get('listingCooldowns', []) + published.get('listingCooldowns', []):
        old = waits.get(row['sourceUrl'], {})
        if row['nextEligibleAt'] > old.get('nextEligibleAt', ''):
            waits[row['sourceUrl']] = row
    local['listingCooldowns'] = list(waits.values())


def intake(data, state_dir, output, *, published, now=None):
    now = now or market.utc_now()
    state_path = state_dir / 'intake-state.json'
    state = market.read_json(state_path, {'failures': 0, 'attempts': 0, 'sourceRuns': {}})
    if state.get('phase') == 'ready_for_publication':
        delivery.load_file(output)
        if hashlib.sha256(output.read_bytes()).hexdigest() != state['receiptSha256']:
            raise ValueError('integrity: completed receipt changed')
        return state
    if state.get('phase') == 'blocked':
        raise ValueError('stopped_for_diagnosis: ' + state['reason'])
    manifest_path = data / 'yuyutei-market.json'
    manifest = market.read_json(manifest_path, {})
    inherit_waits(manifest, published)
    market.atomic_json(manifest_path, manifest)
    block = manifest.get('cooldown') or {}
    if block.get('nextEligibleAt', '') > now:
        state.update(phase='waiting_for_source', nextEligibleAt=block['nextEligibleAt'],
                     sourceRequestsThisAttempt=0, updatedAt=now)
        market.atomic_json(state_path, state)
        return state
    try:
        state.setdefault('startedAt', now)
        previous = manifest.get('lastRun') or {}
        if previous.get('startedAt', '') >= state['startedAt']:
            state['sourceRuns'][previous['startedAt']] = previous.get('providerRequests', 0)
        state.setdefault('requestsReserved', sum(state['sourceRuns'].values()))
        remaining = REQUEST_BUDGET - state['requestsReserved']
        if state['attempts'] >= 3:
            raise ValueError('persistent attempt limit reached')
        state.update(phase='collecting', attempts=state['attempts'] + 1, updatedAt=now)
        market.atomic_json(state_path, state)
        if remaining > 0:
            limiter_type = market.RateLimiter
            reservation_lock = threading.Lock()

            class PersistentLimiter(limiter_type):
                def wait(self, url=''):
                    super().wait(url)
                    # Commit the reservation before urllib can make the GET.
                    # A killed worker cannot reset the shared daily budget.
                    with reservation_lock:
                        state['requestsReserved'] += 1
                        market.atomic_json(state_path, state)

            market.RateLimiter = PersistentLimiter
            try:
                market.main(['--output-dir', str(data), '--max-sets-per-game', '45',
                             '--max-requests', str(remaining), '--workers', '2',
                             '--requests-per-second', '0.5', '--resume-hours', '20'])
            finally:
                market.RateLimiter = limiter_type
        errors, total = market.validate_output(data)
        if errors:
            raise ValueError('integrity: ' + repr(errors[:5]))
        batches = delivery.export(data, state['startedAt'])
        if not batches:
            latest = market.read_json(manifest_path, {})
            raise ValueError('stopped_for_diagnosis: no new original prices; ' +
                             json.dumps(latest.get('lastRun', {})))
        delivery.save_file(output, batches)
        delivery.load_file(output)
        state.update(phase='ready_for_publication', validatedRecords=total,
                     receiptSha256=hashlib.sha256(output.read_bytes()).hexdigest(),
                     output=str(output), sets=len(batches),
                     observations=sum(len(b['cards']) for b in batches),
                     sourceAsOf=max(b['observedAt'] for b in batches),
                     publication='pending authenticated receipt import', updatedAt=market.utc_now())
        market.atomic_json(state_path, state)
        return state
    except Exception as error:
        state.update(phase='blocked', failures=state.get('failures', 0) + 1,
                     reason=str(error), updatedAt=market.utc_now())
        market.atomic_json(state_path, state)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data', type=Path, required=True)
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--wait', action='store_true')
    args = parser.parse_args()
    args.state_dir.mkdir(parents=True, exist_ok=True)
    with exclusive(args.state_dir / 'intake.lock'):
        while True:
            # Only this site's small public manifest is read while waiting;
            # the denied provider is not contacted until its saved hold ends.
            state = intake(args.data, args.state_dir, args.output, published=live_manifest())
            print(json.dumps(state, ensure_ascii=True), flush=True)
            if state['phase'] == 'ready_for_publication' or not args.wait:
                return
            eligible = datetime.fromisoformat(state['nextEligibleAt'].replace('Z', '+00:00'))
            while datetime.now(timezone.utc) < eligible:
                time.sleep(min(60, max(0.1, (eligible - datetime.now(timezone.utc)).total_seconds())))


if __name__ == '__main__':
    main()
