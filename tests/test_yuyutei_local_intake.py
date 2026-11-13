import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import collect_yuyutei_market as market
import yuyutei_local_intake as local


class LocalIntakeTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.data = self.root / 'data'
        self.state = self.root / 'state'
        self.state.mkdir()
        self.output = self.root / 'receipt.json.gz'
        self.now = '2025-11-13T20:00:00Z'
        self.batch = {'game': 'onepiece', 'set': 'op05', 'name': 'OP05',
                      'url': 'https://yuyu-tei.jp/sell/opc/s/op05', 'observedAt': self.now,
                      'cards': [['10001', 'OP05-001', 'L', 'Card', 100, 1, 'in_stock', True, '', '']]}
        market.atomic_json(self.data / 'yuyutei-market.json', {'source': 'yuyutei'})

    def run_intake(self, published=None):
        return local.intake(self.data, self.state, self.output,
                            published=published or {}, now=self.now)

    def test_provider_hold_never_calls_collector_or_exports_old_prices(self):
        block = {'httpStatus': 403, 'nextEligibleAt': '2026-11-14T00:00:00Z',
                 'sourceUrl': 'https://yuyu-tei.jp/sell/poc/s/bkc', 'scope': 'provider'}
        with patch.object(local.market, 'main') as collect, patch.object(local.delivery, 'export') as export:
            state = self.run_intake({'cooldown': block})
        collect.assert_not_called()
        export.assert_not_called()
        self.assertEqual(state['phase'], 'waiting_for_source')
        self.assertEqual(state['attempts'], 0)
        self.assertFalse(self.output.exists())
        self.assertEqual(market.read_json(self.data / 'yuyutei-market.json', {})['cooldown'], block)

    def test_newer_waits_are_preserved_in_both_directions(self):
        old = {'sourceUrl': 'https://yuyu-tei.jp/sell/poc/s/bkc', 'nextEligibleAt': '2026-11-15T00:00:00Z'}
        local_doc = {'cooldown': old, 'listingCooldowns': [old]}
        shorter = dict(old, nextEligibleAt='2026-11-14T00:00:00Z')
        local.inherit_waits(local_doc, {'cooldown': shorter, 'listingCooldowns': [shorter]})
        self.assertEqual(local_doc['cooldown'], old)
        self.assertEqual(local_doc['listingCooldowns'], [old])

    def test_fresh_receipt_can_resume_without_any_collection_or_rewrite(self):
        with patch.object(local.market, 'main') as collect, \
             patch.object(local.market, 'validate_output', return_value=([], 1)), \
             patch.object(local.delivery, 'export', return_value=[self.batch]):
            first = self.run_intake()
            original = self.output.read_bytes()
            second = self.run_intake()
        self.assertEqual(collect.call_count, 1)
        self.assertEqual(first, second)
        self.assertEqual(second['phase'], 'ready_for_publication')
        self.assertEqual(self.output.read_bytes(), original)

    def test_source_403_is_recorded_once_and_never_retried_on_restart(self):
        with patch.object(local.market, 'main', side_effect=ValueError('source HTTP 403')) as collect:
            with self.assertRaisesRegex(ValueError, '403'):
                self.run_intake()
            with self.assertRaisesRegex(ValueError, 'stopped_for_diagnosis'):
                self.run_intake()
        self.assertEqual(collect.call_count, 1)
        saved = market.read_json(self.state / 'intake-state.json', {})
        self.assertEqual(saved['failures'], 1)
        self.assertEqual(saved['phase'], 'blocked')
        self.assertFalse(self.output.exists())

    def test_interrupted_attempts_share_request_budget_and_original_export_time(self):
        market.atomic_json(self.state / 'intake-state.json', {
            'phase': 'collecting', 'startedAt': '2025-11-13T19:00:00Z',
            'attempts': 1, 'failures': 0, 'sourceRuns': {}})
        market.atomic_json(self.data / 'yuyutei-market.json', {
            'lastRun': {'startedAt': '2025-11-13T19:00:00Z', 'providerRequests': 200}})
        with patch.object(local.market, 'main') as collect, \
             patch.object(local.market, 'validate_output', return_value=([], 1)), \
             patch.object(local.delivery, 'export', return_value=[self.batch]) as export:
            state = self.run_intake()
        arguments = collect.call_args.args[0]
        self.assertEqual(arguments[arguments.index('--max-requests') + 1], '50')
        export.assert_called_once_with(self.data, '2025-11-13T19:00:00Z')
        self.assertEqual(state['attempts'], 2)

    def test_no_new_original_observations_does_not_publish_retained_rows(self):
        with patch.object(local.market, 'main'), \
             patch.object(local.market, 'validate_output', return_value=([], 49586)), \
             patch.object(local.delivery, 'export', return_value=[]):
            with self.assertRaisesRegex(ValueError, 'no new original prices'):
                self.run_intake()
        self.assertFalse(self.output.exists())

    def test_request_reservations_are_saved_before_the_network_could_start(self):
        def reserve_without_network(arguments):
            limiter = market.RateLimiter(2, max_requests=2)
            limiter.wait('https://yuyu-tei.jp/sell/opc/s/op05')
            self.assertEqual(market.read_json(self.state / 'intake-state.json', {})['requestsReserved'], 1)
            limiter.wait('https://yuyu-tei.jp/sell/opc/s/op06')
            self.assertEqual(market.read_json(self.state / 'intake-state.json', {})['requestsReserved'], 2)
            raise ValueError('stopped_for_diagnosis: simulated interruption after reservation')
        with patch.object(local.market, 'main', side_effect=reserve_without_network):
            with self.assertRaisesRegex(ValueError, 'simulated interruption'):
                self.run_intake()
        self.assertEqual(market.read_json(self.state / 'intake-state.json', {})['requestsReserved'], 2)

    def test_duplicate_worker_cannot_enter_the_same_intake(self):
        with local.exclusive(self.state / 'intake.lock'):
            with self.assertRaises(OSError):
                with local.exclusive(self.state / 'intake.lock'):
                    self.fail('Duplicate source worker acquired the existing lock')


if __name__ == '__main__':
    unittest.main()
