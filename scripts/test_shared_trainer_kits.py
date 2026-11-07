"""Shared sealed packages must never create prices for their component cards."""
import copy
import unittest
from scripts import collect_us_market as us


class SharedTrainerKits(unittest.TestCase):
    def setUp(self):
        self.members = [{'code': 'EN-A', 'name': 'XY Trainer Kit (A)', 'release': '2014.03.12', 'cardCount': 30}, {'code': 'EN-B', 'name': 'XY Trainer Kit (B)', 'release': '2014.03.12', 'cardCount': 30}]
        self.group = {'categoryId': 3, 'groupId': 123, 'name': 'XY Trainer Kit: A & B', 'publishedOn': '2026-11-05T00:00:00'}
        self.package = {'groupId': 123, 'groupName': self.group['name'], 'productId': '456', 'productName': 'XY Trainer Kit: A & B', 'members': self.members}
        self.review = {'schemaVersion': 1, 'packages': [self.package]}
        self.product = {'categoryId': 3, 'groupId': 123, 'productId': 456, 'name': self.package['productName'], 'url': 'https://www.tcgplayer.com/product/456/xy-trainer-kit', 'extendedData': []}
        self.source = {**self.members[0], 'language': 'en', 'cards': [{'sourceId': '1', 'name': 'A', 'number': '1/30', 'setCode': 'EN-A', 'language': 'en'}]}

    def build(self, products=None, prices=None):
        return us.build_shared_kit_shard(self.source, self.group, products if products is not None else [self.product], prices or [], '2026-11-06T00:00:00+00:00', '2026-11-07T00:00:00+00:00', self.package)

    def test_only_explicit_two_member_identity_can_share_a_group(self):
        ordinary = us.map_sets(self.members, [self.group])
        self.assertTrue(all(row['status'] == 'unmapped' for row in ordinary.values()))
        mapped = us.map_sets(self.members, [self.group], self.review)
        self.assertTrue(all(row['status'] == 'mapped' and row['sharedPackage'] == self.package for row in mapped.values()))
        for field, value in [('name', 'Different Kit'), ('release', '2015.03.12'), ('cardCount', 31)]:
            changed = copy.deepcopy(self.members);changed[0][field] = value
            self.assertTrue(all(row['status'] != 'mapped' for row in us.map_sets(changed, [self.group], self.review).values()))

    def test_unpriced_package_still_has_an_image_identity_without_zero_price(self):
        result = self.build()
        self.assertEqual(result['sealed'], [])
        self.assertEqual(result['sealedCatalogue'][0]['productId'], '456')
        self.assertNotIn('printings', result['sealedCatalogue'][0])
        self.assertEqual(result['cards'], {})

    def test_complete_kit_quote_does_not_become_a_half_deck_or_single_card_quote(self):
        result = self.build(prices=[{'productId': 456, 'subTypeName': 'Normal', 'marketPrice': 20.5}])
        self.assertEqual(result['cards'], {})
        self.assertEqual(result['coverage']['matchedCards'], 0)
        self.assertEqual(result['sealed'][0]['printings']['Normal']['marketPrice'], 20.5)
        self.assertEqual(result['sealed'][0]['scope'], 'shared-trainer-kit-package')
        self.assertEqual(result['sharedPackage']['memberCodes'], ['EN-A', 'EN-B'])

    def test_code_cards_cases_and_changed_products_cannot_replace_the_package(self):
        for patch in [{'name': 'Code Card - XY Trainer Kit: A & B'}, {'name': 'XY Trainer Kit: A & B Display'}, {'categoryId': 1}, {'groupId': 999}, {'extendedData': [{'name': 'Number', 'value': '1/30'}]}]:
            with self.assertRaises(ValueError):self.build(products=[{**self.product, **patch}])
        with self.assertRaises(ValueError):self.build(products=[self.product, self.product])


if __name__ == '__main__':
    unittest.main()
