import copy
import unittest

try:
    from reviewed_market_card_images import repair_payload
except ModuleNotFoundError:
    from scripts.reviewed_market_card_images import repair_payload


class ReviewedMarketImagesTest(unittest.TestCase):
    def setUp(self):
        self.row = {'game': 'yugioh', 'productId': '167628', 'number': '24PP-JP001',
                    'rarity': 'NP', 'name': 'Toy Soldier NP[24PP-JP001](PREMIUM PACK 2024)',
                    'oldImage': 'https://cdn.snkrdunk.com/dead.webp',
                    'image': 'https://ocg-card.com/exact-np.jpg'}
        self.bindings = {('yugioh', '167628'): self.row}
        self.card = {'id': '167628', 'game': 'yugioh', 'name': self.row['name'],
                     'fullCardNumber': '24PP-JP001', 'rarity': 'NP',
                     'image': self.row['oldImage'], 'snkrProduct': {'id': '167628',
                     'minPrice': 42, 'catalogAsk': {'amount': 100, 'currency': 'JPY'}}}

    def test_artwork_only_and_idempotent(self):
        expected = copy.deepcopy(self.card)
        expected['image'] = self.row['image']
        self.assertEqual(repair_payload(self.card, self.bindings), 1)
        self.assertEqual(self.card, expected)
        self.assertEqual(repair_payload(self.card, self.bindings), 0)

    def test_identity_conflicts_block(self):
        for key, value in [('name', self.row['name'].replace('NP[', 'SE RED[')),
                           ('rarity', 'N'), ('fullCardNumber', '24PP-JP002')]:
            with self.subTest(key=key):
                card = copy.deepcopy(self.card)
                card[key] = value
                with self.assertRaises(ValueError):
                    repair_payload(card, self.bindings)
                self.assertEqual(card['image'], self.row['oldImage'])

    def test_other_game_id_and_new_image_retained(self):
        for key, value in [('game', 'weiss_schwarz'), ('id', '999'),
                           ('image', 'https://cdn.snkrdunk.com/new-valid.webp')]:
            card = copy.deepcopy(self.card)
            card[key] = value
            expected = copy.deepcopy(card)
            self.assertEqual(repair_payload(card, self.bindings), 0)
            self.assertEqual(card, expected)

    def test_collector_thumbnails_follow_same_review(self):
        product = {'id': '167628', 'brand': 'yugioh', 'name': self.row['name'],
                   'image': self.row['oldImage'], 'thumbnailUrl': self.row['oldImage'],
                   'minPrice': 0, 'listingCount': 0}
        self.assertEqual(repair_payload(product, self.bindings), 2)
        self.assertEqual(product['minPrice'], 0)
        self.assertEqual(product['thumbnailUrl'], self.row['image'])

    def test_official_fallback_keeps_official_artwork_and_price(self):
        card = copy.deepcopy(self.card)
        card.update(id='official:24pp:001', officialProductId='24pp', name='Official Japanese name',
                    image='https://official.example/001.jpg', fallbackImage=self.row['oldImage'])
        card['snkrdunkId'] = '167628'
        card['snkrProduct']['name'] = self.row['name']
        expected = copy.deepcopy(card)
        expected['fallbackImage'] = self.row['image']
        self.assertEqual(repair_payload(card, self.bindings), 1)
        self.assertEqual(card, expected)

    def test_representative_set_image_requires_exact_review(self):
        self.bindings[('set', 'set24pp')] = {'name': 'PREMIUM PACK 2024',
            'oldImage': self.row['oldImage'], 'image': self.row['image']}
        cover = {'id': 'set24pp', 'name': 'PREMIUM PACK 2024', 'image': self.row['oldImage']}
        self.assertEqual(repair_payload(cover, self.bindings), 1)
        self.assertEqual(cover['image'], self.row['image'])


if __name__ == '__main__':
    unittest.main()
