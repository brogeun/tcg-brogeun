import copy
from datetime import datetime
import json
from pathlib import Path
import tempfile
import unittest
from scripts.collect_kream_promos import KST, IDS, parse_row, validate_bundle, validate_new_rows, unpack_history, pack_history
from scripts.publish_data_snapshot import daily_path, KOREAN_PROMO_FILES

class KreamPromosTests(unittest.TestCase):
    def test_full_published_snapshot_counts_and_options(self):
        root=Path(__file__).resolve().parents[1]
        data=validate_bundle(root)
        self.assertEqual(tuple(c['id'] for c in data['cards']),IDS)
        self.assertGreaterEqual(data['collected_trade_count'],16363)
        self.assertNotIn('937107',IDS)
        self.assertTrue(all(not daily_path(p) for p in KOREAN_PROMO_FILES))
        ex=unpack_history(json.loads((root/'data/korean-promos/934334.json').read_bytes()))
        self.assertTrue(all(not r['option'].startswith('Ungraded') for r in ex['rows']))
        ditto=json.loads((root/'data/korean-promos/508949.json').read_bytes())
        self.assertIn('ONE SIZE',ditto['counts_by_exact_option'])

    def test_lossless_dictionary_encoding(self):
        root=Path(__file__).resolve().parents[1]
        for ident in IDS:
            packed=json.loads((root/f'data/korean-promos/{ident}.json').read_bytes())
            expanded=unpack_history(packed)
            self.assertEqual(unpack_history(pack_history(expanded)),expanded)

    def test_duplicate_transactions_are_not_deduplicated(self):
        row={'date':'2026-10-31','option':'Ungraded A','price_krw':29000,'express_shipping':False}
        old={'rows':[row,row]}
        with self.assertRaises(ValueError):validate_new_rows(old,[row])
        validate_new_rows(old,[row,row,row])
        changed=copy.deepcopy(row);changed['option']='PSA 10'
        with self.assertRaises(ValueError):validate_new_rows(old,[row,changed])

    def test_source_date_and_relative_labels(self):
        anchor=datetime(2026,11,1,0,20,tzinfo=KST)
        source={'date_raw':'빠른배송26/10/29','option':'Ungraded A (Pack Ver.)','price':'30,000원','express_shipping':True}
        self.assertEqual(parse_row(source,anchor)['date'],'2026-10-29')
        source['date_raw']='1시간 전'
        self.assertEqual(parse_row(source,anchor)['date'],'2026-10-31')
        source['date_raw']='확인 중'
        with self.assertRaises(ValueError):parse_row(source,anchor)

if __name__=='__main__':unittest.main()
