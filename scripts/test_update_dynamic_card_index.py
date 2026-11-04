"""Failure-injection checks for preserving the last verified active set."""
import os
import gzip
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import update_dynamic_card_index as target


class PromotionTests(unittest.TestCase):
    def fixture(self, folder):
        root = Path(folder)
        (root / 'data').mkdir()
        stage = root / 'stage'
        stage.mkdir()
        names = ['market-price-index-model-state.json', 'market-price-index-independent-verification.json',
                 'market-price-index-validation.json', 'market-price-index.json']
        for name in names:
            (root / 'data' / name).write_bytes(('old:' + name).encode())
            (stage / name).write_bytes(('new:' + name).encode())
        return root, stage, names

    def test_success_replaces_the_complete_set(self):
        with tempfile.TemporaryDirectory() as folder:
            root, stage, names = self.fixture(folder)
            target.promote_verified_files(stage, root, 'isolated-test')
            self.assertTrue(all((root / 'data' / name).read_bytes() == (stage / name).read_bytes() for name in names))

    def test_every_partial_failure_restores_exact_old_bytes(self):
        for failed_call in (1, 2, 3, 4):
            with self.subTest(failed_call=failed_call), tempfile.TemporaryDirectory() as folder:
                root, stage, names = self.fixture(folder)
                real_replace, calls = os.replace, 0
                def replacement(source, destination):
                    nonlocal calls
                    calls += 1
                    if calls == failed_call:
                        raise OSError('injected replacement failure')
                    return real_replace(source, destination)
                with patch.object(target.os, 'replace', replacement):
                    with self.assertRaisesRegex(RuntimeError, 'previous active files were restored'):
                        target.promote_verified_files(stage, root, 'isolated-test')
                self.assertTrue(all((root / 'data' / name).read_bytes() == ('old:' + name).encode() for name in names))

    def test_incomplete_staging_does_not_change_active_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root, stage, names = self.fixture(folder)
            (stage / names[-1]).unlink()
            with self.assertRaises(FileNotFoundError):
                target.promote_verified_files(stage, root, 'isolated-test')
            self.assertTrue(all((root / 'data' / name).read_bytes() == ('old:' + name).encode() for name in names))


class ResumeTests(unittest.TestCase):
    def fixture(self, root):
        cache = root / target.SOURCE_CACHE
        cache.mkdir(parents=True)
        universe = cache / 'card-index-platform-universe-20261105-100000-fixture.json.gz'
        history = cache / 'card-index-platform-history-20261105-100000-fixture.json.gz'
        universe.write_bytes(gzip.compress(json.dumps({'source':'SNKRDUNK',
            'reportKind':'card-index-platform-universe','catalogReference':{'sha256':'current-catalog'}}).encode()))
        payload = {'source':'SNKRDUNK','reportKind':'market-price-index-live-history',
            'collectionAsOfJST':'2026-11-05','targetFingerprint':'current-catalog',
            'universePath':universe.relative_to(root).as_posix(),
            'universeFingerprint':hashlib.sha256(universe.read_bytes()).hexdigest()}
        history.write_bytes(gzip.compress(json.dumps(payload).encode()))
        return universe, history, payload

    def test_exact_catalog_same_day_pair_is_reused(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            universe, history, _ = self.fixture(root)
            self.assertEqual(target.reusable_sources(root, '2026-11-05', 'current-catalog'),
                             (universe.relative_to(root).as_posix(), history.relative_to(root).as_posix()))
            self.assertIsNone(target.reusable_sources(root, '2026-11-06', 'current-catalog'))
            self.assertIsNone(target.reusable_sources(root, '2026-11-05', 'changed-catalog'))
            self.assertIsNone(target.reusable_sources(root, '2026-11-05', 'current-catalog', universe.relative_to(root).as_posix()))

    def test_tampered_pair_is_retained_but_never_reused(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            universe, history, _ = self.fixture(root)
            universe.write_bytes(gzip.compress(b'{"different":true}'))
            self.assertIsNone(target.reusable_sources(root, '2026-11-05', 'current-catalog'))
            self.assertTrue(universe.exists() and history.exists())

    def test_source_reference_cannot_escape_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            universe, history, payload = self.fixture(root)
            payload['universePath'] = '../outside.json.gz'
            history.write_bytes(gzip.compress(json.dumps(payload).encode()))
            self.assertIsNone(target.reusable_sources(root, '2026-11-05', 'current-catalog'))
            self.assertTrue(universe.exists() and history.exists())


if __name__ == '__main__':
    unittest.main()

