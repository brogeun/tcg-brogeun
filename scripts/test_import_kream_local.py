"""Use real Git objects to test the local-data trust boundary."""
import copy
from datetime import datetime
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

from scripts import collect_kream_promos as collector
from scripts import import_kream_local as importer


class LocalImportTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        source = Path(__file__).resolve().parents[1]
        for name in importer.FILES:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source / name, target)
        self.git('init', '-q')
        self.git('config', 'core.autocrlf', 'false')
        self.git('config', 'user.name', 'Local import test')
        self.git('config', 'user.email', 'test@example.invalid')
        self.git('add', '.')
        self.git('commit', '-qm', 'baseline')
        self.base = self.git('rev-parse', 'HEAD')
        self.original = self.bytes()

    def git(self, *args):
        result = subprocess.run(['git', '-C', str(self.root), *args], capture_output=True,
                                text=True, check=True)
        return result.stdout.strip()

    def bytes(self):
        return {name: (self.root / name).read_bytes() for name in importer.FILES}

    def candidate(self, *, remove_duplicate=False):
        manifest = collector.validate_bundle(self.root)
        attempted = datetime.now(collector.KST).isoformat()
        staged = {}
        for card in manifest['cards']:
            data = collector.unpack_history(json.loads((self.root / card['file'].lstrip('/')).read_bytes()))
            now = datetime.now(collector.KST).isoformat()
            data.update(snapshot_started_at=now, last_observed_at=now,
                        target_count=len(data['rows']))
            staged[card['id']] = data
        if remove_duplicate:
            data = staged['1096144']
            counts = {}
            removed = False
            rows = []
            for row in data['rows']:
                key = collector.signature(row)
                counts[key] = counts.get(key, 0) + 1
                if not removed and counts[key] > 1:
                    removed = True
                    continue
                rows.append(row)
            self.assertTrue(removed)
            for index, row in enumerate(rows):
                row['source_rank'] = index
            data.update(rows=rows, collected_count=len(rows), target_count=len(rows),
                        counts_by_exact_option=dict(collector.Counter(row['option'] for row in rows)))
        with mock.patch.object(collector, 'validate_new_rows') if remove_duplicate else mock.patch(
                'scripts.collect_kream_promos.validate_new_rows', wraps=collector.validate_new_rows):
            collector.publish_generation(self.root, manifest, staged, attempted)
        return staged

    def commit_candidate(self):
        self.git('add', '.')
        self.git('commit', '-qm', 'local candidate')
        source = self.git('rev-parse', 'HEAD')
        self.git('reset', '--hard', self.base)
        return source

    def assert_rejected_unchanged(self, source, base=None):
        before = self.bytes()
        with self.assertRaises((ValueError, KeyError, TypeError)):
            importer.import_generation(self.root, source, base or self.base)
        self.assertEqual(before, self.bytes())

    def test_valid_complete_generation_imports_all_nine_files(self):
        self.candidate()
        expected = self.bytes()
        total = collector.validate_bundle(self.root)['collected_trade_count']
        source = self.commit_candidate()
        result = importer.import_generation(self.root, source, self.base)
        self.assertEqual(result, {'cards': 7, 'trades': total, 'valid': True})
        self.assertEqual(expected, self.bytes())
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.base)

    def test_code_changes_are_rejected_without_execution(self):
        self.candidate()
        (self.root / 'run.py').write_text('raise SystemExit("UNTRUSTED")')
        self.assert_rejected_unchanged(self.commit_candidate())

    def test_symlink_data_is_rejected(self):
        self.candidate()
        path = self.root / importer.FILES[-1]
        self.git('add', '.')
        blob = self.git('hash-object', '-w', '--', str(path))
        # Build a symlink-mode Git entry without requiring Windows symlink rights.
        self.git('update-index', '--cacheinfo', '120000,' + blob + ',' + importer.FILES[-1])
        self.git('commit', '-qm', 'bad file mode')
        source = self.git('rev-parse', 'HEAD')
        self.git('reset', '--hard', self.base)
        self.assert_rejected_unchanged(source)

    def test_wrong_parent_and_injected_ref_are_rejected(self):
        self.candidate()
        source = self.commit_candidate()
        self.assert_rejected_unchanged(source, '0' * 40)
        self.assert_rejected_unchanged('HEAD:run.py')

    def test_concurrent_baseline_health_edit_is_preserved(self):
        self.candidate()
        source = self.commit_candidate()
        path = self.root / importer.FILES[1]
        health = json.loads(path.read_bytes())
        health['reason'] = 'concurrent owner update'
        path.write_bytes(collector.encoded(health))
        self.git('add', '.')
        self.git('commit', '-qm', 'concurrent health change')
        self.assert_rejected_unchanged(source)

    def test_unrelated_new_main_commit_is_allowed(self):
        self.candidate()
        source = self.commit_candidate()
        (self.root / 'unrelated.txt').write_text('retain this')
        self.git('add', '.')
        self.git('commit', '-qm', 'unrelated update')
        importer.import_generation(self.root, source, self.base)
        self.assertEqual((self.root / 'unrelated.txt').read_text(), 'retain this')

    def test_duplicate_loss_rejected_even_with_valid_hashes_and_counts(self):
        self.candidate(remove_duplicate=True)
        collector.validate_bundle(self.root)
        self.assert_rejected_unchanged(self.commit_candidate())

    def test_unexpected_metadata_cannot_upload_auth_values(self):
        self.candidate()
        path = self.root / importer.FILES[0]
        manifest = json.loads(path.read_bytes())
        manifest['cookies'] = [{'value': 'PRIVATE-TEST'}]
        path.write_bytes(collector.encoded(manifest))
        self.assert_rejected_unchanged(self.commit_candidate())

    def test_unused_packed_values_and_ignored_columns_are_rejected(self):
        for field in ('options', 'dates', 'dateLabels', 'row_columns', 'flag_value'):
            with self.subTest(field=field):
                self.candidate()
                name = importer.FILES[2]
                packed = json.loads((self.root / name).read_bytes())
                if field == 'row_columns':
                    packed['rows'][0].append('PRIVATE-TEST')
                elif field == 'flag_value':
                    packed['rows'][0][3] = 'PRIVATE-TEST'
                else:
                    packed[field].append('PRIVATE-TEST')
                raw = collector.encoded(packed)
                (self.root / name).write_bytes(raw)
                manifest_path = self.root / importer.FILES[0]
                manifest = json.loads(manifest_path.read_bytes())
                manifest['cards'][0]['version'] = hashlib.sha256(raw).hexdigest()[:16]
                manifest_path.write_bytes(collector.encoded(manifest))
                # Every bundle count/hash still validates. The importer must
                # reject otherwise-ignored content before writing any files.
                collector.validate_bundle(self.root)
                self.assert_rejected_unchanged(self.commit_candidate())

    def test_same_old_success_cannot_be_relabelled_as_fresh(self):
        path = self.root / importer.FILES[1]
        health = json.loads(path.read_bytes())
        health['status'] = 'success'
        health = {key: health[key] for key in ('schemaVersion', 'status', 'last_attempt_at', 'last_success_at')}
        health['trades'] = collector.validate_bundle(self.root)['collected_trade_count']
        path.write_bytes(collector.encoded(health))
        self.assert_rejected_unchanged(self.commit_candidate())

    def test_write_failure_rolls_back_all_target_files(self):
        self.candidate()
        source = self.commit_candidate()
        replacement = importer.replace_file
        calls = 0
        def fail_once(path, raw):
            nonlocal calls
            calls += 1
            if calls == 4:
                raise OSError('simulated disk failure')
            replacement(path, raw)
        with mock.patch.object(importer, 'replace_file', side_effect=fail_once):
            with self.assertRaises(OSError):
                importer.import_generation(self.root, source, self.base)
        self.assertEqual(self.original, self.bytes())

    def test_json_duplicates_and_nonfinite_values_rejected(self):
        for raw in (b'{"a":1,"a":2}', b'{"a":NaN}', b'{"a":Infinity}'):
            with self.assertRaises(ValueError):
                importer.strict_json(raw)


if __name__ == '__main__':
    unittest.main()
