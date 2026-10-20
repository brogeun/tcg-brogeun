"""Offline checks for website China prices. All fixture auction amounts are synthetic."""
import copy
import csv
import hashlib
import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import build_chinese_market as builder
import collect_chinese_prices as collector


PLAIN = '11111111-1111-4111-8111-111111111111'
MASTER = '22222222-2222-4222-8222-222222222222'
UNPRICED = '33333333-3333-4333-8333-333333333333'
OTHER = '44444444-4444-4444-8444-444444444444'
OBSERVED = '2026-10-10T09:00:00+00:00'


def auction(identity, title, price, day='2025-01-01', time='20:00:00'):
    return {'ID': identity, 'Title': title, 'LowestPrice': price, 'Price': '99999.00',
            'EffectiveDate': f'{day} {time}', 'Status': -2, 'ByWay': 2,
            'PriceCount': 3, 'SellSource': 'CN', 'NewPostageMoney': '80.00'}


class ChineseMarketBuildTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.source = self.root / 'capture'
        self.reports = self.root / 'build-reports'
        self.network = mock.patch('urllib.request.OpenerDirector.open',
                                  side_effect=AssertionError('Offline test attempted network access'))
        network_guard = self.network.start()
        self.addCleanup(self.network.stop)
        self.addCleanup(network_guard.assert_not_called)
        products = []
        for code, original in [('CN-151-LV', '收集啦151 旅'),
                               ('CN-151-WANG', '收集啦151 望'),
                               ('CN-CSV8', '补充包 璀璨诡幻')]:
            facts = [(PLAIN, '001', '妙蛙种子', 'non-holo'),
                     (MASTER, '001', '妙蛙种子', 'masterball'),
                     (UNPRICED, '170', '皮卡丘', 'holo')]
            source_code = '151c'
            if code == 'CN-CSV8':
                facts, source_code = [(OTHER, '009', '水箭龟', 'non-holo')], 'csv8c'
            cards = [{'id': f'{code}:{number}:{variant}', 'sourceId': sid,
                      'sourceSetCode': source_code, 'setCode': code, 'language': 'zh-CN',
                      'number': number, 'name': name, 'variant': variant}
                     for sid, number, name, variant in facts]
            self.write_json(f'data/chinese-sets/{code}.json', {
                'schemaVersion': 1, 'language': 'zh-CN', 'code': code, 'complete': True,
                'cardCount': len(cards), 'expectedCardCount': len(cards), 'cards': cards})
            products.append({'code': code, 'originalName': original, 'name': original,
                             'release': '2025-01-01', 'sourceUrl': 'https://www.pokemon.cn/tcg/product/1.html',
                             'variants': [{'name': '20장 팩 박스', 'cardsPerPack': 20,
                                           'packsPerBox': 6, 'msrpUnit': '박스', 'msrpCny': 300},
                                          {'name': '5장 팩', 'cardsPerPack': 5,
                                           'msrpUnit': '팩', 'msrpCny': 10}]})
        self.write_json('data/chinese-catalog.json', {
            'schemaVersion': 1, 'language': 'zh-CN', 'sets': products})
        self.proof = {
            'BOX:CN-151-LV:5': {'setCode': 'CN-151-LV', 'cardsPerPack': 5,
                                'packsPerBox': 15, 'basis': 'official',
                                'sourceUrl': 'https://www.pokemon.cn/tcg/event/2.html'},
            'BOX:CN-151-WANG:5': {'setCode': 'CN-151-WANG', 'cardsPerPack': 5,
                                  'packsPerBox': 30, 'basis': 'seller_reported',
                                  'sourceUrl': 'https://www.cardhobby.com.cn/market/item/2002'}}
        self.save_proof()
        title = '简中 宝可梦 151C 妙蛙种子 001/151 非闪 '
        rows = [auction(1001, title + 'NM', '12.34'),
                auction(1002, title + 'NM', '12.35', time='20:30:00'),
                auction(1003, title + 'NM', '99.99', day='2025-01-02'),
                auction(1101, title + 'PSA10', '200.00'),
                auction(1102, title + 'PSA10', '400.00', time='21:00:00'),
                auction(1103, title + 'PSA10', '500.00', day='2025-01-02'),
                auction(1201, title.replace('非闪', '大师球') + 'PSA10', '900.00'),
                auction(2001, '简中 宝可梦 收集啦151 旅 原封瘦盒 5张/包', '100.00'),
                auction(2002, '简中 宝可梦 收集啦151 望 原封瘦盒 5张/包', '120.00'),
                auction(2003, '简中 宝可梦 收集啦151 旅 原封肥盒 20张/包', '600.00'),
                auction(3001, title + 'PSA9', '888.00'),
                auction(3002, title + 'PSA10潜力 可送评', '888.00'),
                auction(3003, title + '英文 NM', '888.00'),
                auction(3004, '简中 宝可梦 收集啦151 旅 原封瘦盒 五盒一起', '1000.00')]
        page = collector.page_file(self.source, '151C', 1)
        self.write_json(page.relative_to(self.root), {
            'schemaVersion': 1, 'source': 'cardhobby', 'market': 'CN', 'currency': 'CNY',
            'observedAt': OBSERVED, 'query': '151C', 'page': 1,
            'pageSize': 60, 'totalCount': len(rows), 'items': rows})
        self.write_json('capture/checkpoint.json', {
            'queries': {'151C': {'complete': True}, 'CSV8C': {'complete': False}}})
        # Existing archive exports deliberately disagree with the pages. They must stay untouched.
        self.write_json('capture/prices.json', {'preserve': 'original prices archive'})
        self.write_json('capture/report.json', {'preserve': 'original report archive'})

    def write_json(self, relative, value):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
        return path

    def save_proof(self):
        self.write_json('data/chinese-box-configurations.json', {
            'schemaVersion': 1, 'language': 'zh-CN', 'configurations': self.proof})

    def build(self):
        with redirect_stdout(io.StringIO()):
            return builder.build(self.root, self.source, self.reports)

    def archive_snapshot(self):
        return {str(p.relative_to(self.source)): (hashlib.sha256(p.read_bytes()).hexdigest(),
                                                 p.stat().st_mtime_ns)
                for p in self.source.rglob('*') if p.is_file()}

    def test_grades_and_printed_variants_keep_independent_prices(self):
        market, _ = self.build()
        self.assertEqual(set(market['cards']), {PLAIN, MASTER})
        plain, master = market['cards'][PLAIN], market['cards'][MASTER]
        self.assertEqual(set(plain['grades']), {'psa10', 'raw'})
        self.assertEqual(set(master['grades']), {'psa10'})
        self.assertEqual(plain['grades']['psa10']['priceMinor'], 50000)
        self.assertEqual(plain['grades']['raw']['priceMinor'], 9999)
        self.assertEqual(master['grades']['psa10']['priceMinor'], 90000)
        self.assertEqual((plain['variant'], master['variant']), ('non-holo', 'masterball'))
        self.assertEqual(market['coverage']['auctions'], 10)

    def test_daily_median_uses_exact_cny_minor_units_and_separate_history(self):
        market, _ = self.build()
        raw = market['cards'][PLAIN]['grades']['raw']
        psa = market['cards'][PLAIN]['grades']['psa10']
        self.assertEqual([(p['date'], p['priceMinor'], p['auctionCount']) for p in raw['history']],
                         [('2025-01-01', 1235, 2), ('2025-01-02', 9999, 1)])
        self.assertEqual([(p['priceMinor'], p['auctionCount']) for p in psa['history']],
                         [(30000, 2), (50000, 1)])
        self.assertEqual((raw['totalAuctionCount'], psa['totalAuctionCount']), (3, 3))
        self.assertEqual(raw['sourceUrl'], 'https://www.cardhobby.com.cn/market/item/1003')
        self.assertEqual(raw['history'][0]['sourceUrl'], 'https://www.cardhobby.com.cn/market/item/1002')
        self.assertEqual(psa['history'][0]['sourceUrl'], 'https://www.cardhobby.com.cn/market/item/1102')
        self.assertEqual((market['currency'], market['market'], market['language']), ('CNY', 'CN', 'zh-CN'))
        self.assertEqual(market['aggregation'], 'median_per_auction_end_day')
        self.assertEqual(market['priceKind'], 'auction_end_price')
        self.assertFalse(market['shippingIncluded'])
        self.assertFalse(market['paymentCompletionVerified'])

    def test_official_and_seller_box_proof_remain_distinct(self):
        market, _ = self.build()
        boxes = {b['targetId']: b for rows in market['boxes'].values() for b in rows}
        official = boxes['BOX:CN-151-LV:5']
        seller = boxes['BOX:CN-151-WANG:5']
        self.assertEqual(official['packsPerBox'], 15)
        self.assertTrue(official['configurationVerified'])
        self.assertEqual(official['configurationSourceUrl'], self.proof[official['targetId']]['sourceUrl'])
        self.assertIsNone(official['sellerReportedPacksPerBox'])
        self.assertIsNone(seller['packsPerBox'])
        self.assertFalse(seller['configurationVerified'])
        self.assertIsNone(seller['configurationSourceUrl'])
        self.assertEqual(seller['sellerReportedPacksPerBox'], 30)
        self.assertEqual(seller['sellerConfigurationSourceUrl'], self.proof[seller['targetId']]['sourceUrl'])
        self.assertEqual(seller['priceMinor'], 12000)
        self.assertEqual(boxes['BOX:CN-151-LV:20']['packsPerBox'], 6)
        self.assertTrue(boxes['BOX:CN-151-LV:20']['configurationVerified'])
        self.assertEqual(boxes['BOX:CN-151-LV:20']['configurationSourceUrl'],
                         'https://www.pokemon.cn/tcg/product/1.html')

    def test_absent_box_evidence_does_not_infer_packs_or_change_auction_price(self):
        (self.root / 'data/chinese-box-configurations.json').unlink()
        market, _ = self.build()
        box = next(b for b in market['boxes']['CN-151-WANG'] if b['cardsPerPack'] == 5)
        self.assertIsNone(box['packsPerBox'])
        self.assertIsNone(box['sellerReportedPacksPerBox'])
        self.assertFalse(box['configurationVerified'])
        self.assertEqual(box['priceMinor'], 12000)

    def test_mismatched_box_evidence_is_rejected_before_export(self):
        for changes in [{'setCode': 'CN-CSV8'}, {'cardsPerPack': 20},
                        {'packsPerBox': True}, {'packsPerBox': 0}, {'packsPerBox': '15'}]:
            with self.subTest(changes=changes):
                original = copy.deepcopy(self.proof)
                self.proof['BOX:CN-151-LV:5'].update(changes)
                self.save_proof()
                with self.assertRaises(ValueError):
                    self.build()
                self.assertFalse((self.root / 'data/chinese-market.json').exists())
                self.proof = original

    def test_missing_csv_contains_every_unpriced_card_grade_and_box_target(self):
        market, _ = self.build()
        with (self.reports / 'missing-prices.csv').open(encoding='utf-8-sig', newline='') as stream:
            rows = list(csv.DictReader(stream))
        catalog = collector.PriceCatalog(self.root)
        expected = {('card', sid, grade) for sid in catalog.cards for grade in ('psa10', 'raw')
                    if grade not in market['cards'].get(sid, {}).get('grades', {})}
        priced_boxes = {b['targetId'] for bs in market['boxes'].values() for b in bs}
        expected |= {('box', tid, 'box') for tid in catalog.boxes if tid not in priced_boxes}
        self.assertEqual({(r['kind'], r['targetId'], r['grade']) for r in rows}, expected)
        self.assertEqual(len(rows), len(expected))
        self.assertEqual(len(rows), 8)
        self.assertTrue(all(r['status'] == 'no_verified_price_record' for r in rows))
        shared = next(r for r in rows if r['targetId'] == MASTER and r['grade'] == 'raw')
        self.assertEqual(shared['setCode'], 'CN-151-LV|CN-151-WANG')
        self.assertEqual((shared['number'], shared['variant']), ('001', 'masterball'))

    def test_coverage_counts_shared_uuid_once_and_keeps_unpriced_products_visible(self):
        market, report = self.build()
        expected = {'cardVersions': 4, 'pricedCards': 2, 'psa10Cards': 2, 'ACards': 1,
                    'products': 3, 'pricedBoxProducts': 2, 'boxFormats': 6,
                    'pricedBoxFormats': 3, 'verifiedPricedBoxFormats': 2,
                    'auctions': 10, 'queriesCompleted': 1, 'queriesPending': 1}
        self.assertEqual(market['coverage'], expected)
        self.assertEqual(report['coverage'], expected)
        self.assertEqual(market['sets']['CN-151-LV']['pricedCards'], 2)
        self.assertEqual(market['sets']['CN-151-WANG']['pricedCards'], 2)
        self.assertEqual(market['sets']['CN-CSV8'], {
            'cardVersions': 1, 'pricedCards': 0, 'boxFormats': 2, 'pricedBoxFormats': 0})
        self.assertEqual(market['boxes'].get('CN-CSV8', []), [])

    def test_source_archive_bytes_and_timestamps_are_not_modified(self):
        before = self.archive_snapshot()
        _, report = self.build()
        self.assertEqual(self.archive_snapshot(), before)
        self.assertTrue(report['siteDataBuilt'])
        self.assertFalse(report['originalArchiveModified'])
        self.assertFalse(report['appPricesChanged'])
        self.assertTrue((self.root / 'data/chinese-market.json').is_file())
        self.assertTrue((self.reports / 'report.json').is_file())

    def test_repeated_pages_do_not_duplicate_auction_count_or_daily_prices(self):
        first = next((self.source / 'pages').glob('*.json'))
        payload = json.loads(first.read_text(encoding='utf-8'))
        payload.update(page=2, observedAt='2026-10-10T10:00:00+00:00')
        duplicate = collector.page_file(self.source, '151C', 2)
        self.write_json(duplicate.relative_to(self.root), payload)
        before = self.archive_snapshot()
        market, _ = self.build()
        self.assertEqual(market['coverage']['auctions'], 10)
        self.assertEqual(market['cards'][PLAIN]['grades']['raw']['history'][0]['auctionCount'], 2)
        self.assertEqual(market['cards'][PLAIN]['grades']['raw']['history'][0]['priceMinor'], 1235)
        self.assertEqual(market['observedAt'], payload['observedAt'])
        self.assertEqual(self.archive_snapshot(), before)

    def test_repeated_builds_preserve_prices_coverage_and_missing_targets(self):
        before = self.archive_snapshot()
        first, _ = self.build()
        missing = (self.reports / 'missing-prices.csv').read_bytes()
        second, _ = self.build()
        first.pop('generatedAt')
        second.pop('generatedAt')
        self.assertEqual(first, second)
        self.assertEqual((self.reports / 'missing-prices.csv').read_bytes(), missing)
        self.assertEqual(self.archive_snapshot(), before)

    def test_output_paths_cannot_overlap_read_only_source_archive(self):
        original_source, original_reports = self.source, self.reports
        for source, reports in [(original_source, original_source),
                                (original_source, original_source / 'nested-reports'),
                                (self.root / 'data', original_reports)]:
            with self.subTest(source=source, reports=reports):
                self.source, self.reports = source, reports
                before = self.archive_snapshot()
                with self.assertRaises(ValueError):
                    self.build()
                self.assertEqual(self.archive_snapshot(), before)
        self.source, self.reports = original_source, original_reports

    def test_compiler_is_called_read_only_and_mock_payload_is_not_mutated(self):
        data, report = collector.compile_results(self.source, collector.PriceCatalog(self.root), write=False)
        original_data, original_report = copy.deepcopy(data), copy.deepcopy(report)
        # Builder intentionally annotates its report. Return a separate report object from the mock.
        with mock.patch.object(builder.collector, 'compile_results',
                               return_value=(data, copy.deepcopy(report))) as compiled:
            market, _ = self.build()
        compiled.assert_called_once()
        self.assertEqual(compiled.call_args.args[0], self.source)
        self.assertEqual(compiled.call_args.kwargs, {'write': False})
        self.assertEqual(data, original_data)
        self.assertEqual(report, original_report)
        self.assertEqual(market['observedAt'], OBSERVED)

    def test_empty_archive_creates_complete_missing_list_without_placeholder_prices(self):
        for path in (self.source / 'pages').glob('*.json'):
            path.unlink()
        market, _ = self.build()
        self.assertEqual(market['cards'], {})
        self.assertTrue(all(not boxes for boxes in market['boxes'].values()))
        self.assertIsNone(market['observedAt'])
        self.assertEqual(market['coverage']['auctions'], 0)
        with (self.reports / 'missing-prices.csv').open(encoding='utf-8-sig', newline='') as stream:
            rows = list(csv.DictReader(stream))
        self.assertEqual(len(rows), 14)

    def test_invalid_source_cache_aborts_without_overwriting_existing_site_data(self):
        existing = self.write_json('data/chinese-market.json', {'preserve': 'previous site prices'})
        before = existing.read_bytes()
        page = next((self.source / 'pages').glob('*.json'))
        payload = json.loads(page.read_text(encoding='utf-8'))
        payload['currency'] = 'USD'
        page.write_text(json.dumps(payload), encoding='utf-8')
        archive_before = self.archive_snapshot()
        with self.assertRaises(ValueError):
            self.build()
        self.assertEqual(existing.read_bytes(), before)
        self.assertEqual(self.archive_snapshot(), archive_before)
        self.assertFalse((self.reports / 'missing-prices.csv').exists())


if __name__ == '__main__':
    unittest.main()
