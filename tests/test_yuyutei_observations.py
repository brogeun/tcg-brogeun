from pathlib import Path
import json
import sys
import tempfile
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"scripts"))
import collect_yuyutei_market as market
import yuyutei_observations as delivery


class ObservationTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.data=Path(tmp.name)
        self.packet=self.data/"prices.json.gz"
        self.batch={"game":"onepiece","set":"op05","name":"OP05","url":"https://yuyu-tei.jp/sell/opc/s/op05",
                    "observedAt":"2025-10-01T09:00:00Z",
                    "cards":[["10001","OP05-001","L","テスト",100,1,"in_stock",True,"在庫 : 1","https://card.yuyu-tei.jp/opc/100_140/op05/10001.jpg"]]}
        market.atomic_json(self.data/"yuyutei-market.json",{"games":[{"game":"onepiece","recordCount":0}],
                          "lastRun":{"outcome":"blocked","httpStatus":403}})
        market.atomic_json(self.data/"yuyutei-market/onepiece.json",{"sets":[],"rows":[],"columns":market.INDEX_COLUMNS})

    def test_replay_and_older_observations_do_not_replace_newer_rows(self):
        delivery.save_file(self.packet,[self.batch])
        self.assertEqual(delivery.apply(self.data,self.packet)["onepiece"],{"newProducts":1,"observationsApplied":1})
        detail=self.data/"yuyutei-market/onepiece/op05.json"
        original=detail.read_bytes()
        self.assertEqual(delivery.apply(self.data,self.packet),{})
        self.batch["observedAt"]="2025-09-01T09:00:00Z"
        self.batch["cards"][0][4]=2
        delivery.save_file(self.packet,[self.batch])
        self.assertEqual(delivery.apply(self.data,self.packet),{})
        self.assertEqual(detail.read_bytes(),original)
        manifest=json.loads((self.data/"yuyutei-market.json").read_bytes())
        self.assertEqual(manifest["lastRun"]["outcome"],"blocked")
        self.assertEqual(manifest["lastImport"]["sourceAsOf"],"2025-10-01T09:00:00Z")

    def test_wrong_source_or_nonpositive_price_is_not_imported(self):
        with self.assertRaises(ValueError):
            delivery.save_file(self.packet,[dict(self.batch,url="https://example.org/")])
        self.batch["cards"][0][4]=0
        with self.assertRaises(ValueError):
            delivery.save_file(self.packet,[self.batch])
