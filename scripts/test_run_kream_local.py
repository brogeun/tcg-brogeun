"""Check local collection boundaries with synthetic public trade data only."""
import base64
import contextlib
import copy
from datetime import datetime
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

from scripts import run_kream_local as local


class LocalCollectorTests(unittest.TestCase):
    base = '1' * 40
    tree = '2' * 40
    created_tree = '3' * 40
    created_commit = '4' * 40

    def fixture(self, root):
        last_success = '2026-11-03T09:00:00+09:00'
        cards = []
        for ident in local.collector.IDS:
            history = {'schemaVersion': 1, 'id': ident, 'complete': True,
                       'rows': [{'date': '2026-11-03', 'option': 'A', 'price_krw': 100,
                                 'express_shipping': False, 'date_raw': '26/11/03'}],
                       'collected_count': 1, 'counts_by_exact_option': {'A': 1}}
            name = 'data/korean-promos/' + ident + '.json'
            raw = local.collector.encoded(history)
            path = root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(raw)
            cards.append({'id': ident, 'file': '/' + name, 'collected_count': 1,
                          'counts_by_exact_option': {'A': 1},
                          'version': hashlib.sha256(raw).hexdigest()[:16]})
        manifest = {'schemaVersion': 1, 'cards': cards, 'collected_trade_count': 7,
                    'last_success_at': last_success, 'refresh': {}}
        (root / 'data/korean-promos.json').write_bytes(local.collector.encoded(manifest))
        (root / 'data/korean-promos-health.json').write_bytes(local.collector.encoded(
            {'schemaVersion': 1, 'status': 'success', 'last_success_at': last_success, 'trades': 7}))
        local.collector.validate_bundle(root)
        return {name: (root / name).read_bytes() for name in local.FILES}

    def test_baseline_files_use_one_immutable_main_commit(self):
        with tempfile.TemporaryDirectory() as fixture_dir, tempfile.TemporaryDirectory() as destination:
            files = self.fixture(Path(fixture_dir))
            calls = []

            def api(endpoint):
                calls.append(endpoint)
                if endpoint == 'git/ref/heads/main':
                    return {'object': {'sha': self.base}}
                if endpoint == 'git/commits/' + self.base:
                    return {'tree': {'sha': self.tree}}
                name, ref = endpoint.removeprefix('contents/').split('?ref=')
                self.assertEqual(ref, self.base)
                raw = files[name]
                digest = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
                return {'type': 'file', 'path': name, 'encoding': 'base64', 'sha': digest,
                        'content': base64.b64encode(raw).decode()}

            baseline = local.fetch_baseline(api, Path(destination))
            self.assertEqual(baseline, {'sha': self.base, 'tree': self.tree})
            self.assertEqual(calls.count('git/ref/heads/main'), 1)
            self.assertEqual(len(calls), 11)
            self.assertEqual({name: (Path(destination) / name).read_bytes() for name in local.FILES}, files)

    def test_upload_contains_only_nine_data_files_and_never_updates_main(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            files = self.fixture(root)
            (root / 'profile').mkdir()
            (root / 'profile/PRIVATE-PROFILE').write_text('PRIVATE-AUTH')
            calls = []

            def api(endpoint, **kwargs):
                calls.append((endpoint, kwargs))
                return {'sha': self.created_tree if endpoint == 'git/trees' else self.created_commit}

            source = local.upload_generation(api, root, {'sha': self.base, 'tree': self.tree})
            self.assertEqual(source, self.created_commit)
            self.assertEqual([endpoint for endpoint, _ in calls],
                             ['git/trees', 'git/commits', 'git/refs',
                              'actions/workflows/kream-local-publish.yml/dispatches'])
            tree = calls[0][1]['payload']
            self.assertEqual(tree['base_tree'], self.tree)
            self.assertEqual({entry['path']: entry['content'].encode() for entry in tree['tree']}, files)
            self.assertTrue(all(entry['mode'] == '100644' and entry['type'] == 'blob' for entry in tree['tree']))
            self.assertNotIn('PRIVATE-AUTH', json.dumps(calls))
            self.assertEqual(calls[1][1]['payload']['parents'], [self.base])
            self.assertTrue(calls[2][1]['payload']['ref'].startswith('refs/heads/kream-local-data/'))
            self.assertEqual(calls[3][1]['payload'], {'ref': 'main', 'inputs': {
                'source_commit': self.created_commit, 'source_base': self.base}})
            self.assertTrue(all(kwargs['method'] == 'POST' for _, kwargs in calls))

    def test_invalid_bundle_cannot_make_any_upload_request(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            self.fixture(root)
            (root / local.FILES[-1]).write_text('{"cookies":"PRIVATE-AUTH"}')
            api = mock.Mock()
            with self.assertRaises(Exception):
                local.upload_generation(api, root, {'sha': self.base, 'tree': self.tree})
            api.assert_not_called()

    def test_late_collection_failure_never_replaces_or_uploads_partial_data(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = self.fixture(root)
            context = SimpleNamespace(pages=[object()])
            responses = [json.loads(original[name]) for name in local.FILES[2:]]
            responses[-1] = local.collector.CollectionError('session_expired', 'Login required')
            with mock.patch.object(local.collector, 'collect', side_effect=responses), \
                    mock.patch.object(local.collector, 'publish_generation') as publish:
                with self.assertRaises(local.collector.CollectionError):
                    local.collect_generation(context, root, lambda *_a, **_k: None)
                publish.assert_not_called()
            self.assertEqual({name: (root / name).read_bytes() for name in local.FILES}, original)

    def test_gh_json_bodies_are_stdin_only_and_cli_errors_are_private(self):
        payload = {'content': 'PRIVATE-REQUEST'}
        with mock.patch.object(local.subprocess, 'run', return_value=SimpleNamespace(
                returncode=0, stdout=b'{"sha":"ok"}')) as run:
            self.assertEqual(local.GhApi('gh.exe')('git/trees', method='POST', payload=payload), {'sha': 'ok'})
        args, kwargs = run.call_args
        self.assertNotIn('PRIVATE-REQUEST', ' '.join(args[0]))
        self.assertIn('--input', args[0])
        self.assertEqual(json.loads(kwargs['input']), payload)
        self.assertTrue(kwargs['capture_output'])
        with mock.patch.object(local.subprocess, 'run', return_value=SimpleNamespace(
                returncode=1, stdout=b'PRIVATE-OUT', stderr=b'PRIVATE-ERROR')):
            with self.assertRaises(local.LocalError) as caught:
                local.GhApi('gh.exe')('git/trees', method='POST', payload=payload)
        self.assertEqual(str(caught.exception), 'github_request_failed')

    def test_profile_lock_excludes_concurrent_runs_and_recovers_on_release(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'runner.lock'
            with local.profile_lock(path):
                with self.assertRaises(local.LocalError) as caught:
                    with local.profile_lock(path):
                        self.fail('Concurrent profile access was allowed')
                self.assertEqual(caught.exception.code, 'already_running')
            with local.profile_lock(path):
                self.assertTrue(path.exists())

    def test_failure_has_fixed_log_code_without_raw_private_exception(self):
        with tempfile.TemporaryDirectory() as directory:
            output = io.StringIO()
            with mock.patch.object(local, 'execute', side_effect=RuntimeError('PRIVATE-AUTH')), \
                    contextlib.redirect_stdout(output):
                result = local.main(['--run', '--state-root', directory])
            self.assertEqual(result, 1)
            log = (Path(directory) / 'logs/latest.log').read_text()
            self.assertNotIn('PRIVATE', log + output.getvalue())
            self.assertEqual(json.loads(log.splitlines()[-1])['code'], 'local_collection_failed')

    def test_collection_error_keeps_safe_product_progress_in_log(self):
        with tempfile.TemporaryDirectory() as directory:
            error=local.collector.CollectionError('historical_rows_missing','Prior prices retained.',
                product_id='893073',stage='validating_history',loaded_rows=50,missing_previous_rows=20)
            with mock.patch.object(local,'execute',side_effect=error),contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(local.main(['--run','--state-root',directory]),1)
            record=json.loads((Path(directory)/'logs/latest.log').read_text().splitlines()[-1])
            self.assertEqual(record['code'],'historical_rows_missing')
            self.assertEqual(record['product_id'],'893073')
            self.assertEqual(record['loaded_rows'],50)
            self.assertEqual(record['missing_previous_rows'],20)

    def test_scheduled_skip_uses_kst_midnight_and_matching_healthy_generation(self):
        now = datetime(2026, 11, 4, 9, 0, tzinfo=local.collector.KST)
        manifest = {'last_success_at': '2026-11-04T05:00:00+09:00'}
        health = {'status': 'success', 'last_success_at': manifest['last_success_at']}
        self.assertTrue(local.already_successful_today(manifest, health, now))
        self.assertFalse(local.already_successful_today(manifest, {**health, 'status': 'failed'}, now))
        self.assertFalse(local.already_successful_today(manifest, {**health, 'last_success_at': 'other'}, now))
        for raw in ('2026-11-03T23:59:59+09:00', '2026-11-04T10:00:00+09:00', '2026-11-04T05:00:00'):
            with self.subTest(timestamp=raw):
                self.assertFalse(local.already_successful_today(
                    {'last_success_at': raw}, {'status': 'success', 'last_success_at': raw}, now))
        # Nov 3 UTC is already Nov 4 in the owner's timezone.
        raw = '2026-11-03T20:00:00Z'
        self.assertTrue(local.already_successful_today(
            {'last_success_at': raw}, {'status': 'success', 'last_success_at': raw}, now))


class StandaloneReleaseImportTests(unittest.TestCase):
    def release(self, root):
        release = root / 'installed release' / 'scripts'
        release.mkdir(parents=True)
        source = Path(__file__).resolve().parent
        for name in ('run_kream_local.py', 'setup_kream_session.py', 'collect_kream_promos.py'):
            shutil.copyfile(source / name, release / name)
        return release

    def test_direct_three_file_release_ignores_unrelated_scripts_packages(self):
        for regular_package in (False, True):
            with self.subTest(regular_package=regular_package), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                release = self.release(root)
                foreign = root / 'unrelated modules'
                scripts = foreign / 'scripts'
                scripts.mkdir(parents=True)
                if regular_package:
                    (scripts / '__init__.py').write_text('raise RuntimeError("UNRELATED-SCRIPTS-PACKAGE")\n')
                else:
                    (scripts / 'unrelated.py').write_text('UNRELATED = True\n')
                outside = root / 'working directory'
                outside.mkdir()
                environment = dict(os.environ, PYTHONPATH=str(foreign))
                for name in ('run_kream_local.py', 'setup_kream_session.py'):
                    result = subprocess.run([sys.executable, str(release / name), '--help'],
                                            cwd=outside, env=environment, capture_output=True,
                                            text=True, encoding='utf-8', errors='replace', timeout=15)
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertIn('usage:', result.stdout)
                    self.assertNotIn('UNRELATED-SCRIPTS-PACKAGE', result.stderr)
                # Exercise real startup beyond argparse without opening a browser
                # or making a network request; the missing CLI has a safe code.
                result = subprocess.run([
                    sys.executable, str(release / 'run_kream_local.py'), '--run',
                    '--state-root', str(root / 'state'),
                    '--gh-path', str(root / 'missing-gh-executable')],
                    cwd=outside, env=environment, capture_output=True, text=True,
                    encoding='utf-8', errors='replace', timeout=15)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertEqual(json.loads(result.stdout.splitlines()[-1])['code'], 'github_cli_missing')
                self.assertNotIn('Traceback', result.stderr)

    def test_repository_package_imports_keep_shared_module_identity(self):
        repository = Path(__file__).resolve().parents[1]
        code = (
            'from scripts import run_kream_local as runner; '
            'from scripts import collect_kream_promos as collector; '
            'from scripts import setup_kream_session as setup; '
            'assert runner.collector is collector; '
            'assert runner.wait_for_owner_login is setup.wait_for_owner_login; '
            'assert setup.session_state is collector.session_state; '
            'print("repository_import_ok")'
        )
        result = subprocess.run([sys.executable, '-c', code], cwd=repository,
                                env=dict(os.environ, PYTHONPATH=''), capture_output=True,
                                text=True, encoding='utf-8', errors='replace', timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.strip(), 'repository_import_ok')


if __name__ == '__main__':
    unittest.main()
