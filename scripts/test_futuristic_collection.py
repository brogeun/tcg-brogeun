import json
import unittest
from unittest.mock import patch, Mock
from datetime import datetime
import sync_futuristic_market as m

class CollectionTests(unittest.TestCase):
    def html(self, packaging='Opened', number='131'):
        p=dict(id=897035,productNumber='pkmn-tcg-M-P-'+number,brands=[{'id':'pokemon'}],
               name=f'Pikachu ex PROMO :{packaging} [{number}/M-P](Special Box "30th CELEBRATION FUTURISTIC BOX")',
               primaryMedia={'imageUrl':'https://cdn.snkrdunk.com/card.webp'})
        obj=dict(apparelData=p,apparelId=897035,listings=[dict(variant={'filterSizeID':'quantity_1'},minNewListingPrice=100,minUsedListingPrice=50)])
        chips=[dict(conditionId=18,text='A',hasListing=True,usedMinPrice=100),dict(conditionId=22,text='PSA10',hasListing=False,usedMinPrice=999)]
        queries={'mutations':[],'queries':[{'queryKey':['/v2/products/897035/size-chips'],'state':{'data':{'data':{'chips':chips}}}}]}
        return '<script>self.__next_f.push('+json.dumps([1,'1:'+json.dumps(obj)])+');</script><script>x.push('+json.dumps(queries)+');</script>'
    def test_identity_and_grade_separation(self):
        p=m.parse_product(self.html(),'897035','131','opened')
        self.assertEqual(p['grades'][0]['lowestAsk'],100)
        self.assertIsNone(p['grades'][1]['lowestAsk'])
        with self.assertRaises(ValueError):m.parse_product(self.html(),'897035','132','opened')
        with self.assertRaises(ValueError):m.parse_product(self.html(),'897035','131','sealed')
        p=m.parse_product(self.html('Unopen'),'897035','131','sealed')
        self.assertEqual(p['grades'],[{'key':'raw','label':'미개봉 · 1팩','lowestAsk':100}])
    def test_full_pagination_preserves_distinct_equal_sales(self):
        trade={'date':'1分前','price':100,'condition':'A'}
        with patch.object(m,'get',side_effect=[Mock(json=lambda:{'history':[trade,trade]}),Mock(json=lambda:{'history':[]})]) as get:
            self.assertEqual(len(m.sales('897035')),2)
            self.assertEqual(get.call_count,2)
        with patch.object(m,'get',return_value=Mock(json=lambda:{'history':[trade]})):
            with self.assertRaises(ValueError):m.sales('897035')
    def test_sealed_multipack_not_single_card_price(self):
        now=datetime(2026,9,21,0,10,tzinfo=m.JST)
        trades=[{'date':'1分前','price':800,'size':'10パック'},{'date':'2分前','price':100,'size':'1パック'}]
        h=m.build_history({'id':'881432','packaging':'sealed'},trades,now)['history'][0]
        self.assertEqual(h['raw_price'],100);self.assertEqual(h['total_vol'],2);self.assertNotIn('psa10_price',h)
        self.assertEqual(m.sale_day('20分前',now),'2026-09-20')
        with self.assertRaises(ValueError):m.sale_day('unknown',now)
    def test_failure_keeps_previous_snapshot(self):
        with patch.object(m,'collect',side_effect=ValueError('source unavailable')),patch.object(m,'write_json') as write:
            with self.assertRaises(ValueError):m.main()
            write.assert_not_called()

if __name__=='__main__':unittest.main()
