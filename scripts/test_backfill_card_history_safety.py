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
            stack.enter_context(patch.object(target.sys, 'argv', ['backfill_card_history.py', *args]))
            stack.enter_context(patch.object(target.time, 'sleep', lambda _: None))
            stack.enter_context(patch.object(target.urllib.request, 'urlopen', opener))
            for name, value in patches.items():
                stack.enter_context(patch.object(target, name, value))
            return target.main()

    def reply(self, payload):
        return Response(json.dumps(payload).encode())

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
        for bad in (b'<html>blocked</html>', b'{}', b'{"points":null}', b'{"points":[[1,"price"]]}',
                    b'{"points":[[1,0.5]]}'):
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


if __name__ == '__main__':
    unittest.main()
