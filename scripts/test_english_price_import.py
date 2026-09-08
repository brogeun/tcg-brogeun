"""Identity, grade/currency, history and saved-page regression checks."""
import copy
import json
import unittest
from pathlib import Path
from import_english_prices import ROOT, merge, parse_html, sale_reason

class Prices(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.data = json.loads((ROOT/'data/english-sets/EN-TCG11803.json').read_text('utf-8'))
        for c in cls.data['cards']: c.pop('psa10', None)
        rows=[]
        for line in (ROOT/'scripts/fixtures/pricecharting-chaos-rising-20260908.txt').read_text('utf-8').splitlines():
            if not line or line.startswith('#'): continue
            title,slug,price=line.split('|')
            rows.append(dict(title=title,sourceUrl='https://www.pricecharting.com/game/pokemon-chaos-rising/'+slug,price='$'+price if price else ''))
        cls.snapshot=dict(schemaVersion=1,kind='set',sourceUrl='https://www.pricecharting.com/console/pokemon-chaos-rising',sourceSetName='Chaos Rising',observedAt='2026-09-08T06:47:06.661Z',grade='PSA 10',currency='USD',rows=rows)
        cls.sales=json.loads((ROOT/'scripts/fixtures/pricecharting-greninja-sales-20260908.json').read_text('utf-8'))

    def test_all_identities_and_missing_quotes(self):
        data,r=merge(self.data,self.snapshot)
        self.assertEqual((r['matched'],r['priced'],r['noPrice'],r['unmatchedCards']),(122,120,2,0))
        self.assertEqual(next(c for c in data['cards'] if c['number']=='116/086')['psa10']['sourcePriceCents'],49500)
        self.assertTrue(all(not c['psa10'].get('sales') for c in data['cards']))

    def test_sales_are_partial_deduplicated_and_keep_actual_price(self):
        data,r=merge(self.data,self.sales)
        self.assertEqual(r['acceptedSales'],29)
        self.assertEqual(r['rejectedSales'][0]['reason'],'name-mismatch')
        data2,_=merge(data,self.sales)
        p=next(c for c in data2['cards'] if c['number']=='116/086')['psa10']
        self.assertEqual(len(p['sales']),29)
        self.assertEqual(next(s for s in p['sales'] if s['url'].endswith('198622644373'))['priceCents'],50000)
        self.assertEqual(p['salesCoverage'],'public-recent-sample')

    def test_stale_file_cannot_overwrite_newer(self):
        data,_=merge(self.data,self.sales)
        older=copy.deepcopy(self.snapshot); older['rows'][0]['price']='$1.00'
        result,r=merge(data,older)
        self.assertEqual(r['stale'],1)
        self.assertEqual(next(c for c in result['cards'] if c['number']=='116/086')['psa10']['sourcePriceCents'],49500)

    def test_reject_wrong_set_grade_currency_and_url(self):
        for key,value in [('sourceSetName','Pitch Black'),('grade','Grade 9'),('currency','CAD')]:
            s=copy.deepcopy(self.snapshot);s[key]=value
            with self.assertRaises(ValueError):merge(self.data,s)
        s=copy.deepcopy(self.snapshot);s['rows'][0]['sourceUrl']=s['rows'][0]['sourceUrl'].replace('-116','-122')
        with self.assertRaises(ValueError):merge(self.data,s)

    def test_candidate_and_bad_date_rejected(self):
        card=next(c for c in self.data['cards'] if c['number']=='116/086')
        sale=copy.deepcopy(self.sales['sales'][0]);sale['title']+=' PSA 10 Candidate'
        self.assertEqual(sale_reason(sale,card,self.data,self.sales['observedAt']),'other-grade-language-or-ungraded')
        sale=copy.deepcopy(self.sales['sales'][0]);sale['date']='2025-01-01'
        self.assertEqual(sale_reason(sale,card,self.data,self.sales['observedAt']),'invalid-date')

    def test_html_uses_header_not_fixed_price_column(self):
        raw='''<link rel="canonical" href="https://www.pricecharting.com/console/pokemon-chaos-rising"><a id="dropdown_selected_currency">USD</a><h1>Prices For Pokemon Chaos Rising Pokemon Cards</h1><table id="games_table"><thead><tr><th>Card</th><th>PSA 10</th><th>Ungraded</th></tr></thead><tbody><tr><td class="title"><a href="/game/pokemon-chaos-rising/mega-greninja-ex-116">Mega Greninja ex #116</a></td><td>$495.00</td><td>$185.00</td></tr></tbody></table>'''
        self.assertEqual(parse_html(raw,self.snapshot['observedAt'])['rows'][0]['price'],'$495.00')
        with self.assertRaises(ValueError):parse_html(raw.replace('>USD<','>CAD<'),self.snapshot['observedAt'])

    def test_html_sale_price_ignores_listed_price(self):
        raw='''<link rel="canonical" href="https://www.pricecharting.com/game/pokemon-chaos-rising/mega-greninja-ex-116"><a id="dropdown_selected_currency">USD</a><h1 id="product_name">Mega Greninja ex #116 <a>Pokemon Chaos Rising</a></h1><div id="full-prices"><table><tr><td>PSA 10</td><td>$495.00</td></tr></table></div><select><option value="completed-auctions-manual-only">PSA 10 (1)</option></select><div class="completed-auctions-manual-only"><table><tbody><tr><td class="date">2026-09-06</td><td class="title"><a href="https://www.ebay.com/itm/198622644373">2026 POKEMON CHAOS RISING MEGA GRENINJA EX PSA 10 #116</a></td><td class="numeric"><span class="js-price">$500.00</span></td><td class="numeric listed-price"><span class="js-price">$515.00</span></td></tr></tbody></table></div>'''
        p=parse_html(raw,self.snapshot['observedAt']);self.assertEqual(p['sales'][0]['price'],'$500.00')
        with self.assertRaises(ValueError):parse_html(raw.replace('PSA 10 (1)','PSA 10 (30)'),self.snapshot['observedAt'])

if __name__=='__main__': unittest.main()
