"""Offline regressions for complete, truthful history rotation updates."""
import io
import json
import tempfile
import unittest
import urllib.error
from contextlib import ExitStack, redirect_stdout, redirect_stderr
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

import backfill_card_history as target


class Response(io.BytesIO):
    pass


class HistorySafetyTests(unittest.TestCase):
    day = '2026-10-20'

    def fixture(self, folder, cid='1'):
        path = Path(folder) / (cid + '.json')
        previous = {'id': cid, 'updatedAt': '2020-01-01T00:00:00Z', 'source': 'old source',
                    'historyTimezone': 'legacy preserved', 'userMetadata': {'keep': True},
                    'history': [{'date': self.day, 'raw_price': 100, 'total_price': 100, 'total_vol': 99}]}
        raw = json.dumps(previous, indent=3).encode()
        path.write_bytes(raw)
        return path, previous, raw

    def run_main(self, folder, opener, args=(), **patches):
        with ExitStack() as stack:
            stack.enter_context(redirect_stdout(io.StringIO()))
            stack.enter_context(redirect_stderr(io.StringIO()))
            stack.enter_context(patch.object(target, 'HISTORY_DIR', Path(folder)))
            stack.enter_context(patch.object(target, 'DATA_DIR', Path(folder) / 'data'))
            stack.enter_context(patch.object(target.sys, 'argv', ['backfill_card_history.py', *args]))
            stack.enter_context(patch.object(target.time, 'sleep', lambda _: None))
            stack.enter_context(patch.object(target.urllib.request, 'urlopen', opener))
            for name, value in patches.items():
                stack.enter_context(patch.object(target, name, value))
            return target.main()

    def reply(self, payload):
        payload = dict(payload)
        if 'points' in payload and 'salesChartOption' not in payload:
            payload['salesChartOption'] = ([{'id': option, 'localizedName': label}
                for option, label in target.GRADE_OPTION_LABELS.items()] if payload['points'] else [])
        return Response(json.dumps(payload).encode())

    def metadata(self, folder, name, payload):
        path = Path(folder) / 'data' / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload), encoding='utf-8')
        return path

    def row(self, **values):
        return {'date': self.day.replace('-', '/'), 'price': 100, **values}

    def empty(self, request, **kwargs):
        return self.reply({'history': []} if '/sales-history?' in request.full_url else {'points': []})

    def test_second_page_http_failure_never_replaces_volume_99_with_partial_1(self):
        for args in ((), ('--fresh',)):
            with self.subTest(args=args), tempfile.TemporaryDirectory() as folder:
                path, _, original = self.fixture(folder)
                calls = []
                def source(request, **kwargs):
                    calls.append(request.full_url)
                    if '/sales-chart/' in request.full_url:
                        return self.reply({'points': []})
                    if 'page=1&' in request.full_url:
                        return self.reply({'history': [self.row()]})
                    raise urllib.error.HTTPError(request.full_url, 503, 'offline second-page failure', {}, None)
                self.assertEqual(self.run_main(folder, source, args), 1)
                self.assertEqual(path.read_bytes(), original)
                self.assertEqual(len(calls), 8)  # six grades, then two volume pages

    def test_partial_grade_success_followed_by_failure_preserves_entire_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path, _, original = self.fixture(folder)
            def source(request, **kwargs):
                if 'OptionId=22' in request.full_url:
                    return self.reply({'points': [[1792497600000, 123]]})
                raise urllib.error.URLError('offline remaining grade')
            self.assertEqual(self.run_main(folder, source), 1)
            self.assertEqual(path.read_bytes(), original)

    def test_malformed_json_and_missing_source_arrays_are_actual_failures(self):
        for bad in (b'<html>blocked</html>', b'{}', b'{"points":null}',
                    b'{"points":[[1,"price"]],"salesChartOption":[{"id":22,"localizedName":"PSA10"}]}',
                    b'{"points":[[1,0.5]],"salesChartOption":[{"id":22,"localizedName":"PSA10"}]}'):
            with self.subTest(body=bad), tempfile.TemporaryDirectory() as folder:
                path, _, original = self.fixture(folder)
                self.assertEqual(self.run_main(folder, lambda *a, **k: Response(bad)), 1)
                self.assertEqual(path.read_bytes(), original)

    def test_invalid_volume_schema_date_or_price_preserves_original(self):
        invalid = ({}, {'history': None}, {'history': [self.row(date='unknown day')]},
                   {'history': [self.row(date='2026/02/30')]}, {'history': [self.row(price='USD 100')]},
                   {'history': [self.row(price=True)]})
        for payload in invalid:
            with self.subTest(payload=payload), tempfile.TemporaryDirectory() as folder:
                path, _, original = self.fixture(folder)
                def source(request, **kwargs):
                    return self.reply(payload if '/sales-history?' in request.full_url else {'points': []})
                self.assertEqual(self.run_main(folder, source), 1)
                self.assertEqual(path.read_bytes(), original)

    def test_verified_empty_is_successful_no_change_without_fresh_timestamp(self):
        with tempfile.TemporaryDirectory() as folder:
            path, _, original = self.fixture(folder)
            self.assertEqual(self.run_main(folder, self.empty), 0)
            self.assertEqual(path.read_bytes(), original)

    def test_verified_existing_values_are_no_change_and_keep_exact_original_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            path, _, original = self.fixture(folder)
            def source(request, **kwargs):
                if '/sales-chart/' in request.full_url:
                    return self.reply({'points': []})
                return self.reply({'history': [self.row()] * 99 if 'page=1&' in request.full_url else []})
            self.assertEqual(self.run_main(folder, source), 0)
            self.assertEqual(path.read_bytes(), original)

    def test_complete_sources_update_values_and_preserve_user_and_date_metadata(self):
        with tempfile.TemporaryDirectory() as folder:
            path, previous, _ = self.fixture(folder)
            def source(request, **kwargs):
                if '/sales-chart/' in request.full_url:
                    return self.reply({'points': []})
                return self.reply({'history': [self.row()] if 'page=1&' in request.full_url else []})
            self.assertEqual(self.run_main(folder, source), 0)
            after = json.loads(path.read_bytes())
            self.assertEqual(after['history'][0]['total_vol'], 1)
            self.assertNotEqual(after['updatedAt'], previous['updatedAt'])
            self.assertEqual(after['historyTimezone'], previous['historyTimezone'])
            self.assertEqual(after['userMetadata'], previous['userMetadata'])

    def test_failed_card_keeps_bytes_while_independent_success_can_be_published(self):
        with tempfile.TemporaryDirectory() as folder:
            good, _, _ = self.fixture(folder, '1')
            bad, _, original = self.fixture(folder, '2')
            def source(request, **kwargs):
                if '/2/' in request.full_url:
                    raise urllib.error.HTTPError(request.full_url, 403, 'offline denied fixture', {}, None)
                if '/sales-chart/' in request.full_url:
                    return self.reply({'points': []})
                return self.reply({'history': [self.row()] if 'page=1&' in request.full_url else []})
            self.assertEqual(self.run_main(folder, source), 1)
            self.assertEqual(bad.read_bytes(), original)
            self.assertEqual(json.loads(good.read_bytes())['history'][0]['total_vol'], 1)

    def test_atomic_failure_retains_old_bytes_and_unrelated_temporary_file(self):
        with tempfile.TemporaryDirectory() as folder:
            path, _, original = self.fixture(folder)
            user_temp = Path(folder) / '1.tmp'; user_temp.write_bytes(b'user-owned temporary')
            with patch.object(target.os, 'replace', side_effect=OSError('offline write failure')):
                self.assertEqual(self.run_main(folder, self.empty, fetch_volume=lambda *a, **k: ({self.day: 1}, {self.day: 100})), 1)
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(user_temp.read_bytes(), b'user-owned temporary')
            self.assertEqual({p.name for p in Path(folder).iterdir()}, {'1.json', '1.tmp'})

    def test_concurrent_local_change_is_preserved_and_reported_as_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            path, _, _ = self.fixture(folder)
            def changed(*args, **kwargs):
                path.write_bytes(b'user concurrent change')
                return {self.day: 1}, {self.day: 100}
            self.assertEqual(self.run_main(folder, self.empty, fetch_volume=changed), 1)
            self.assertEqual(path.read_bytes(), b'user concurrent change')

    def test_invalid_existing_json_is_not_repaired_or_overwritten(self):
        with tempfile.TemporaryDirectory() as folder:
            path, _, original = self.fixture(folder)
            path.write_bytes(original + b'\x00')
            self.assertEqual(self.run_main(folder, self.empty), 1)
            self.assertEqual(path.read_bytes(), original + b'\x00')

    def test_chart_keeps_original_utc_day_instead_of_japanese_next_day(self):
        stamp = datetime(2026, 10, 20, 16, 30, tzinfo=timezone.utc).timestamp() * 1000
        with patch.object(target.urllib.request, 'urlopen', lambda *a, **k: self.reply({'points': [[stamp, 123]]})):
            self.assertEqual(target.fetch_chart_grade('1', 22), {'2026-10-20': 123})

    def test_volume_needs_explicit_empty_or_verified_cutoff_and_rejects_repeat(self):
        with patch.object(target.time, 'sleep', lambda _: None), patch.object(target.urllib.request, 'urlopen',
                lambda *a, **k: self.reply({'history': [self.row()]})):
            with self.assertRaisesRegex(target.CollectionError, 'page limit'):
                target.fetch_volume('1', max_pages=1)
            with self.assertRaisesRegex(target.CollectionError, 'Repeated'):
                target.fetch_volume('1', max_pages=3)
        with patch.object(target.time, 'sleep', lambda _: None), patch.object(target.urllib.request, 'urlopen',
                side_effect=[self.reply({'history': [self.row(date='2020/01/01')]}), self.reply({'history': []})]):
            self.assertEqual(target.fetch_volume('1', days_limit=40), ({}, {}))

    def test_mixed_old_then_new_row_in_one_page_preserves_bytes_and_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            path, _, original = self.fixture(folder)
            def source(request, **kwargs):
                return self.reply({'history': [self.row(date='2020/01/01'), self.row()]} if '/sales-history?' in request.full_url else {'points': []})
            self.assertEqual(self.run_main(folder, source, ('--days', '40')), 1)
            self.assertEqual(path.read_bytes(), original)

    def test_newer_next_page_after_cutoff_is_rejected_and_original_retained(self):
        with tempfile.TemporaryDirectory() as folder:
            path, _, original = self.fixture(folder)
            calls = []
            def source(request, **kwargs):
                if '/sales-chart/' in request.full_url:
                    return self.reply({'points': []})
                calls.append(request.full_url)
                return self.reply({'history': [self.row(date='2020/01/01')] if 'page=1&' in request.full_url else [self.row()]})
            self.assertEqual(self.run_main(folder, source, ('--days', '40')), 1)
            self.assertEqual(path.read_bytes(), original)
            self.assertEqual(len(calls), 2)

    def test_page_boundary_date_increase_is_rejected_before_any_cutoff(self):
        pages = [{'history': [self.row(date='2026/10/19')]}, {'history': [self.row(date='2026/10/20')]}]
        with patch.object(target.time, 'sleep', lambda _: None), patch.object(target.urllib.request, 'urlopen',
                side_effect=[self.reply(payload) for payload in pages]):
            with self.assertRaisesRegex(target.CollectionError, 'dates increased'):
                target.fetch_volume('1')

    def test_ordered_cutoff_checks_one_following_page_and_stops_without_full_crawl(self):
        pages = [{'history': [self.row(), self.row(date='2020/01/02')]},
                 {'history': [self.row(date='2020/01/01')]}]
        with patch.object(target.time, 'sleep', lambda _: None), patch.object(target.urllib.request, 'urlopen',
                side_effect=[self.reply(payload) for payload in pages]) as opener:
            self.assertEqual(target.fetch_volume('1', days_limit=40), ({self.day: 1}, {self.day: 100}))
            self.assertEqual(opener.call_count, 2)
        with patch.object(target.time, 'sleep', lambda _: None), patch.object(target.urllib.request, 'urlopen',
                lambda *a, **k: self.reply(pages[0])):
            with self.assertRaisesRegex(target.CollectionError, 'page limit'):
                target.fetch_volume('1', days_limit=40, max_pages=1)

    def test_short_volume_page_continues_until_explicit_empty(self):
        calls = []
        def source(request, **kwargs):
            calls.append(request.full_url)
            return self.reply({'history': [self.row()] if 'page=1&' in request.full_url else []})
        with patch.object(target.time, 'sleep', lambda _: None), patch.object(target.urllib.request, 'urlopen', source):
            self.assertEqual(target.fetch_volume('1'), ({self.day: 1}, {self.day: 100}))
        self.assertEqual(len(calls), 2)

    def test_explicit_box_lists_categories_kinds_and_verified_ids_skip_before_network(self):
        sources = [
            ('manual-boxes-pokemon.json', {'products': [{'id': '1', 'name': 'A real-looking [SET 001]'}]}),
            ('price-onepiece-box.json', {'products': [{'id': '1'}]}),
            ('top10-pokemon.json', {'products': [{'id': '1', 'kind': 'box'}]}),
            ('price-onepiece.json', {'products': [{'id': '1', 'categoryId': 14}]}),
            ('cards-meta.json', {'cards': {'1': {'categories': [{'id': 14}]}}}),
            ('cards-meta-index.json', {'1': {'kind': 'box'}}),
            ('all-cards.json', {'details': [{'id': '1', 'kind': 'box'}]}),
            ('cards-detail.json', {'cards': {'1': {'kind': 'box'}}}),
            ('cards-detail.json', {'cards': {}, 'collection': {'verifiedBoxIds': ['1']}}),
        ]
        for name, payload in sources:
            for args in ((), ('1', '--fresh')):
                with self.subTest(source=name, payload=payload, args=args), tempfile.TemporaryDirectory() as folder:
                    path, _, original = self.fixture(folder)
                    self.metadata(folder, name, payload)
                    def no_request(*a, **k):
                        self.fail('Explicit box products must be skipped before every grade/volume request')
                    self.assertEqual(self.run_main(folder, no_request, args), 0)
                    self.assertEqual(path.read_bytes(), original)

    def test_explicit_box_evidence_is_not_erased_by_generic_card_catalogue(self):
        with tempfile.TemporaryDirectory() as folder:
            path, _, original = self.fixture(folder)
            self.metadata(folder, 'manual-boxes-onepiece.json', {'products': [{'id': '1'}]})
            self.metadata(folder, 'cards-meta.json', {'cards': {'1': {'kind': 'card'}}})
            self.assertEqual(self.run_main(folder, lambda *a, **k: self.fail('No box requests')), 0)
            self.assertEqual(path.read_bytes(), original)

    def test_box_only_history_is_not_forced_through_grades_by_explicit_id_or_fresh(self):
        for args in (('1',), ('1', '--fresh'), ()):
            with self.subTest(args=args), tempfile.TemporaryDirectory() as folder:
                path, payload, _ = self.fixture(folder)
                payload['history'] = [{'date': self.day, 'box_price': 123, 'total_vol': 3}]
                path.write_text(json.dumps(payload, indent=4), encoding='utf-8')
                original = path.read_bytes()
                self.assertEqual(self.run_main(folder, lambda *a, **k: self.fail('No box API'), args), 0)
                self.assertEqual(path.read_bytes(), original)

    def test_saved_root_box_type_is_respected_without_any_catalogue(self):
        with tempfile.TemporaryDirectory() as folder:
            path, payload, _ = self.fixture(folder)
            payload['kind'] = 'box'
            path.write_text(json.dumps(payload), encoding='utf-8')
            original = path.read_bytes()
            self.assertEqual(self.run_main(folder, lambda *a, **k: self.fail('No box API'), ('1',)), 0)
            self.assertEqual(path.read_bytes(), original)

    def test_explicit_sealed_cards_skip_preserving_bytes_even_when_catalogue_says_card(self):
        for source in ('futuristic-market.json', 'anniversary-market.json', 'cards-detail.json'):
            with self.subTest(source=source), tempfile.TemporaryDirectory() as folder:
                path, _, original = self.fixture(folder)
                self.metadata(folder, source, {'products': {'1': {'id': '1', 'kind': 'card', 'packaging': 'sealed'}}})
                self.metadata(folder, 'cards-meta.json', {'cards': {'1': {'kind': 'card'}}})
                self.assertEqual(self.run_main(folder, lambda *a, **k: self.fail('No sealed grade API'), ('1', '--fresh')), 0)
                self.assertEqual(path.read_bytes(), original)

    def test_unknown_mixed_or_name_only_box_items_keep_existing_card_collection_behavior(self):
        for metadata, history in [
            ({'id': '1', 'kind': 'card', 'name': 'BOX Special Gift [SET 001]', 'packaging': 'opened'},
             [{'date': self.day, 'raw_price': 100}]),
            ({'id': '1', 'name': 'BOX Special Gift'}, [{'date': self.day, 'raw_price': 100, 'box_price': 100}]),
            ({'id': '1'}, [{'date': self.day, 'total_price': 100}]),
            ({'id': '1', 'kind': 'box', 'categories': [{'id': 14}, {'id': 25}]},
             [{'date': self.day, 'raw_price': 100}]),
        ]:
            with self.subTest(metadata=metadata), tempfile.TemporaryDirectory() as folder:
                path, payload, _ = self.fixture(folder)
                payload['history'] = history
                path.write_text(json.dumps(payload), encoding='utf-8')
                original = path.read_bytes()
                self.metadata(folder, 'all-cards.json', {'details': [metadata]})
                calls = []
                def source(request, **kwargs):
                    calls.append(request.full_url)
                    return self.empty(request, **kwargs)
                self.assertEqual(self.run_main(folder, source, ('1',)), 0)
                self.assertEqual(len(calls), 7)
                self.assertEqual(path.read_bytes(), original)

    def test_mismatched_catalogue_key_and_id_do_not_exclude_a_different_card(self):
        with tempfile.TemporaryDirectory() as folder:
            path, _, original = self.fixture(folder)
            self.metadata(folder, 'cards-meta.json', {'cards': {'1': {'id': '2', 'kind': 'box'}}})
            calls = []
            def source(request, **kwargs):
                calls.append(request.full_url)
                return self.empty(request, **kwargs)
            self.assertEqual(self.run_main(folder, source), 0)
            self.assertEqual(len(calls), 7)
            self.assertEqual(path.read_bytes(), original)

    def test_unreadable_classification_preserves_history_and_reports_failure_without_requests(self):
        with tempfile.TemporaryDirectory() as folder:
            path, _, original = self.fixture(folder)
            source = self.metadata(folder, 'cards-detail.json', {})
            source.write_bytes(b'broken classification JSON')
            self.assertEqual(self.run_main(folder, lambda *a, **k: self.fail('No unsafe requests')), 1)
            self.assertEqual(path.read_bytes(), original)

    def exclusion(self, **values):
        return {'productId': '1', 'reason': 'verified-not-single', 'appliesTo': 'all-observed-history',
                'evidence': 'Officially verified multi-card product', 'evidenceUrl': 'https://snkrdunk.com/apparels/1',
                'verifiedAt': '2026-10-12', **values}

    def scope_metadata(self, folder, rows):
        self.metadata(folder, 'market-price-index-dynamic-policy.json', {'scope': {'exclusionsSourcePath': 'data/exclusions.json'}})
        self.metadata(folder, 'exclusions.json', {'schemaVersion': 1, 'reportKind': 'card-index-platform-scope-exclusions',
                      'source': 'SNKRDUNK', 'exclusions': rows})

    def test_verified_non_single_scope_reason_is_reused_but_other_reasons_are_not_guessed(self):
        for reason, requests in [('verified-not-single', 0), ('not-a-grade-scope-reason', 7)]:
            with self.subTest(reason=reason), tempfile.TemporaryDirectory() as folder:
                path, _, original = self.fixture(folder)
                self.scope_metadata(folder, [self.exclusion(reason=reason)])
                calls = []
                def source(request, **kwargs):
                    calls.append(request.full_url)
                    return self.empty(request, **kwargs)
                self.assertEqual(self.run_main(folder, source, ('1',)), 0)
                self.assertEqual(len(calls), requests)
                self.assertEqual(path.read_bytes(), original)

    def test_invalid_verified_scope_or_escaping_path_fails_closed_without_requests(self):
        for row in [self.exclusion(evidenceUrl='https://untrusted.example/1'), self.exclusion(verifiedAt='2999-01-01'),
                    self.exclusion(appliesTo='today-only')]:
            with self.subTest(row=row), tempfile.TemporaryDirectory() as folder:
                path, _, original = self.fixture(folder)
                self.scope_metadata(folder, [row])
                self.assertEqual(self.run_main(folder, lambda *a, **k: self.fail('No requests')), 1)
                self.assertEqual(path.read_bytes(), original)
        with tempfile.TemporaryDirectory() as folder:
            path, _, original = self.fixture(folder)
            self.metadata(folder, 'market-price-index-dynamic-policy.json', {'scope': {'exclusionsSourcePath': 'data/../../unrelated.json'}})
            self.assertEqual(self.run_main(folder, lambda *a, **k: self.fail('No requests')), 1)
            self.assertEqual(path.read_bytes(), original)

    def test_each_grade_requires_its_verified_exact_id_and_localized_label(self):
        for option, label in target.GRADE_OPTION_LABELS.items():
            with self.subTest(option=option), patch.object(target.urllib.request, 'urlopen',
                    lambda *a, **k: self.reply({'points': [[1792497600000, 123]],
                                              'salesChartOption': [{'id': option, 'localizedName': label}]})):
                self.assertEqual(target.fetch_chart_grade('1', option), {self.day: 123})

    def test_nonempty_unverified_or_malformed_chart_options_preserve_bytes_and_fail(self):
        for choices in [[], None, {}, [{'id': 18, 'localizedName': 'A'}],
                        [{'id': 22, 'localizedName': 'A'}], [{'id': '22', 'localizedName': 'PSA10'}],
                        [{'id': 22}], [None], [{'id': 22, 'localizedName': 'PSA10'}] * 2]:
            with self.subTest(choices=choices), tempfile.TemporaryDirectory() as folder:
                path, _, original = self.fixture(folder)
                calls = []
                def source(request, **kwargs):
                    calls.append(request.full_url)
                    return self.reply({'points': [[1792497600000, 31000]], 'salesChartOption': choices})
                self.assertEqual(self.run_main(folder, source), 1)
                self.assertEqual(len(calls), 1)
                self.assertEqual(path.read_bytes(), original)

    def test_empty_points_and_empty_choices_are_legitimate_unavailable_but_malformed_choices_fail(self):
        for choices, expected in [([], 0), ([{'id': 22, 'localizedName': 'PSA10'}], 0),
                                  ([None], 1), (None, 1), ([{'id': 22, 'localizedName': 'A'}], 1)]:
            with self.subTest(choices=choices), tempfile.TemporaryDirectory() as folder:
                path, _, original = self.fixture(folder)
                def source(request, **kwargs):
                    if '/sales-history?' in request.full_url:
                        return self.reply({'history': []})
                    # The requested grade can be unavailable even when another valid option exists.
                    return self.reply({'points': [], 'salesChartOption': choices})
                self.assertEqual(self.run_main(folder, source), expected)
                self.assertEqual(path.read_bytes(), original)

    def test_unsupported_option_is_rejected_before_network(self):
        with patch.object(target.urllib.request, 'urlopen') as source:
            with self.assertRaisesRegex(target.CollectionError, 'Unsupported requested'):
                target.fetch_chart_grade('1', 999)
            source.assert_not_called()

    def test_actual_saved_sealed_product_is_excluded_without_inventing_new_prices(self):
        fixture = Path(__file__).resolve().parents[2] / 'operations-observation/api-fallback-push-20261020T192906Z'
        if not (fixture / 'futuristic-market.json').is_file():
            self.skipTest('Audit-only public metadata fixtures are not packaged')
        market = json.loads((fixture / 'futuristic-market.json').read_bytes())
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / '881433.json'
            path.write_bytes((fixture / 'history-881433-before.json').read_bytes())
            original = path.read_bytes()
            self.metadata(folder, 'futuristic-market.json', market)
            self.assertEqual(self.run_main(folder, lambda *a, **k: self.fail('No sealed grade requests'), ('881433', '--fresh')), 0)
            self.assertEqual(path.read_bytes(), original)


if __name__ == '__main__':
    unittest.main()
