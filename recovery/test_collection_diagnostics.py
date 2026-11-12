"""Offline checks that diagnostic observation never relaxes trade validation."""
from datetime import datetime
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

import collect_with_diagnostics as diagnostic

sys.path.insert(0, str(diagnostic.RELEASE))
import run_kream_local as runner


class ObservationChecks(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=diagnostic.ROOT / 'recovery')
        self.evidence = Path(self.temporary.name)
        self.events = []
        self.row = {'date': '2026-10-31', 'option': 'Ungraded A',
                    'price_krw': 10000, 'express_shipping': False,
                    'unrelated': 'excluded from evidence'}
        self.old = {'id': '1096144', 'rows': [dict(self.row), dict(self.row)]}
        self.original = runner.collector.validate_new_rows
        self.restore = diagnostic.install_observers(
            runner, self.evidence, lambda code, **details: self.events.append((code, details)))

    def tearDown(self):
        self.restore()
        self.temporary.cleanup()

    def test_repeated_identical_trades_cannot_disappear(self):
        with self.assertRaisesRegex(ValueError, 'Source snapshot is incomplete'):
            runner.collector.validate_new_rows(self.old, [self.row])
        saved = json.loads((self.evidence / '1096144-validation.json').read_bytes())
        self.assertFalse(saved['passed'])
        self.assertEqual(saved['missing_previous_rows'], 1)

    def test_valid_new_trades_still_pass(self):
        new = dict(self.row, date='2026-11-06')
        self.assertIsNone(runner.collector.validate_new_rows(self.old, [new, self.row, self.row]))
        saved = json.loads((self.evidence / '1096144-validation.json').read_bytes())
        self.assertTrue(saved['passed'])
        self.assertEqual(saved['observed_rows'], 3)

    def test_reversed_dates_still_fail(self):
        new = dict(self.row, date='2026-11-06')
        with self.assertRaisesRegex(ValueError, 'Source trade order is not newest first'):
            runner.collector.validate_new_rows(self.old, [self.row, self.row, new])
        saved = json.loads((self.evidence / '1096144-validation.json').read_bytes())
        self.assertEqual(saved['order_violations'], 1)

    def test_only_public_trade_fields_are_written(self):
        runner.collector.validate_new_rows(self.old, self.old['rows'])
        saved = json.loads((self.evidence / '1096144-observed.json').read_bytes())
        self.assertTrue(saved['diagnostic_only'])
        self.assertFalse(saved['complete'])
        self.assertNotIn('unrelated', saved['rows'][0])

    def test_original_functions_are_restored(self):
        self.restore()
        self.assertIs(runner.collector.validate_new_rows, self.original)

    def test_public_row_parse_failure_is_retained_and_propagated(self):
        self.restore()
        raw = {'option': 'Ungraded A', 'price': '10,000', 'date_raw': 'unsupported-label',
               'express_shipping': False, 'unrelated': 'excluded from evidence'}

        def failing_collect(page, card, old):
            return runner.collector.parse_row(raw, datetime.now(runner.collector.KST))

        with patch.object(runner.collector, 'collect', failing_collect):
            restore = diagnostic.install_observers(runner, self.evidence, lambda *a, **k: None)
            try:
                with self.assertRaises(ValueError):
                    runner.collector.collect(None, {'id': '1096144'}, self.old)
            finally:
                restore()
        saved = json.loads((self.evidence / '1096144-row-parse-failure.json').read_bytes())
        self.assertEqual(saved['row']['date_raw'], 'unsupported-label')
        self.assertNotIn('unrelated', saved['row'])


if __name__ == '__main__':
    unittest.main()
