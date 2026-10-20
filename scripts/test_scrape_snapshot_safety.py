"""Network-free failure injection for preserving actual daily scraper snapshots."""
import importlib.util
import io
import json
import os
import sys
import tempfile
import types
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch


def load_scraper():
    # Unit tests do not start/install a browser. Production still imports the
    # existing Selenium dependencies in the unchanged normal way.
    names = ['selenium', 'selenium.webdriver', 'selenium.webdriver.chrome',
             'selenium.webdriver.chrome.options', 'selenium.webdriver.support', 'selenium.webdriver.support.ui']
    stubs = {name: types.ModuleType(name) for name in names}
    stubs['selenium'].webdriver = stubs['selenium.webdriver']
    stubs['selenium.webdriver.chrome.options'].Options = object
    stubs['selenium.webdriver.support.ui'].WebDriverWait = object
    spec = importlib.util.spec_from_file_location('safe_daily_scraper', Path(__file__).with_name('scrape_snkrdunk.py'))
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, stubs):
        spec.loader.exec_module(module)
    return module


target = load_scraper()


class Response(io.BytesIO):
    pass


def products(count):
    return [{'id': str(100 + i), 'name': 'Current card ' + str(i), 'lastPrice': 100,
             'currency': 'JPY', 'kind': 'card'} for i in range(count)]


class DailySnapshotSafetyTests(unittest.TestCase):
    def fixture(self, folder):
        data = Path(folder)
        (data / 'history').mkdir()
        snapshots = {
            'top10-pokemon.json': {'fetchedAt': '2020-01-01T00:00:00Z', 'products': products(10)},
            'cards-detail.json': {'fetchedAt': '2020-01-01T00:00:00Z', 'custom': 'keep',
                                  'cards': {'1': {'id': '1', 'grades': {'raw': {'lowest_ask': 99}}, 'custom': 'keep'}}},
            'history/1.json': {'id': '1', 'updatedAt': '2020-01-01T00:00:00Z', 'custom': 'keep',
                               'history': [{'date': '2020-01-01', 'raw_price': 99}]},
        }
        original = {}
        for name, payload in snapshots.items():
            raw = json.dumps(payload, indent=3).encode()
            (data / name).write_bytes(raw)
            original[name] = raw
        return data, original

    def main_patches(self, data, scraped, transport):
        from contextlib import ExitStack, redirect_stdout, redirect_stderr
        stack = ExitStack()
        stack.enter_context(redirect_stdout(io.StringIO()))
        stack.enter_context(redirect_stderr(io.StringIO()))
        for name, value in [('DATA_DIR', data), ('TOP10_URLS', {'pokemon': 'public-category'}),
                            ('PRICE_URLS_PRIMARY', {}), ('scrape_url', lambda *a, **k: scraped),
                            ('collect_card_ids', lambda: {'1'}), ('fetch_usd_jpy', lambda: 150)]:
            stack.enter_context(patch.object(target, name, value))
        stack.enter_context(patch.object(target.urllib.request, 'urlopen', transport))
        stack.enter_context(patch.object(target.time, 'sleep', lambda _: None))
        return stack

    def test_all_category_grade_and_history_failures_preserve_exact_old_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            data, original = self.fixture(folder)
            def unavailable(*args, **kwargs):
                raise urllib.error.URLError('network fixture unavailable')
            with self.main_patches(data, [], unavailable), self.assertRaises(SystemExit) as result:
                target.main()
            self.assertEqual(result.exception.code, 1)
            for name, raw in original.items():
                self.assertEqual((data / name).read_bytes(), raw)

    def test_partial_category_keeps_old_file_and_is_not_reported_as_success(self):
        with tempfile.TemporaryDirectory() as folder:
            data, original = self.fixture(folder)
            with self.main_patches(data, products(1), lambda *a, **k: Response(b'{"points":[]}')):
                with self.assertRaises(SystemExit) as result:
                    target.main()
            self.assertEqual(result.exception.code, 1)
            self.assertEqual((data / 'top10-pokemon.json').read_bytes(), original['top10-pokemon.json'])

    def test_successful_category_can_refresh_but_failed_grades_history_stay_old_and_job_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            data, original = self.fixture(folder)
            with self.main_patches(data, products(10), lambda *a, **k: (_ for _ in ()).throw(TimeoutError('offline'))):
                with self.assertRaises(SystemExit) as result:
                    target.main()
            self.assertEqual(result.exception.code, 1)
            self.assertNotEqual((data / 'top10-pokemon.json').read_bytes(), original['top10-pokemon.json'])
            for name in ('cards-detail.json', 'history/1.json'):
                self.assertEqual((data / name).read_bytes(), original[name])

    def test_partial_grade_chart_failure_does_not_merge_or_refresh_history(self):
        with tempfile.TemporaryDirectory() as folder:
            data, original = self.fixture(folder)
            def source(request, **kwargs):
                if '/sales-chart/' not in request.full_url:
                    return Response(b'{"conditionId":18,"usedMinPrice":20}{"conditionId":22,"usedMinPrice":100}{"conditionId":23,"usedMinPrice":50}')
                if 'OptionId=22' in request.full_url:
                    return Response(b'{"points":[[1700000000000,123]]}')
                raise urllib.error.HTTPError(request.full_url, 503, 'fixture outage', {}, None)
            with self.main_patches(data, products(10), source), self.assertRaises(SystemExit):
                target.main()
            self.assertEqual((data / 'history/1.json').read_bytes(), original['history/1.json'])
            self.assertEqual(json.loads((data / 'cards-detail.json').read_bytes())['cards']['1']['custom'], 'keep')

    def test_one_failed_card_keeps_entire_previous_grade_snapshot(self):
        with tempfile.TemporaryDirectory() as folder:
            data, original = self.fixture(folder)
            def fetch(cid):
                if cid == '2':
                    raise ValueError('incomplete second card')
                return {'raw': {'lowest_ask': 123}}
            with patch.object(target, 'DATA_DIR', data), patch.object(target.time, 'sleep', lambda _: None):
                with self.assertRaises(ValueError):
                    target.refresh_cards_detail(['1', '2'], set(), 'new source check', 150, fetch)
            self.assertEqual((data / 'cards-detail.json').read_bytes(), original['cards-detail.json'])

    def test_successful_grade_rows_preserve_unrequested_rows_without_claiming_global_freshness(self):
        with tempfile.TemporaryDirectory() as folder:
            data, _ = self.fixture(folder)
            path = data / 'cards-detail.json'
            previous = json.loads(path.read_bytes()); previous['cards']['2'] = {'grades': {'raw': {'lowest_ask': 10}}}
            path.write_text(json.dumps(previous))
            with patch.object(target, 'DATA_DIR', data), patch.object(target.time, 'sleep', lambda _: None):
                target.refresh_cards_detail(['1'], set(), 'fresh successful row', 150, lambda _: {'raw': {'lowest_ask': 123}})
            payload = json.loads(path.read_bytes())
            self.assertEqual(payload['fetchedAt'], previous['fetchedAt'])
            self.assertEqual(payload['cards']['2'], previous['cards']['2'])
            self.assertEqual(payload['cards']['1']['fetchedAt'], 'fresh successful row')

    def test_atomic_write_failure_keeps_existing_file_and_cleans_temporary_copy(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'history.json'; path.write_bytes(b'previous exact bytes')
            with patch.object(target.os, 'replace', side_effect=OSError('disk failure')):
                with self.assertRaises(OSError):
                    target.atomic_json(path, {'history': []})
            self.assertEqual(path.read_bytes(), b'previous exact bytes')
            self.assertEqual(list(Path(folder).iterdir()), [path])

    def test_grade_empty_or_incomplete_html_is_not_a_successful_empty_quote(self):
        for body in (b'maintenance page', b'{"conditionId":18,"usedMinPrice":20}'):
            with patch.object(target.urllib.request, 'urlopen', lambda *a, **k: Response(body)):
                with self.assertRaises(ValueError):
                    target.fetch_grade_min_prices('1')

    def test_official_explicit_no_listing_chip_is_verified_absence_not_parse_failure(self):
        body = (b'{"conditionId":18,"usedMinPrice":7400,"hasListing":true}'
                b'{"conditionId":22,"usedMinPrice":86800,"hasListing":true,"listingCount":1}'
                b'{"conditionId":23,"text":"PSA9","hasListing":false}')
        with patch.object(target.urllib.request, 'urlopen', lambda *a, **k: Response(body)):
            grades = target.fetch_grade_min_prices('881429')
        self.assertEqual(set(grades), {'raw', 'psa10'})
        self.assertEqual(grades['raw']['lowest_ask'], 7400)

    def test_successful_sources_with_no_new_chart_points_do_not_relabel_old_history(self):
        with tempfile.TemporaryDirectory() as folder:
            data, original = self.fixture(folder)
            def source(request, **kwargs):
                if '/sales-chart/' in request.full_url:
                    return Response(b'{"points":[]}')
                return Response(b'{"conditionId":18,"usedMinPrice":20}{"conditionId":22,"usedMinPrice":100}{"conditionId":23,"usedMinPrice":50}')
            with self.main_patches(data, products(10), source):
                target.main()
            self.assertEqual((data / 'history/1.json').read_bytes(), original['history/1.json'])
            self.assertNotEqual((data / 'cards-detail.json').read_bytes(), original['cards-detail.json'])

    def test_box_page_budget_is_not_misreported_as_complete_volume(self):
        with tempfile.TemporaryDirectory() as folder:
            data, _ = self.fixture(folder)
            old = json.dumps({'id': '1', 'updatedAt': 'old', 'history': [{'date': '2020-01-01', 'box_price': 99}]}).encode()
            (data / 'history/1.json').write_bytes(old)
            def source(request, **kwargs):
                if '/sales-history?' in request.full_url:
                    return Response(json.dumps({'history': [{'date': '2026/10/20', 'price': 100, 'size': 1}] * 20}).encode())
                return Response(b'{"conditionId":18,"usedMinPrice":20}{"conditionId":22,"usedMinPrice":100}{"conditionId":23,"usedMinPrice":50}')
            with self.main_patches(data, products(10), source):
                target.main()
            self.assertEqual((data / 'history/1.json').read_bytes(), old)

    def test_box_http_failure_is_failed_collection_not_a_normal_budget_skip(self):
        with tempfile.TemporaryDirectory() as folder:
            data, _ = self.fixture(folder)
            old = json.dumps({'id': '1', 'updatedAt': 'old', 'history': [{'date': '2020-01-01', 'box_price': 99}]}).encode()
            (data / 'history/1.json').write_bytes(old)
            def source(request, **kwargs):
                if '/sales-history?' in request.full_url:
                    raise urllib.error.HTTPError(request.full_url, 503, 'source outage', {}, None)
                return Response(b'{"conditionId":18,"usedMinPrice":20}{"conditionId":22,"usedMinPrice":100}{"conditionId":23,"usedMinPrice":50}')
            with self.main_patches(data, products(10), source), self.assertRaises(SystemExit) as result:
                target.main()
            self.assertEqual(result.exception.code, 1)
            self.assertEqual((data / 'history/1.json').read_bytes(), old)

    def test_partial_thirty_product_category_does_not_replace_last_complete_list(self):
        with tempfile.TemporaryDirectory() as folder:
            data = Path(folder)
            path = data / 'price-pokemon-card.json';path.write_bytes(b'last complete category bytes')
            with patch.object(target, 'DATA_DIR', data), self.assertRaises(ValueError):
                target.save_payload(path.name, 'pokemon-card', products(29), 'new timestamp')
            self.assertEqual(path.read_bytes(), b'last complete category bytes')

    def test_manual_boxes_outside_current_top_thirty_are_excluded_and_old_grades_retained(self):
        with tempfile.TemporaryDirectory() as folder:
            data, _ = self.fixture(folder)
            path = data / 'cards-detail.json'
            payload = json.loads(path.read_bytes())
            old_box_row = {'id': '136031', 'grades': {'raw': {'lowest_ask': 999}}, 'fetchedAt': 'old', 'custom': 'keep'}
            payload['cards']['136031'] = old_box_row
            payload['cards']['136033'] = {**old_box_row, 'id': '136033'}
            path.write_text(json.dumps(payload))
            (data / 'manual-boxes-onepiece.json').write_text(json.dumps({'products': [
                {'id': '136031', 'name': 'Romance Dawn Box'},
                {'id': '136033', 'name': 'Pillars Of Strength Box'}]}))
            (data / 'history/136031.json').write_text(json.dumps({'id': '136031', 'updatedAt': 'old',
                'history': [{'date': '2020-01-01', 'box_price': 99, 'raw_price': 999}]}))
            visited = []
            def source(request, **kwargs):
                visited.append(request.full_url)
                if any('/' + cid + '/' in request.full_url for cid in ('136031', '136033')):
                    self.assertIn('/sales-history?', request.full_url)
                    return Response(b'{"history":[]}')
                if any(request.full_url.endswith('/' + cid) for cid in ('136031', '136033')):
                    self.fail('Verified box must never request card grade chips')
                if '/sales-chart/' in request.full_url:
                    return Response(b'{"points":[]}')
                return Response(b'{"conditionId":18,"usedMinPrice":20}{"conditionId":22,"usedMinPrice":100}{"conditionId":23,"usedMinPrice":50}')
            with self.main_patches(data, products(10), source), patch.object(target, 'collect_card_ids', lambda: {'1', '136031', '136033'}):
                target.main()
            refreshed = json.loads(path.read_bytes())
            self.assertEqual(refreshed['cards']['136031'], {**old_box_row, 'kind': 'box'})
            self.assertEqual(refreshed['cards']['136033'], {**old_box_row, 'id': '136033', 'kind': 'box'})
            self.assertEqual(refreshed['fetchedAt'], payload['fetchedAt'])
            self.assertEqual(refreshed['collection']['checkedCardIds'], ['1'])
            self.assertTrue(any('/136031/sales-history?' in url for url in visited))

    def test_explicit_box_sources_cover_same_tracked_inputs_without_name_guesses(self):
        with tempfile.TemporaryDirectory() as folder:
            data = Path(folder)
            sources = {
                'price-onepiece.json': {'products': [{'id': '1', 'name': 'Unknown Box'},
                    {'id': '2', 'name': 'Box promotion [P-002]', 'kind': 'card'},
                    {'id': '3', 'name': 'Explicit old box', 'kind': 'box'}]},
                'top10-pokemon.json': {'products': [{'id': '4', 'categoryId': 14}]},
                'manual-boxes-onepiece.json': {'products': [{'id': '5'}]},
                'price-pokemon-box.json': {'products': [{'id': '6'}]},
                'cards-meta.json': {'cards': [{'id': '7', 'kind': 'box'}, {'id': '8', 'kind': 'card'}]},
                'cards-meta-index.json': {'9': {'kind': 'box'}, '10': {'name': 'Ambiguous Box'}},
                'all-cards.json': {'details': [{'id': '11', 'kind': 'box'}], 'boxes': ['12']},
            }
            for name, document in sources.items():
                (data / name).write_text(json.dumps(document))
            with patch.object(target, 'DATA_DIR', data):
                self.assertEqual(target.collect_explicit_box_ids(), {'3', '4', '5', '6', '7', '9', '11', '12'})
                self.assertEqual(target.collect_explicit_box_ids(False), {'3', '4', '5', '6'})
                result = target.preserve_product_metadata('price-onepiece-card.json', [
                    {'id': '5', 'kind': 'card', 'name': 'old wrong kind'}, {'id': '2', 'kind': 'card', 'name': 'Box promotion [P-002]'}])
            self.assertEqual(result[0]['kind'], 'box')
            self.assertEqual(result[1]['kind'], 'card')

    def official_html(self, cid='136033', categories=(14,)):
        product = {'id': int(cid), 'name': 'ONE PIECE Card Game Booster Pack Pillars Of Strength Box',
                   'categories': [{'id': key, 'name': 'trading_card'} for key in categories],
                   'apparelInfo': {'isTradingCard': False}}
        return '<script>self.__next_f.push(' + json.dumps([1, json.dumps({'apparelData': product})]) + ')</script>'

    def test_official_id_bound_category_fourteen_replaces_no_missing_grade_chips(self):
        body = self.official_html().encode()
        with patch.object(target.urllib.request, 'urlopen', lambda *a, **k: Response(body)):
            with self.assertRaises(target.VerifiedBoxProduct):
                target.fetch_grade_min_prices('136033')
        complete_chips = '{"conditionId":18,"usedMinPrice":20}{"conditionId":22,"usedMinPrice":100}{"conditionId":23,"usedMinPrice":50}'
        for body in (self.official_html('999'), self.official_html('999') + complete_chips,
                     self.official_html(categories=(25,)), self.official_html(categories=(14, 25)), 'Unclassified Box'):
            with self.subTest(body=body), patch.object(target.urllib.request, 'urlopen', lambda *a, **k: Response(body.encode())):
                with self.assertRaises(ValueError) as result:
                    target.fetch_grade_min_prices('136033')
                self.assertNotIsInstance(result.exception, target.VerifiedBoxProduct)

    def test_box_only_metadata_does_not_claim_any_grade_price_was_checked(self):
        with tempfile.TemporaryDirectory() as folder:
            data, _ = self.fixture(folder)
            before = json.loads((data / 'cards-detail.json').read_bytes())
            with patch.object(target, 'DATA_DIR', data):
                target.refresh_cards_detail([], {'2'}, 'new source check', 150,
                                            lambda _: self.fail('No box should request card grades'))
            after = json.loads((data / 'cards-detail.json').read_bytes())
            self.assertEqual(after['fetchedAt'], before['fetchedAt'])
            self.assertEqual(after['cards']['1'], before['cards']['1'])
            self.assertEqual(after['cards']['2'], {'id': '2', 'grades': {}, 'kind': 'box'})
            self.assertEqual(after['collection']['checkedCardIds'], [])

    def test_new_official_box_uses_box_history_and_keeps_prior_grade_prices_and_time(self):
        with tempfile.TemporaryDirectory() as folder:
            data, _ = self.fixture(folder)
            path = data / 'cards-detail.json'
            previous = json.loads(path.read_bytes())
            box_row = {'id': '216885', 'grades': {'raw': {'lowest_ask': 999}}, 'fetchedAt': 'old', 'kind': 'card'}
            previous['cards']['216885'] = box_row
            path.write_text(json.dumps(previous))
            (data / 'history/216885.json').write_text(json.dumps({'id': '216885', 'updatedAt': 'old',
                'history': [{'date': '2020-01-01', 'raw_price': 999}]}))
            visited = []
            def source(request, **kwargs):
                url = request.full_url
                visited.append(url)
                if url.endswith('/216885'):
                    return Response(self.official_html('216885').encode())
                if '/216885/' in url:
                    self.assertIn('/sales-history?', url)
                    return Response(b'{"history":[]}')
                if '/sales-chart/' in url:
                    return Response(b'{"points":[]}')
                return Response(b'{"conditionId":18,"usedMinPrice":20}{"conditionId":22,"usedMinPrice":100}{"conditionId":23,"usedMinPrice":50}')
            with self.main_patches(data, products(10), source), patch.object(target, 'collect_card_ids', lambda: {'1', '216885'}):
                target.main()
            result = json.loads(path.read_bytes())
            self.assertEqual(result['cards']['216885'], {**box_row, 'kind': 'box'})
            self.assertEqual(result['fetchedAt'], previous['fetchedAt'])
            self.assertEqual(result['collection']['checkedCardIds'], ['1'])
            self.assertEqual(result['collection']['verifiedBoxIds'], ['216885'])
            self.assertTrue(any('/216885/sales-history?' in url for url in visited))

    def test_official_box_discovery_does_not_hide_another_real_card_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            data, original = self.fixture(folder)
            def fetch(cid):
                if cid == '2':
                    raise target.VerifiedBoxProduct('official ID-bound category 14 fixture')
                raise ValueError('Real incomplete card source')
            with patch.object(target, 'DATA_DIR', data), patch.object(target.time, 'sleep', lambda _: None):
                with self.assertRaises(ValueError):
                    target.refresh_cards_detail(['2', '1'], set(), 'new check', 150, fetch)
            self.assertEqual((data / 'cards-detail.json').read_bytes(), original['cards-detail.json'])


if __name__ == '__main__':
    unittest.main()
