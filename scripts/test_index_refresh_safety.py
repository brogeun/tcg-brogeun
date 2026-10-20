"""Offline checks for cache binding, conservative refresh limits, and failure retention."""
import hashlib
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import date, datetime
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

import refresh_card_index_platform_source as source
import update_dynamic_card_index as updater
import build_dynamic_market_index as builder


class SafetyTests(unittest.TestCase):
    def fixture(self, folder):
        root = Path(folder)
        (root / 'scripts').mkdir()
        (root / 'data').mkdir()
        for name in updater.REQUIRED_SCRIPTS:
            (root / 'scripts' / name).write_text('# fixture\n', encoding='utf-8')
        for name in updater.BASELINE_INPUTS:
            (root / name).write_bytes(b'{}')
        exclusion = 'data/exclusions.json'
        (root / exclusion).write_bytes(b'{}')
        (root / 'data/market-price-index-dynamic-policy.json').write_text(
            json.dumps({'scope': {'exclusionsSourcePath': exclusion}}), encoding='utf-8')
        universe = 'data/card-index-platform-universe-20261012.json.gz'
        history = 'data/card-index-platform-history-20261012.json.gz'
        digest = hashlib.sha256(b'{}').hexdigest()
        state = b'{"model":"fixture"}'
        active = {'sourceAsOf': '2026-10-12', 'sourceSummary': {
            'universeSourcePath': universe, 'universeSourceSha256': digest,
            'liveCollection': {'sourcePath': history, 'sourceSha256': digest}},
            'modelStateRef': {'sha256': hashlib.sha256(state).hexdigest()}}
        raw = json.dumps(active).encode()
        sha = hashlib.sha256(raw).hexdigest()
        proof = json.dumps({'status': 'passed', 'dataSha256': sha}).encode()
        report = {'status': 'passed', 'dataSha256': sha,
                  'independentAudit': {'sha256': hashlib.sha256(proof).hexdigest()}}
        (root / 'data/market-price-index.json').write_bytes(raw)
        (root / 'data/market-price-index-model-state.json').write_bytes(state)
        (root / 'data/market-price-index-independent-verification.json').write_bytes(proof)
        (root / 'data/market-price-index-validation.json').write_text(json.dumps(report), encoding='utf-8')
        return root, universe, history

    def test_complete_bound_inputs_pass_without_network(self):
        with tempfile.TemporaryDirectory() as folder:
            root, _, _ = self.fixture(folder)
            result = updater.preflight(root)
            self.assertEqual(result['status'], 'passed')
            self.assertEqual(result['networkRequests'], 0)

    def test_missing_archive_fails_before_refresh(self):
        with tempfile.TemporaryDirectory() as folder:
            root, _, history = self.fixture(folder)
            (root / history).unlink()
            with self.assertRaisesRegex(FileNotFoundError, 'inputs/cache are incomplete'):
                updater.preflight(root)

    def test_wrong_cached_bytes_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root, universe, _ = self.fixture(folder)
            (root / universe).write_bytes(b'{"wrong":true}')
            with self.assertRaisesRegex(ValueError, 'archive differs'):
                updater.preflight(root)

    def test_mismatched_active_set_is_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            root, _, _ = self.fixture(folder)
            (root / 'data/market-price-index-model-state.json').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'matched verified set'):
                updater.preflight(root)

    def test_only_old_managed_cache_files_are_pruned(self):
        with tempfile.TemporaryDirectory() as folder:
            root, universe, history = self.fixture(folder)
            cache = root / updater.SOURCE_CACHE
            cache.mkdir()
            keep = ['card-index-platform-universe-current.json.gz', 'card-index-platform-history-current.json.gz']
            old = cache / 'card-index-platform-history-old.json.gz'
            note = cache / 'unrelated.txt'
            for name in keep:
                (cache / name).write_bytes(b'{}')
            old.write_bytes(b'old')
            note.write_bytes(b'preserve')
            active_path = root / 'data/market-price-index.json'
            active = json.loads(active_path.read_bytes())
            active['sourceSummary']['universeSourcePath'] = updater.SOURCE_CACHE + '/' + keep[0]
            active['sourceSummary']['liveCollection']['sourcePath'] = updater.SOURCE_CACHE + '/' + keep[1]
            active_path.write_text(json.dumps(active), encoding='utf-8')
            updater.prune_source_cache(root)
            self.assertFalse(old.exists())
            self.assertTrue(note.exists())
            self.assertTrue((root / universe).exists() and (root / history).exists())
            self.assertTrue(all((cache / name).exists() for name in keep))

    def test_source_reference_cannot_escape_data(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaisesRegex(ValueError, 'inside data'):
                updater.data_reference(Path(folder), '../outside.json')

    def test_global_rate_limit_is_eight_per_second(self):
        clock = [0.0]
        sleeps = []
        def sleep(seconds):
            sleeps.append(seconds)
            clock[0] += seconds
        with patch.object(source, 'RATE_NEXT', 0.0), patch.object(source.time, 'monotonic', lambda: clock[0]), \
             patch.object(source.time, 'sleep', sleep):
            for _ in range(4):
                source.rate_limit()
        self.assertEqual(source.MAX_REQUESTS_PER_SECOND, 8)
        self.assertEqual(sleeps, [0.125, 0.125, 0.125])

    def test_discovery_limit_marks_incomplete_and_stops(self):
        calls = []
        def listing(url):
            query = parse_qs(urlsplit(url).query)
            brand, order, page = query['brandId'][0], query['order'][0], int(query['page'][0])
            calls.append((brand, order, page))
            offset = (0 if brand == 'pokemon' else 100) + (0 if order == 'popular' else 10)
            return {'tradingCards': [{'id': str(offset + page), 'kind': 'card'}]}, 'fixture-sha'
        def chart(cid, brand, grade, *args):
            return {'id': cid, 'brand': brand, 'grade': grade, 'conditionCode': source.GRADES[grade],
                    'status': 'ok', 'history': [], 'fetchedAt': source.now()}
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'data').mkdir()
            (root / 'data/cards-meta.json').write_text('{"cards":[]}', encoding='utf-8')
            arguments = ['refresh', '--root', str(root), '--workers', '1']
            with patch.object(source, 'MAX_DISCOVERY_PAGES', 2), \
                 patch.object(source, 'listing_request', listing), patch.object(source, 'fetch_chart', chart), \
                 patch('sys.argv', arguments), redirect_stdout(io.StringIO()):
                result = source.main()
            history = json.loads((root / 'data/card-index-platform-history.json').read_bytes())
            universe = json.loads((root / 'data/card-index-platform-universe.json').read_bytes())
            self.assertEqual(result, 2)
            self.assertEqual(len(calls), 8)
            self.assertTrue(all(page <= 2 for _, _, page in calls))
            self.assertFalse(history['scopeSummary']['complete'])
            self.assertEqual(history['collectionPolicy']['maxRequestsPerSecond'], 8)
            self.assertTrue(all(stream['errors'][-1]['error'] == 'discovery-page-limit'
                                for stream in universe['discovery']['streams']))

    def test_new_catalog_rebinds_fresh_source_and_preserves_archive_prices(self):
        def chart(cid, brand, grade, *args):
            return {'id': cid, 'brand': brand, 'grade': grade, 'conditionCode': source.GRADES[grade],
                    'status': 'ok', 'range': 'all', 'history': [], 'fetchedAt': source.now()}
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'data').mkdir()
            product = {'id': '1', 'brand': 'pokemon', 'kind': 'card', 'name': 'fixture'}
            catalog_raw = json.dumps({'fetchedAt': 'new-catalog', 'cards': [product]}).encode()
            (root / 'data/cards-meta.json').write_bytes(catalog_raw)
            (root / 'data/market-price-index-dynamic-policy.json').write_bytes(b'{"scope":{}}')
            for name in ('market-price-index-live-history-20261011.json', 'market-price-index-live-history-20261012.json'):
                (root / 'data' / name).write_bytes(b'{"targetFingerprint":"old-catalog","records":[]}')
            archive_universe = root / 'data/archive-universe.json'
            archive_universe.write_text(json.dumps({'source': 'SNKRDUNK',
                'reportKind': 'card-index-platform-universe', 'products': [product]}), encoding='utf-8')
            archive_history = root / 'data/archive-history.json'
            stamp = datetime.fromisoformat('2026-10-10T00:00:00+09:00').timestamp() * 1000
            archive_history.write_text(json.dumps({'targetFingerprint': 'old-catalog', 'records': [{
                'id': '1', 'brand': 'pokemon', 'grade': 'raw', 'conditionCode': 18, 'status': 'ok',
                'history': [{'date': '2026-10-10', 'price': 100, 'sourceTimestampMs': stamp}]}]}), encoding='utf-8')
            archive_bytes = archive_history.read_bytes()
            arguments = ['refresh', '--root', str(root), '--workers', '1',
                         '--archive-universe', str(archive_universe), '--archive-history', str(archive_history)]
            with (patch.object(source, 'listing_request', lambda url: ({'tradingCards': []}, 'fixture')),
                  patch.object(source, 'fetch_chart', chart), patch('sys.argv', arguments), redirect_stdout(io.StringIO())):
                result = source.main()
            self.assertEqual(result, 0)
            payload = json.loads((root / 'data/card-index-platform-history.json').read_bytes())
            self.assertEqual(payload['targetFingerprint'], hashlib.sha256(catalog_raw).hexdigest())
            self.assertEqual(archive_history.read_bytes(), archive_bytes)
            prices, _, _, summary, _ = builder.load_inputs(root)
            self.assertEqual(prices['1']['grades']['raw'][date(2026, 10, 10)], 100)
            self.assertTrue(all(item['skipped'] == 'catalog-fingerprint-changed'
                                for item in summary['sourceSnapshots'][:2]))


if __name__ == '__main__':
    unittest.main()
