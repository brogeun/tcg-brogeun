import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import prepare_card_index_public_bundle as bundle

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

    def test_public_catalogue_omits_only_three_diagnostics_and_retains_repo_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            root, script = self.fixture(folder)
            row = {'id': '1', 'name': '기존 이름', 'brand': 'pokemon', 'kind': 'card',
                   'minPrice': 10, 'currency': 'USD', 'listingCount': '99+',
                   'userMetadata': {'preserve': True}, 'priceSource': {'originalPrice': 14000},
                   'priceCheckedAt': '2026-10-20T14:00:00Z', 'priceStatus': 'available'}
            document = {'details': [row], 'fetchedAt': '2026-10-20T14:00:00Z',
                        'searchPriceRefresh': {'complete': True}, 'customTopLevel': 'preserve'}
            original = json.dumps(document, ensure_ascii=False, indent=2).encode('utf-8')
            (root / 'data/all-cards.json').write_bytes(original)
            (root / '_deploy/data/all-cards.json').write_bytes(original)
            prices = b'{"prices":{"1":[10,"USD","99+","2026-10-20T14:00:00Z","available"]}}'
            (root / '_deploy/data/cards-prices.json').write_bytes(prices)
            result = subprocess.run([sys.executable, str(script), '--data-dir', str(root / '_deploy/data')],
                                    cwd=root, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            public = json.loads((root / '_deploy/data/all-cards.json').read_bytes())
            self.assertEqual(public, {**document, 'details': [{key: value for key, value in row.items()
                                                              if key not in bundle.SEARCH_INTERNAL_FIELDS}]})
            self.assertEqual((root / 'data/all-cards.json').read_bytes(), original)
            self.assertEqual((root / '_deploy/data/cards-prices.json').read_bytes(), prices)

    def test_actual_pages_limit_fails_without_truncating_catalogue_or_changing_original(self):
        with tempfile.TemporaryDirectory() as folder:
            root, script = self.fixture(folder)
            document = {'details': [{'id': '1', 'name': 'x' * bundle.MAX_ASSET_BYTES}], 'custom': 'keep'}
            original = json.dumps(document, separators=(',', ':')).encode('utf-8')
            (root / 'data/all-cards.json').write_bytes(original)
            public = root / '_deploy/data/all-cards.json'
            public.write_bytes(original)
            result = subprocess.run([sys.executable, str(script), '--data-dir', str(root / '_deploy/data')],
                                    cwd=root, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('maximum 26214400', result.stderr)
            self.assertIn('not truncated', result.stderr)
            self.assertEqual(public.read_bytes(), original)
            self.assertEqual((root / 'data/all-cards.json').read_bytes(), original)

    def test_saved_public_samples_project_below_pages_limit_after_copy_only_compaction(self):
        samples = Path(__file__).resolve().parents[2] / 'samples'
        paths = [samples / f'{brand}-{order}-100.json'
                 for brand in ('pokemon', 'onepiece') for order in ('popular', 'new')]
        if not all(path.is_file() for path in paths):
            self.skipTest('Audit-only saved samples are not packaged in the application')
        import refresh_search_prices as refresh
        from datetime import datetime, timezone
        basis = {'rates': {'USD': 1400, 'JPY': 9}}
        records = []
        for path in paths:
            source = json.loads(path.read_bytes())
            brand, order, _ = path.stem.split('-')
            rows, _ = refresh.collect_stream(
                lambda _b, _o, page, _n: source if page == 1 else {'tradingCards': []},
                brand, order, basis, now=lambda: datetime(2026, 10, 20, 14, tzinfo=timezone.utc))
            records.extend(rows.values())
        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder)
            path = target / 'all-cards.json'
            path.write_text(json.dumps({'details': records}, ensure_ascii=False), encoding='utf-8')
            before = len(json.dumps(records, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
            bundle.prepare_search_catalogue(target)
            after_rows = json.loads(path.read_bytes())['details']
            after = len(json.dumps(after_rows, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
            projected_products = 53372
            self.assertGreater(before / len(records) * projected_products, bundle.MAX_ASSET_BYTES)
            self.assertLess(after / len(records) * projected_products, bundle.MAX_ASSET_BYTES)

if __name__ == '__main__':
    unittest.main()
