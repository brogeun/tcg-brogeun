import unittest
from scripts.collect_yuyutei_market import INDEX_COLUMNS, REQUIRED_INDEX_COLUMNS, compact_rows, index_row, choose_sets

class Migration(unittest.TestCase):
    def test_legacy_prices_survive_column_upgrade_and_stale_flags_survive_compaction(self):
        record=dict(zip(REQUIRED_INDEX_COLUMNS,['op16','10007','OP16','OP16-005','UC','サッチ',80,1,'in_stock','2026-10-29T12:45:48Z',True]))
        rows=compact_rows({'columns':REQUIRED_INDEX_COLUMNS,'rows':[index_row(record,REQUIRED_INDEX_COLUMNS)]})
        self.assertEqual(len(rows),1);self.assertEqual(dict(zip(INDEX_COLUMNS,rows[0]))['price'],80)
        record.update(notObservedInLatestSnapshot=True,stale=True,fetchStatus='error')
        decoded=dict(zip(INDEX_COLUMNS,index_row(record)))
        self.assertTrue(decoded['notObservedInLatestSnapshot']);self.assertTrue(decoded['stale']);self.assertEqual(decoded['fetchStatus'],'error')
    def test_uncollected_sets_receive_a_majority_of_a_bounded_run(self):
        found=[{'sourceSetCode':'s'+str(n),'name':'set '+str(n)}for n in range(15)]
        previous={'sets':[{'sourceSetCode':'s'+str(n),'lastSuccessAt':'2026-10-30T00:00:00Z'}for n in range(5)]}
        chosen=choose_sets(found,['s0','s1','s2'],previous,10)
        self.assertEqual(len(chosen),10);self.assertGreaterEqual(sum(int(r['sourceSetCode'][1:])>=5 for r in chosen),6)
if __name__=='__main__':unittest.main()
