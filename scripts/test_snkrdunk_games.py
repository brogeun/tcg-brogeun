"""Regression checks for game identity, quote semantics and additive publication."""
import argparse
import ast
import copy
import json
import pathlib
import re
import tempfile
import unittest
import urllib.error
from datetime import datetime, timezone
from unittest import mock

import collect_snkrdunk_games as collector
import game_registry as registry
import refresh_search_prices as legacy_refresh

NOW = '2026-10-29T00:00:00+00:00'

def listing(cid='123', **changes):
    return {'id': int(cid), 'name': 'Modernia SR [UA18BT-NIK-1-019]',
            'productNumber': 'UATCG-UA18BT-NIK-1-019', 'thumbnailUrl': 'https://cdn.snkrdunk.com/card.webp',
            'minPrice': 1000, 'minPriceFormat': '¥1,000', 'listingCount': '1', **changes}

def quote_html(price=1000, cid='123'):
    chips = [
        {'conditionId': 18, 'usedMinPrice': price, 'hasListing': bool(price), 'listingCount': 1 if price else 0},
        {'conditionId': 22, 'hasListing': False},
        {'conditionId': 23, 'hasListing': False},
    ]
    data={'queries':[{'queryKey':[f'/v2/products/{cid}/size-chips',{'type':'apparel'}],
                      'state':{'status':'success','data':{'status':200,'data':{'chips':chips}}}}]}
    return '<script>window["__RQ_TEST"].push('+json.dumps(data,separators=(',',':'))+');</script>'

def args(data_dir, **changes):
    return argparse.Namespace(data_dir=pathlib.Path(data_dir), brands='union_arena', delay=.25,
                              max_seconds=30, per_page=100, max_pages=2, grade_limit=1,
                              history_limit=0, checkpoint_every=1, no_shared=False, **changes)

class FakeClient:
    def __init__(self, listings=None, html=None, charts=None, failure=None):
        self.requests, self.urls = 0, []
        self.listings = listings if listings is not None else [listing()]
        self.html = html if html is not None else quote_html()
        self.charts = charts if charts is not None else {'points': []}
        self.failure = failure

    def get(self, url, json_response=True):
        self.requests += 1
        self.urls.append(url)
        if self.failure:
            raise self.failure
        if '/trading-cards?' in url:
            from urllib.parse import urlparse, parse_qs
            query = parse_qs(urlparse(url).query)
            if query['categoryId'] == ['14']:
                return {'tradingCards': []}
            return {'tradingCards': self.listings if query['page'] == ['1'] else []}
        return self.charts if json_response else self.html

class RegistryTests(unittest.TestCase):
    def test_unknown_never_becomes_pokemon(self):
        self.assertIsNone(registry.normalize_brand('unknown'))
        self.assertIsNone(registry.normalize_brand(None))
        self.assertIsNone(registry.infer_brand_from_product_number('ST01'))

    def test_aliases_and_canonical_selection(self):
        self.assertEqual(registry.select_brands('weis-schwarz,union-arena,digimoncard'), ['weiss_schwarz', 'union_arena', 'digimon'])
        self.assertEqual(registry.normalize_brand({'slug':'yu-gi-oh'}), 'yugioh')

    def test_nikke_is_ip_not_independent_game(self):
        with self.assertRaises(ValueError): registry.select_brands('nikke')
        self.assertEqual(registry.ip_tags({'name':'Goddess of Victory: NIKKE'}), ['nikke'])

    def test_fusion_world_does_not_admit_masters_or_divers(self):
        self.assertTrue(registry.product_in_scope('dragon_ball_fusion_world', {'productNumber':'DBSC-TCG-FB01-139'}))
        self.assertFalse(registry.product_in_scope('dragon_ball_fusion_world', {'productNumber':'DBSC-TCG-BT12-001','name':'Masters'}))
        self.assertFalse(registry.product_in_scope('dragon_ball_fusion_world', {'productNumber':'SDV1-001','name':'Super Divers'}))

    def test_weiss_blau_kept_separate(self):
        self.assertFalse(registry.product_in_scope('weiss_schwarz', {'name':'Weiss Schwarz Blau Chiikawa'}))
        self.assertTrue(registry.product_in_scope('weiss_schwarz', {'name':'Weiss Schwarz NIKKE'}))

    def test_recognition_aliases_preserve_source_id(self):
        self.assertEqual(registry.RECOGNITION_GAME_IDS['weiss_schwarz'], 'weiss')
        self.assertEqual(registry.RECOGNITION_GAME_IDS['union_arena'], 'union-arena')

    def test_queue_does_not_starve_games_with_high_numeric_ids(self):
        products={str(i):{'id':str(i),'brand':brand,'kind':'card'} for i,brand in [(1,'yugioh'),(2,'yugioh'),(999999,'digimon')]}
        rows=collector.fair_queue(products,['yugioh','digimon'],'gradeCheckedAt')
        self.assertEqual([row['id'] for row in rows],['1','999999','2'])

class QuoteTests(unittest.TestCase):
    def test_jpy_native_and_usd_conversion_explicit(self):
        row = collector.normalize_product(listing(), 'union_arena', 'card', NOW, {'rates':{'USD':1000,'JPY':10}})
        self.assertEqual(row['minPrice'], 10)
        self.assertEqual(row['catalogAsk']['amount'], 1000)
        self.assertEqual(row['catalogAsk']['currency'], 'JPY')
        self.assertEqual(row['catalogAsk']['condition'], 'unspecified')

    def test_missing_fx_keeps_native_and_no_fabricated_usd(self):
        row = collector.normalize_product(listing(), 'union_arena', 'card', NOW, None)
        self.assertIsNone(row['minPrice'])
        self.assertEqual(row['priceStatus'], 'native-currency-only')
        self.assertEqual(row['catalogAsk']['amount'], 1000)

    def test_zero_means_missing_not_free(self):
        row = collector.normalize_product(listing(minPrice=0,minPriceFormat='¥--',listingCount='0'), 'union_arena', 'card', NOW, None)
        self.assertIsNone(row['minPrice'])
        self.assertIsNone(row['catalogAsk']['amount'])
        self.assertEqual(row['priceStatus'], 'no-listings')

    def test_unverified_currency_and_conflicting_count_rejected(self):
        with self.assertRaises(collector.CollectionError): collector.parse_native_listing(listing(minPriceFormat='1,000'))
        with self.assertRaises(collector.CollectionError): collector.parse_native_listing(listing(minPriceFormat='¥2,000'))
        with self.assertRaises(collector.CollectionError): collector.normalize_product(listing(listingCount=0), 'union_arena', 'card', NOW, None)
        with self.assertRaises(collector.CollectionError): collector.parse_native_listing(listing(currency='USD'))

    def test_listing_count_lower_bound_preserved_without_guessing(self):
        row=collector.normalize_product(listing(listingCount='99+'), 'union_arena', 'card', NOW, None)
        self.assertEqual(row['listingCount'],'99+')

    def test_grade_chips_do_not_merge_or_make_zero_price(self):
        grades = collector.parse_grade_chips(quote_html())
        self.assertEqual(grades['raw']['lowest_ask'], 1000)
        self.assertNotIn('lowest_ask', grades['psa10'])
        self.assertEqual(grades['psa10']['availability'], 'no-listing')

    def test_incomplete_grade_source_rejected(self):
        with self.assertRaises(collector.CollectionError): collector.parse_grade_chips('{"conditionId":18,"usedMinPrice":1000}')

    def test_grade_chips_must_belong_to_requested_product(self):
        with self.assertRaises(collector.CollectionError):collector.parse_grade_chips(quote_html(cid='999'),'123')
        text=quote_html(price=99999,cid='999')+quote_html(price=1000,cid='123')
        self.assertEqual(collector.parse_grade_chips(text,'123')['raw']['lowest_ask'],1000)

    def test_chart_empty_is_valid_no_trades_and_malformed_rejected(self):
        self.assertEqual(collector.parse_chart({'points':[]}), [])
        self.assertEqual(collector.parse_chart({'points':[[1000,0],[2000,200]]}), [[2000,200]])
        with self.assertRaises(collector.CollectionError): collector.parse_chart({'points':[[1000,'bad']]})

    def test_language_not_guessed_from_english_product_name(self):
        self.assertEqual(collector.declared_language({'name':'Modernia SR'}), 'unknown')
        self.assertEqual(collector.declared_language({'name':'Modernia [EN]'}), 'en')

    def test_box_and_full_card_number_classification(self):
        self.assertEqual(collector.classified_kind({'name':'NIKKE Booster Box'}, 'card'), 'box')
        self.assertEqual(collector.classified_kind({'name':'Rapi SEC+ [NIK/S117-010EX](Booster Pack NIKKE)'}, 'box'), 'card')

class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = pathlib.Path(self.temp.name)
        self.old = {'details':[
            {'id':'1','name':'Old Pokemon','brand':'pokemon','kind':'card','psa10':{'sourcePriceCents':12300}},
            {'id':'2','name':'Unknown game preserved','brand':'custom_future_game','kind':'card'},
        ], 'fetchedAt':'old-global', 'byBrand':{'pokemon':['1'],'custom_future_game':['2']}}
        (self.data/'all-cards.json').write_text(json.dumps(self.old),encoding='utf-8')
        (self.data/'cards-meta.json').write_text(json.dumps({'fetchedAt':'old-global','cards':self.old['details']}),encoding='utf-8')
        (self.data/'cards-prices.json').write_text(json.dumps({'fetchedAt':'old-global','prices':{'1':[12,'USD',1],'2':[34,'USD',2]}}),encoding='utf-8')

    def tearDown(self): self.temp.cleanup()

    def test_end_to_end_additive_shared_group_and_original_quotes(self):
        client = FakeClient()
        self.assertEqual(collector.run(args(self.data,merge_new_search=True),client),0)
        data = json.loads((self.data/'all-cards.json').read_text(encoding='utf-8'))
        rows = {r['id']:r for r in data['details']}
        self.assertEqual(rows['1'],self.old['details'][0])
        self.assertEqual(rows['2'],self.old['details'][1])
        self.assertEqual(data['byBrand']['custom_future_game'],['2'])
        self.assertEqual(rows['123']['brand'],'union_arena')
        self.assertEqual(data['fetchedAt'],'old-global')
        prices=json.loads((self.data/'cards-prices.json').read_text(encoding='utf-8'))['prices']
        self.assertEqual(prices['2'],[34,'USD',2])
        detail=json.loads((self.data/'cards-detail.json').read_text(encoding='utf-8'))
        self.assertEqual(detail['cards']['123']['grades']['raw']['lowest_ask'],1000)
        metadata=json.loads((self.data/'cards-meta-index.json').read_text(encoding='utf-8'))
        self.assertEqual(metadata['123']['brand'],'union_arena')
        self.assertEqual(len(client.urls),4)

    def test_default_scoped_search_keeps_full_new_source_feed(self):
        collector.run(args(self.data),FakeClient())
        shared=json.loads((self.data/'all-cards.json').read_text(encoding='utf-8'))
        self.assertEqual([row['id'] for row in shared['details']],['1','2'])
        self.assertEqual(shared['byBrand']['custom_future_game'],['2'])
        source=json.loads((self.data/'price-union_arena-card.json').read_text(encoding='utf-8'))
        self.assertEqual(source['products'][0]['id'],'123')
        metadata=json.loads((self.data/'cards-meta-index.json').read_text(encoding='utf-8'))
        self.assertEqual(metadata['123']['brand'],'union_arena')

    def test_existing_shards_preserve_quote_checkpoints(self):
        (self.data/'snkrdunk-games').mkdir()
        row=collector.normalize_product(listing(), 'union_arena', 'card', NOW, None)
        shard={'schemaVersion':1,'brand':'union_arena','kind':'card','products':[row]}
        (self.data/'snkrdunk-games/union_arena-card-0001.json').write_text(json.dumps(shard),encoding='utf-8')
        base={'brand':'union_arena','kind':'card','products':[],'totalCount':1,'shards':['/data/snkrdunk-games/union_arena-card-0001.json']}
        path=self.data/'price-union_arena-card.json';path.write_text(json.dumps(base),encoding='utf-8')
        self.assertEqual(collector._catalog_rows(path)['123'],row)

    def test_listing_continuation_does_not_restart_completed_streams(self):
        old=collector.normalize_product(listing(), 'union_arena', 'card', NOW, None)
        (self.data/'price-union_arena-card.json').write_text(json.dumps({'products':[old],'collection':{'complete':False,'terminal':'page-budget','pages':1}}),encoding='utf-8')
        (self.data/'price-union_arena-box.json').write_text(json.dumps({'products':[],'collection':{'complete':True,'terminal':'empty-page','pages':1}}),encoding='utf-8')
        client=FakeClient()
        collector.run(args(self.data,continue_listing=True,skip_grades=True),client)
        self.assertEqual(len(client.urls),1)
        self.assertIn('page=2',client.urls[0])
        source=json.loads((self.data/'price-union_arena-card.json').read_text(encoding='utf-8'))
        self.assertEqual(source['products'][0]['priceCheckedAt'],NOW)

    def test_listing_page_budget_does_not_cap_retained_cursor(self):
        class LaterPages(FakeClient):
            def get(self,url,json_response=True):
                self.requests += 1
                self.urls.append(url)
                from urllib.parse import parse_qs, urlparse
                page = int(parse_qs(urlparse(url).query)['page'][0])
                return {'tradingCards':[listing(str(page))]}
        client = LaterPages()
        rows, stream = collector.collect_listing(client,'union_arena','card',None,per_page=1,max_pages=2,start_page=2001)
        self.assertEqual(set(rows), {'2001','2002'})
        self.assertEqual(stream['pages'],2002)
        self.assertEqual(stream['terminal'],'page-budget')
        self.assertEqual(len(client.urls),2)

    def test_grade_phase_expiry_still_processes_history(self):
        class ExpiringGradeClient(FakeClient):
            def get(self,url,json_response=True):
                if not json_response:
                    self.requests+=1
                    raise collector.PhaseBudgetExhausted('fixture reserved history')
                return super().get(url,json_response)
        settings=args(self.data);settings.history_limit=1
        collector.run(settings,ExpiringGradeClient())
        result=json.loads((self.data/'snkrdunk-games.json').read_text(encoding='utf-8'))['collection']
        self.assertEqual(result['gradeChecks'],0)
        self.assertEqual(result['historyChecks'],1)
        self.assertEqual(result['gradePhaseStatus'],'time-budget-reached-history-reserved')
        self.assertTrue((self.data/'snkrdunk-history/123.json').exists())

    def test_unchanged_legacy_search_files_not_rewritten(self):
        before={name:(self.data/name).read_bytes() for name in ['all-cards.json','cards-meta.json','cards-prices.json']}
        collector.run(args(self.data),FakeClient())
        self.assertEqual(before,{name:(self.data/name).read_bytes() for name in before})

    def test_existing_unrelated_metadata_not_relabeled(self):
        previous={'77':{'name':'Custom','brand':'unrelated_game','custom':True}}
        (self.data/'cards-meta-index.json').write_text(json.dumps(previous),encoding='utf-8')
        collector.run(args(self.data),FakeClient())
        metadata=json.loads((self.data/'cards-meta-index.json').read_text(encoding='utf-8'))
        self.assertEqual(metadata['77'],previous['77'])

    def test_conflicting_game_rejected_before_any_write(self):
        product=collector.normalize_product(listing('1'), 'union_arena', 'card', NOW, None)
        before={p.name:p.read_bytes() for p in self.data.iterdir()}
        with self.assertRaises(collector.CollectionError):
            collector.publish(self.data,{'1':product},{},['union_arena'],{'runId':NOW})
        self.assertEqual(before,{p.name:p.read_bytes() for p in self.data.iterdir()})

    def test_metadata_only_and_unknown_ids_cannot_be_relabelled(self):
        for cid, old in [('777',{'brand':'pokemon','name':'Only in metadata'}),
                         ('2',{'brand':'future_game','name':'Unknown explicit game'})]:
            with self.subTest(cid=cid):
                (self.data/'cards-meta-index.json').write_text(json.dumps({cid:old}),encoding='utf-8')
                before={path:path.read_bytes() for path in self.data.rglob('*.json')}
                product=collector.normalize_product(listing(cid),'union_arena','card',NOW,None)
                with self.assertRaises(collector.CollectionError):
                    collector.publish(self.data,{cid:product},{},['union_arena'],{'runId':NOW})
                self.assertEqual(before,{path:path.read_bytes() for path in self.data.rglob('*.json')})

    def test_failed_grade_retains_previous_quote_and_check_time(self):
        old=collector.normalize_product(listing(), 'union_arena', 'card', NOW, None)
        old.update(grades={'raw':{'lowest_ask':900,'currency':'JPY'}},gradeCheckedAt='2026-10-01T00:00:00Z')
        (self.data/'price-union_arena-card.json').write_text(json.dumps({'products':[old]}),encoding='utf-8')
        collector.run(args(self.data),FakeClient(html='upstream incomplete'))
        row=json.loads((self.data/'price-union_arena-card.json').read_text(encoding='utf-8'))['products'][0]
        self.assertEqual(row['grades'],old['grades'])
        self.assertEqual(row['gradeCheckedAt'],old['gradeCheckedAt'])
        self.assertEqual(row['gradeStatus'],'previous-retained-after-error')

    def test_budget_checkpoints_without_redating_old_quotes(self):
        old=collector.normalize_product(listing(), 'union_arena', 'card', NOW, None)
        old.update(gradeCheckedAt='2026-10-01',grades={'raw':{'lowest_ask':900,'currency':'JPY'}})
        (self.data/'price-union_arena-card.json').write_text(json.dumps({'products':[old]}),encoding='utf-8')
        self.assertEqual(collector.run(args(self.data),FakeClient(failure=collector.BudgetExhausted('fixture budget'))),0)
        row=json.loads((self.data/'price-union_arena-card.json').read_text(encoding='utf-8'))['products'][0]
        self.assertEqual(row['priceCheckedAt'],NOW)
        self.assertEqual(row['gradeCheckedAt'],'2026-10-01')

    def test_legacy_search_refresh_preserves_new_and_unknown_games(self):
        old={'details':[
            {'id':'123','brand':'union_arena','kind':'card','name':'Modernia','minPrice':99,'currency':'USD','listingCount':1,'priceCheckedAt':NOW,'priceStatus':'available'},
            {'id':'456','brand':'custom_future_game','kind':'card','name':'Custom','minPrice':5,'currency':'USD','listingCount':1},
        ]}
        def page(brand,order,page,per_page):
            return {'tradingCards':[listing('900' if brand=='pokemon' else '901',name='Card',minPrice=2,minPriceFormat='$2')]} if page==1 else {'tradingCards':[]}
        out=legacy_refresh.build_documents(old,{'rates':{'USD':1000,'JPY':10}},page,now=lambda:datetime(2026,10,29,tzinfo=timezone.utc))
        rows={r['id']:r for r in out['all-cards.json']['details']}
        self.assertEqual(rows['123'],old['details'][0])
        self.assertEqual(rows['456'],old['details'][1])

class ClientTests(unittest.TestCase):
    def test_403_stops_without_retry_or_cookies(self):
        captured=[]
        def fail(req,timeout):
            captured.append(req)
            raise urllib.error.HTTPError(req.full_url,403,'blocked',{},None)
        client=collector.PublicClient(opener=fail,sleep=lambda value:None)
        with self.assertRaises(collector.SourceStopped):client.get('https://snkrdunk.com/example')
        self.assertEqual(len(captured),1)
        self.assertNotIn('Cookie',dict(captured[0].header_items()))

    def test_non_original_host_rejected(self):
        client=collector.PublicClient(sleep=lambda value:None)
        with self.assertRaises(collector.CollectionError):client.get('https://example.com/')
        self.assertEqual(client.requests,0)

if __name__ == '__main__': unittest.main()
