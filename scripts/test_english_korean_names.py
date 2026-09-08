import json
import unittest
from build_english_korean_names import ROOT, translator

class Names(unittest.TestCase):
    @classmethod
    def setUpClass(cls): cls.translate=staticmethod(translator())
    def test_all_1025_species(self):
        for s in json.loads((ROOT/'data/pokemon-names-pokeapi.json').read_text('utf-8')):
            self.assertEqual(self.translate(s['en']),s['ko'],s['en'])
    def test_forms_owners_tags_and_source_spelling(self):
        for en,ko in {
            'Mega Greninja ex':'메가개굴닌자 ex',
            'Galarian Articuno V':'가라르프리져 V',
            "Team Rocket's Mewtwo ex":'로켓단의 뮤츠 ex',
            'Pikachu & Zekrom-GX':'피카츄 & 제크로무-GX',
            'Nidoran ♂':'니드런♂','Nidoran ♀':'니드런♀',
            'Farfetch’d':'파오리','Mr.Mime':'마임맨','Flabebe':'플라베베',
        }.items(): self.assertEqual(self.translate(en),ko)
    def test_non_species_words_not_partially_matched(self):
        for n in ["Misty's Vitality",'Energy Retrieval','Switch','Mewtwonite','Eeveevolutions']:
            self.assertEqual(self.translate(n),n)
    def test_published_dictionary_matches_all_catalog_entries(self):
        names=json.loads((ROOT/'data/english-card-names-ko.json').read_text('utf-8'))['names']
        count=0
        for path in (ROOT/'data/english-sets').glob('*.json'):
            for c in json.loads(path.read_text('utf-8'))['cards']:
                expected=self.translate(c['name'])
                self.assertEqual(names.get(c['name'],c['name']),expected)
                count+=expected!=c['name']
        self.assertEqual(count,20311)

if __name__=='__main__': unittest.main()
