"""Calendar boundaries and failed/skipped jobs must not create a green cycle."""
from datetime import datetime, timezone
import unittest
from daily_cycle import assess, plan


class DailyCycleTests(unittest.TestCase):
    def results(self, weekly=False):
        return {name: {'result': 'success' if weekly or name not in ('pokemon', 'onepiece') else 'skipped'}
                for name in ('plan', 'pokemon', 'onepiece', 'history', 'boxes', 'chinese', 'site')}

    def test_monday_uses_korean_day_even_on_sunday_utc(self):
        result = plan(datetime(2026, 10, 18, 19, 17, tzinfo=timezone.utc))
        self.assertEqual(result['source_day_kst'], '2026-10-19')
        self.assertEqual(result['weekly'], 'true')
        self.assertEqual(result['box_days'], '14')

    def test_sunday_reconciliation_is_90_days(self):
        result = plan(datetime(2026, 10, 17, 19, 17, tzinfo=timezone.utc))
        self.assertEqual(result['source_day_kst'], '2026-10-18')
        self.assertEqual(result['box_days'], '90')
        self.assertEqual(result['weekly'], 'false')

    def test_normal_day_keeps_recent_box_collection(self):
        result = plan(datetime(2026, 10, 20, 19, 17, tzinfo=timezone.utc))
        self.assertEqual(result['box_days'], '14')
        self.assertEqual(result['weekly'], 'false')

    def test_rotation_preserves_existing_utc_rule(self):
        now = datetime(2026, 12, 31, 19, 17, tzinfo=timezone.utc)
        result = plan(now)
        self.assertEqual(result['source_day_kst'], '2027-01-01')
        self.assertEqual(int(result['history_batch']), now.timetuple().tm_yday % 7)

    def test_naive_time_is_rejected(self):
        with self.assertRaises(ValueError):
            plan(datetime(2026, 10, 21))

    def test_normal_day_allows_only_intended_weekly_skips(self):
        self.assertEqual(assess(self.results(), 'false')['status'], 'success')

    def test_monday_requires_both_weekly_sources(self):
        self.assertEqual(assess(self.results(True), 'true')['status'], 'success')
        self.assertEqual(assess(self.results(), 'true')['incompleteJobs'], ['pokemon', 'onepiece'])

    def test_successful_deploy_does_not_hide_any_source_failure(self):
        for name in ('history', 'boxes', 'chinese', 'site', 'plan'):
            with self.subTest(name=name):
                results = self.results()
                results[name]['result'] = 'failure'
                self.assertEqual(assess(results, 'false')['incompleteJobs'], [name])

    def test_unexpected_skip_cancel_or_missing_result_fails(self):
        for state in ('skipped', 'cancelled', None):
            results = self.results()
            results['boxes']['result'] = state
            self.assertEqual(assess(results, 'false')['status'], 'incomplete')
        results = self.results()
        del results['chinese']
        self.assertEqual(assess(results, 'false')['status'], 'incomplete')

    def test_unplanned_weekly_execution_is_not_silently_accepted(self):
        self.assertEqual(assess(self.results(True), 'false')['status'], 'incomplete')


if __name__ == '__main__':
    unittest.main()
