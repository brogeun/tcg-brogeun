"""Offline checks: budgets, resumable state, and fail-closed website promotion."""
import copy
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest import mock

import run_chinese_daily as daily


class Clock:
    def __init__(self): self.now = 0
    def time(self): return self.now
    def sleep(self, seconds): self.now += seconds


class ChineseDailyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        (self.root / 'data/chinese-sets').mkdir(parents=True)
        daily.base.save_json(self.root / 'data/chinese-catalog.json', {'sets': []})
        self.previous = {
            'source': 'cardhobby', 'market': 'CN', 'currency': 'CNY', 'priceKind': 'auction_end_price',
            'observedAt': '2026-10-10T00:00:00+00:00',
            'cards': {'example': {'grades': {'psa10': {'totalAuctionCount': 2,
                'history': [{'date': '2026-10-09', 'priceMinor': 100}]}}}}, 'boxes': {}}
        daily.base.save_json(self.root / 'data/chinese-market.json', self.previous)
        self.original = (self.root / 'data/chinese-market.json').read_bytes()
        guard = mock.patch('urllib.request.OpenerDirector.open', side_effect=AssertionError('Offline only'))
        self.network = guard.start()
        self.addCleanup(guard.stop)
        self.addCleanup(self.network.assert_not_called)

    def budget(self):
        clock = Clock()
        return daily.Budget(clock=clock.time, sleep=clock.sleep), clock

    def test_global_attempt_limits_include_retries_and_shared_spacing(self):
        budget, clock = self.budget()
        starts = []
        for _ in range(300): budget.perform('search', lambda timeout: starts.append(clock.now))
        with self.assertRaises(daily.RequestLimit): budget.perform('search', lambda timeout: None)
        for _ in range(100): budget.perform('detail', lambda timeout: starts.append(clock.now))
        with self.assertRaises(daily.RequestLimit): budget.perform('detail', lambda timeout: None)
        self.assertEqual(budget.counts, {'search': 300, 'detail': 100})
        self.assertTrue(all(b - a >= 1.5 for a, b in zip(starts, starts[1:])))
        self.assertLess(clock.now, 600)

    def test_deadline_caps_http_timeout_and_stops_next_attempt(self):
        budget, clock = self.budget()
        clock.now = 599
        timeouts = []
        budget.perform('search', lambda timeout: timeouts.append(timeout))
        self.assertEqual(timeouts, [1])
        with self.assertRaises(daily.RequestLimit): budget.perform('detail', lambda timeout: None)
        with self.assertRaises(daily.RequestLimit): budget.pause(2)

    def test_search_retries_are_three_budgeted_http_attempts(self):
        budget, _ = self.budget()
        with mock.patch.object(daily, 'public_json', side_effect=TimeoutError('synthetic timeout')) as request:
            with self.assertRaises(TimeoutError):
                daily.collector.fetch_with_retry('CSV9C', 1, attempts=3,
                    fetcher=daily.search_fetcher(budget), sleeper=budget.pause)
        self.assertEqual(request.call_count, 3)
        self.assertEqual(budget.counts['search'], 3)

    def test_attribute_budget_preserves_successful_progress_and_website_bytes(self):
        archive = self.root / 'archive'
        daily.base.save_json(archive / 'listing-details.json', {'schemaVersion': 1,
            'source': 'cardhobby', 'endpoint': daily.details.ENDPOINT, 'items': {}})
        quotes = [{'listingId': str(n), 'sourceUrl': f'https://www.cardhobby.com.cn/market/item/{n}'} for n in range(1, 102)]
        budget, _ = self.budget()
        with mock.patch.object(daily.collector, 'compile_results', return_value=({'records': quotes}, {})), \
             mock.patch.object(daily.collector, 'read_listing_details', return_value={}), \
             mock.patch.object(daily, 'public_json', return_value={'result': 1, 'data': []}):
            with self.assertRaises(daily.RequestLimit): daily.fill_attributes(archive, object(), budget)
        self.assertEqual(len(daily.base.read_json(archive / 'listing-details.json')['items']), 100)
        self.assertEqual((self.root / 'data/chinese-market.json').read_bytes(), self.original)

    def test_incomplete_build_and_lost_history_preserve_exact_published_bytes(self):
        complete = {'queriesPending': 0, 'listingDetailsPending': 0, 'publicAttributesRequired': True}
        lost = copy.deepcopy(self.previous)
        lost['cards'] = {}
        for updated, report in [(self.previous, {**complete, 'listingDetailsPending': 1}), (lost, complete)]:
            with self.subTest(report=report):
                with self.assertRaises(ValueError):
                    daily.promote(self.root, self.root / 'archive', self.root / 'reports',
                                  build=lambda *args: (updated, report))
                self.assertEqual((self.root / 'data/chinese-market.json').read_bytes(), self.original)

    def test_valid_complete_snapshot_is_the_only_promotion(self):
        updated = copy.deepcopy(self.previous)
        updated['observedAt'] = '2026-10-20T00:00:00+00:00'
        report = {'queriesPending': 0, 'listingDetailsPending': 0, 'publicAttributesRequired': True}
        daily.promote(self.root, self.root / 'archive', self.root / 'reports', build=lambda *args: (updated, report))
        self.assertEqual(daily.base.read_json(self.root / 'data/chinese-market.json'), updated)

    def test_incomplete_head_resumes_same_run_and_does_not_promote(self):
        identities = []
        for _ in range(2):
            budget, _ = self.budget()
            with mock.patch.object(daily, 'bootstrap', return_value=self.root / 'archive'), \
                 mock.patch.object(daily.collector, 'PriceCatalog'), \
                 mock.patch.object(daily.head, 'refresh', return_value={'complete': False}) as refresh, \
                 mock.patch.object(daily, 'fill_attributes') as attributes, \
                 mock.patch.object(daily, 'promote') as promote:
                with self.assertRaises(daily.RequestLimit): daily.run(self.root, budget)
                identities.append(refresh.call_args.args[2])
                self.assertEqual(refresh.call_args.kwargs['max_pages'], 100)
                self.assertEqual(refresh.call_args.kwargs['attempts'], 3)
                attributes.assert_not_called(); promote.assert_not_called()
        self.assertEqual(identities[0], identities[1])
        self.assertEqual((self.root / 'data/chinese-market.json').read_bytes(), self.original)

    def test_success_starts_fresh_head_next_time(self):
        identities = []
        for _ in range(2):
            budget, _ = self.budget()
            with mock.patch.object(daily, 'bootstrap', return_value=self.root / 'archive'), \
                 mock.patch.object(daily.collector, 'PriceCatalog'), \
                 mock.patch.object(daily.head, 'refresh', return_value={'complete': True, 'newUniqueListingIds': 0}) as refresh, \
                 mock.patch.object(daily, 'fill_attributes', return_value={'listingDetailsPending': 0}), \
                 mock.patch.object(daily, 'promote', return_value={'coverage': {}}):
                result = daily.run(self.root, budget)
                self.assertTrue(result['published'])
                identities.append(refresh.call_args.args[2])
        self.assertNotEqual(identities[0], identities[1])

    def test_bootstrap_rejects_path_traversal(self):
        seed = self.root / daily.SEED
        seed.parent.mkdir()
        with tarfile.open(seed, 'w:gz') as archive:
            member = tarfile.TarInfo('../outside.json'); member.size = 2
            archive.addfile(member, io.BytesIO(b'{}'))
        with self.assertRaises(ValueError): daily.bootstrap(self.root)


if __name__ == '__main__':
    unittest.main()
