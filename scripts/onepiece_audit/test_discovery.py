"""Meaningful source-stop and last-good retention regressions."""
import importlib.util,json,tempfile,unittest,urllib.error
from pathlib import Path
spec=importlib.util.spec_from_file_location('discovery',Path(__file__).with_name('discover_mercari.py'));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
class DiscoveryTests(unittest.TestCase):
 def test_refresh_retains_unselected_and_newer_observations(self):
  old={'schemaVersion':1,'source':'mercari','updatedAt':'2026-11-01T01:00:00Z','references':[{'itemId':'m11111111111','observedAt':'2026-11-01T01:00:00Z','price':{'amount':100}},{'itemId':'m22222222222','observedAt':'2026-11-01T01:00:00Z','price':{'amount':200}}],'verifiedQuotes':[]}
  fresh={'schemaVersion':1,'source':'mercari','updatedAt':'2026-11-01T02:00:00Z','references':[{'itemId':'m11111111111','observedAt':'2026-10-31T01:00:00Z','price':{'amount':1}},{'itemId':'m33333333333','observedAt':'2026-11-01T02:00:00Z','price':{'amount':300}}],'coverage':{'fetchedCount':2}}
  merged=m.merge_references(old,fresh);rows={r['itemId']:r for r in merged['references']}
  self.assertEqual(len(rows),3);self.assertEqual(rows['m11111111111']['price']['amount'],100);self.assertEqual(rows['m22222222222'],old['references'][1]);self.assertEqual(merged['coverage']['trackedCount'],3)
 def test_failed_refresh_keeps_amount_and_original_observation_but_marks_source_failure(self):
  old={'schemaVersion':1,'source':'mercari','references':[{'itemId':'m11111111111','observedAt':'2026-11-01T01:00:00Z','price':{'amount':100},'saleStatus':'active'}]}
  fresh={'updatedAt':'2026-11-01T02:00:00Z','references':[{'itemId':'m11111111111','lastAttemptAt':'2026-11-01T02:00:00Z','fetchStatus':'error','lastError':'HTTP 403'}],'coverage':{}}
  row=m.merge_references(old,fresh)['references'][0];self.assertEqual(row['price']['amount'],100);self.assertEqual(row['observedAt'],'2026-11-01T01:00:00Z');self.assertTrue(row['stale']);self.assertEqual(row['saleStatus'],'unknown');self.assertFalse(row['valuationEligible'])
 def test_watchlist_keeps_manual_urls_and_only_canonical_original_urls(self):
  def row(i):return {'itemId':'m'+str(i).zfill(11),'sourceUrl':'https://jp.mercari.com/item/m'+str(i).zfill(11),'game':'onepiece'}
  x=m.combine_watchlist([row(1)], [row(i)for i in range(2,110)]+[{'itemId':'m99999999999','sourceUrl':'https://evil.test/item/m99999999999'}], [row(111)], maximum=100)
  self.assertEqual(len(x['items']),100);self.assertEqual(x['items'][0],{**row(1),'enabled':True});self.assertEqual(x['items'][1]['itemId'],row(111)['itemId']);self.assertEqual(len({r['itemId']for r in x['items']}),100)
 def test_source_403_stops_searches_and_leaves_price_references_unchanged(self):
  with tempfile.TemporaryDirectory()as tmp:
   root=Path(tmp);(root/'data').mkdir()
   m.write(root/'data/mercari-reference-watchlist.json',{'items':[{'itemId':'m11111111111','sourceUrl':'https://jp.mercari.com/item/m11111111111','game':'onepiece'}]})
   prior={'schemaVersion':1,'source':'mercari','references':[]};m.write(root/'data/mercari-references.json',prior)
   m.write(root/'data/onepiece-official-search.json',{'cards':[{'officialId':'OP01-001_p1','name':'ルフィ','productId':None},{'officialId':'OP01-002_p1','name':'ゾロ','productId':None}]})
   calls=[]
   def blocked(url):calls.append(url);raise urllib.error.HTTPError(url,403,'blocked',{},None)
   result=m.prepare(root,blocked)
   self.assertEqual(len(calls),1);self.assertEqual(result['status'],'deferred');self.assertEqual(result['newVerifiedQuotes'],0);self.assertEqual(m.read(root/'data/mercari-references.json'),prior)
if __name__=='__main__':unittest.main()
