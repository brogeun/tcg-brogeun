"""Exact-source rarity recovery must never invent legacy printed numbers."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import urllib.error

import collect_vintage_rarity as target


URL = 'https://www.tcgcollector.com/cards/29518/oddish-gold-silver-to-a-new-world-no-001'
NAME = 'Oddish (Gold, Silver, to a New World... No. 001)'


def page(url=URL, name=NAME, ordinal='No. 001', grade='Common'):
    return ('<div class="card-list-item card-search-result-item" data-card-id="29518">'
            '<a class="card-list-item-name-entry" href="' + url + '" title="' + name + '">Oddish</a>'
            '<div class="card-list-item-number-entry">' + ordinal + '</div>'
            '<div class="card-list-item-rarity-entry"><img class="card-rarity-symbol" alt="' + grade + '" title="' + grade + '"></div>'
            '<button>Wrong price text: Rare Secret</button></div>').encode()


class VintageRarityTests(unittest.TestCase):
    def setUp(self):
        self.card = {'url': URL, 'name': NAME, 'number': '', 'image': 'untouched', 'rarity': ''}

    def test_explicit_common_is_mapped_without_copying_source_ordinal_into_blank_number(self):
        before = copy.deepcopy(self.card)
        result = target.set_overlay('Neo1', [self.card], page(), 'test')
        entry = result['cards'][URL]
        self.assertEqual(entry['rarity'], 'C')
        self.assertEqual(entry['rarityOriginal'], 'Common')
        self.assertEqual(entry['number'], '')
        self.assertEqual(entry['sourceListNumber'], 'No. 001')
        self.assertEqual(self.card, before)

    def test_holo_classification_is_preserved_literally(self):
        result = target.set_overlay('Neo1', [self.card], page(grade='Rare Holo'), 'test')
        self.assertEqual(result['cards'][URL]['rarity'], 'Rare Holo')

    def test_changed_url_full_title_or_inventory_membership_is_rejected(self):
        for body in (page(name=NAME.replace('Oddish', 'Chikorita')), page(url=URL.replace('29518', '29519')),
                     page() + page(), page(url='https://attacker.invalid/cards/29518/other')):
            with self.subTest(body=body[:80]):
                with self.assertRaises(ValueError):
                    target.set_overlay('Neo1', [self.card], body, 'test')
        with self.assertRaises(ValueError):
            target.set_overlay('Neo1', [self.card, {**self.card, 'url': URL + '-another'}], page(), 'test')

    def test_blank_rarity_and_conflicting_alt_title_never_create_a_grade(self):
        for body in (page(grade=''), page().replace(b'title="Common"', b'title="Rare"')):
            with self.assertRaises(ValueError):
                target.set_overlay('Neo1', [self.card], body, 'test')

    def test_failed_second_source_keeps_prior_source_cache_and_index_unmodified(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            index = root / target.INDEX
            index.parent.mkdir(parents=True)
            original = b'{"schemaVersion":1,"brand":"pokemon","language":"ja","cards":{},"setShards":{}}'
            index.write_bytes(original)
            for code in ('Neo1', 'Neo2'):
                path = root / 'data/cards-by-set' / (code + '.json')
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(json.dumps({'code': code, 'brand': 'pokemon', 'cards': [self.card]}))
            cached = root / '.cache/vintage-rarity-source/Neo1.html'
            cached.parent.mkdir(parents=True)
            cached.write_bytes(page())
            denied = urllib.error.HTTPError(target.PAGES['Neo2'], 403, 'denied', {}, None)
            with patch.object(target.urllib.request, 'urlopen', side_effect=denied) as network:
                with self.assertRaises(urllib.error.HTTPError):
                    target.collect(root, ['Neo1', 'Neo2'], fetch=True)
                self.assertEqual(network.call_count, 1)
            self.assertEqual(index.read_bytes(), original)
            self.assertEqual(cached.read_bytes(), page())
            self.assertFalse((root / target.SHARD).exists())

    def test_adding_shard_preserves_unrelated_index_entries_and_refuses_conflicts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            index = root / target.INDEX
            index.parent.mkdir(parents=True)
            value = {'schemaVersion': 1, 'brand': 'pokemon', 'language': 'ja', 'cards': {'preserve': {'value': 1}},
                     'setShards': {'OTHER': '/prior.json?v=old'}, 'coverage': {'prior': 9}}
            index.write_text(json.dumps(value))
            inventory = root / 'data/cards-by-set/Neo1.json'
            inventory.parent.mkdir(parents=True)
            inventory.write_text(json.dumps({'code': 'Neo1', 'brand': 'pokemon', 'cards': [self.card]}))
            with patch.object(target, 'source_body', return_value=page()):
                target.collect(root, ['Neo1'])
            result = json.loads(index.read_bytes())
            self.assertEqual(result['cards'], value['cards'])
            self.assertEqual(result['setShards']['OTHER'], '/prior.json?v=old')
            self.assertEqual(result['coverage']['prior'], 9)
            result['setShards']['NEO1'] = '/independently-reviewed.json?v=new'
            index.write_text(json.dumps(result))
            with patch.object(target, 'source_body', return_value=page()):
                with self.assertRaisesRegex(ValueError, 'independent rarity shard'):
                    target.collect(root, ['Neo1'])


if __name__ == '__main__':
    unittest.main()
