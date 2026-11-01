import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from source_card_rarities import RarityResolver


def resolver(game, cards):
    return RarityResolver({game: {'products': [{'cards': [dict(c, id=str(i), url='https://official.test/' + str(i))
                                                         for i, c in enumerate(cards)]}]}})


class SourceRarityTests(unittest.TestCase):
    def test_documented_unprinted_rarity_needs_exact_market_and_native_identity(self):
        r = resolver('weiss_schwarz', [{'number': 'LL/W36-S01', 'rarity': '-'}])
        p = {'id': '366204', 'name': 'Cafe Maid [LL/W36-S01]'}
        entry = {'name': p['name'], 'fullCardNumber': 'LL/W36-S01', 'manufacturerCardIds': ['0'],
                 'status': 'verified-unprinted-rarity', 'manufacturerLiteral': '-',
                 'references': [{'provider': 'wiki', 'url': 'https://w.atwiki.jp/ws_wiki/pages/10897.html', 'literal': 'unprinted'}]}
        r.disclosures = {'weiss_schwarz': {'366204': entry}}
        result = r.resolve(p, 'weiss_schwarz', 'LL/W36-S01', '')
        self.assertEqual(result['rarityDisclosureStatus'], 'verified-unprinted-rarity')
        self.assertEqual(result['rarity'], '')
        self.assertNotEqual(result['rarityStatus'], 'not_applicable')
        self.assertNotIn('rarityDisclosureStatus', r.resolve(dict(p, name='another product'), 'weiss_schwarz', 'LL/W36-S01', ''))
        self.assertNotIn('rarityDisclosureStatus', r.resolve(p, 'weiss_schwarz', 'LL/W36-S01', 'PR'))

    def test_exact_suffix_and_code_retains_serial_autograph_grade(self):
        r = resolver('weiss_schwarz', [{'number': 'NIK/S135-053A', 'rarity': 'AGR'}])
        product = {'id': '898468', 'name': 'OLD TALES AGR :Autographed & Serial Numbered [NIK/S135-053A]',
                   'url': 'https://snkrdunk.com/apparels/898468', 'minPrice': 10}
        before = dict(product)
        self.assertEqual(r.resolve(product, 'weiss_schwarz', 'NIK/S135-053A', '')['rarity'], 'AGR')
        self.assertEqual(product, before)

    def test_fullwidth_precious_rarity_stars_and_uapr_separator(self):
        r = resolver('union_arena', [{'number': 'PC02BT/NIK-2-036', 'rarity': 'PcSR★★'},
                                     {'number': 'UAPR/NIK-1-019', 'rarity': 'R'}])
        p = {'id': '1', 'name': 'Name ＰＣＳＲ** [PC02BT-NIK-2-036]'}
        self.assertEqual(r.resolve(p, 'union_arena', 'PC02BT-NIK-2-036', '')['rarity'], 'PcSR★★')
        self.assertEqual(r.resolve({'id': '2', 'name': 'Name [UAPR-NIK-1-019]'}, 'union_arena', 'UAPR-NIK-1-019', '')['rarity'], 'R')

    def test_missing_grade_requires_unanimous_full_code_and_preserves_conflicts(self):
        r = resolver('weiss_schwarz', [{'number': 'X/W01-001', 'rarity': 'R'},
                                      {'number': 'X/W01-001', 'rarity': 'SP'},
                                      {'number': 'X/W01-001a', 'rarity': 'C'}])
        p = {'id': '1', 'name': 'Name [X/W01-001]'}
        self.assertEqual(r.resolve(p, 'weiss_schwarz', 'X/W01-001', '')['rarityStatus'], 'unavailable')
        p['name'] = 'Name R [X/W01-001]'
        self.assertEqual(r.resolve(p, 'weiss_schwarz', 'X/W01-001', '')['rarity'], 'R')
        p['name'] = 'Name C [X/W01-001]'
        self.assertEqual(r.resolve(p, 'weiss_schwarz', 'X/W01-001', '')['rarityOrigin'], 'source-conflict')

    def test_missing_manufacturer_field_does_not_mean_not_applicable(self):
        for value, status, expected in [('-', None, 'unavailable'), (None, None, 'unavailable'),
                                         (None, 'not_applicable', 'not_applicable')]:
            r = resolver('union_arena', [{'number': 'UA01BT/NIK-1-AP01', 'rarity': value, 'rarityStatus': status}])
            result = r.resolve({'id': '1', 'name': 'Action Point [UA01BT/NIK-1-AP01]'}, 'union_arena', 'UA01BT/NIK-1-AP01', '')
            self.assertEqual(result['rarityStatus'], expected)

    def test_grade_word_inside_name_and_related_number_never_supply_grade(self):
        r = resolver('weiss_schwarz', [{'number': 'X/W01-001', 'rarity': 'AGR'}])
        p = {'id': '1', 'name': 'AGR character [name] title [X/W01-001A]'}
        self.assertEqual(r.resolve(p, 'weiss_schwarz', 'X/W01-001A', '')['rarityStatus'], 'unavailable')
        self.assertEqual(r.resolve(p, 'weiss_schwarz', 'X/W01-001A', 'SP'), {'rarity': 'SP'})

    def test_marketplace_parallel_labels_preserve_source_namespace(self):
        r = resolver('yugioh', [{'number': 'X-JP001', 'rarity': 'P'}])
        p = {'id': '1', 'name': 'Name NP [X-JP001]'}
        self.assertEqual(r.resolve(p, 'yugioh', 'X-JP001', '')['rarity'], 'NP')


if __name__ == '__main__':
    unittest.main()
