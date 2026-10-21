"""A partial box source must retain the exact file and fail the daily cycle."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import backfill_box_history as target


class BoxFailureTests(unittest.TestCase):
    def test_incomplete_volume_retains_bytes_and_time_and_returns_failure(self):
        for flags in ([], ['--fresh']):
            with self.subTest(flags=flags), tempfile.TemporaryDirectory() as folder:
                data = Path(folder)
                hist = data / 'history'
                hist.mkdir()
                (data / 'price-pokemon-box.json').write_text(json.dumps({'products': [{'id': '123', 'kind': 'box'}]}))
                path = hist / '123.json'
                original = b'{"id":"123","updatedAt":"2026-10-20T01:00:00Z","history":[{"date":"2026-10-19","box_price":1000,"box_vol":2}]}'
                path.write_bytes(original)
                original_time = path.stat().st_mtime_ns
                with patch.object(target, 'DATA', data), patch.object(target, 'HIST', hist), \
                        patch('sys.argv', ['box', '--only', '123', *flags]), \
                        patch.object(target, 'fetch_chart', return_value=[]), \
                        patch.object(target, 'fetch_volume_box', return_value=({}, {}, False)), \
                        contextlib.redirect_stdout(io.StringIO()):
                    code = target.main()
                self.assertEqual(code, 1)
                self.assertEqual(path.read_bytes(), original)
                self.assertEqual(path.stat().st_mtime_ns, original_time)

    def test_valid_box_still_saves_its_prices_and_volume(self):
        with tempfile.TemporaryDirectory() as folder:
            data = Path(folder)
            hist = data / 'history'
            hist.mkdir()
            (data / 'price-pokemon-box.json').write_text(json.dumps({'products': [{'id': '123', 'kind': 'box'}]}))
            with patch.object(target, 'DATA', data), patch.object(target, 'HIST', hist), \
                    patch('sys.argv', ['box']), patch.object(target.time, 'sleep'), \
                    patch.object(target, 'fetch_chart', return_value=[]), \
                    patch.object(target, 'fetch_volume_box', return_value=({'2026-10-21': 3}, {'2026-10-21': 1200}, True)), \
                    contextlib.redirect_stdout(io.StringIO()):
                code = target.main()
            self.assertEqual(code, 0)
            result = json.loads((hist / '123.json').read_bytes())
            self.assertEqual(result['history'], [{'date': '2026-10-21', 'box_vol': 3, 'box_price': 1200}])


if __name__ == '__main__':
    unittest.main()
