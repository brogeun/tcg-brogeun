import copy
import gzip
import tempfile
import unittest
from pathlib import Path

from test_build_tcg_card_info import builder, card, source_files


class OfficialContentsTests(unittest.TestCase):
    def fixture(self, root):
        old = card('10', 'digimon', 'Agumon C [BT1-001](Booster Pack "NEW EVOLUTION")', code='DGCG-BT1-001')
        box = {'id': '20', 'kind': 'box', 'name': 'DIGIMON CARD GAME Booster Pack "NEW EVOLUTION" Box',
               'code': 'DGCG-BT-01', 'language': 'ja'}
        source_files(root, {'digimon': [old]}, {'digimon': [box]})
        cards = [{'id': 'BT1-001', 'number': 'BT1-001', 'name': 'アグモン', 'rarity': 'C', 'variant': 'base',
                  'image': 'https://digimoncard.com/images/BT1-001.png', 'url': 'https://digimoncard.com/cards/#BT1-001'},
                 {'id': 'BT1-002', 'number': 'BT1-002', 'name': '価格のないカード', 'rarity': 'C', 'variant': 'base',
                  'image': None, 'url': 'https://digimoncard.com/cards/#BT1-002'}]
        product = {'id': 'official-bt1', 'code': 'BT01', 'name': 'NEW EVOLUTION', 'complete': True,
                   'kind': 'booster', 'url': 'https://digimoncard.com/cards/?category=1',
                   'expectedCardCount': 2, 'cards': cards}
        data = {'game': 'digimon', 'source': 'official manufacturer Japanese card list',
                'sourceUrl': 'https://digimoncard.com/cards/', 'fetchedAt': '2026-10-31T00:00:00Z',
                'complete': True, 'expectedProducts': 1, 'products': [product]}
        path = root / 'data/official-card-contents/digimon.json'
        builder.atomic_write(path, data)
        return path, data

    def official(self, root, manifest):
        game = next(g for g in manifest['games'] if g['id'] == 'digimon')
        entry = next(s for s in game['sets'] if s['officialComplete'])
        rows = builder.read_json(root / entry['file'].lstrip('/'))['cards']
        return game, entry, rows

    def test_price_free_official_cards_appear_and_exact_market_quote_survives(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); self.fixture(root)
            manifest = builder.build(root)
            game, entry, rows = self.official(root, manifest)
            self.assertEqual(len(rows), 2)
            self.assertEqual(rows[0]['snkrdunkId'], '10')
            self.assertEqual(rows[0]['snkrProduct']['minPrice'], 12.34)
            self.assertNotIn('snkrProduct', rows[1])
            self.assertTrue(game['boxes'][0]['officialMembershipComplete'])
            self.assertEqual(game['boxes'][0]['setIds'], [entry['id']])
            self.assertEqual(builder.validate(root)[0], [])

    def test_compressed_source_snapshot_uses_the_same_validated_membership(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); path, _ = self.fixture(root)
            path.with_suffix('.json.gz').write_bytes(gzip.compress(path.read_bytes(), mtime=0)); path.unlink()
            manifest = builder.build(root)
            _, _, rows = self.official(root, manifest)
            self.assertEqual(len(rows), 2)
            self.assertEqual(builder.validate(root)[0], [])

    def test_union_market_separator_alias_retains_each_exact_variant_and_quote(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            market = [card('11', 'union_arena', 'Helm U [UA18BT-NIK-1-002](Booster Pack "NIKKE")', code='UATCG-UA18BT-NIK-1-002'),
                      card('12', 'union_arena', 'Helm U* [UA18BT-NIK-1-002](Booster Pack "NIKKE")', code='UATCG-UA18BT-NIK-1-002')]
            box = {'id': '20', 'name': 'UNION ARENA Booster Pack "NIKKE" Box', 'code': 'UATCG-UA18BT', 'kind': 'box'}
            source_files(root, {'union_arena': market}, {'union_arena': [box]})
            native = [{'id': 'native' + str(i), 'number': 'UA18BT/NIK-1-002', 'name': 'ヘルム', 'rarity': 'U',
                       'variant': variant, 'url': 'https://www.unionarena-tcg.com/jp/cardlist/?card_no=UA18BT/NIK-1-002'}
                      for i, variant in enumerate(('base', '_p1'))]
            source = {'game': 'union_arena', 'source': 'official', 'sourceUrl': 'https://www.unionarena-tcg.com/jp/cardlist/',
                      'fetchedAt': '2026-10-31', 'complete': True, 'expectedProducts': 1,
                      'products': [{'id': '570118', 'code': 'UA18BT', 'name': 'NIKKE', 'complete': True,
                                    'url': 'https://www.unionarena-tcg.com/jp/cardlist/?series=570118',
                                    'expectedCardCount': 2, 'cards': native}]}
            builder.atomic_write(root / 'data/official-card-contents/union_arena.json', source)
            manifest = builder.build(root)
            game = next(g for g in manifest['games'] if g['id'] == 'union_arena')
            entry = next(s for s in game['sets'] if s['officialComplete'])
            rows = builder.read_json(root / entry['file'].lstrip('/'))['cards']
            self.assertEqual({r['snkrdunkId'] for r in rows}, {'11', '12'})
            self.assertTrue(all(r['fullCardNumber'] == 'UA18BT/NIK-1-002' for r in rows))
            self.assertTrue(all(r['snkrProduct']['fullCardNumber'] == 'UA18BT-NIK-1-002' for r in rows))
            self.assertEqual(builder.validate(root)[0], [])

    def test_ambiguous_same_number_artwork_is_kept_without_guessing_a_price(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); path, data = self.fixture(root)
            base = data['products'][0]['cards'][0]
            data['products'][0]['cards'].extend([{**base, 'id': 'BT1-001_P1', 'variant': '_P1'},
                                                {**base, 'id': 'BT1-001_P2', 'variant': '_P2'}])
            data['products'][0]['expectedCardCount'] = 4
            builder.atomic_write(path, data)
            manifest = builder.build(root)
            _, _, rows = self.official(root, manifest)
            self.assertEqual(len({r['id'] for r in rows}), 4)
            self.assertTrue(all('snkrdunkId' not in r for r in rows if r['variant'] != 'base'))
            self.assertEqual(builder.validate(root)[0], [])

    def test_invalid_official_count_preserves_last_good_manifest(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); path, data = self.fixture(root)
            builder.build(root); manifest_path = root / 'data/tcg-card-info.json'; before = manifest_path.read_bytes()
            data['products'][0]['expectedCardCount'] = 999
            builder.atomic_write(path, data)
            with self.assertRaisesRegex(ValueError, 'count/integrity'):
                builder.build(root)
            self.assertEqual(manifest_path.read_bytes(), before)

    def test_box_with_explicit_bonus_components_keeps_both_official_lists(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); path, data = self.fixture(root)
            first = data['products'][0]; first['marketBoxIds'] = ['BOX:20']
            bonus = copy.deepcopy(first); bonus.update({'id': 'bonus', 'code': 'BONUS', 'name': 'Included bonus pack'})
            bonus['cards'] = [{**first['cards'][0], 'id': 'BONUS-001', 'number': 'BONUS-001'}]
            bonus['expectedCardCount'] = 1
            data['products'].append(bonus); data['expectedProducts'] = 2
            builder.atomic_write(path, data)
            manifest = builder.build(root)
            game = next(g for g in manifest['games'] if g['id'] == 'digimon')
            self.assertEqual(len(game['boxes'][0]['setIds']), 2)
            self.assertEqual(game['boxes'][0]['officialCardCount'], 3)
            self.assertEqual(builder.validate(root)[0], [])

    def test_promo_aggregate_does_not_replace_an_individual_box(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); path, data = self.fixture(root)
            data['products'][0]['isAggregate'] = True
            builder.atomic_write(path, data)
            manifest = builder.build(root)
            game = next(g for g in manifest['games'] if g['id'] == 'digimon')
            self.assertTrue(all(not s['officialComplete'] for s in game['sets']))
            self.assertFalse(game['boxes'][0]['officialComplete'])

    def test_same_market_sku_cannot_price_both_base_and_bonus_printings(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); path, data = self.fixture(root)
            first = data['products'][0]; first['marketBoxIds'] = ['BOX:20']
            bonus = copy.deepcopy(first); bonus.update({'id': 'bonus', 'code': 'BONUS', 'name': 'Included bonus pack'})
            bonus['cards'] = [bonus['cards'][0]]; bonus['expectedCardCount'] = 1
            data['products'].append(bonus); data['expectedProducts'] = 2
            builder.atomic_write(path, data)
            manifest = builder.build(root)
            game = next(g for g in manifest['games'] if g['id'] == 'digimon')
            rows = [r for s in game['sets'] if s['officialComplete']
                    for r in builder.read_json(root / s['file'].lstrip('/'))['cards']]
            self.assertTrue(all('snkrdunkId' not in r for r in rows))
            self.assertEqual(game['boxes'][0]['marketCardIds'], ['10'])
            self.assertEqual(builder.validate(root)[0], [])

    def test_receipt_cannot_rebind_another_market_product(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); self.fixture(root); manifest = builder.build(root)
            _, entry, rows = self.official(root, manifest)
            path = root / entry['file'].lstrip('/'); body = builder.read_json(path)
            body['cards'][0]['snkrProduct']['id'] = 'wrong-product'
            builder.atomic_write(path, body)
            self.assertIn('binding identity', builder.validate(root)[0][0])

    def edition(self, data):
        base = data['products'][0]
        row = copy.deepcopy(base['cards'][0])
        return {'id': 'reviewed-second', 'sourceNativeProductId': base['id'], 'edition': 'second',
                'isDerivedProduct': True, 'marketBoxIds': ['BOX:21'], 'reviewedBoxIds': ['BOX:21'],
                'membershipMethod': 'official-native-inventory-minus-explicit-second-edition-serial-AP-exclusions',
                'officialNoticeImageUrl': 'https://digimoncard.com/products/notice.jpg',
                'officialNoticeImageSha256': 'a' * 64, 'excludedCardIds': [base['cards'][1]['id']],
                'exclusions': [{'id': base['cards'][1]['id'], 'number': base['cards'][1]['number'], 'visualMatchVerified': True}],
                'url': 'https://digimoncard.com/products/', 'name': 'NEW EVOLUTION second edition',
                'code': 'BT01', 'complete': True, 'expectedCardCount': 1, 'cards': [row]}

    def test_reviewed_reprint_excludes_only_documented_rows_and_retains_common_quote(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); path, data = self.fixture(root)
            data['derivedProducts'] = [self.edition(data)]
            builder.atomic_write(path, data)
            boxes = builder.read_json(root / 'data/price-digimon-box.json')
            boxes['products'].append({**boxes['products'][0], 'id': '21', 'name': boxes['products'][0]['name'] + ' Second Edition'})
            boxes['totalCount'] = 2
            builder.atomic_write(root / 'data/price-digimon-box.json', boxes)
            manifest = builder.build(root)
            game = next(g for g in manifest['games'] if g['id'] == 'digimon')
            first = next(b for b in game['boxes'] if b['id'] == 'BOX:20')
            second = next(b for b in game['boxes'] if b['id'] == 'BOX:21')
            self.assertEqual(first['officialCardCount'], 2)
            self.assertEqual(second['officialCardCount'], 1)
            sets = {s['id']: s for s in game['sets']}
            for box in (first, second):
                rows = builder.read_json(root / sets[box['setIds'][0]]['file'].lstrip('/'))['cards']
                self.assertEqual(rows[0]['snkrdunkId'], '10')
            self.assertEqual(builder.validate(root)[0], [])

    def test_unproven_reprint_changes_are_rejected_before_writing(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); path, data = self.fixture(root)
            edition = self.edition(data); edition['cards'][0]['image'] = 'https://digimoncard.com/wrong.png'
            data['derivedProducts'] = [edition]; builder.atomic_write(path, data)
            with self.assertRaisesRegex(ValueError, 'alters a retained native printing'):
                builder.build(root)

    def test_verified_unprinted_and_not_applicable_are_distinct_from_unknown(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); path, data = self.fixture(root)
            row = data['products'][0]['cards'][1]
            row.update(number='', numberStatus='unprinted', rarity=None, rarityStatus='not_applicable')
            builder.atomic_write(path, data); manifest = builder.build(root)
            game, entry, rows = self.official(root, manifest)
            self.assertEqual(rows[1]['numberStatus'], 'unprinted')
            self.assertEqual(rows[1]['rarityStatus'], 'not_applicable')
            self.assertEqual(entry['metadataCoverage']['unknownNumbers'], 0)
            self.assertEqual(entry['metadataCoverage']['unknownRarities'], 0)
            self.assertEqual(entry['metadataCoverage']['unprintedNumbers'], 1)
            self.assertEqual(builder.validate(root)[0], [])

    def test_related_promos_are_retained_outside_box_membership(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); path, data = self.fixture(root)
            product = data['products'][0]
            product.update(coreCardIds=['BT1-001'], relatedCardIds=['BT1-002'],
                           includedBonusIds=[], packMembershipComplete=False)
            builder.atomic_write(path, data); manifest = builder.build(root)
            game = next(g for g in manifest['games'] if g['id'] == 'digimon')
            box = game['boxes'][0]; sets = {s['id']: s for s in game['sets']}
            self.assertEqual(box['officialCardCount'], 1)
            self.assertEqual(box['relatedCardCount'], 1)
            self.assertTrue(box['officialCatalogueComplete'])
            self.assertFalse(box['officialMembershipComplete'])
            related = sets[box['relatedSetIds'][0]]
            self.assertEqual(related['inclusionScope'], 'related-promo')
            self.assertEqual(builder.read_json(root / related['file'].lstrip('/'))['cards'][0]['fullCardNumber'], 'BT1-002')
            self.assertEqual(builder.validate(root)[0], [])

    def test_roster_reprint_rejects_a_substituted_finish_despite_matching_counts(self):
        from scripts.official_card_contents import validate_reprint_roster
        base = {'id': '1', 'number': 'HOL/W91-001', 'name': 'Original', 'rarity': 'RR',
                'image': 'https://ws-tcg.com/base.png', 'url': 'https://ws-tcg.com/cardlist/',
                'variation': 0, 'parallelParam': '', 'isParallel': False}
        foil = {**base, 'id': '2', 'number': 'HOL/W91-001S', 'rarity': 'SR',
                'parallelParam': '〇', 'isParallel': True, 'image': 'https://ws-tcg.com/foil.png'}
        native = {'a': {'cards': [base, foil]}}
        image = 'https://ws-tcg.com/roster.jpg'
        product = {'isDerivedProduct': True, 'edition': 'reprint', 'sourceNativeProductIds': ['a'],
                   'marketBoxIds': ['BOX:1'], 'reviewedBoxIds': ['BOX:1'],
                   'officialNoticeUrl': 'https://ws-tcg.com/products/', 'officialNoticeImageUrl': image,
                   'officialNoticeImageSha256': 'a' * 64,
                   'rosterProvenance': {'sourceUrl': image, 'sha256': 'a' * 64},
                   'unchangedPrintingsNotice': {'fieldsExplicitlyCovered': ['card number', 'card text', 'card illustration', 'card finish']},
                   'rosterBaseNumbers': ['HOL/W91-001'], 'advertisedRarityCounts': {'RR': 1, 'SR': 1},
                   'expectedPackTypes': {'normal': 1, 'parallel': 1, 'total': 2},
                   'cards': [{**c, 'sourceNativeProductId': 'a'} for c in (base, foil)]}
        validate_reprint_roster(product, native, 'weiss_schwarz')
        product['cards'][1]['image'] = 'https://ws-tcg.com/other-finish.png'
        with self.assertRaisesRegex(ValueError, 'differs from the explicit publisher roster'):
            validate_reprint_roster(product, native, 'weiss_schwarz')

    def test_documented_included_bonus_stays_with_product_and_bad_partition_fails(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); path, data = self.fixture(root)
            product = data['products'][0]
            product.update(coreCardIds=['BT1-001'], relatedCardIds=['BT1-002'], includedBonusIds=['BT1-002'])
            builder.atomic_write(path, data); manifest = builder.build(root)
            game = next(g for g in manifest['games'] if g['id'] == 'digimon')
            self.assertEqual(game['boxes'][0]['officialCardCount'], 2)
            self.assertEqual(game['boxes'][0]['relatedCardCount'], 0)
            product['relatedCardIds'] = ['BT1-001', 'BT1-002']
            builder.atomic_write(path, data)
            with self.assertRaisesRegex(ValueError, 'inclusion partition'):
                builder.build(root)

    def test_identical_weiss_titles_are_separated_by_full_printed_set_code(self):
        sets = [{'id': 'old', 'sourceGame': 'weiss_schwarz', 'sourcePackTitle': 'Booster Pack "Summer Pockets"', 'code': 'SMP/W60', 'cardCount': 140},
                {'id': 'new', 'sourceGame': 'weiss_schwarz', 'sourcePackTitle': 'Booster Pack "Summer Pockets"', 'code': 'SMP/W137', 'cardCount': 232}]
        boxes = [{'id': '1', 'name': 'Weiss Schwarz Booster Pack "Summer Pockets" Box', 'code': 'WS-TCG-SMP/W60'},
                 {'id': '2', 'name': 'Weiss Schwarz Booster Pack "Summer Pockets" Box', 'code': 'WS-TCG-SMP/W137'}]
        result = builder.navigation_boxes(sets, boxes, 'weiss_schwarz')
        self.assertEqual({b['code']: b['setIds'] for b in result}, {'SMP/W60': ['old'], 'SMP/W137': ['new']})


if __name__ == '__main__':
    unittest.main()
