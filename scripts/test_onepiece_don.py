import json
import unittest
from pathlib import Path

from fetch_onepiece_http import supplement_don_cards

ROOT = Path(__file__).resolve().parent.parent


class DonSupplementTests(unittest.TestCase):
    def test_recrawl_retains_all_numberless_designs_and_the_original_cards(self):
        saved = json.loads((ROOT / 'data/cards-by-set/OP17.json').read_text())
        original = [card for card in saved['cards'] if card.get('cardType') != 'DON']
        result = supplement_don_cards(original, 'OP17')
        self.assertEqual(len(original), 169)
        self.assertEqual(len(result), 177)
        self.assertEqual(result[:169], original)
        self.assertEqual(len({card['fullId'] for card in result}), 177)
        self.assertEqual(supplement_don_cards(result, 'OP17'), result)
        self.assertEqual(supplement_don_cards(original, 'OP16'), original)

    def test_curated_market_id_never_replaces_an_official_card_id(self):
        for card in supplement_don_cards([], 'OP17'):
            self.assertNotIn('id', card)
            self.assertNotIn('productId', card)
            self.assertEqual(card['cardType'], 'DON')
            self.assertTrue((ROOT / card['image'].lstrip('/')).is_file())


if __name__ == '__main__':
    unittest.main()
