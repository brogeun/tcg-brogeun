import copy
import json
import subprocess
import unittest
from datetime import datetime, timezone
from pathlib import Path

from export_daily_card_charts import project
from snkrdunk_sale_day import sale_day


class DailyCardChartTests(unittest.TestCase):
    def source(self):
        midnight = datetime.fromisoformat('2026-11-18T00:00:00+09:00')
        raw = {'id': '886017', 'grade': 'raw', 'conditionCode': 18, 'conditionLabel': 'A',
               'conditionLabelVerified': True, 'status': 'ok', 'httpStatus': 200,
               'fetchedAt': '2026-11-18T01:00:00+00:00', 'freshLatestDate': '2026-11-18',
               'history': [{'date': '2026-11-18', 'price': 22500,
                            'sourceTimestampMs': midnight.timestamp() * 1000,
                            'sourceObservation': 'current-public-graded-chart'}]}
        psa = dict(raw, grade='psa10', conditionCode=22, conditionLabel='PSA10',
                   freshLatestDate=None, history=[])
        return {'reportKind': 'market-price-index-live-history', 'source': 'SNKRDUNK',
                'currency': 'JPY', 'timezone': 'Asia/Tokyo', 'collectionAsOfJST': '2026-11-18',
                'scopeSummary': {'complete': True, 'failedConditions': 0, 'requestedConditions': 2},
                'records': [raw, psa]}

    def test_latest_observation_and_verified_empty_keep_independent_dates(self):
        source = self.source()
        # An archived date can be newer than the latest accepted source point.
        source['records'][0]['history'].append({'date': '2026-11-19', 'price': 1})
        row = project(source)[886017 % 32]['886017']
        self.assertEqual(row['raw'][1], ['2026-11-18', 22500])
        self.assertEqual(len(row['psa10']), 1)
        self.assertFalse(any(project(source, {'886017'})))
        source['records'][0].pop('httpStatus')
        self.assertFalse(any(project(source)))

    def test_reject_unverified_and_incomplete_sources(self):
        for changes in ({'grade': 'psa10'}, {'httpStatus': 503}, {'conditionLabelVerified': False},
                        {'freshLatestDate': '2026-11-17'}):
            source = self.source()
            source['records'][0].update(changes)
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                project(source)
        source = self.source()
        source['records'][1] = copy.deepcopy(source['records'][0])
        with self.assertRaises(ValueError):
            project(source)

    def test_sale_dates_across_midnight(self):
        observed = datetime(2026, 11, 17, 16, 30, tzinfo=timezone.utc)
        self.assertEqual(sale_day('1時間前', observed), '2026-11-18')
        self.assertEqual(sale_day('2 hours ago', observed), '2026-11-17')
        self.assertEqual(sale_day('2026/11/12', observed), '2026-11-12')
        for invalid in ['unknown', '2026/11/19', '2026/02/31']:
            with self.assertRaises(ValueError):
                sale_day(invalid, observed)

    def test_browser_preserves_volume_and_only_normalizes_known_grade_dates(self):
        js = Path(__file__).resolve().parents[1] / 'assets/price-expanded.js'
        test = """
          const assert = require('node:assert/strict');
          global.window = global.document = {addEventListener(){}};
          require(process.argv[1]);
          const merge = window.PriceExpandedTest.marketHistory;
          const old = {source:'daily (sales-history 1ea)',updatedAt:'2026-11-18T03:00:00Z',
            history:[{date:'2026-11-17',raw_price:22222,total_vol:7,total_price:23000}]};
          const result=merge(old,JSON.parse(process.argv[2]));
          assert.deepEqual(result.history, [{date:'2026-11-17',total_vol:7,total_price:23000},
            {date:'2026-11-18',raw_price:22222}]);
          assert.equal(merge({...old,historyTimezone:'Asia/Tokyo'},null).history[0].date,'2026-11-17');
          assert.deepEqual(merge({source:'box backfill', history:[{date:'2026-11-17',box_price:1000}]},null).history,
            [{date:'2026-11-17',box_price:1000}]);
          assert.deepEqual(merge(null,JSON.parse(process.argv[2])).history,[{date:'2026-11-18',raw_price:22500}]);
          assert.deepEqual(merge(null,{raw:[1794950400],psa10:[1794950400]}).history,[]);
          assert.equal(old.history[0].raw_price,22222);
        """
        row = project(self.source())[886017 % 32]['886017']
        subprocess.run(['node', '-e', test, str(js), json.dumps(row)], check=True)


if __name__ == '__main__':
    unittest.main()
