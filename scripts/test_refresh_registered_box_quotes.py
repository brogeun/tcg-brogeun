import json
from pathlib import Path
import tempfile
import unittest

from refresh_registered_box_quotes import canonical_onepiece_code, collect, merge_manual
from refresh_search_prices import RefreshError


class Client:
    def __init__(self, pages):
        self.pages = iter(pages)
        self.calls = []

    def get_category(self, brand, category, order, page, per_page):
        self.calls.append((brand, category, order, page, per_page))
        return {'tradingCards': next(self.pages)}


class RegisteredBoxesTests(unittest.TestCase):
    def test_reviewed_editions_have_independent_prices_and_no_default_catalogue_code(self):
        first = self.row(name='Pokemon EX Battle Boost 1ED Box', productNumber='pkmn-tcg-EBB', releasedAt='2013-07-12T15:00:00Z')
        resale = self.row(12, name='Pokemon EX Battle Boost Resale Box', productNumber='pkmn-tcg-EBB', releasedAt='2013-07-12T15:00:00Z', minPrice=0, minPriceFormat='US $ -', listingCount='0')
        proofs = [{'brand': 'pokemon', 'parentCode': 'EBB', 'id': str(row['id']), 'label': label, 'scope': 'sealed-variant-only', 'sourceName': row['name'], 'sourceProductNumber': row['productNumber'], 'sourceRelease': row['releasedAt'], 'sourceUrl': 'https://snkrdunk.com/en/trading-cards/'+str(row['id'])} for row, label in [(first, '1ED'), (resale, 'Resale')]]
        result, counts, _ = merge_manual({'products': []}, {'11': first, '12': resale}, {}, 'observed', 'pokemon', reviewed_variants=proofs)
        self.assertEqual([row.get('code') for row in result['products']], [None, None])
        self.assertEqual([row['marketVariantOf'] for row in result['products']], ['EBB', 'EBB'])
        self.assertEqual([row['lastPrice'] for row in result['products']], [10, None])
        retained, _, _ = merge_manual(result, {}, {}, 'later', 'pokemon', reviewed_variants=proofs)
        self.assertEqual(retained['products'], result['products'])
        with self.assertRaises(RefreshError):
            merge_manual(result, {'11': {**first, 'name': 'Another Edition Box'}}, {}, 'later', 'pokemon', reviewed_variants=proofs)

    def row(self, identity=11, **extra):
        return {'id': identity, 'name': 'ONE PIECE Card Game Starter Deck Test',
                'productNumber': 'OPC-TCG-ST-01', 'minPrice': 10,
                'minPriceFormat': 'US $10', 'listingCount': '1', **extra}

    def test_no_featured_thirty_cap_and_empty_terminal_is_required(self):
        with tempfile.TemporaryDirectory() as directory:
            client = Client([[self.row(i) for i in range(1, 101)], [self.row(101)], []])
            result = collect(client, 'onepiece', Path(directory) / 'state.json')
            self.assertEqual(len(result['rows']), 101)
            self.assertTrue(result['complete'])
            self.assertEqual(len(client.calls), 3)

    def test_repeated_page_does_not_advance_cursor_and_can_resume(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / 'state.json'
            with self.assertRaises(RefreshError):
                collect(Client([[self.row()], [self.row()]]), 'onepiece', file)
            self.assertEqual(json.loads(file.read_text())['nextPage'], 2)
            client = Client([[]])
            result = collect(client, 'onepiece', file, resume=True)
            self.assertTrue(result['complete'])
            self.assertEqual(client.calls[0][3], 2)

    def test_unexpected_empty_catalogue_and_wrong_brand_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            for rows in [[], [self.row(brandId='pokemon')]]:
                with self.assertRaises(RefreshError):
                    collect(Client([rows]), 'onepiece', Path(directory) / 'state.json')

    def test_observed_absence_clears_old_ask_but_unobserved_price_is_not_redated(self):
        previous = {'products': [{'id': '11', 'code': 'ST01', 'lastPrice': 200, 'priceCheckedAt': 'old'},
                                 {'id': '12', 'code': 'ST02', 'lastPrice': 300, 'priceCheckedAt': 'older'}]}
        observed = {'11': self.row(minPrice=0, minPriceFormat='US $ -', listingCount='0')}
        result, counts, added = merge_manual(previous, observed, {}, 'now', 'onepiece')
        self.assertIsNone(result['products'][0]['lastPrice'])
        self.assertEqual(result['products'][0]['priceStatus'], 'no-listings')
        self.assertEqual(result['products'][1], previous['products'][1])
        self.assertEqual(previous['products'][0]['lastPrice'], 200)
        self.assertEqual(counts['not-observed'], 1)

    def test_bonus_foreign_cases_and_distinct_editions_cannot_become_default_box(self):
        self.assertEqual(canonical_onepiece_code(self.row()), 'ST01')
        self.assertEqual(canonical_onepiece_code(self.row(productNumber='PRB-01', name='ONE PIECE Premium Booster Box')), 'PRB01')
        for title in ['ONE PIECE Start Deck Bonus Pack', 'ONE PIECE Start Deck ENGLISH', 'ONE PIECE Start Deck Case']:
            self.assertIsNone(canonical_onepiece_code(self.row(name=title)))
        self.assertIsNone(canonical_onepiece_code(self.row(productNumber='OPC-EN-TCG-ST-01')))
        observed = {'11': self.row(), '12': self.row(12, name='ONE PIECE Card Game Starter Deck Test 1st Edition')}
        result, _, added = merge_manual({'products': []}, observed, {}, 'now', 'onepiece', ['ST01'])
        self.assertEqual(result['products'], [])
        self.assertEqual(added, [])

    def test_exact_unique_source_link_preserves_existing_ids_and_rejects_zero_stock_price(self):
        previous = {'products': [{'id': '9', 'code': 'ST02', 'name': 'Owner supplied name', 'image': '/reviewed.webp'}]}
        result, _, added = merge_manual(previous, {'11': self.row()}, {}, 'now', 'onepiece', ['ST01'])
        self.assertEqual(result['products'][0], previous['products'][0])
        self.assertEqual(added, [{'code': 'ST01', 'id': '11'}])
        self.assertEqual(result['products'][1]['lastPrice'], 10)
        with self.assertRaises(RefreshError):
            merge_manual({'products': [{'id': '11'}]}, {'11': self.row(listingCount=0)}, {}, 'now', 'onepiece')

    def test_reviewed_legacy_code_requires_the_original_source_identity(self):
        row = self.row(name='Pokemon Card Game Space Juggler Box', productNumber='pkmn-337', releasedAt='2022-04-07T15:00:00Z')
        proof = {'brand':'pokemon','code':'S10P','id':'11','language':'ja',
                 'verification':'reviewed-product-code-title-release','sourceName':row['name'],
                 'sourceProductNumber':row['productNumber'],'sourceRelease':row['releasedAt'],
                 'sourceUrl':'https://snkrdunk.com/en/trading-cards/11'}
        result, _, added = merge_manual({'products':[]}, {'11':row}, {}, 'now', 'pokemon', reviewed_links=[proof])
        self.assertEqual(result['products'][0]['code'],'S10P')
        self.assertEqual(added,[{'code':'S10P','id':'11'}])
        with self.assertRaises(RefreshError):
            merge_manual({'products':[]}, {'11':{**row,'productNumber':'pkmn-336'}}, {}, 'now', 'pokemon', reviewed_links=[proof])


if __name__ == '__main__':
    unittest.main()
