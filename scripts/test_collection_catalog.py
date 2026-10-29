import importlib.util
import json
import pathlib
import unittest
ROOT = pathlib.Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location('collection_builder', ROOT / 'scripts/build_collection_catalog.py')
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)
def read(name):
    return json.loads((ROOT / name).read_text(encoding='utf-8-sig'))
evidence = read('data/collections/sources/evidence.json')
taxonomy = read('data/collections/sources/taxonomy.json')
names = read('data/japanese-card-names-ko.json')
_, aliases, mega, forms, _ = builder.prepare_taxonomy(evidence, taxonomy, names)
classify = builder.pokemon_classifier(aliases, mega, forms, names['owners'])
class CharacterClassifierTests(unittest.TestCase):
    def test_real_vendor_annotations_do_not_drop_beedrill_or_scizor(self):
        cases = [
            ('Beedrill R[SV2a 015/165](Enhanced Expansion Pack "Pokemon Card 151")', 15, 'base'),
            ('Beedrill V RR[s10P 001/067](Expansion Pack "Space Juggler")', 15, 'base'),
            ('Beedrill V SR[s10P 068/067](Expansion Pack "Space Juggler")', 15, 'base'),
            ('Beedrill U :1ED [CP6 007/087](Concept Pack "Pokemon Card Game Expansion Pack 20th Anniversary")', 15, 'base'),
            ('M Beedrill EX [CP4 002/131](Premium Champion Pack "EX x M x BREAK")', 15, 'mega'),
            ("Janine's Beedrill :1ED [VS 061/141](Half Deck example)", 15, 'base'),
            ('Scizor EX SR[XY9 085/080](Expansion Pack example)', 212, 'base'),
            ('M Scizor EX RR :1ED[XY9 058/080](Expansion Pack example)', 212, 'mega'),
        ]
        for title, species, form in cases:
            with self.subTest(title=title):
                self.assertEqual(classify(title), (['pokemon:species:' + str(species)], form))
    def test_trainer_and_prose_titles_do_not_become_species(self):
        for title in ['Beedrill Spirit Link', 'Beedrill Spirit Link [CP4 113/131](Premium Champion Pack)', 'Pikachu Records', 'Scizor Spirit Link', 'Beedrill mystery product']:
            with self.subTest(title=title):
                self.assertEqual(classify(title)[0], [])
    def test_similar_names_and_tag_teams_remain_exact(self):
        self.assertEqual(classify('Mewtwo')[0], ['pokemon:species:150'])
        self.assertEqual(classify('Mewtwo & Mew-GX')[0], ['pokemon:species:150', 'pokemon:species:151'])
        self.assertEqual(classify('Mew')[0], ['pokemon:species:151'])
    def test_japanese_mega_name_uses_the_verified_taxonomy(self):
        self.assertEqual(classify('メガスピアーex'), (['pokemon:species:15'], 'mega'))
if __name__ == '__main__':
    unittest.main()
