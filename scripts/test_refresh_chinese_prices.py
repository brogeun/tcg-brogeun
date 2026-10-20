"""Offline archive-preservation and pagination checks for CN head refresh."""
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import backfill_chinese_prices as base
import refresh_chinese_prices as refresh


class Catalog:
    def queries(self):
        return ['CSV9.5C']


class HeadRefreshTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name) / 'archive'
        self.run_dir = Path(self.temp.name) / 'refresh'
        base.save_json(self.source/'checkpoint.json', {'source':'cardhobby', 'currency':'CNY', 'pageSize':2,
                       'queries':{'CSV9.5C':{'complete':True, 'nextPage':3, 'totalCount':4}}})
        self.old_page = self.source / 'pages' / 'original.json'
        base.save_json(self.old_page, {'source':'cardhobby', 'currency':'CNY', 'query':'CSV9.5C',
                                    'items':[{'ID':1}, {'ID':2}, {'ID':3}, {'ID':4}]})
        self.checkpoint_bytes = (self.source/'checkpoint.json').read_bytes()
        self.page_bytes = self.old_page.read_bytes()

    def run_refresh(self, pages, max_pages=100):
        calls=[]
        def fetch(query, page, size):
            calls.append(page)
            return pages[page]
        result = refresh.refresh(Catalog(), self.source, self.run_dir, delay=1,
                                 max_pages=max_pages, fetcher=fetch, sleeper=lambda _:None, attempts=1)
        self.assertEqual((self.source/'checkpoint.json').read_bytes(), self.checkpoint_bytes)
        self.assertEqual(self.old_page.read_bytes(), self.page_bytes)
        return result, calls

    def test_only_partial_overlap_keeps_fetching_and_preserves_originals(self):
        result,calls=self.run_refresh({1:(8,[{'ID':6},{'ID':1}]),2:(8,[{'ID':5},{'ID':2}]),
                                      3:(8,[{'ID':3},{'ID':4}])})
        self.assertEqual(calls,[1,2,3])
        self.assertTrue(result['complete'])
        self.assertEqual(result['newUniqueListingIds'],2)
        self.assertEqual(result['queries']['CSV9.5C']['stopReason'],'saved_page_overlap')

    def test_end_of_results_without_overlap_is_complete(self):
        result,calls=self.run_refresh({1:(2,[{'ID':7},{'ID':8}])})
        self.assertTrue(result['complete'])
        self.assertEqual(result['newUniqueListingIds'],2)
        self.assertEqual(calls,[1])

    def test_limit_does_not_claim_completion_and_resume_retains_saved_rows(self):
        result,calls=self.run_refresh({1:(8,[{'ID':5},{'ID':6}])}, max_pages=1)
        self.assertFalse(result['complete'])
        result,calls=self.run_refresh({1:(8,[{'ID':7},{'ID':5}]),2:(8,[{'ID':1},{'ID':2}])})
        self.assertTrue(result['complete'])
        self.assertEqual(result['newUniqueListingIds'],3)
        front=next(p for p in (self.source/'pages').glob('refresh-*-000001.json'))
        self.assertEqual({r['ID'] for r in base.read_json(front)['items']},{5,6,7})

    def test_completed_run_is_not_downloaded_twice(self):
        self.run_refresh({1:(4,[{'ID':1},{'ID':2}])})
        result,calls=self.run_refresh({})
        self.assertTrue(result['complete'])
        self.assertEqual(calls,[])

    def test_resume_does_not_mistake_its_own_partial_front_page_for_old_overlap(self):
        result,_=self.run_refresh({1:(8,[{'ID':5},{'ID':6}])},max_pages=1)
        self.assertFalse(result['complete'])
        result,calls=self.run_refresh({1:(8,[{'ID':5},{'ID':6}]),2:(8,[{'ID':1},{'ID':2}])})
        self.assertTrue(result['complete'])
        self.assertEqual(calls,[1,2])

    def test_incomplete_original_history_is_rejected_before_new_writes(self):
        checkpoint=base.read_json(self.source/'checkpoint.json')
        checkpoint['queries']['CSV9.5C']['complete']=False
        base.save_json(self.source/'checkpoint.json',checkpoint)
        with self.assertRaisesRegex(ValueError,'Finish the original'):
            refresh.refresh(Catalog(),self.source,self.run_dir,sleeper=lambda _:None)
        self.assertFalse(self.run_dir.exists())

    def test_cli_uses_public_validation_for_success_and_offline_validation_after_stop(self):
        root=Path(self.temp.name)
        source=root/'.cache/chinese-price-backfill/cardhobby'
        for error,allow_network in [(None,True),(KeyboardInterrupt(),False),(TimeoutError(),False)]:
            with self.subTest(error=type(error).__name__):
                with mock.patch.object(refresh.collector,'PriceCatalog'), \
                     mock.patch.object(refresh,'refresh',return_value={'complete':True,'newUniqueListingIds':1,'scope':'fixture'},side_effect=error), \
                     mock.patch.object(refresh.collector,'apply_cached_prices') as apply:
                    if error is None:
                        self.assertEqual(refresh.main(['--root',str(root),'--run-dir',str(self.run_dir)]),0)
                    else:
                        with self.assertRaises(type(error)):
                            refresh.main(['--root',str(root),'--run-dir',str(self.run_dir)])
                    apply.assert_called_once_with(root,source,allow_network=allow_network)


if __name__=='__main__':
    unittest.main()
