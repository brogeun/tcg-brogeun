"""Collect on the owner's PC; upload only a validated nine-file price generation.

The dedicated Edge profile stays on this PC. Nothing writes directly to main.
"""
from __future__ import annotations

import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import uuid

if __package__:
    # Repository/module execution: resolve siblings in this package only.
    from . import collect_kream_promos as collector
    from .setup_kream_session import wait_for_owner_login, verify_full_history_access
else:
    # The installer launches this file directly from its three-file release.
    # Its own directory is sys.path[0]; an unrelated package named "scripts"
    # elsewhere on the PC must not participate in these imports.
    import collect_kream_promos as collector
    from setup_kream_session import wait_for_owner_login, verify_full_history_access


REPO = 'brogeun/tcg-brogeun'
PREFIX = 'repos/' + REPO + '/'
FILES = ('data/korean-promos.json', 'data/korean-promos-health.json') + tuple(
    'data/korean-promos/' + ident + '.json' for ident in collector.IDS)
MAX_FILE_BYTES = 2 * 1024 * 1024


class LocalError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def sha(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{40}', value):
        raise LocalError('invalid_github_snapshot')
    return value


class GhApi:
    """All JSON request bodies go through stdin, never command-line arguments."""
    def __init__(self, executable):
        self.executable = executable

    def __call__(self, endpoint, *, method='GET', payload=None):
        command = [self.executable, 'api', '--hostname', 'github.com', '--method', method,
                   PREFIX + endpoint]
        data = None
        if payload is not None:
            command += ['--input', '-']
            data = json.dumps(payload, ensure_ascii=True, separators=(',', ':')).encode()
        try:
            result = subprocess.run(command, input=data, capture_output=True, timeout=120)
        except Exception:
            raise LocalError('github_request_failed') from None
        if result.returncode:
            raise LocalError('github_request_failed')
        if not result.stdout.strip():
            return None
        try:
            return json.loads(result.stdout)
        except (ValueError, TypeError):
            raise LocalError('invalid_github_response') from None


@contextmanager
def profile_lock(path):
    """An OS-held lock is released even after a crash; never delete stale locks."""
    path.parent.mkdir(parents=True, exist_ok=True)
    stream = path.open('a+b')
    acquired = False
    try:
        stream.seek(0, os.SEEK_END)
        if stream.tell() == 0:
            stream.write(b'0')
            stream.flush()
        stream.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise LocalError('already_running') from None
        acquired = True
        yield
    finally:
        if acquired:
            stream.seek(0)
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        stream.close()


def fetch_baseline(api, root):
    """Resolve main once, then fetch only the nine files at that immutable SHA."""
    reference = api('git/ref/heads/main')
    base = sha(reference['object']['sha'])
    commit = api('git/commits/' + base)
    tree = sha(commit['tree']['sha'])

    def fetch_one(name):
        document = api('contents/' + name + '?ref=' + base)
        if (document.get('type') != 'file' or document.get('path') != name
                or document.get('encoding') != 'base64'):
            raise LocalError('invalid_github_snapshot')
        try:
            raw = base64.b64decode(''.join(document['content'].split()), validate=True)
        except Exception:
            raise LocalError('invalid_github_snapshot') from None
        digest = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
        if not raw or len(raw) > MAX_FILE_BYTES or sha(document['sha']) != digest:
            raise LocalError('invalid_github_snapshot')
        return name, raw

    with ThreadPoolExecutor(max_workers=3) as pool:
        for name, raw in pool.map(fetch_one, FILES):
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
    collector.validate_bundle(root)
    return {'sha': base, 'tree': tree}


def upload_generation(api, root, baseline):
    """Create one isolated data branch, then request validation/publication on main."""
    collector.validate_bundle(root)
    base, base_tree = sha(baseline['sha']), sha(baseline['tree'])
    entries = []
    for name in FILES:
        raw = (root / name).read_bytes()
        if not raw or len(raw) > MAX_FILE_BYTES:
            raise LocalError('invalid_generation')
        entries.append({'path': name, 'mode': '100644', 'type': 'blob',
                        'content': raw.decode('utf-8')})
    created_tree = api('git/trees', method='POST',
                       payload={'base_tree': base_tree, 'tree': entries})
    created = api('git/commits', method='POST', payload={
        'message': 'Collect Korean promo KREAM histories on owner PC',
        'tree': sha(created_tree['sha']), 'parents': [base]})
    source = sha(created['sha'])
    branch = ('kream-local-data/' + datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
              + '-' + uuid.uuid4().hex[:12])
    api('git/refs', method='POST', payload={'ref': 'refs/heads/' + branch, 'sha': source})
    api('actions/workflows/kream-local-publish.yml/dispatches', method='POST',
        payload={'ref': 'main', 'inputs': {'source_commit': source, 'source_base': base}})
    return source


def collect_generation(context, root, emit):
    manifest = collector.validate_bundle(root)
    page = context.pages[0] if context.pages else context.new_page()
    staged = {}
    attempted = datetime.now(collector.KST).isoformat()
    for card in manifest['cards']:
        emit('collecting_product', product_id=card['id'])
        old = collector.unpack_history(json.loads((root / card['file'].lstrip('/')).read_bytes()))
        data = collector.collect(page, card, old)
        staged[card['id']] = data
        emit('product_complete', product_id=card['id'], rows=len(data['rows']))
    collector.publish_generation(root, manifest, staged, attempted)
    return collector.validate_bundle(root)


def already_successful_today(manifest, health, now):
    """Use the owner's KST calendar day, including successful early-morning runs."""
    try:
        raw = manifest['last_success_at']
        success = datetime.fromisoformat(raw.replace('Z', '+00:00'))
        if success.tzinfo is None or now.tzinfo is None:
            return False
        success, now = success.astimezone(collector.KST), now.astimezone(collector.KST)
        return (health.get('status') == 'success' and health.get('last_success_at') == raw
                and success <= now and success.date() == now.date())
    except (KeyError, TypeError, ValueError, AttributeError):
        return False


def execute(args, state_root, emit):
    root = None
    api = None
    with tempfile.TemporaryDirectory(prefix='generation-', dir=state_root) as working:
        if args.run:
            executable = shutil.which(args.gh_path)
            if not executable:
                raise LocalError('github_cli_missing')
            api = GhApi(executable)
            root = Path(working)
            emit('fetching_immutable_baseline')
            baseline = fetch_baseline(api, root)
            manifest = collector.validate_bundle(root)
            health = json.loads((root / 'data/korean-promos-health.json').read_bytes())
            if args.scheduled and already_successful_today(
                    manifest, health, datetime.now(collector.KST)):
                emit('already_collected_today', trades=manifest['collected_trade_count'])
                return 0

        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            emit('opening_dedicated_edge_profile')
            context = pw.chromium.launch_persistent_context(
                user_data_dir=str(state_root / 'profile'), channel='msedge', headless=False,
                locale='ko-KR', timezone_id='Asia/Seoul', viewport={'width': 1440, 'height': 1080})
            try:
                if args.setup:
                    page = context.pages[0] if context.pages else context.new_page()
                    page.goto('https://kream.co.kr', wait_until='domcontentloaded', timeout=45000)
                    emit('waiting_for_owner_login')
                    wait_for_owner_login(page, '열린 전용 Edge 창에서 로그인한 뒤 Enter를 누르세요: ')
                    verify_full_history_access(page)
                    emit('dedicated_profile_verified')
                else:
                    manifest = collect_generation(context, root, emit)
            finally:
                context.close()
        if args.run:
            emit('uploading_validated_data_only', trades=manifest['collected_trade_count'])
            source = upload_generation(api, root, baseline)
            emit('publication_requested', source_commit=source,
                 source_base=baseline['sha'], trades=manifest['collected_trade_count'])
        else:
            emit('setup_complete')
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--setup', action='store_true')
    mode.add_argument('--run', action='store_true')
    parser.add_argument('--scheduled', action='store_true')
    parser.add_argument('--state-root', type=Path,
                        default=Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'TCGHUB' / 'kream-local')
    parser.add_argument('--gh-path', default='gh')
    args = parser.parse_args(argv)
    state_root = args.state_root.expanduser().resolve()
    log = None

    def emit(code, **details):
        record = {'at': datetime.now(collector.KST).isoformat(), 'code': code, **details}
        line = json.dumps(record, ensure_ascii=True, separators=(',', ':'))
        print(line, flush=True)
        if log is not None and not log.closed:
            try:
                log.write(line + '\n')
                log.flush()
            except OSError:
                pass

    try:
        with profile_lock(state_root / 'runner.lock'):
            logs = state_root / 'logs'
            logs.mkdir(parents=True, exist_ok=True)
            log = (logs / 'latest.log').open('w', encoding='utf-8')
            try:
                emit('starting_setup' if args.setup else 'starting_collection')
                return execute(args, state_root, emit)
            except (KeyboardInterrupt, EOFError):
                emit('cancelled')
                return 1
            except (LocalError, collector.CollectionError) as error:
                emit(error.code)
                return 1
            except Exception as error:
                emit('local_collection_failed', error_type=type(error).__name__)
                return 1
            finally:
                log.close()
                log = None
    except (KeyboardInterrupt, EOFError):
        emit('cancelled')
        return 1
    except (LocalError, collector.CollectionError) as error:
        emit(error.code)
        return 1
    except Exception as error:
        emit('local_collection_failed', error_type=type(error).__name__)
        return 1
    finally:
        log = None


if __name__ == '__main__':
    raise SystemExit(main())
