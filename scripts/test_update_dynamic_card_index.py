"""Failure-injection checks for preserving the last verified active set."""
import os
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


if __name__ == '__main__':
    unittest.main()
