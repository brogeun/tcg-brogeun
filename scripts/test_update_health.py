import copy
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from check_daily_freshness import DATASETS, inspect
from verify_beezie_snapshot import validate

class FreshnessTests(unittest.TestCase):
    def test_stale_source_cannot_be_hidden_by_recent_file_write(self):
        now = datetime(2026, 10, 20, 12, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            for name, (field, _) in DATASETS.items():
                item = {field: now.isoformat()}
                if name == 'fx-rates.json':
                    item.update(asOf='2026-10-19', rates={'USD': 1300, 'JPY': 9})
                (path / name).write_text(json.dumps(item), encoding='utf-8')
            self.assertEqual(inspect(path, now)['status'], 'healthy')
            (path / 'cards-prices.json').write_text(json.dumps({'fetchedAt': '2026-09-01T00:00:00Z'}))
            report = inspect(path, now)
            self.assertEqual(report['status'], 'incomplete')
            self.assertEqual(next(x for x in report['datasets'] if x['file'] == 'cards-prices.json')['status'], 'stale')

    def test_missing_invalid_and_future_dates_are_unavailable(self):
        now = datetime(2026, 10, 20, 12, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            for value in ('invalid', '2026-11-01T00:00:00Z', None):
                (path / 'cards-prices.json').write_text(json.dumps({'fetchedAt': value}))
                report = inspect(path, now)
                self.assertEqual(next(x for x in report['datasets'] if x['file'] == 'cards-prices.json')['status'], 'unavailable')

    def test_newly_collected_old_business_close_does_not_pass(self):
        now = datetime(2026, 10, 20, 12, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)
            (path / 'fx-rates.json').write_text(json.dumps({'updated': now.isoformat(),
                'asOf': '2026-10-08', 'rates': {'USD': 1300, 'JPY': 9}}))
            report = inspect(path, now)
            self.assertEqual(next(x for x in report['datasets'] if x['file'] == 'fx-rates.json')['status'], 'unavailable')

class BeezieTests(unittest.TestCase):
    def fixture(self):
        return {'ok': True, 'fetchedAt': 1000_000, 'results': [
            {'tier': str(i), 'ok': True, 'price': 10, 'avg': 12} for i in range(4)]}

    def test_complete_fresh_output_is_valid(self):
        self.assertTrue(validate(self.fixture(), 1010))

    def test_rejects_stale_future_partial_duplicate_and_nonfinite_results(self):
        cases = []
        for stamp in (0, 1100_000, float('nan')):
            item = self.fixture(); item['fetchedAt'] = stamp; cases.append(item)
        item = self.fixture(); item['results'][0]['ok'] = False; cases.append(item)
        item = self.fixture(); item['results'][0]['tier'] = '1'; cases.append(item)
        item = self.fixture(); item['results'][0]['price'] = float('inf'); cases.append(item)
        for item in cases:
            with self.subTest(item=item), self.assertRaises(ValueError):
                validate(item, 1010)

if __name__ == '__main__':
    unittest.main()
