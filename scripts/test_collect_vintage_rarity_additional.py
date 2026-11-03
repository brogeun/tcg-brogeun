"""Committed canonical aliases, not catalogue ordinals, prove old card identity."""
import copy
import unittest

import collect_vintage_rarity_additional as target


class AdditionalVintageRarityTests(unittest.TestCase):
    def setUp(self):
        self.original = 'https://www.tcgcollector.com/cards/10/example-old-no-001'
        self.current = 'https://www.tcgcollector.com/cards/10/example-current-no-004'
        self.card = {'url': self.original, 'name': 'Example (Old Set No. 001)', 'number': '', 'rarity': '',
                     'image': 'original-artwork', 'localImage': '/images/pokemon-vintage/CL1/tcg-10.webp',
                     'currentSourceUrl': self.current}
        self.proof = {'sourceUrl': self.original, 'sourceName': self.card['name'], 'sourceId': '10',
                      'canonicalSourceUrl': self.current, 'sourceCurrentName': 'Example (Old Set No. 004)',
                      'originalImage': self.card['image'], 'localImage': self.card['localImage'],
                      'sha256': 'a' * 64, 'method': 'exact-source-page-canonical-id-and-title-set'}
        self.rows = {self.current: {'name': self.proof['sourceCurrentName'], 'literal': 'Common', 'sourceId': '10',
                                   'sourceListNumber': 'No. 004'}}
        self.info = {'observedAt': 'test', 'sourceSetUrl': 'https://www.tcgcollector.com/sets/1/exact-set', 'sha256': 'b' * 64}

    def invoke(self, card=None, proof=None, rows=None):
        return target.stage_set('CL1', {'cards': [card or self.card]},
                                {('CL1', self.original): self.proof if proof is None else proof},
                                self.rows if rows is None else rows, self.info)

    def test_only_committed_alias_matches_current_title_and_original_identity_is_retained(self):
        before = copy.deepcopy(self.card)
        member, report = self.invoke()
        entry = member['cards'][self.original]
        self.assertEqual(entry['name'], self.card['name'])
        self.assertEqual(entry['number'], '')
        self.assertEqual(entry['sourceListNumber'], 'No. 004')
        self.assertEqual(entry['rarity'], 'C')
        self.assertEqual(entry['verifiedCurrentSourceUrl'], self.current)
        self.assertEqual(report['reviewedAliasesUsed'], 1)
        self.assertEqual(self.card, before)

    def test_unknown_canonical_url_or_title_does_not_acquire_a_grade(self):
        for card in ({**self.card, 'currentSourceUrl': self.current + '-unreviewed'},
                     {**self.card, 'image': 'other-artwork'}):
            member, report = self.invoke(card=card)
            self.assertFalse(member['cards'])
            self.assertEqual(len(report['held']), 1)
        wrong_rows = {self.current: {**self.rows[self.current], 'name': 'Different card (Old Set No. 004)'}}
        member, report = self.invoke(rows=wrong_rows)
        self.assertFalse(member['cards'])
        self.assertEqual(report['held'][0]['reason'], 'source-url-or-full-title-mismatch')

    def test_blank_source_stays_unknown_and_existing_explicit_grade_is_never_changed(self):
        for literal in ('', '—', '-', 'None', 'No rarity'):
            rows = {self.current: {**self.rows[self.current], 'literal': literal}}
            member, report = self.invoke(rows=rows)
            self.assertFalse(member['cards'])
            self.assertEqual(report['held'][0]['reason'], 'source-rarity-blank-or-unlisted')
        member, report = self.invoke(card={**self.card, 'rarity': 'Prior exact grade'})
        self.assertFalse(member['cards'])
        self.assertEqual(report['existingGradesPreserved'][0]['rarity'], 'Prior exact grade')


if __name__ == '__main__':
    unittest.main()
