import gzip
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

try:
    from scripts import retailer_card_printings as subject
except ImportError:
    import retailer_card_printings as subject


class RetailerCoverTest(unittest.TestCase):
    def generate(self, image):
        parent = {'id':'11','name':'Exact source set','cards':[
            {'id':'native-1','number':'TEST/W01-001','name':'Sample','rarity':'C'}]}
        source = {'id':'retailer:c-labo:123','nativeProductId':'11',
                  'nativeCardId':'native-1','nativeNumberNameMatch':True,
                  'name':'Sample','cardNumber':'TEST/W01-001','finish':'foil',
                  'sourceTitle':'Sample (Foil)','sourceProductId':'123',
                  'sourceUrl':'https://www.c-labo-online.jp/product/123',
                  'sourceDeclaredRarity':'C','image':image,'finishEvidence':{'label':'Foil'}}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            input_path = root / 'data/retailer-printings/weiss_schwarz.json.gz'
            input_path.parent.mkdir(parents=True)
            input_path.write_bytes(gzip.compress(json.dumps({'schemaVersion':1,
                'game':'weiss_schwarz','source':'c-labo','products':[
                    {'nativeProductId':'11','supplementalPrintings':[source]}]}).encode()))
            manifest={'generatedAt':'2026-11-04T00:00:00Z','games':[
                {'id':'weiss_schwarz','sets':[],'boxes':[]}]}
            outputs=[]
            with patch.object(subject,'load_sources',return_value={
                    'weiss_schwarz':{'products':[parent]}}):
                subject.augment_retailer(root,manifest,outputs)
        return manifest['games'][0]['sets'][0], outputs[0][1]

    def test_cover_is_the_same_verified_foil_card_and_never_a_box(self):
        image='https://www.c-labo-online.jp/data/c-labo/verified-foil.jpg'
        entry,payload=self.generate(image)
        self.assertEqual(entry['image'],image)
        self.assertEqual(entry['coverType'],'card')
        self.assertEqual(entry['coverProductId'],payload['cards'][0]['id'])
        self.assertEqual(entry['inclusionScope'],'related-printing')
        self.assertEqual(payload['cards'][0]['priceLookupPolicy'],'exact-finish-required')
        self.assertNotIn('price',payload['cards'][0])
        self.assertNotIn('snkrdunkId',payload['cards'][0])

    def test_missing_verified_photo_does_not_borrow_native_art_or_prices(self):
        entry,payload=self.generate('')
        self.assertEqual(entry['image'],'')
        self.assertEqual(entry['coverProductId'],'')
        self.assertEqual(entry['coverType'],'card')
        self.assertEqual(payload['cards'][0]['image'],'')


if __name__=='__main__':
    unittest.main()
