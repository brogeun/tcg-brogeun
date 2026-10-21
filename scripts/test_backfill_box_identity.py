"""The box updater must never rewrite verified card or sealed-card histories."""
import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import backfill_box_history as target


class BoxIdentityTests(unittest.TestCase):
    def run_case(self, source, packaging, args):
        with tempfile.TemporaryDirectory() as folder:
            data = Path(folder)
            hist = data / 'history'
            hist.mkdir()
            original = b'{"id":"881433","history":[{"date":"2026-10-20","total_vol":324,"raw_price":32000}]}'
            path = hist / '881433.json'
            path.write_bytes(original)
            (data / 'price-pokemon-box.json').write_text(json.dumps({'products': [
                {'id': '881433', 'name': 'Sealed promo', 'kind': 'box'},
                {'id': '123', 'name': 'Actual booster box'}]}))
            (data / source).write_text(json.dumps({'products': {'881433': {
                'id': '881433', 'kind': 'card', 'packaging': packaging}}}))
            with patch.object(target, 'DATA', data), patch.object(target, 'HIST', hist), \
                    patch('sys.argv', ['backfill_box_history.py', *args]), \
                    patch.object(target, 'fetch_chart', return_value=[]) as chart, \
                    patch.object(target, 'fetch_volume_box', return_value=({}, {}, True)) as volume, \
                    patch.object(target.time, 'sleep'), contextlib.redirect_stdout(io.StringIO()):
                target.main()
            self.assertEqual(path.read_bytes(), original)
            self.assertNotIn('881433', [call.args[0] for call in chart.call_args_list])
            self.assertNotIn('881433', [call.args[0] for call in volume.call_args_list])
            return [call.args[0] for call in chart.call_args_list]

    def test_verified_cards_are_excluded_from_both_metadata_sources(self):
        for source in ('futuristic-market.json', 'anniversary-market.json'):
            for packaging in ('opened', 'sealed'):
                with self.subTest(source=source, packaging=packaging):
                    self.assertEqual(self.run_case(source, packaging, []), ['123'])

    def test_explicit_id_and_fresh_cannot_override_card_identity(self):
        for args in (['--only', '881433'], ['--only', '881433', '--fresh']):
            with self.subTest(args=args):
                self.assertEqual(self.run_case('futuristic-market.json', 'sealed', args), [])

    def test_limit_is_applied_after_cards_are_excluded(self):
        self.assertEqual(self.run_case('futuristic-market.json', 'sealed', ['--limit', '1']), ['123'])


if __name__ == '__main__':
    unittest.main()
