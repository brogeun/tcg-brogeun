"""Reproduce truncated categories, rejected source data, and retained public bytes."""
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import checkpoint_daily_snapshot as checkpoint
from test_scrape_snapshot_safety import target
from refresh_search_prices import RefreshError


def rows(start, count, kind='card'):
    return [{'id': str(start + n), 'brandId': 'pokemon',
        'name': 'Verified product ' + str(start + n), 'kind': kind,
        'categoryId': 14 if kind == 'box' else 25,
        'minPrice': 100, 'minPriceFormat': 'US $100', 'listingCount': 1,
        'thumbnailUrl': 'https://cdn.snkrdunk.com/upload/example.jpg'} for n in range(count)]


class Client:
    def __init__(self, pages):
        self.pages, self.calls = pages, []

    def get_category(self, brand, category, order, page, size):
        self.calls.append((brand, category, order, page, size))
        return {'tradingCards': self.pages[page - 1] if page <= len(self.pages) else []}


class TypedCategoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.guard = patch.object(target, 'DATA_DIR', self.root)
        self.guard.start()
        self.addCleanup(self.guard.stop)
        now = datetime.now(timezone.utc)
        (self.root / 'fx-rates.json').write_text(json.dumps({'updated': now.isoformat(),
            'asOf': now.date().isoformat(), 'rates': {'USD': 1300, 'JPY': 9}}))

    def test_twenty_three_visible_products_continue_to_thirty_distinct_typed_offers(self):
        client = Client([rows(1, 23, 'box'), rows(24, 20, 'box')])
        products = target.scrape_price_category('pokemon', 'box', client)
        self.assertEqual(len(products), 30)
        self.assertEqual(len({p['id'] for p in products}), 30)
        self.assertTrue(all(p['kind'] == 'box' and p['currency'] == 'USD' and p['image'] for p in products))
        self.assertEqual([c[1] for c in client.calls], [14, 14])
        self.assertEqual([c[3] for c in client.calls], [1, 2])

    def test_duplicate_or_unpriced_rows_cannot_supply_the_missing_seven(self):
        for pages in ([rows(1, 23), rows(1, 23)], [rows(1, 29)],
                      [[{**r, 'minPrice': 0, 'minPriceFormat': 'US $--', 'listingCount': 0} for r in rows(1, 40)]]):
            path = self.root / 'price-pokemon-card.json'
            old = b'{"fetchedAt":"2020-01-01T00:00:00Z","products":[]}'
            path.write_bytes(old)
            with self.subTest(pages=len(pages)), self.assertRaises(RefreshError):
                target.scrape_price_category('pokemon', 'card', Client(pages))
            self.assertEqual(path.read_bytes(), old)

    def test_wrong_brand_kind_currency_or_category_is_rejected(self):
        changes = [{'brandId': 'onepiece'}, {'kind': 'box'}, {'categoryId': 14},
            {'currency': 'JPY'}, {'minPriceFormat': 'US $1'}, {'listingCount': 0}]
        for change in changes:
            source = rows(1, 30)
            source[0].update(change)
            with self.subTest(change=change), self.assertRaises(RefreshError):
                target.scrape_price_category('pokemon', 'card', Client([source]))

    def test_stale_fx_stops_before_requesting_or_relabelling_any_price(self):
        (self.root / 'fx-rates.json').write_text(json.dumps({'updated': '2020-01-01T00:00:00Z',
            'asOf': '2020-01-01', 'rates': {'USD': 1300, 'JPY': 9}}))
        client = Client([rows(1, 30)])
        with self.assertRaises(RefreshError):
            target.scrape_price_category('pokemon', 'card', client)
        self.assertEqual(client.calls, [])

    def test_unopened_promotion_in_box_category_stays_a_card_and_krw_is_converted(self):
        source = rows(1, 31, 'box')
        for row in source:
            row.pop('kind')
            row.pop('categoryId')
        source[0]['name'] = 'Pikachu ex PROMO [131/M-P](Special Box "Futuristic Box")'
        source[1].update(minPrice=130000, minPriceFormat='₩130,000')
        result = target.scrape_price_category('pokemon', 'box', Client([source]))
        self.assertEqual(len(result), 30)
        self.assertNotIn('1', {p['id'] for p in result})
        self.assertEqual(result[0]['lastPrice'], 100)
        self.assertEqual(result[0]['priceSource']['originalCurrency'], 'KRW')


class CheckpointTests(unittest.TestCase):
    def test_publication_failure_can_recover_exact_source_dated_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'source'
            root.mkdir()
            def git(*args):
                return subprocess.run(['git', '-c', 'safe.directory=*', '-C', str(root), *args],
                    capture_output=True, text=True, check=True).stdout.strip()
            git('init', '-b', 'main')
            git('config', 'user.name', 'Offline fixture')
            git('config', 'user.email', 'fixture@example.invalid')
            (root / 'data').mkdir()
            path = root / 'data/fx-rates.json'
            path.write_text('{"updated":"old"}')
            git('add', '.')
            git('commit', '-m', 'fixture')
            base = git('rev-parse', 'HEAD')
            raw = b'{"updated":"2026-10-31T00:00:00Z", "rates":{"JPY":9}}\n'
            path.write_bytes(raw)
            (root / 'data/credentials.json').write_text('{"private":"excluded"}')
            destination = Path(folder) / 'retained'
            manifest = checkpoint.checkpoint(root, base, destination)
            self.assertEqual([r['file'] for r in manifest['files']], ['data/fx-rates.json'])
            self.assertEqual((destination / 'data/fx-rates.json').read_bytes(), raw)
            self.assertEqual(manifest['files'][0]['sha256'], hashlib.sha256(raw).hexdigest())
            self.assertFalse((destination / 'data/credentials.json').exists())
            self.assertEqual(path.read_bytes(), raw)
            with self.assertRaises(FileExistsError):
                checkpoint.checkpoint(root, base, destination)


if __name__ == '__main__':
    unittest.main()
