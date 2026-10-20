"""Offline tests for public CardHobby CNY collection; every price is synthetic."""
import copy
import csv
import io
import http.client
import ssl
import urllib.error
from contextlib import redirect_stdout
import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest import mock

import collect_chinese_prices as collector

NOW = datetime(2026, 10, 10, 12, 0, tzinfo=timezone.utc)
PLAIN_ID = '11111111-1111-4111-8111-111111111111'
MASTER_ID = '22222222-2222-4222-8222-222222222222'
HOLO_ID = '33333333-3333-4333-8333-333333333333'
BASE_TITLE = '简中 宝可梦 151C 妙蛙种子 001/151 非闪 NM'


def auction(**changes):
    row = {'ID': 12345, 'Title': BASE_TITLE, 'LowestPrice': '12.34',
           'Price': '1.00', 'EffectiveDate': '2025-01-09 20:30:00',
           'Status': -2, 'ByWay': 2, 'PriceCount': 3, 'SellSource': 'CN',
           'NewPostageMoney': '8.00', 'QuantitySold': 0}
    row.update(changes)
    return row


def fixture_card(code, source_id, number, name, variant):
    return {'id': f'{code}:{number}:{variant}', 'sourceId': source_id,
            'sourceSetCode': '151c', 'setCode': code, 'language': 'zh-CN',
            'number': number, 'name': name, 'variant': variant,
            'rarity': 'C', 'image': 'https://images.pikaqian.com/originals/151c/' + source_id + '.png'}


class ChinesePriceCollectorTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.output = self.root / 'capture'
        self.output.mkdir()
        self.network = mock.patch('urllib.request.OpenerDirector.open', side_effect=AssertionError('Offline tests cannot call the network'))
        self.network_guard = self.network.start()
        self.addCleanup(self.network.stop)
        self.addCleanup(self.network_guard.assert_not_called)
        self.write_catalog()

    def write_json(self, relative, value):
        file = self.root / relative
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
        return file

    def write_catalog(self):
        products = []
        for code, original in [('CN-151-LV', '收集啦151 旅'), ('CN-151-WANG', '收集啦151 望')]:
            rows = [fixture_card(code, PLAIN_ID, '001', '妙蛙种子', 'non-holo'),
                    fixture_card(code, MASTER_ID, '001', '妙蛙种子', 'masterball'),
                    fixture_card(code, HOLO_ID, '170', '皮卡丘', 'holo')]
            self.write_json('data/chinese-sets/' + code + '.json', {
                'schemaVersion': 1, 'language': 'zh-CN', 'code': code,
                'sourceSetCode': '151c', 'complete': True, 'cardCount': len(rows),
                'expectedCardCount': len(rows), 'printedCardCount': 2, 'cards': rows})
            products.append({'code': code, 'name': original, 'originalName': original,
                             'aliases': [original, '151'], 'release': '2025-01-01',
                             'sourceUrl': 'https://special.pokemon.cn/151/',
                             'variants': [{'name': '20장 팩 박스', 'cardsPerPack': 20,
                                           'packsPerBox': 6, 'msrpUnit': '박스', 'msrpCny': 300},
                                          {'name': '5장 팩', 'cardsPerPack': 5,
                                           'msrpUnit': '팩', 'msrpCny': 10}]})
        self.write_json('data/chinese-catalog.json', {
            'schemaVersion': 1, 'language': 'zh-CN', 'sets': products})


    def add_source_product(self, code, source_code, original, rows):
        data = json.loads((self.root / 'data/chinese-catalog.json').read_text(encoding='utf-8'))
        data['sets'].append({'code': code, 'name': original, 'originalName': original,
                             'release': '2025-01-01', 'sourceUrl': 'https://www.pokemon.cn/tcg/test.html', 'variants': []})
        self.write_json('data/chinese-catalog.json', data)
        self.write_json('data/chinese-sets/' + code + '.json', {
            'schemaVersion': 1, 'language': 'zh-CN', 'code': code,
            'sourceSetCode': source_code, 'complete': True, 'cardCount': len(rows),
            'expectedCardCount': len(rows), 'printedCardCount': len({r['number'] for r in rows}), 'cards': rows})

    def quote(self, row=None):
        return collector.normalize_quote(auction() if row is None else row, now=NOW)

    def assert_rejected(self, row):
        quote, reason = self.quote(row)
        self.assertIsNone(quote)
        self.assertTrue(reason)

    def save_page(self, keyword, page, rows, **changes):
        value = {'schemaVersion': 1, 'source': 'cardhobby', 'market': 'CN', 'currency': 'CNY',
                 'observedAt': '2026-10-10T09:00:00+00:00', 'query': keyword,
                 'page': page, 'pageSize': 2, 'totalCount': len(rows), 'items': rows}
        value.update(changes)
        file = collector.page_file(self.output, keyword, page)
        self.write_json(file.relative_to(self.root), value)
        return file

    def test_actual_end_price_excludes_shipping_and_preserves_auction_semantics(self):
        row = auction()
        before = copy.deepcopy(row)
        quote, reason = self.quote(row)
        self.assertEqual(reason, '')
        self.assertEqual((quote['listingId'], quote['priceMinor'], quote['shippingMinor']), ('12345', 1234, 800))
        self.assertEqual((quote['source'], quote['market'], quote['currency'], quote['grade']), ('cardhobby', 'CN', 'CNY', 'raw'))
        self.assertEqual((quote['condition'], quote['conditionLabel'], quote['bidCount']), ('A', 'NM', 3))
        self.assertEqual(quote['priceKind'], 'auction_end_price')
        self.assertEqual(quote['auctionEndAt'], '2025-01-09T20:30:00+08:00')
        self.assertEqual(quote['timeZoneAssumed'], 'Asia/Shanghai')
        self.assertFalse(quote['paymentCompletionVerified'])
        self.assertTrue(quote['sellerConditionOnly'])
        self.assertNotIn('paymentCompletedAt', quote)
        self.assertNotIn('salesCount', quote)
        self.assertEqual(row, before)

    def test_money_uses_exact_minor_units_and_never_rounds_float_contamination(self):
        for amount, expected in [('0.29', 29), (12.34, 1234), ('1,234.56', 123456), (1, 100)]:
            with self.subTest(amount=amount):
                quote, reason = self.quote(auction(LowestPrice=amount))
                self.assertEqual(reason, '')
                self.assertEqual(quote['priceMinor'], expected)
                self.assertIs(type(quote['priceMinor']), int)
        for amount in [0, -1, True, '0', 'NaN', 'Infinity', float('inf'), float('nan'), 0.1 + 0.2, '12.345', '$12.34', None]:
            with self.subTest(amount=amount):
                self.assert_rejected(auction(LowestPrice=amount))

    def test_missing_or_zero_end_price_never_falls_back_to_starting_bid(self):
        for amount in [None, '', '0.00']:
            with self.subTest(amount=amount):
                self.assert_rejected(auction(LowestPrice=amount, Price='999.99'))
        row = auction(Price='999.99')
        row.pop('LowestPrice')
        self.assert_rejected(row)

    def test_listing_scope_bids_and_end_time_must_be_confirmed(self):
        cases = [{'Status': 0}, {'ByWay': 1}, {'SellSource': 'US'}, {'SellSource': None},
                 {'PriceCount': 0}, {'PriceCount': -1}, {'PriceCount': True}, {'PriceCount': '3'},
                 {'ID': True}, {'ID': ''}, {'ID': '../123'},
                 {'EffectiveDate': 'garbage'}, {'EffectiveDate': '2026-10-11 20:30:00'}]
        for changes in cases:
            with self.subTest(changes=changes):
                self.assert_rejected(auction(**changes))

    def test_psa10_requires_actual_seller_grade_without_other_grades_or_estimates(self):
        title = '简中 宝可梦 151C 妙蛙种子 001/151 非闪 '
        for grade in ['PSA 10', 'PSA评级10分', 'PSA GEM MINT 10']:
            with self.subTest(grade=grade):
                quote, reason = self.quote(auction(Title=title + grade))
                self.assertEqual(reason, '')
                self.assertEqual((quote['grade'], quote['gradingCompany']), ('psa10', 'PSA'))
                self.assertNotIn('condition', quote)
        # Card-name suffix ex before a printed number is not a quantity marker.
        for real_title in ['简中 宝可梦 梦幻ex 151C 191/151 SAR PSA评级10分',
                           '2025 Pokemon TCG 151C 梦幻ex chs 梦幻ex 191/151 SAR 闪卡 简中 评级卡 PSA 10分']:
            with self.subTest(real_title=real_title):
                quote, reason = self.quote(auction(Title=real_title))
                self.assertEqual(reason, '')
                self.assertEqual((quote['grade'], quote['gradingCompany']), ('psa10', 'PSA'))
                self.assertEqual(quote['title'], real_title)
        for grade in ['PSA9 九分', 'CCIC10 对标PSA10', 'PSA10潜力 可送评', 'PSA10 PSA9', 'PSA10.5', 'PSA100', 'BGS 10', '非PSA10']:
            with self.subTest(grade=grade):
                self.assert_rejected(auction(Title=title + grade))

    def test_psa10_attempt_probability_comparison_and_conflicting_company_are_excluded(self):
        title = '简中 宝可梦 151C 妙蛙种子 001/151 非闪 '
        rejected = [
            '博PSA10', '可博PSA 10', '搏psa10', '可搏评级PSA10分',
            '冲PSA10', '可冲psa10 p10率70%', '衝 PSA 10',
            'PSA10概率 100%', 'PSA10几率80%', 'PSA评级10分機率90%',
            'PSA10不保证', '不保证PSA10', '媲美PSA评级10分',
            'CCG评分9.5分 PSA10', 'PSA10 CCG 10分', 'BGN金10 可博psa10',
            '公博9.5分 可搏PSA10', 'PSA10 ARS10', 'PSA10 CGC评级金10分',
            'ＰＳＡ１０概率100%', '博ＰＳＡ１０', 'PSA 9 PSA10',
        ]
        for label in rejected:
            for condition in ['', ' NM 品相A']:
                with self.subTest(label=label, condition=condition):
                    quote, reason = self.quote(auction(Title=title + label + condition))
                    self.assertIsNone(quote)
                    self.assertEqual(reason, 'unsupported_or_estimated_grade')

    def test_real_psa10_labels_keep_card_names_and_set_decimals(self):
        for title in [
            '简中 宝可梦 CSV9.5C 可达鸭 001/151 PSA10',
            '简中 宝可梦 CSV9.5C 博士的研究 148/127 PSA10',
            '简中 宝可梦 151C 妙蛙种子 001/151 PSA 10分 已评级',
            '简中 宝可梦 151C 妙蛙种子 001/151 ＰＳＡ ＧＥＭ ＭＩＮＴ １０',
        ]:
            with self.subTest(title=title):
                quote, reason = self.quote(auction(Title=title))
                self.assertEqual(reason, '')
                self.assertEqual(quote['grade'], 'psa10')
                self.assertEqual(quote['title'], title)

    def test_ungraded_a_requires_explicit_clear_condition_evidence(self):
        title = '简中 宝可梦 151C 妙蛙种子 001/151 非闪 '
        for condition in ['NM', 'Near Mint', '品相A级', '卡品A']:
            with self.subTest(condition=condition):
                quote, reason = self.quote(auction(Title=title + condition))
                self.assertEqual(reason, '')
                self.assertEqual((quote['grade'], quote['condition']), ('raw', 'A'))
        for condition in ['未鉴定 卡品如图', '默认微瑕', 'A品 NM/LP 轻微白点', 'NM 不保证品相 卡品如图',
                          '卡品A038', '品相A038', 'A038', 'A级 不保卡品', 'NM 不保卡品']:
            with self.subTest(condition=condition):
                self.assert_rejected(auction(Title=title + condition))
        quote, reason = self.quote(auction(Title=title + 'NM 卡品如图'))
        self.assertEqual(reason, '')
        self.assertEqual((quote['condition'], quote['conditionLabel']), ('A', 'NM'))
        self.assertTrue(quote['sellerConditionOnly'])

    def test_seller_cn_does_not_replace_explicit_simplified_chinese_pokemon_identity(self):
        for title in ['CHS Pokémon 151C 妙蛙种子 001/151 非闪 NM', BASE_TITLE]:
            with self.subTest(title=title):
                self.assertIsNotNone(self.quote(auction(Title=title))[0])
        for title in ['宝可梦 151C 妙蛙种子 001/151 非闪 NM', '简中 游戏王 青眼白龙 001/151 NM',
                      BASE_TITLE + ' 日版', BASE_TITLE + ' 英文版', BASE_TITLE + ' 繁中',
                      BASE_TITLE.replace('简中', '简中/英文')]:
            with self.subTest(title=title):
                self.assert_rejected(auction(Title=title))

    def test_sealed_single_box_never_accepts_packs_cartons_or_lots(self):
        quote, reason = self.quote(auction(Title='简中 宝可梦 收集啦151 旅 原封肥盒 20张/包'))
        self.assertEqual(reason, '')
        self.assertEqual((quote['grade'], quote['condition'], quote['unit'], quote['quantity']), ('box', 'sealed', 'box', 1))
        for title in ['简中 宝可梦 收集啦151 旅 20张补充包 全新未拆 单包',
                      '简中 宝可梦 收集啦151 旅 原封整箱 12盒 carton',
                      '简中 宝可梦 收集啦151 旅 原封肥盒 2盒合集 两盒捆绑 lot',
                      '简中 宝可梦 收集啦151 旅 拆盒 肥盒', BASE_TITLE + ' 两张打包',
                      BASE_TITLE + ' x2', BASE_TITLE + ' ×2', BASE_TITLE + ' 2x',
                      '简中 宝可梦 收集啦151 旅 原封肥盒 五盒一起']:
            with self.subTest(title=title):
                self.assert_rejected(auction(Title=title))
        for gift in ['徽章礼盒', '皮卡丘公仔 gift box', '硬币 coin box', '主题收藏小铁盒', '卡牌卡砖收纳盒']:
            with self.subTest(gift=gift):
                quote, reason = self.quote(auction(Title='简中 宝可梦 收集啦151 旅 原封肥盒 ' + gift))
                self.assertIsNone(quote)
                self.assertEqual(reason, 'gift_product_not_a_booster_box')

    def test_public_response_requires_explicit_success_valid_total_and_rows(self):
        payload = {'result': 1, 'data': {'TotalCount': 1, 'PagedMarketItemList': [auction()]}}
        self.assertEqual(collector.decode_response(payload), (1, [auction()]))
        self.assertEqual(collector.decode_response({'result': 1, 'data': {'TotalCount': 0, 'PagedMarketItemList': []}}), (0, []))
        bad = [None, {}, {'result': 0, 'data': payload['data']}, {'result': True, 'data': payload['data']}, {'result': 1, 'data': None}]
        for total in [None, True, '1', 1.5, -1]:
            bad.append({'result': 1, 'data': {'TotalCount': total, 'PagedMarketItemList': [auction()]}})
        for rows in [None, {}, ['not a listing'], []]:
            bad.append({'result': 1, 'data': {'TotalCount': 1, 'PagedMarketItemList': rows}})
        bad.append({'result': 1, 'data': {'TotalCount': 0}})
        for value in bad:
            with self.subTest(payload=value):
                with self.assertRaises(ValueError):
                    collector.decode_response(value)

    def test_card_mapping_requires_exact_source_set_number_name_and_foil(self):
        catalog = collector.PriceCatalog(self.root)
        plain, reason = catalog.match(BASE_TITLE, 'raw')
        self.assertEqual(reason, '')
        self.assertEqual((plain['sourceId'], plain['variant']), (PLAIN_ID, 'non-holo'))
        self.assertEqual({r['setCode'] for r in plain['refs']}, {'CN-151-LV', 'CN-151-WANG'})
        master, reason = catalog.match(BASE_TITLE.replace('非闪', '大师球'), 'psa10')
        self.assertEqual(reason, '')
        self.assertEqual((master['sourceId'], master['variant']), (MASTER_ID, 'masterball'))
        for title in [BASE_TITLE.replace('001/151', '002/151'), BASE_TITLE.replace('妙蛙种子', '妙蛙草'),
                      BASE_TITLE.replace('151C', 'CSV1C'), BASE_TITLE.replace('151C', '')]:
            with self.subTest(title=title):
                self.assertIsNone(catalog.match(title, 'raw')[0])

    def test_full_official_product_name_fallback_requires_unique_source_and_respects_volume_boundaries(self):
        ids = ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555']
        for index, volume in enumerate([2, 20]):
            code, source = f'CN-GEM-{volume}', f'cbb{volume}c'
            card = fixture_card(code, ids[index], '001', '妙蛙种子', 'non-holo')
            card['sourceSetCode'] = source
            self.add_source_product(code, source, f'补充包 Gem Pack Vol.{volume}', [card])
        catalog = collector.PriceCatalog(self.root)
        target, reason = catalog.match(BASE_TITLE.replace('151C', '收集啦151 旅'), 'raw')
        self.assertEqual(reason, '')
        self.assertEqual(target['sourceId'], PLAIN_ID)
        for volume, source_id in zip([2, 20], ids):
            target, reason = catalog.match(BASE_TITLE.replace('151C', f'Gem Pack Vol.{volume}'), 'raw')
            self.assertEqual(reason, '')
            self.assertEqual(target['sourceId'], source_id)
        target, reason = catalog.match(BASE_TITLE.replace('151C', '151C Gem Pack Vol.2'), 'raw')
        self.assertIsNone(target)
        self.assertEqual(reason, 'card_set_code_name_conflict')
        ambiguous = []
        for index, source in enumerate(['csv1c', 'csv2c']):
            card = fixture_card('CN-AMBIG', f'{index + 6}' * 8 + '-' + f'{index + 6}' * 4 + '-4' + f'{index + 6}' * 3 + '-8' + f'{index + 6}' * 3 + '-' + f'{index + 6}' * 12, '001', '妙蛙种子', 'non-holo')
            card['sourceSetCode'] = source
            ambiguous.append(card)
        self.add_source_product('CN-AMBIG', 'csv1c', '补充包 多源测试', ambiguous)
        self.assertEqual(collector.PriceCatalog(self.root).match(BASE_TITLE.replace('151C', '多源测试'), 'raw'), (None, 'card_set_not_unique'))

    def test_source_visible_denominator_is_checked_but_gem_pack_is_exempt(self):
        self.write_json('.cache/chinese-card-source-151c.json', {'set': {'set_count_visible': 151}, 'cards': []})
        catalog = collector.PriceCatalog(self.root)
        self.assertEqual(catalog.match(BASE_TITLE, 'raw')[0]['sourceId'], PLAIN_ID)
        target, reason = catalog.match(BASE_TITLE.replace('001/151', '001/150'), 'raw')
        self.assertIsNone(target)
        self.assertEqual(reason, 'card_printed_denominator_mismatch')
        card = fixture_card('CN-GEM-2', '44444444-4444-4444-8444-444444444444', '001', '妙蛙种子', 'non-holo')
        card['sourceSetCode'] = 'cbb2c'
        self.add_source_product('CN-GEM-2', 'cbb2c', '补充包 Gem Pack Vol.2', [card])
        self.write_json('.cache/chinese-card-source-cbb2c.json', {'set': {'set_count_visible': 64}, 'cards': []})
        catalog = collector.PriceCatalog(self.root)
        self.assertNotIn('cbb2c', catalog.visible_numbers)
        target, reason = catalog.match('CHS Pokemon CBB2C 妙蛙种子 001/001 非闪 NM', 'raw')
        self.assertEqual(reason, '')
        self.assertEqual(target['sourceId'], card['sourceId'])

    def test_source_uuid_english_aliases_match_whole_names_without_mew_or_vmax_guessing(self):
        rows, cached = [], []
        for index, (english, chinese) in enumerate([('Mew', '梦幻'), ('Mewtwo', '超梦'), ('Mew V', '梦幻V'), ('Mew VMAX', '梦幻VMAX')]):
            digit = str(index + 4)
            source_id = digit * 8 + '-' + digit * 4 + '-4' + digit * 3 + '-8' + digit * 3 + '-' + digit * 12
            row = fixture_card('CN-EN-TEST', source_id, '191', chinese, 'holo')
            rows.append(row)
            cached.append({'id': source_id, 'card_number': '191', 'english_card_name': english})
        self.add_source_product('CN-EN-TEST', '151c', '补充包 英文名测试', rows)
        self.write_json('.cache/chinese-card-source-151c.json', {'set': {'set_count_visible': 151}, 'cards': cached + [
            {'id': PLAIN_ID, 'card_number': '999', 'english_card_name': 'Wrong Alias'}]})
        catalog = collector.PriceCatalog(self.root)
        for row, item in zip(rows, cached):
            title = f"CHS Pokemon 151C {item['english_card_name']} 191/151 SAR PSA10"
            target, reason = catalog.match(title, 'psa10')
            self.assertEqual(reason, '')
            self.assertEqual(target['sourceId'], row['sourceId'])
        for name in ['Mewtwos', 'SomeMew', 'MewVMAXPlus']:
            self.assertIsNone(catalog.match(f'CHS Pokemon 151C {name} 191/151 SAR PSA10', 'psa10')[0], name)
        self.assertIsNone(catalog.match('CHS Pokemon 151C Wrong Alias 001/151 非闪 NM', 'raw')[0])

    def test_unclear_or_conflicting_foil_is_held_instead_of_guessing_plain_card(self):
        catalog = collector.PriceCatalog(self.root)
        for title in [BASE_TITLE.replace('非闪', ''), BASE_TITLE.replace('非闪', '大师球 精灵球'),
                      BASE_TITLE.replace('非闪', '大师球 非闪')]:
            with self.subTest(title=title):
                target, reason = catalog.match(title, 'raw')
                self.assertIsNone(target)
                self.assertTrue(reason)

    def test_explicit_reverse_synonyms_match_only_the_reverse_card(self):
        row = fixture_card('CN-REVERSE', '44444444-4444-4444-8444-444444444444', '001', '妙蛙种子', 'reverse')
        self.add_source_product('CN-REVERSE', '151c', '补充包 反向闪测试', [row])
        catalog = collector.PriceCatalog(self.root)
        for marker in ['反闪', '反閃', '反向闪', '反向閃', 'reverse']:
            with self.subTest(marker=marker):
                target, reason = catalog.match(BASE_TITLE.replace('非闪', marker), 'raw')
                self.assertEqual(reason, '')
                self.assertEqual((target['sourceId'], target['variant']), (row['sourceId'], 'reverse'))

    def test_box_mapping_requires_unique_product_and_pack_format(self):
        catalog = collector.PriceCatalog(self.root)
        target, reason = catalog.match('简中 宝可梦 收集啦151 旅 原封肥盒 20张/包', 'box')
        self.assertEqual(reason, '')
        self.assertEqual(target['targetId'], 'BOX:CN-151-LV:20')
        self.assertEqual((target['cardsPerPack'], target['packsPerBox'], target['unit']), (20, 6, 'box'))
        self.assertTrue(target['configurationVerified'])
        for title in ['简中 宝可梦 151C 原封整盒', '简中 宝可梦 收集啦151 旅 原封整盒',
                      '简中 宝可梦 收集啦151 旅 原封整盒 99张/包']:
            with self.subTest(title=title):
                self.assertIsNone(catalog.match(title, 'box')[0])

    def test_gem_pack_storage_tins_are_not_booster_boxes(self):
        for title in [
            '简中 Pokemon 宝可梦 宝石包 Vol.6 主题收藏小铁盒 全新未拆 卡牌卡砖收纳盒 周边摆件',
            '简中 Pokemon 宝可梦 宝石包 Vol.6 收藏铁盒 原盒未拆封 收纳盒',
            '简中 Pokemon 宝可梦 宝石包 Vol.6 收藏鐵盒 原盒未拆封 卡磚收納盒',
        ]:
            with self.subTest(title=title):
                self.assertEqual(collector.classify_title(title), (None, 'gift_product_not_a_booster_box'))

    def test_explicit_pack_sizes_match_in_both_word_orders_and_hold_conflicts(self):
        catalog = collector.PriceCatalog(self.root)
        for suffix in ['5张/包', '每包5张 每盒15包', '每包 5 張']:
            with self.subTest(suffix=suffix):
                target, reason = catalog.match('简中 宝可梦 收集啦151 旅 原封整盒 ' + suffix, 'box')
                self.assertEqual(reason, '')
                self.assertEqual(target['targetId'], 'BOX:CN-151-LV:5')
                self.assertFalse(target['configurationVerified'])
        self.assertEqual(catalog.match('简中 宝可梦 收集啦151 旅 原封整盒 5张/包 每包20张', 'box'),
                         (None, 'box_format_not_unique'))
        target, reason = catalog.match('简中 宝可梦 收集啦 151 C 望 未拆封肥盒 20张/包', 'box')
        self.assertEqual(reason, '')
        self.assertEqual(target['targetId'], 'BOX:CN-151-WANG:20')
        self.assertEqual(catalog.match('简中 宝可梦 收集啦151C 原封肥盒 20张/包', 'box'),
                         (None, 'box_product_not_unique'))

    def test_box_brand_prefix_punctuation_and_volume_boundaries_are_exact(self):
        for volume, source_id in [(2, '44444444-4444-4444-8444-444444444444'),
                                  (20, '55555555-5555-4555-8555-555555555555')]:
            code, source = f'CN-GEM-{volume}', f'cbb{volume}c'
            card = fixture_card(code, source_id, '001', '妙蛙种子', 'non-holo')
            card['sourceSetCode'] = source
            self.add_source_product(code, source, f'Pokémon 宝石包VOL.{volume}', [card])
        data = json.loads((self.root / 'data/chinese-catalog.json').read_text(encoding='utf-8'))
        for product in data['sets']:
            if product['code'].startswith('CN-GEM-'):
                product['variants'] = [{'name': '4장 팩', 'cardsPerPack': 4, 'msrpUnit': '팩', 'msrpCny': 10}]
        self.write_json('data/chinese-catalog.json', data)
        catalog = collector.PriceCatalog(self.root)
        for volume in [2, 20]:
            target, reason = catalog.match(f'Pokemon 简中 宝可梦 宝石包 Vol.{volume} 原盒原膜未拆封1盒', 'box')
            self.assertEqual(reason, '')
            self.assertEqual(target['targetId'], f'BOX:CN-GEM-{volume}:4')
        self.assertEqual(catalog.match('Pokemon 简中 宝可梦 宝石包 Vol.200 原盒原膜未拆封1盒', 'box'),
                         (None, 'box_product_not_unique'))
        self.assertEqual(catalog.match('Pokemon 简中 宝可梦 151C 宝石包 Vol.2 原盒原膜未拆封1盒', 'box'),
                         (None, 'box_set_code_name_conflict'))

    def save_listing_details(self, entries, **changes):
        from chinese_listing_details import ENDPOINT
        cache = {'schemaVersion': 1, 'source': 'cardhobby', 'endpoint': ENDPOINT, 'items': {}}
        for item_id, fields in entries.items():
            cache['items'][str(item_id)] = {
                'id': str(item_id), 'sourceUrl': f'https://www.cardhobby.com.cn/market/item/{item_id}',
                'propertiesUrl': f'{ENDPOINT}?id={item_id}', 'observedAt': '2026-10-11T09:00:00+00:00',
                'properties': [{'PropertyControlName': key, 'PropertyValue': value} for key, value in fields.items()]}
        cache.update(changes)
        return self.write_json((self.output / 'listing-details.json').relative_to(self.root), cache)

    def test_explicit_listing_detail_conflicts_are_excluded_without_assuming_missing_certification(self):
        catalog = collector.PriceCatalog(self.root)
        psa = BASE_TITLE.replace('NM', 'PSA10')
        self.save_page('151C', 1, [auction(ID=item_id, Title=psa) for item_id in range(501, 507)])
        self.save_page('151C', 2, [auction(ID=507), auction(ID=508)])
        self.save_listing_details({
            501: {'Graded': 'No'},
            502: {'Graded': 'Yes', 'ProfessionalGrader': 'CCG', 'Grade': '10'},
            503: {'Graded': 'Yes', 'ProfessionalGrader': 'PSA', 'Grade': '9.5'},
            504: {},
            505: {'Graded': 'Yes', 'ProfessionalGrader': 'PSA', 'Grade': '10'},
            506: {'Graded': 'Yes', 'ProfessionalGrader': 'PSA'},
            507: {'Graded': 'Yes', 'CardCondition': 'NM'},
            508: {'Graded': 'No', 'CardCondition': 'Good'},
        })
        data, report = collector.compile_results(self.output, catalog, write=False)
        self.assertEqual({row['listingId'] for row in data['records']}, {'504', '505', '506'})
        self.assertEqual(report['listingDetailsChecked'], 8)
        self.assertEqual(report['detailContradictions'], {
            'detail_says_not_graded': 1, 'detail_grading_company_not_PSA': 1,
            'detail_grade_not_10': 1, 'detail_says_graded': 1,
            'detail_condition_not_explicit_A_or_NM': 1})
        by_id = {row['listingId']: row for row in data['records']}
        self.assertFalse(by_id['504']['detailGradeEvidence']['psaCompanyAndGradeExplicitlySupported'])
        self.assertTrue(by_id['505']['detailGradeEvidence']['psaCompanyAndGradeExplicitlySupported'])
        self.assertFalse(by_id['506']['detailGradeEvidence']['psaCompanyAndGradeExplicitlySupported'])
        self.assertTrue(all(not row['detailGradeEvidence']['certificateVerificationPerformed'] for row in data['records']))
        self.assertFalse(report['certificateVerificationPerformed'])

    def test_public_attribute_required_policy_holds_uncached_new_quotes_and_retains_known_good(self):
        catalog = collector.PriceCatalog(self.root)
        title = BASE_TITLE.replace('NM', 'PSA10')
        self.save_page('151C', 1, [auction(ID=501, Title=title), auction(ID=502, Title=title)])
        self.save_listing_details({501: {'Graded': 'Yes', 'ProfessionalGrader': 'PSA', 'Grade': '10'}},
                                  requirePublicAttributes=True)
        data, report = collector.compile_results(self.output, catalog, write=False)
        self.assertEqual({row['listingId'] for row in data['records']}, {'501'})
        self.assertTrue(report['publicAttributesRequired'])
        self.assertEqual(report['listingDetailsPending'], 1)
        candidates, candidate_report = collector.compile_results(self.output, catalog, write=False, require_details=False)
        self.assertEqual({row['listingId'] for row in candidates['records']}, {'501', '502'})
        self.assertFalse(candidate_report['publicAttributesRequired'])
        self.assertEqual(candidate_report['listingDetailsPending'], 0)
        # A successful public response without grading fields is still seller title evidence.
        self.save_listing_details({501: {'Graded': 'Yes', 'ProfessionalGrader': 'PSA', 'Grade': '10'}, 502: {}},
                                  requirePublicAttributes=True)
        ready, report = collector.compile_results(self.output, catalog, write=False)
        self.assertEqual({row['listingId'] for row in ready['records']}, {'501', '502'})
        quote = next(row for row in ready['records'] if row['listingId'] == '502')
        self.assertFalse(quote['detailGradeEvidence']['psaCompanyAndGradeExplicitlySupported'])
        self.assertFalse(quote['detailGradeEvidence']['certificateVerificationPerformed'])

    def test_only_exact_catalog_targets_count_as_pending_public_attributes(self):
        catalog = collector.PriceCatalog(self.root)
        title = BASE_TITLE.replace('NM', 'PSA10')
        self.save_page('151C', 1, [
            auction(ID=501, Title=title), auction(ID=502, Title=title),
            auction(ID=503, Title=title.replace('妙蛙种子', '未收录名字')),
            auction(ID=504, Title=title),
            auction(ID=505, Title=title.replace('001/151', '002/151')),
            auction(ID=506, Title=title),
        ])
        good = {'Graded': 'Yes', 'ProfessionalGrader': 'PSA', 'Grade': '10'}
        self.save_listing_details({501: good, 504: {**good, 'Version': 'en'},
                                   505: {'Graded': 'No'}, 506: {'Graded': 'No'}},
                                  requirePublicAttributes=True)
        data, report = collector.compile_results(self.output, catalog, write=False)
        self.assertEqual({row['listingId'] for row in data['records']}, {'501'})
        self.assertEqual(report['listingDetailsPending'], 1)
        self.assertEqual(report['listingDetailsChecked'], 3)
        self.assertEqual(report['rejectedByReason'], {
            'detail_public_attributes_pending': 1, 'card_number_name_or_foil_not_unique': 2,
            'detail_language_not_simplified_chinese': 1, 'detail_says_not_graded': 1})
        self.assertEqual(report['detailContradictions'], {
            'detail_language_not_simplified_chinese': 1, 'detail_says_not_graded': 1})

    def test_invalid_public_attribute_observation_times_preserve_previous_output(self):
        catalog = collector.PriceCatalog(self.root)
        self.save_page('151C', 1, [auction()])
        collector.compile_results(self.output, catalog)
        original = (self.output / 'prices.json').read_bytes()
        for observed in ['garbage', '2026-10-11T09:00:00', '2100-01-01T00:00:00+00:00']:
            with self.subTest(observed=observed):
                path = self.save_listing_details({12345: {}})
                cache = json.loads(path.read_text(encoding='utf-8'))
                cache['items']['12345']['observedAt'] = observed
                path.write_text(json.dumps(cache), encoding='utf-8')
                with self.assertRaises(ValueError):
                    collector.compile_results(self.output, catalog)
                self.assertEqual((self.output / 'prices.json').read_bytes(), original)

    def test_invalid_or_mismatched_listing_details_preserve_previous_output(self):
        catalog = collector.PriceCatalog(self.root)
        self.save_page('151C', 1, [auction()])
        collector.compile_results(self.output, catalog)
        original = (self.output / 'prices.json').read_bytes()
        for changes in [{'source': 'another-market'}, {'schemaVersion': 2}, {'endpoint': 'https://invalid.example/'}, {'items': []}]:
            with self.subTest(changes=changes):
                self.save_listing_details({12345: {}}, **changes)
                with self.assertRaises(ValueError):
                    collector.compile_results(self.output, catalog)
                self.assertEqual((self.output / 'prices.json').read_bytes(), original)
        path = self.save_listing_details({12345: {}})
        cache = json.loads(path.read_text(encoding='utf-8'))
        cache['items']['12345']['id'] = '99999'
        path.write_text(json.dumps(cache), encoding='utf-8')
        with self.assertRaises(ValueError):
            collector.compile_results(self.output, catalog)
        self.assertEqual((self.output / 'prices.json').read_bytes(), original)

    def test_cache_compile_deduplicates_and_keeps_unknown_prices_only_in_raw_cache(self):
        catalog = collector.PriceCatalog(self.root)
        first = auction(ID=1001, LowestPrice='12.34')
        second = auction(ID=1002, LowestPrice='12.35', NewPostageMoney=None)
        psa = auction(ID=1003, Title=BASE_TITLE.replace('NM', 'PSA 10'), LowestPrice='99.99', NewPostageMoney='0.00')
        box = auction(ID=2001, Title='简中 宝可梦 收集啦151 旅 原封肥盒 20张/包', LowestPrice='300.00')
        unknown = auction(ID=9999, Title='简中 宝可梦 UNLISTED 其他卡 999/999 NM')
        raw_file = self.save_page('151C', 1, [first, second, psa, box, unknown])
        self.save_page('收集啦151 旅', 1, [copy.deepcopy(first)])
        data, report = collector.compile_results(self.output, catalog)
        self.assertEqual((report['listingsDownloaded'], report['acceptedAuctions']), (5, 4))
        self.assertEqual((report['AAuctions'], report['PSA10Auctions'], report['boxAuctions']), (2, 1, 1))
        self.assertEqual({r['listingId'] for r in data['records']}, {'1001', '1002', '1003', '2001'})
        self.assertEqual(len(data['histories']), 3)
        by_grade = {history['grade']: history for history in data['histories']}
        point = by_grade['raw']['history'][0]
        self.assertEqual(by_grade['psa10']['history'][0]['priceMinor'], 9999)
        self.assertEqual(by_grade['box']['history'][0]['priceMinor'], 30000)
        self.assertEqual(by_grade['box']['targetId'], 'BOX:CN-151-LV:20')
        self.assertEqual((point['priceMinor'], point['auctionCount'], point['listingIds']), (1235, 2, ['1001', '1002']))
        self.assertEqual((data['source'], data['currency'], data['market']), ('cardhobby', 'CNY', 'CN'))
        self.assertFalse(data['appliedToApp'])
        self.assertFalse(report['appPricesChanged'])
        self.assertEqual(len(json.loads(raw_file.read_text(encoding='utf-8'))['items']), 5)
        with (self.output / 'excluded.csv').open(encoding='utf-8-sig', newline='') as stream:
            excluded = list(csv.DictReader(stream))
        self.assertEqual([r['listingId'] for r in excluded], ['9999'])
        with (self.output / 'prices.csv').open(encoding='utf-8-sig', newline='') as stream:
            rows = list(csv.DictReader(stream))
        self.assertEqual({r['priceMinor'] for r in rows}, {'1234', '1235', '9999', '30000'})
        self.assertEqual({r['grade'] for r in rows}, {'raw', 'psa10', 'box'})
        by_id = {row['listingId']: row for row in rows}
        self.assertEqual({key: row['priceCNY'] for key, row in by_id.items()},
                         {'1001': '12.34', '1002': '12.35', '1003': '99.99', '2001': '300.00'})
        self.assertEqual({key: row['shippingCNY'] for key, row in by_id.items()},
                         {'1001': '8.00', '1002': '', '1003': '0.00', '2001': '8.00'})
        self.assertEqual({key: row['title'] for key, row in by_id.items()},
                         {str(row['ID']): row['Title'] for row in (first, second, psa, box)})
        self.assertFalse((self.root / 'data/chinese-prices-cardhobby.json').exists())

    def test_foreign_or_invalid_cached_pages_preserve_previous_local_output(self):
        catalog = collector.PriceCatalog(self.root)
        self.save_page('151C', 1, [auction()])
        collector.compile_results(self.output, catalog)
        saved = (self.output / 'prices.json').read_bytes()
        for changes in [{'source': 'jihuanshe'}, {'currency': 'USD'}, {'market': 'US'}, {'items': None}]:
            with self.subTest(changes=changes):
                bad_file = self.save_page('foreign', 1, [], **changes)
                with self.assertRaises(ValueError):
                    collector.compile_results(self.output, catalog)
                self.assertEqual((self.output / 'prices.json').read_bytes(), saved)
                bad_file.unlink()

    def test_interrupted_collection_resumes_without_losing_or_double_counting_front_page(self):
        catalog = collector.PriceCatalog(self.root)
        calls = []
        master = BASE_TITLE.replace('非闪', '大师球')
        holo = '简中 宝可梦 151C 皮卡丘 170/151 NM'
        def interrupted(keyword, page, size):
            calls.append(page)
            if page == 2:
                raise KeyboardInterrupt()
            return 6, [auction(ID=101, LowestPrice='1.00'), auction(ID=102, Title=master, LowestPrice='2.00')]
        with redirect_stdout(io.StringIO()), self.assertRaises(KeyboardInterrupt):
            collector.run_collection(catalog, self.output, ['151C'], max_pages=20, size=2,
                                     delay=0, fetcher=interrupted, sleeper=lambda _: None)
        self.assertEqual(calls, [1, 2])
        state = json.loads((self.output / 'checkpoint.json').read_text(encoding='utf-8'))['queries']['151C']
        self.assertEqual((state['nextPage'], state['complete']), (2, False))
        self.assertFalse(collector.page_file(self.output, '151C', 2).exists())
        first = json.loads((self.output / 'prices.json').read_text(encoding='utf-8'))
        self.assertEqual({r['listingId'] for r in first['records']}, {'101', '102'})
        retained_observed_at = next(r['observedAt'] for r in first['records'] if r['listingId'] == '102')
        pages = {1: [auction(ID=101, LowestPrice='1.00'), auction(ID=103, LowestPrice='3.00')],
                 2: [auction(ID=104, Title=master, LowestPrice='4.00'), auction(ID=105, Title=holo, LowestPrice='5.00')],
                 3: [auction(ID=106, Title=holo, LowestPrice='6.00'), auction(ID=107, LowestPrice='7.00')]}
        calls.clear()
        def resumed(keyword, page, size):
            calls.append(page)
            return 6, pages[page]
        with redirect_stdout(io.StringIO()):
            report = collector.run_collection(catalog, self.output, ['151C'], max_pages=20, size=2,
                                              delay=0, fetcher=resumed, sleeper=lambda _: None)
        self.assertEqual(calls, [1, 2, 3])
        self.assertEqual((report['acceptedAuctions'], report['queriesCompleted'], report['queriesPending']), (7, 1, 0))
        calls.clear()
        with redirect_stdout(io.StringIO()):
            replay = collector.run_collection(catalog, self.output, ['151C'], max_pages=20, size=2,
                                              delay=0, fetcher=resumed, sleeper=lambda _: None)
        self.assertEqual(calls, [1])
        self.assertEqual(replay['acceptedAuctions'], 7)
        data = json.loads((self.output / 'prices.json').read_text(encoding='utf-8'))
        self.assertEqual(len({r['listingId'] for r in data['records']}), len(data['records']))
        self.assertEqual(sum(p['auctionCount'] for h in data['histories'] for p in h['history']), 7)
        self.assertFalse(replay['appPricesChanged'])
        self.assertEqual(next(r['observedAt'] for r in data['records'] if r['listingId'] == '102'), retained_observed_at)
        # New auctions can move previously completed front-page items onto page 2.
        pages[4] = [auction(ID=108, LowestPrice='8.00'), auction(ID=109, LowestPrice='9.00')]
        calls.clear()
        def expanded(keyword, page, size):
            calls.append(page)
            return 8, pages[page]
        with redirect_stdout(io.StringIO()):
            grown = collector.run_collection(catalog, self.output, ['151C'], max_pages=20, size=2,
                                             delay=0, fetcher=expanded, sleeper=lambda _: None)
        self.assertEqual(calls, [1, 2, 3, 4])
        self.assertEqual((grown['acceptedAuctions'], grown['queriesCompleted'], grown['queriesPending']), (9, 1, 0))


    def test_incomplete_checkpoint_restarts_page_two_when_result_count_changes(self):
        catalog = collector.PriceCatalog(self.root)
        for new_total in (12, 6):
            with self.subTest(new_total=new_total):
                output = self.output / str(new_total)
                calls = []
                first_pages = {1: [auction(ID=101), auction(ID=102)],
                               2: [auction(ID=103), auction(ID=104)]}
                def interrupted(keyword, page, size):
                    calls.append(page)
                    if page == 3:
                        raise KeyboardInterrupt()
                    return 8, first_pages[page]
                with redirect_stdout(io.StringIO()), self.assertRaises(KeyboardInterrupt):
                    collector.run_collection(catalog, output, ['151C'], max_pages=20, size=2,
                                             delay=0, fetcher=interrupted, sleeper=lambda _: None)
                self.assertEqual(calls, [1, 2, 3])
                before = json.loads((output / 'checkpoint.json').read_text(encoding='utf-8'))['queries']['151C']
                self.assertEqual((before['nextPage'], before['totalCount'], before['complete']), (3, 8, False))
                moved_pages = {1: [auction(ID=201), auction(ID=202)],
                               2: [auction(ID=203), auction(ID=204)],
                               3: [auction(ID=101), auction(ID=102)]}
                if new_total == 12:
                    moved_pages.update({4: [auction(ID=103), auction(ID=104)],
                                        5: [auction(ID=105), auction(ID=106)],
                                        6: [auction(ID=107), auction(ID=108)]})
                calls.clear()
                def resumed(keyword, page, size):
                    calls.append(page)
                    return new_total, moved_pages[page]
                with redirect_stdout(io.StringIO()):
                    report = collector.run_collection(catalog, output, ['151C'], max_pages=20, size=2,
                                                      delay=0, fetcher=resumed, sleeper=lambda _: None)
                self.assertEqual(calls, list(range(1, new_total // 2 + 1)))
                after = json.loads((output / 'checkpoint.json').read_text(encoding='utf-8'))['queries']['151C']
                self.assertEqual((after['totalCount'], after['complete']), (new_total, True))
                data = json.loads((output / 'prices.json').read_text(encoding='utf-8'))
                expected_ids = {'101', '102', '103', '104', '201', '202', '203', '204'}
                if new_total == 12:
                    expected_ids.update({'105', '106', '107', '108'})
                actual_ids = {row['listingId'] for row in data['records']}
                self.assertEqual(actual_ids, expected_ids)
                self.assertEqual(len(data['records']), len(expected_ids))
                self.assertEqual(report['acceptedAuctions'], len(expected_ids))
                self.assertEqual((report['queriesCompleted'], report['queriesPending']), (1, 0))
                self.assertFalse(report['appPricesChanged'])



    def test_transient_errors_retry_the_same_page_with_bounded_backoff(self):
        windows_timeout = OSError('Windows connect timeout')
        windows_timeout.winerror = 10060
        failures = [TimeoutError('timed out'), ConnectionResetError('reset'),
                    urllib.error.URLError(TimeoutError('timed out')), windows_timeout,
                    http.client.IncompleteRead(b'partial', 20)]
        failures += [urllib.error.HTTPError('https://offline.invalid/', code, 'temporary error', {}, None)
                     for code in (408, 500, 502, 503, 504)]
        for error in failures:
            with self.subTest(error=type(error).__name__, code=getattr(error, 'code', None)):
                result = (2, [auction()])
                fetcher = mock.Mock(side_effect=[error, error, error, error, result])
                sleeper = mock.Mock()
                with redirect_stdout(io.StringIO()):
                    actual = collector.fetch_with_retry('151C', 62, size=2, attempts=5,
                                                        fetcher=fetcher, sleeper=sleeper)
                self.assertEqual(actual, result)
                self.assertEqual(fetcher.call_args_list, [mock.call('151C', 62, 2)] * 5)
                self.assertEqual(sleeper.call_args_list, [mock.call(n) for n in (3, 6, 12, 24)])

    def test_retry_exhaustion_raises_without_a_sixth_request(self):
        error = TimeoutError('timed out')
        fetcher = mock.Mock(side_effect=error)
        sleeper = mock.Mock()
        with redirect_stdout(io.StringIO()), self.assertRaises(TimeoutError) as caught:
            collector.fetch_with_retry('CSV9.5C', 62, size=2, attempts=5,
                                       fetcher=fetcher, sleeper=sleeper)
        self.assertIs(caught.exception, error)
        self.assertEqual(fetcher.call_args_list, [mock.call('CSV9.5C', 62, 2)] * 5)
        self.assertEqual(sleeper.call_args_list, [mock.call(n) for n in (3, 6, 12, 24)])

    def test_auth_limits_validation_certificates_and_ctrl_c_stop_immediately(self):
        errors = [ValueError('invalid public response'), KeyboardInterrupt(),
                  ssl.SSLCertVerificationError('certificate verification failed'),
                  urllib.error.URLError(ssl.SSLCertVerificationError('certificate verification failed'))]
        errors += [urllib.error.HTTPError('https://offline.invalid/', code, 'non-retryable response', {}, None)
                   for code in (401, 403, 425, 429)]
        for error in errors:
            with self.subTest(error=type(error).__name__, code=getattr(error, 'code', None)):
                fetcher = mock.Mock(side_effect=error)
                sleeper = mock.Mock()
                with redirect_stdout(io.StringIO()), self.assertRaises(type(error)) as caught:
                    collector.fetch_with_retry('151C', 2, size=2, attempts=5,
                                               fetcher=fetcher, sleeper=sleeper)
                self.assertIs(caught.exception, error)
                fetcher.assert_called_once_with('151C', 2, 2)
                sleeper.assert_not_called()

    def test_failed_page_after_all_retries_does_not_advance_or_erase_saved_prices(self):
        catalog = collector.PriceCatalog(self.root)
        error = TimeoutError('timed out')
        fetcher = mock.Mock(side_effect=[(6, [auction(ID=101), auction(ID=102)])] + [error] * 5)
        sleeper = mock.Mock()
        with redirect_stdout(io.StringIO()), self.assertRaises(TimeoutError):
            collector.run_collection(catalog, self.output, ['151C'], max_pages=20, size=2,
                                     delay=0, attempts=5, fetcher=fetcher, sleeper=sleeper)
        self.assertEqual(fetcher.call_args_list, [mock.call('151C', 1, 2)] + [mock.call('151C', 2, 2)] * 5)
        self.assertEqual(sleeper.call_args_list, [mock.call(n) for n in (0, 0, 3, 6, 12, 24)])
        state = json.loads((self.output / 'checkpoint.json').read_text(encoding='utf-8'))['queries']['151C']
        self.assertEqual((state['nextPage'], state['totalCount'], state['complete']), (2, 6, False))
        self.assertTrue(collector.page_file(self.output, '151C', 1).exists())
        self.assertFalse(collector.page_file(self.output, '151C', 2).exists())
        data = json.loads((self.output / 'prices.json').read_text(encoding='utf-8'))
        report = json.loads((self.output / 'report.json').read_text(encoding='utf-8'))
        self.assertEqual({r['listingId'] for r in data['records']}, {'101', '102'})
        self.assertEqual((report['acceptedAuctions'], report['queriesCompleted'], report['queriesPending']), (2, 0, 1))
        self.assertFalse(data['appliedToApp'])

    def test_pending_selection_skips_complete_keywords_but_all_complete_refreshes_front(self):
        catalog = collector.PriceCatalog(self.root)
        done_rows = [auction(ID=900), auction(ID=901)]
        done_file = self.save_page('DONE', 1, done_rows)
        done_bytes = done_file.read_bytes()
        self.write_json((self.output / 'checkpoint.json').relative_to(self.root), {
            'schemaVersion': 1, 'source': 'cardhobby', 'currency': 'CNY', 'pageSize': 2,
            'queries': {'DONE': {'nextPage': 2, 'complete': True, 'totalCount': 2},
                        'PENDING': {'nextPage': 2, 'complete': False, 'totalCount': 4}}})
        pending_pages = {1: [auction(ID=201), auction(ID=202)],
                         2: [auction(ID=203), auction(ID=204)]}
        calls = []
        def pending_fetch(keyword, page, size):
            calls.append((keyword, page, size))
            self.assertEqual(keyword, 'PENDING')
            return 4, pending_pages[page]
        with redirect_stdout(io.StringIO()):
            report = collector.run_collection(catalog, self.output, ['DONE', 'PENDING'],
                                              max_pages=20, size=2, delay=0, attempts=5,
                                              fetcher=pending_fetch, sleeper=lambda _: None)
        self.assertEqual(calls, [('PENDING', 1, 2), ('PENDING', 2, 2)])
        self.assertEqual(done_file.read_bytes(), done_bytes)
        self.assertEqual((report['queriesCompleted'], report['queriesPending'], report['acceptedAuctions']), (2, 0, 6))
        calls.clear()
        def refresh_fetch(keyword, page, size):
            calls.append((keyword, page, size))
            self.assertEqual(page, 1)
            return (2, done_rows) if keyword == 'DONE' else (4, pending_pages[1])
        with redirect_stdout(io.StringIO()):
            refreshed = collector.run_collection(catalog, self.output, ['DONE', 'PENDING'],
                                                 max_pages=20, size=2, delay=0, attempts=5,
                                                 fetcher=refresh_fetch, sleeper=lambda _: None)
        self.assertEqual(calls, [('DONE', 1, 2), ('PENDING', 1, 2)])
        self.assertEqual((refreshed['queriesCompleted'], refreshed['queriesPending'], refreshed['acceptedAuctions']), (2, 0, 6))
        self.assertFalse(refreshed['appPricesChanged'])



    def test_read_only_compile_returns_prices_without_creating_or_replacing_outputs(self):
        catalog = collector.PriceCatalog(self.root)
        self.save_page('151C', 1, [auction()])
        before_files = {str(p.relative_to(self.output)): p.read_bytes()
                        for p in self.output.rglob('*') if p.is_file()}
        with mock.patch.object(collector.base, 'save_json', side_effect=AssertionError('Read-only compilation wrote a file')) as save:
            data, report = collector.compile_results(self.output, catalog, write=False)
            save.assert_not_called()
        self.assertEqual((data['records'][0]['priceMinor'], report['acceptedAuctions']), (1234, 1))
        after_files = {str(p.relative_to(self.output)): p.read_bytes()
                       for p in self.output.rglob('*') if p.is_file()}
        self.assertEqual(after_files, before_files)
        collector.compile_results(self.output, catalog)
        outputs = {name: (self.output / name).read_bytes()
                   for name in ('prices.json', 'prices.csv', 'report.json', 'excluded.csv')}
        self.save_page('151C', 1, [auction(LowestPrice='17.89')])
        with mock.patch.object(collector.base, 'save_json', side_effect=AssertionError('Read-only compilation replaced output')) as save:
            fresh, report = collector.compile_results(self.output, catalog, write=False)
            save.assert_not_called()
        self.assertEqual((fresh['records'][0]['priceMinor'], report['acceptedAuctions']), (1789, 1))
        self.assertEqual({name: (self.output / name).read_bytes() for name in outputs}, outputs)
        self.assertFalse(fresh['appliedToApp'])



    def test_partial_and_interrupted_collection_publish_only_after_revalidation(self):
        catalog = collector.PriceCatalog(self.root)
        for failure in [None, KeyboardInterrupt(), TimeoutError('network stopped')]:
            with self.subTest(failure=type(failure).__name__):
                output = self.output / ('partial' if failure is None else type(failure).__name__)
                callback = mock.Mock()
                def publish():
                    data = json.loads((output / 'prices.json').read_text(encoding='utf-8'))
                    report = json.loads((output / 'report.json').read_text(encoding='utf-8'))
                    self.assertEqual({r['listingId'] for r in data['records']}, {'501', '502'})
                    self.assertEqual((report['queriesCompleted'], report['queriesPending']), (0, 1))
                callback.side_effect = publish
                def fetcher(keyword, page, size):
                    if page == 2:
                        raise failure
                    return 8, [auction(ID=501), auction(ID=502)]
                kwargs = dict(max_pages=1 if failure is None else 2, size=2, delay=0,
                              attempts=1, fetcher=fetcher, sleeper=lambda _: None, on_compiled=callback)
                with redirect_stdout(io.StringIO()):
                    if failure is None:
                        report = collector.run_collection(catalog, output, ['151C'], **kwargs)
                        self.assertEqual(report['queriesPending'], 1)
                    else:
                        with self.assertRaises(type(failure)):
                            collector.run_collection(catalog, output, ['151C'], **kwargs)
                callback.assert_called_once_with()

    def test_invalid_cached_pages_block_partial_publication(self):
        catalog = collector.PriceCatalog(self.root)
        self.save_page('foreign', 1, [], source='jihuanshe')
        callback = mock.Mock()
        with redirect_stdout(io.StringIO()), self.assertRaises(ValueError):
            collector.run_collection(catalog, self.output, ['151C'], max_pages=1, size=2, delay=0,
                                     fetcher=lambda *_: (8, [auction()]), sleeper=lambda _: None,
                                     on_compiled=callback)
        callback.assert_not_called()

    def test_automatic_application_is_guarded_by_each_root_archive_and_keyword_scope(self):
        expected = self.root / '.cache/chinese-price-backfill/cardhobby'
        expected.mkdir(parents=True)
        page = collector.page_file(expected, '151C', 1)
        page.parent.mkdir()
        page.write_text('{}', encoding='utf-8')
        with mock.patch('build_chinese_market.build', return_value=({}, {'queriesPending': 1})) as build, \
                mock.patch.object(collector, 'validate_saved_prices') as validate:
            with redirect_stdout(io.StringIO()) as output:
                self.assertTrue(collector.apply_cached_prices(self.root, expected))
            self.assertIn('과거 기록은 남아', output.getvalue())
            build.assert_called_once_with(self.root, expected)
            validate.assert_called_once_with(self.root, expected, allow_network=True)
            build.reset_mock()
            validate.reset_mock()
            self.assertFalse(collector.apply_cached_prices(self.root, self.output))
            self.assertFalse(collector.apply_cached_prices(self.root, expected, ['151C']))
            self.assertFalse(collector.apply_cached_prices(self.root / 'another-root', expected))
            build.assert_not_called()
            validate.assert_not_called()
        for file in page.parent.glob('*.json'):
            file.unlink()
        with mock.patch('build_chinese_market.build') as build:
            self.assertFalse(collector.apply_cached_prices(self.root, expected))
            build.assert_not_called()

    def test_validation_fetches_all_price_kinds_and_holds_failed_new_rows(self):
        catalog = collector.PriceCatalog(self.root)
        psa = BASE_TITLE.replace('NM', 'PSA10')
        box = '简中 宝可梦 收集啦151 旅 原封肥盒 20张/包'
        self.save_page('151C', 1, [auction(ID=501, Title=psa), auction(ID=502, Title=psa),
                                    auction(ID=503), auction(ID=504, Title=box),
                                    auction(ID=505, Title=psa.replace('PSA10', '博PSA10 NM'))])
        good_fields = {'Graded': 'Yes', 'ProfessionalGrader': 'PSA', 'Grade': '10'}
        self.save_listing_details({501: good_fields}, requirePublicAttributes=True)
        def ensure(source, quotes):
            self.assertEqual(source, self.output)
            self.assertEqual({row['listingId'] for row in quotes}, {'501', '502', '503', '504'})
            self.assertEqual({row['grade'] for row in quotes}, {'psa10', 'raw', 'box'})
            self.save_listing_details({501: good_fields, 502: {'Graded': 'No'}, 504: {}}, requirePublicAttributes=True)
            return {'requestedCount': 3, 'cachedCount': 1, 'fetchedCount': 2, 'failedCount': 1,
                    'failures': [{'listingId': '503', 'error': 'timeout'}]}
        with mock.patch('chinese_listing_details.ensure_listing_details', side_effect=ensure) as detail:
            with redirect_stdout(io.StringIO()) as printed:
                data, report, detail_report = collector.validate_saved_prices(self.root, self.output)
        detail.assert_called_once()
        self.assertEqual({row['listingId'] for row in data['records']}, {'501', '504'})
        self.assertEqual(report['listingDetailsPending'], 1)
        self.assertEqual(report['detailContradictions'], {'detail_says_not_graded': 1})
        self.assertEqual(detail_report['failedCount'], 1)
        self.assertIn('확인 실패 1건', printed.getvalue())
        stored = json.loads((self.output / 'prices.json').read_text(encoding='utf-8'))
        self.assertEqual({row['listingId'] for row in stored['records']}, {'501', '504'})
        self.assertEqual(next(row for row in stored['records'] if row['listingId'] == '501')['priceMinor'], 1234)

    def test_interrupted_detail_validation_keeps_good_records_and_holds_unchecked_new_quotes(self):
        psa = BASE_TITLE.replace('NM', 'PSA10')
        self.save_page('151C', 1, [auction(ID=501, Title=psa), auction(ID=502, Title=psa)])
        def interrupt(source, quotes):
            self.save_listing_details({501: {'Graded': 'Yes', 'ProfessionalGrader': 'PSA', 'Grade': '10'}},
                                      requirePublicAttributes=True)
            raise KeyboardInterrupt()
        with mock.patch('chinese_listing_details.ensure_listing_details', side_effect=interrupt):
            with redirect_stdout(io.StringIO()), self.assertRaises(KeyboardInterrupt):
                collector.validate_saved_prices(self.root, self.output)
        stored = json.loads((self.output / 'prices.json').read_text(encoding='utf-8'))
        report = json.loads((self.output / 'report.json').read_text(encoding='utf-8'))
        self.assertEqual({row['listingId'] for row in stored['records']}, {'501'})
        self.assertTrue(report['publicAttributesRequired'])
        self.assertEqual(report['listingDetailsPending'], 1)

    def test_offline_validation_retains_good_quotes_holds_new_quotes_and_makes_no_requests(self):
        psa = BASE_TITLE.replace('NM', 'PSA10')
        self.save_page('151C', 1, [auction(ID=501, Title=psa), auction(ID=502, Title=psa)])
        self.save_listing_details({501: {'Graded': 'Yes', 'ProfessionalGrader': 'PSA', 'Grade': '10'}})
        with mock.patch('chinese_listing_details.ensure_listing_details', side_effect=AssertionError('Interrupted collection made new requests')) as ensure:
            with redirect_stdout(io.StringIO()):
                data, report, detail_report = collector.validate_saved_prices(self.root, self.output, allow_network=False)
        ensure.assert_not_called()
        self.assertEqual({row['listingId'] for row in data['records']}, {'501'})
        self.assertTrue(report['publicAttributesRequired'])
        self.assertEqual(report['listingDetailsPending'], 1)
        self.assertEqual(detail_report['networkRequests'], 0)
        cache = json.loads((self.output / 'listing-details.json').read_text(encoding='utf-8'))
        self.assertTrue(cache['requirePublicAttributes'])

    def test_main_stopped_collection_callback_disables_new_detail_requests(self):
        expected = self.root / '.cache/chinese-price-backfill/cardhobby'
        for error, expected_code in [(KeyboardInterrupt(), 130), (TimeoutError('stopped'), 1)]:
            with self.subTest(error=type(error).__name__):
                def collect(catalog, output, keywords, *args, **kwargs):
                    try:
                        raise error
                    finally:
                        kwargs['on_compiled']()
                with mock.patch.object(collector, 'run_collection', side_effect=collect):
                    with mock.patch.object(collector, 'apply_cached_prices', return_value=False) as apply:
                        with redirect_stdout(io.StringIO()):
                            self.assertEqual(collector.main(['--root', str(self.root)]), expected_code)
                        apply.assert_called_once_with(self.root, expected, None, allow_network=False)

    def test_saved_only_menu_uses_no_network_and_holds_unverified_prices(self):
        psa = BASE_TITLE.replace('NM', 'PSA10')
        self.save_page('151C', 1, [auction(ID=501, Title=psa), auction(ID=502, Title=psa)])
        self.save_listing_details({501: {'Graded': 'Yes', 'ProfessionalGrader': 'PSA', 'Grade': '10'}})
        with mock.patch('builtins.input', return_value='4'):
            with mock.patch('chinese_listing_details.ensure_listing_details', side_effect=AssertionError('Saved-only menu made requests')) as ensure:
                with mock.patch('build_chinese_market.build') as build:
                    with redirect_stdout(io.StringIO()):
                        code = collector.main(['--root', str(self.root), '--output', str(self.output), '--interactive'])
        self.assertEqual(code, 0)
        ensure.assert_not_called()
        build.assert_called_once_with(self.root, self.output)
        stored = json.loads((self.output / 'prices.json').read_text(encoding='utf-8'))
        self.assertEqual({row['listingId'] for row in stored['records']}, {'501'})

    def test_main_custom_root_uses_its_own_default_archive_and_callback(self):
        expected = self.root / '.cache/chinese-price-backfill/cardhobby'
        report = {'acceptedAuctions': 0, 'PSA10Auctions': 0, 'AAuctions': 0,
                  'boxAuctions': 0, 'queriesPending': 1}
        def collect(catalog, output, keywords, *args, **kwargs):
            self.assertEqual(output, expected)
            kwargs['on_compiled']()
            return report
        with mock.patch.object(collector, 'run_collection', side_effect=collect) as run:
            with mock.patch.object(collector, 'apply_cached_prices', return_value=False) as apply:
                with redirect_stdout(io.StringIO()) as printed:
                    self.assertEqual(collector.main(['--root', str(self.root)]), 0)
                run.assert_called_once()
                apply.assert_called_once_with(self.root, expected, None, allow_network=True)
                self.assertIn('더 오래된 기록이 남아', printed.getvalue())



if __name__ == '__main__':
    unittest.main()
