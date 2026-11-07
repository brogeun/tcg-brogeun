"""Collect on the owner's PC; upload only a validated nine-file price generation.

The dedicated Edge profile stays on this PC. Nothing writes directly to main.
"""
from __future__ import annotations

import argparse
import base64
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import uuid
import socket
import ssl
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError

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
RUNNER_EVENT_HOOK = True
GITHUB_TIMEOUT_SECONDS = 20
BASELINE_BUDGET_SECONDS = 90
TRANSIENT_GITHUB_ERRORS = frozenset(('github_timeout', 'github_network_failed',
    'github_dns_failed', 'github_server_error', 'github_request_failed'))
CACHE_FALLBACK_ERRORS = TRANSIENT_GITHUB_ERRORS | frozenset((
    'github_tls_failed', 'github_rate_limited', 'github_auth_required', 'github_forbidden'))


class LocalError(RuntimeError):
    def __init__(self, code, **details):
        self.code = code
        # Never retain raw stderr, HTTP response bodies, headers or command text.
        allowed = {'transport', 'endpoint_kind', 'operation', 'http_status',
                   'return_code', 'attempt', 'timeout_seconds', 'retry_after_seconds'}
        self.details = {key: value for key, value in details.items() if key in allowed}
        super().__init__(code)


def sha(value):
    if not isinstance(value, str) or not re.fullmatch(r'[0-9a-f]{40}', value):
        raise LocalError('invalid_github_snapshot')
    return value


def endpoint_kind(endpoint):
    if endpoint == 'git/ref/heads/main': return 'main_reference'
    if endpoint.startswith('git/commits/'): return 'commit_metadata'
    if endpoint.startswith('contents/'): return 'data_file'
    if endpoint.startswith('actions/'): return 'publication_dispatch'
    return 'git_object'


def public_endpoint(endpoint):
    if endpoint == 'git/ref/heads/main': return True
    if re.fullmatch(r'git/commits/[0-9a-f]{40}', endpoint): return True
    return any(re.fullmatch(re.escape('contents/' + name) + r'\?ref=[0-9a-f]{40}', endpoint)
               for name in FILES)


def run_github_command(command, *, input=None, capture_output=True, timeout=20, env=None):
    """Bound Windows waits without pipes inherited by a lingering CLI helper."""
    with tempfile.TemporaryFile() as incoming, tempfile.TemporaryFile() as outgoing, tempfile.TemporaryFile() as errors:
        if input: incoming.write(input)
        incoming.seek(0)
        process = subprocess.Popen(command, stdin=incoming, stdout=outgoing, stderr=errors,
                                   env=env, creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        try:
            process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            try:
                process.kill()
                process.wait(timeout=2)
            except (OSError, subprocess.TimeoutExpired):
                pass
            # Do not call communicate(): inherited pipe handles can extend the
            # Windows cleanup wait beyond the original request timeout.
            raise subprocess.TimeoutExpired(command, timeout) from None
        outgoing.seek(0); errors.seek(0)
        raw = outgoing.read(4 * 1024 * 1024 + 1)
        if len(raw) > 4 * 1024 * 1024: raise LocalError('invalid_github_response')
        return subprocess.CompletedProcess(command, process.returncode, raw, errors.read(8192))


class GhApi:
    """Bounded CLI requests; public price reads can use credential-free HTTPS."""
    def __init__(self, executable, emit=None):
        self.executable = executable
        self.emit = emit or (lambda *_args, **_kwargs: None)
        self.public_reads = False
        self.deadline = None
        self.rate_limited_until = 0

    @contextmanager
    def read_budget(self):
        previous = self.deadline
        self.deadline = time.monotonic() + BASELINE_BUDGET_SECONDS
        try: yield
        finally: self.deadline = previous

    def timeout(self):
        remaining = self.deadline - time.monotonic() if self.deadline else GITHUB_TIMEOUT_SECONDS
        if remaining <= 0:
            raise LocalError('github_timeout', timeout_seconds=BASELINE_BUDGET_SECONDS)
        return min(GITHUB_TIMEOUT_SECONDS, remaining)

    def http_error(self, status, headers=None):
        headers = headers or {}
        if status in (403, 429) and (status == 429 or headers.get('X-RateLimit-Remaining') == '0'
                                    or headers.get('Retry-After') is not None):
            delay = 60
            try:
                if headers.get('Retry-After') is not None:
                    delay = max(delay, int(headers['Retry-After']))
                if headers.get('X-RateLimit-Remaining') == '0':
                    delay = max(delay, int(headers.get('X-RateLimit-Reset', 0)) - int(time.time()))
            except (ValueError, TypeError): pass
            self.rate_limited_until = time.time() + delay
            return LocalError('github_rate_limited', http_status=status, retry_after_seconds=delay)
        return LocalError('github_auth_required' if status == 401 else
                          'github_forbidden' if status == 403 else
                          'github_server_error' if status >= 500 else 'github_http_error',
                          http_status=status)

    def cli_error(self, result):
        # Classification only: the original output is never logged or persisted.
        message = getattr(result, 'stderr', b'') or b''
        if isinstance(message, bytes): message = message.decode('utf-8', errors='replace')
        status = re.search(r'HTTP\s+(\d{3})', message, re.I)
        if status:
            if int(status[1]) == 403 and re.search(r'rate.?limit', message, re.I):
                return self.http_error(403, {'Retry-After': '60'})
            return self.http_error(int(status[1]))
        if re.search(r'gh auth login|GH_TOKEN|not logged into', message, re.I):
            return LocalError('github_auth_required')
        if re.search(r'timeout|timed out|deadline exceeded', message, re.I):
            return LocalError('github_timeout')
        if re.search(r'x509|certificate|TLS handshake', message, re.I):
            return LocalError('github_tls_failed')
        if re.search(r'no such host|name resolution|getaddrinfo', message, re.I):
            return LocalError('github_dns_failed')
        if re.search(r'connection|connectex|network is unreachable|EOF', message, re.I):
            return LocalError('github_network_failed')
        return LocalError('github_request_failed', return_code=result.returncode)

    def cli(self, endpoint, method, payload):
        if not self.executable:
            raise LocalError('github_cli_missing')
        command = [self.executable, 'api', '--hostname', 'github.com', '--method', method,
                   PREFIX + endpoint]
        data = None
        if payload is not None:
            command += ['--input', '-']
            data = json.dumps(payload, ensure_ascii=True, separators=(',', ':')).encode()
        environment = dict(os.environ, GH_PROMPT_DISABLED='1', GH_NO_UPDATE_NOTIFIER='1',
                           GH_DEBUG='', GH_FORCE_TTY='', GH_PAGER='', NO_COLOR='1')
        try:
            result = run_github_command(command, input=data, capture_output=True,
                                        timeout=self.timeout(), env=environment)
        except subprocess.TimeoutExpired:
            raise LocalError('github_timeout', timeout_seconds=GITHUB_TIMEOUT_SECONDS) from None
        except OSError:
            raise LocalError('github_cli_unavailable') from None
        if result.returncode:
            raise self.cli_error(result)
        if not result.stdout.strip(): return None
        try: return json.loads(result.stdout)
        except (ValueError, TypeError):
            raise LocalError('invalid_github_response') from None

    def public(self, endpoint):
        if not public_endpoint(endpoint):
            raise LocalError('github_public_read_not_allowed')
        for attempt in range(1, 4):
            self.emit('github_request_started', transport='public_https',
                      endpoint_kind=endpoint_kind(endpoint), attempt=attempt)
            try:
                request = urlrequest.Request('https://api.github.com/' + PREFIX + endpoint,
                    headers={'Accept': 'application/vnd.github+json',
                             'User-Agent': 'TCGHUB-KREAM-local', 'X-GitHub-Api-Version': '2022-11-28'})
                with urlrequest.urlopen(request, timeout=self.timeout()) as response:
                    if not response.geturl().startswith('https://api.github.com/' + PREFIX):
                        raise LocalError('invalid_github_response')
                    raw = response.read(4 * 1024 * 1024 + 1)
                    if len(raw) > 4 * 1024 * 1024: raise LocalError('invalid_github_response')
                return json.loads(raw)
            except HTTPError as error:
                failure = self.http_error(error.code, error.headers)
                error.close()
            except (socket.timeout, TimeoutError):
                failure = LocalError('github_timeout', timeout_seconds=GITHUB_TIMEOUT_SECONDS)
            except URLError as error:
                failure = LocalError('github_tls_failed' if isinstance(error.reason, ssl.SSLError)
                                     else 'github_dns_failed' if isinstance(error.reason, socket.gaierror)
                                     else 'github_timeout' if isinstance(error.reason, TimeoutError)
                                     else 'github_network_failed')
            except (ValueError, TypeError):
                failure = LocalError('invalid_github_response')
            except OSError:
                failure = LocalError('github_network_failed')
            failure.details.update(transport='public_https', endpoint_kind=endpoint_kind(endpoint), attempt=attempt)
            self.emit('github_request_failed_detail', failure_code=failure.code, **failure.details)
            if failure.code not in TRANSIENT_GITHUB_ERRORS or attempt == 3:
                raise failure
            delay = attempt * 2
            if self.deadline and time.monotonic() + delay >= self.deadline: raise failure
            time.sleep(delay)

    def __call__(self, endpoint, *, method='GET', payload=None):
        if time.time() < self.rate_limited_until:
            raise LocalError('github_rate_limited', retry_after_seconds=max(1, int(self.rate_limited_until-time.time())))
        if method == 'GET' and payload is None and self.public_reads and public_endpoint(endpoint):
            return self.public(endpoint)
        self.emit('github_request_started', transport='cli', operation=method,
                  endpoint_kind=endpoint_kind(endpoint), timeout_seconds=GITHUB_TIMEOUT_SECONDS)
        try:
            return self.cli(endpoint, method, payload)
        except LocalError as error:
            error.details.update(transport='cli', operation=method, endpoint_kind=endpoint_kind(endpoint))
            self.emit('github_request_failed_detail', failure_code=error.code, **error.details)
            fallback = TRANSIENT_GITHUB_ERRORS | {'github_tls_failed', 'github_auth_required', 'github_cli_unavailable'}
            if method != 'GET' or payload is not None or not public_endpoint(endpoint) or error.code not in fallback:
                raise
            self.public_reads = True
            self.emit('github_public_read_fallback', failure_code=error.code, endpoint_kind=endpoint_kind(endpoint))
            return self.public(endpoint)


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
    if not isinstance(reference, dict) or not isinstance(reference.get('object'), dict):
        raise LocalError('invalid_github_response')
    base = sha(reference['object'].get('sha'))
    commit = api('git/commits/' + base)
    if not isinstance(commit, dict) or not isinstance(commit.get('tree'), dict):
        raise LocalError('invalid_github_response')
    tree = sha(commit['tree'].get('sha'))

    def fetch_one(name):
        document = api('contents/' + name + '?ref=' + base)
        if (not isinstance(document, dict) or document.get('type') != 'file' or document.get('path') != name
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

    # Serialize reads to avoid multiplying CLI processes and secondary limits.
    for name in FILES:
        name, raw = fetch_one(name)
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(raw)
    collector.validate_bundle(root)
    return {'sha': base, 'tree': tree}


def file_hashes(root):
    result = {}
    for name in FILES:
        raw = (root / name).read_bytes()
        if not raw or len(raw) > MAX_FILE_BYTES: raise LocalError('invalid_generation')
        result[name] = hashlib.sha256(raw).hexdigest()
    return result


def copy_prices(source, destination):
    for name in FILES:
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        collector.replace_file(target, (source / name).read_bytes())


def snapshot_record(state_root, kind, root, **metadata):
    """Write only public price files; publish its pointer after full validation."""
    collector.validate_bundle(root)
    directory = state_root / kind / uuid.uuid4().hex
    directory.mkdir(parents=True)
    copy_prices(root, directory)
    record = {'schemaVersion': 1, 'repository': REPO, 'created_at': datetime.now(collector.KST).isoformat(),
              'hashes': file_hashes(directory), **metadata}
    collector.replace_file(directory / 'record.json', collector.encoded(record))
    pointer = {'schemaVersion': 1, 'generation': directory.name, 'state': 'pending'}
    collector.replace_file(state_root / kind / 'latest.json', collector.encoded(pointer))
    return directory, record


def read_snapshot(state_root, kind, max_age):
    folder = state_root / kind
    pointer = json.loads((folder / 'latest.json').read_bytes())
    if not isinstance(pointer, dict): raise LocalError('invalid_saved_generation')
    ident = pointer.get('generation', '')
    if pointer.get('schemaVersion') != 1 or not re.fullmatch(r'[0-9a-f]{32}', ident):
        raise LocalError('invalid_saved_generation')
    if pointer.get('state') not in ('pending', 'requested', 'dispatching'): raise LocalError('saved_generation_inactive')
    directory = folder / ident
    # Resolve every public file inside this exact generation, including links.
    if directory.resolve().parent != folder.resolve(): raise LocalError('invalid_saved_generation')
    for name in (*FILES, 'record.json'):
        if not (directory / name).resolve().is_relative_to(directory.resolve()):
            raise LocalError('invalid_saved_generation')
    record = json.loads((directory / 'record.json').read_bytes())
    if not isinstance(record, dict) or not isinstance(record.get('created_at'), str):
        raise LocalError('invalid_saved_generation')
    created = datetime.fromisoformat(record['created_at'].replace('Z', '+00:00'))
    now = datetime.now(collector.KST)
    if (record.get('schemaVersion') != 1 or record.get('repository') != REPO
            or created.tzinfo is None or not now - max_age <= created <= now + timedelta(minutes=5)
            or record.get('hashes') != file_hashes(directory)):
        raise LocalError('invalid_saved_generation')
    collector.validate_bundle(directory)
    return directory, record


def cache_baseline(state_root, root, baseline):
    reference = {'sha': sha(baseline['sha']), 'tree': sha(baseline['tree'])}
    return snapshot_record(state_root, 'baseline-cache', root, baseline=reference)


def network_baseline(api, root):
    if isinstance(api, GhApi):
        with api.read_budget(): return fetch_baseline(api, root)
    return fetch_baseline(api, root)


def load_baseline(api, root, state_root, emit):
    try:
        baseline = network_baseline(api, root)
    except LocalError as error:
        if error.code not in CACHE_FALLBACK_ERRORS: raise
        try:
            directory, saved = read_snapshot(state_root, 'baseline-cache', timedelta(days=7))
            baseline = {key: sha(saved['baseline'][key]) for key in ('sha', 'tree')}
            copy_prices(directory, root)
        except (OSError, ValueError, KeyError, TypeError) as cache_error:
            emit('github_baseline_cache_unavailable', error_type=type(cache_error).__name__)
            raise error from None
        except LocalError as cache_error:
            emit('github_baseline_cache_unavailable', failure_code=cache_error.code)
            raise error from None
        emit('cached_baseline_used', source_base=baseline['sha'],
             failure_code=error.code, publication_requires_fresh_reference=True)
        return baseline, True
    cache_baseline(state_root, root, baseline)
    emit('github_baseline_verified', source_base=baseline['sha'])
    return baseline, False


def reuse_pending(state_root, root, input_hashes, emit, *, today_only=False):
    if not (state_root / 'pending-publication/latest.json').is_file(): return None
    try:
        directory, saved = read_snapshot(state_root, 'pending-publication', timedelta(days=1))
        health = json.loads((directory / FILES[1]).read_bytes())
        completed = datetime.fromisoformat((health.get('completed_at') or health['last_success_at']).replace('Z', '+00:00'))
        now = datetime.now(collector.KST)
        if (saved.get('input_hashes') != input_hashes or completed.tzinfo is None
                or not now - timedelta(days=1) <= completed <= now + timedelta(minutes=5)
                or (today_only and completed.astimezone(collector.KST).date() != now.date())):
            raise LocalError('saved_generation_baseline_changed_or_expired')
    except (OSError, ValueError, KeyError, TypeError, LocalError):
        emit('saved_generation_not_reused')
        return None
    pointer = json.loads((state_root / 'pending-publication/latest.json').read_bytes())
    if pointer.get('state') in ('requested', 'dispatching'):
        emit('publication_confirmation_pending', generation=directory.name)
        raise LocalError('github_publication_confirmation_pending')
    copy_prices(directory, root)
    emit('saved_generation_resumed', generation=directory.name,
         trades=collector.validate_bundle(root)['collected_trade_count'])
    return directory


def publication_baseline(api, state_root, baseline, input_hashes):
    """A cached collection can never publish without a fresh remote reference."""
    def resolve_current():
        current = sha(api('git/ref/heads/main')['object']['sha'])
        if current == baseline['sha']: return baseline
        with tempfile.TemporaryDirectory(prefix='publication-baseline-', dir=state_root) as temporary:
            root = Path(temporary)
            latest = fetch_baseline(api, root)
            if file_hashes(root) != input_hashes:
                raise LocalError('github_baseline_changed')
            cache_baseline(state_root, root, latest)
            return latest
    if isinstance(api, GhApi):
        with api.read_budget(): return resolve_current()
    return resolve_current()


def mark_publication_requested(state_root, directory, source):
    pointer = {'schemaVersion': 1, 'generation': directory.name, 'state': 'requested',
               'source_commit': sha(source)}
    collector.replace_file(state_root / 'pending-publication/latest.json', collector.encoded(pointer))


def upload_generation(api, root, baseline, *, before_dispatch=None):
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
    if before_dispatch is not None:
        before_dispatch(source, base)
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
        try:
            data = collector.collect(page, card, old, report=emit)
        except Exception as error:
            code = getattr(error, 'code', 'product_collection_failed')
            emit('product_retained', product_id=card['id'], failure_code=code,
                 error_type=type(error).__name__)
            if code in ('session_expired', 'access_denied'):
                break
            continue
        staged[card['id']] = data
        emit('product_complete', product_id=card['id'], rows=len(data['rows']))
    if not staged:
        raise LocalError('no_products_completed')
    if len(staged) < len(collector.IDS):
        collector.publish_partial_generation(root, manifest, staged, attempted)
        emit('partial_generation_validated', completed_products=len(staged),
             retained_products=len(collector.IDS)-len(staged))
    else:
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
            api = GhApi(executable, emit=emit)
            root = Path(working)
            emit('fetching_immutable_baseline')
            baseline, cached = load_baseline(api, root, state_root, emit)
            input_hashes = file_hashes(root)
            manifest = collector.validate_bundle(root)
            health = json.loads((root / 'data/korean-promos-health.json').read_bytes())
            if args.scheduled and not cached and already_successful_today(
                    manifest, health, datetime.now(collector.KST)):
                emit('already_collected_today', trades=manifest['collected_trade_count'])
                return 0
            pending = reuse_pending(state_root, root, input_hashes, emit, today_only=args.scheduled)

        if not args.run or pending is None:
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
            manifest = collector.validate_bundle(root)
            if pending is None:
                pending, _ = snapshot_record(state_root, 'pending-publication', root,
                                             input_hashes=input_hashes, baseline=baseline)
                emit('pending_generation_saved', generation=pending.name,
                     trades=manifest['collected_trade_count'])
            try:
                current_baseline = publication_baseline(api, state_root, baseline, input_hashes)
            except LocalError as error:
                emit('publication_deferred', failure_code=error.code, generation=pending.name)
                raise
            emit('uploading_validated_data_only', trades=manifest['collected_trade_count'])
            def before_dispatch(source_commit, source_base):
                pointer = {'schemaVersion': 1, 'generation': pending.name, 'state': 'dispatching',
                           'source_commit': sha(source_commit), 'source_base': sha(source_base)}
                collector.replace_file(state_root / 'pending-publication/latest.json', collector.encoded(pointer))
            try:
                source = upload_generation(api, root, current_baseline, before_dispatch=before_dispatch)
            except LocalError as error:
                # A definitive 4xx rejection did not enqueue a publication.
                # Network/5xx uncertainty keeps dispatching state for read-only
                # confirmation, preventing duplicate dispatches on restart.
                if error.details.get('http_status') in (400, 401, 403, 404, 422, 429):
                    pointer = {'schemaVersion': 1, 'generation': pending.name, 'state': 'pending'}
                    collector.replace_file(state_root / 'pending-publication/latest.json', collector.encoded(pointer))
                emit('publication_deferred', failure_code=error.code, generation=pending.name)
                raise
            mark_publication_requested(state_root, pending, source)
            emit('publication_requested', source_commit=source,
                 source_base=current_baseline['sha'], trades=manifest['collected_trade_count'])
        else:
            emit('setup_complete')
    return 0


def main(argv=None, *, event_hook=None):
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
        if event_hook is not None:
            event_hook(code, **details)

    last_failure = None

    def run_attempt(number):
        nonlocal log, last_failure
        last_failure = None
        try:
            with profile_lock(state_root / 'runner.lock'):
                logs = state_root / 'logs'
                logs.mkdir(parents=True, exist_ok=True)
                log = (logs / 'latest.log').open('w' if number == 1 else 'a', encoding='utf-8')
                try:
                    emit('starting_setup' if args.setup else 'starting_collection', attempt=number)
                    return execute(args, state_root, emit)
                except (KeyboardInterrupt, EOFError):
                    emit('cancelled')
                    return 1
                except (LocalError, collector.CollectionError) as error:
                    if isinstance(error, LocalError): last_failure = error
                    emit('failure_classified', failure_code=error.code, **getattr(error, 'details', {}))
                    emit(error.code, **getattr(error, 'details', {}))
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
            emit('failure_classified', failure_code=error.code, **getattr(error, 'details', {}))
            emit(error.code, **getattr(error, 'details', {}))
            return 1
        except Exception as error:
            emit('local_collection_failed', error_type=type(error).__name__)
            return 1

    attempts = 3 if args.run and args.scheduled else 1
    retry_deadline = time.monotonic() + 90 * 60
    retry_codes = TRANSIENT_GITHUB_ERRORS | {'github_tls_failed', 'github_rate_limited',
        'github_baseline_changed', 'github_publication_confirmation_pending'}
    for number in range(1, attempts + 1):
        result = run_attempt(number)
        if (result == 0 or last_failure is None or last_failure.code not in retry_codes
                or number == attempts):
            return result
        delay = max(600 * number, last_failure.details.get('retry_after_seconds', 0))
        if time.monotonic() + delay >= retry_deadline:
            emit('github_retry_deferred', failure_code=last_failure.code, retry_after_seconds=delay)
            return result
        emit('github_scheduled_retry_wait', failure_code=last_failure.code,
             next_attempt=number + 1, retry_after_seconds=delay)
        # No browser or profile lock is held while waiting for the next attempt.
        try: time.sleep(delay)
        except (KeyboardInterrupt, EOFError):
            emit('cancelled')
            return 1
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
