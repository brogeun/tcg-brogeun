import json
import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from unittest.mock import patch
import fetch_fx_rates as fx


def row(day, value):
    return {"localTradedAt": day, "closePrice": value, "calcPrice": "999999"}


class FXTests(unittest.TestCase):
    now = datetime(2026, 9, 11, 4, tzinfo=fx.KST)

    def fetch(self, currency):
        return [row("2026-09-11", "999"), row("2026-09-10", "1,351.00" if currency == "USD" else "875.09")]

    def test_previous_day_and_units(self):
        result = fx.build_snapshot(self.now, self.fetch)
        self.assertEqual(result["asOf"], "2026-09-10")
        self.assertEqual(result["rates"], {"USD": 1351.0, "JPY": 8.7509, "JPY_PER_100": 875.09})

    def test_utc_runner_uses_kst_day(self):
        result = fx.build_snapshot(datetime(2026, 9, 10, 19, tzinfo=timezone.utc), self.fetch)
        self.assertEqual(result["targetDate"], "2026-09-10")

    def test_weekend_and_holiday(self):
        for day in (12, 13, 14, 15):
            result = fx.build_snapshot(datetime(2026, 9, day, 4, tzinfo=fx.KST),
                lambda c: [row("2026-09-11", "1351" if c == "USD" else "875.09")])
            self.assertEqual(result["asOf"], "2026-09-11")

    def test_unsorted_rows(self):
        got = fx.previous_close([row("2026-09-09", "1"), row("2026-09-10", "2")], date(2026, 9, 10))
        self.assertEqual(got[1], 2)

    def test_invalid_or_missing_close(self):
        for value in ("", "NaN", "Infinity", "-1", "0", None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                fx.previous_close([row("2026-09-10", value), row("2026-09-09", "100")], date(2026, 9, 10))

    def test_today_only_and_stale(self):
        for day in ("2026-09-11", "2026-08-01"):
            with self.assertRaises(ValueError):
                fx.previous_close([row(day, "100")], date(2026, 9, 10))

    def test_different_currency_dates(self):
        with self.assertRaises(ValueError):
            fx.build_snapshot(self.now, lambda c: [row("2026-09-10" if c == "USD" else "2026-09-09", "100")])

    def test_failure_keeps_existing_complete_file(self):
        with tempfile.TemporaryDirectory() as folder:
            dest = Path(folder) / "fx.json"
            dest.write_text('{"old":"snapshot"}', encoding="utf-8")
            def partial(currency):
                if currency == "JPY":
                    raise OSError("network error")
                return self.fetch(currency)
            self.assertEqual(fx.main([], self.now, partial, dest), 1)
            self.assertEqual(dest.read_text(), '{"old":"snapshot"}')

    def test_dry_run_and_success(self):
        with tempfile.TemporaryDirectory() as folder:
            dest = Path(folder) / "fx.json"
            self.assertEqual(fx.main(["--dry-run"], self.now, self.fetch, dest), 0)
            self.assertFalse(dest.exists())
            self.assertEqual(fx.main([], self.now, self.fetch, dest), 0)
            self.assertEqual(json.loads(dest.read_text())["asOf"], "2026-09-10")
            self.assertEqual(len(list(Path(folder).iterdir())), 1)

    def test_interrupted_replace_keeps_existing_file(self):
        with tempfile.TemporaryDirectory() as folder:
            dest = Path(folder) / "fx.json"
            dest.write_text("original", encoding="utf-8")
            with patch.object(fx.os, "replace", side_effect=OSError("disk error")):
                with self.assertRaises(OSError):
                    fx.main([], self.now, self.fetch, dest)
            self.assertEqual(dest.read_text(), "original")
            self.assertEqual(len(list(Path(folder).iterdir())), 1)


if __name__ == "__main__":
    unittest.main()
