import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

class PublicBundleTests(unittest.TestCase):
    def fixture(self, folder):
        root = Path(folder)
        (root / 'scripts').mkdir()
        script = root / 'scripts/prepare_card_index_public_bundle.py'
        script.write_bytes(Path(__file__).with_name('prepare_card_index_public_bundle.py').read_bytes())
        (root / 'data').mkdir()
        (root / '_deploy/data').mkdir(parents=True)
        return root, script

    def test_prunes_only_disposable_deploy_sources_preserving_public_results_and_originals(self):
        with tempfile.TemporaryDirectory() as folder:
            root, script = self.fixture(folder)
            for name in ('card-index-platform-history-original.json.gz',
                         'market-price-index-live-history-20261011.json',
                         'market-price-index-model-state.json'):
                (root / 'data' / name).write_bytes(b'original')
                (root / '_deploy/data' / name).write_bytes(b'deploy-copy')
            cache = root / '_deploy/data/_card-index-source-cache'
            cache.mkdir()
            (cache / 'private-source.json.gz').write_bytes(b'source')
            public = root / '_deploy/data/market-price-index.json'
            public.write_bytes(b'public-verified-result')
            result = subprocess.run([sys.executable, str(script), '--data-dir', str(root / '_deploy/data')],
                                    cwd=root, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(cache.exists())
            self.assertEqual(public.read_bytes(), b'public-verified-result')
            self.assertTrue(all(path.read_bytes() == b'original' for path in (root / 'data').iterdir()))
            self.assertEqual(list((root / '_deploy/data').iterdir()), [public])

    def test_refuses_original_data_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            root, script = self.fixture(folder)
            original = root / 'data/card-index-platform-history-original.json.gz'
            original.write_bytes(b'user-original')
            result = subprocess.run([sys.executable, str(script), '--data-dir', str(root / 'data')],
                                    cwd=root, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(original.read_bytes(), b'user-original')

if __name__ == '__main__':
    unittest.main()
