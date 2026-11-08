import copy
import json
from pathlib import Path
import tempfile
import unittest

try:
    from apply_verified_image_repairs import run
except ModuleNotFoundError:
    from scripts.apply_verified_image_repairs import run


class VerifiedImageRepairTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cards, self.bindings = [], []
        for number, extension in enumerate(('jpg', 'webp', 'png'), 1):
            source = f'https://www.tcgcollector.com/cards/{number}/card-{number}'
            old = f'https://static.tcgcollector.com/content/images/aa/bb/cc/old{number}.{extension}'
            new = f'https://static.tcgcollector.com/content/images/dd/ee/ff/new{number}.webp'
            card = {'id': f'JP:T:{number:03}', 'number': f'{number:03}', 'sourceUrl': source,
                    'image': old, 'thumbnailUrl': old, 'productId': str(9000+number), 'minPrice': 123}
            self.cards.append(card)
            self.bindings.append({'cardId': card['id'], 'number': card['number'], 'sourceUrl': source,
                                  'oldImage': old, 'image': new, 'width': 868, 'height': 1212})
        self.config = {'schemaVersion': 1, 'bindings': self.bindings,
                       'targetFiles': ['data/japanese-catalog.json', 'data/cards-by-set/T.json']}
        self.write('config/verified-image-url-repairs.json', self.config)
        self.write('data/japanese-catalog.json', {'cards': self.cards})
        self.write('data/cards-by-set/T.json', {'cards': copy.deepcopy(self.cards)})

    def write(self, name, data):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(data), encoding='utf-8')

    def test_all_original_formats_repair_without_price_or_identity_changes(self):
        result = run(self.root)
        self.assertEqual(result['replacedReferences'], 12)
        updated = json.loads((self.root/'data/japanese-catalog.json').read_bytes())['cards']
        for before, after, binding in zip(self.cards, updated, self.bindings):
            self.assertEqual(after, {**before, 'image': binding['image'], 'thumbnailUrl': binding['image']})
        self.assertEqual(run(self.root)['replacedReferences'], 0)
        self.assertEqual(run(self.root, verify_only=True)['staleReferences'], 0)

    def test_verify_only_does_not_write_or_accept_stale_images(self):
        path = self.root/'data/japanese-catalog.json'
        before = path.read_bytes()
        with self.assertRaises(ValueError): run(self.root, verify_only=True)
        self.assertEqual(path.read_bytes(), before)

    def test_printed_number_mismatch_blocks_the_mapping(self):
        self.cards[0]['number'] = 'different'
        self.write('data/japanese-catalog.json', {'cards': self.cards})
        with self.assertRaises(AssertionError): run(self.root)

    def test_newer_unrelated_artwork_is_retained(self):
        replacement = 'https://example.com/newer-reviewed.jpg'
        self.cards[0]['image'] = self.cards[0]['thumbnailUrl'] = replacement
        self.write('data/japanese-catalog.json', {'cards': self.cards})
        run(self.root)
        self.assertEqual(json.loads((self.root/'data/japanese-catalog.json').read_bytes())['cards'][0]['image'], replacement)


if __name__ == '__main__': unittest.main()
