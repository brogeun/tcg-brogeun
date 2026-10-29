"""Complete lookup buckets remain compatible with bounded legacy metadata."""
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import metadata_index


class MetadataIndexTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_bucket_uses_original_id_and_rejects_paths(self):
        self.assertEqual(metadata_index.metadata_bucket('472683'), '83')
        self.assertEqual(metadata_index.metadata_bucket('1'), '01')
        for value in ('../1', '01', '0', '-1', '1/2', 'a', '1' * 21):
            with self.assertRaises(ValueError):
                metadata_index.metadata_bucket(value)

    def test_every_game_and_unknown_row_survives_partial_updates(self):
        original = {'1':{'name':'Legacy','brand':'pokemon'},
                    '2':{'name':'Unknown retained','brand':'future_game'},
                    '472683':{'name':'NIKKE','brand':'weiss_schwarz','kind':'card'}}
        metadata_index.publish_metadata_index(self.data, original)
        metadata_index.publish_metadata_index(self.data, {'472683':{'name':'NIKKE updated'}})
        result = metadata_index.load_metadata_index(self.data)
        self.assertEqual(result['1'], original['1'])
        self.assertEqual(result['2'], original['2'])
        self.assertEqual(result['472683']['brand'], 'weiss_schwarz')
        self.assertEqual(result['472683']['name'], 'NIKKE updated')
        self.assertEqual(set(result), set(original))

    def test_root_size_caps_new_overlay_but_all_rows_stay_in_buckets(self):
        legacy = {'1':{'name':'Legacy','brand':'pokemon'},'2':{'name':'Unknown','brand':'future'}}
        (self.data/'cards-meta-index.json').write_text(json.dumps(legacy),encoding='utf-8')
        stats = metadata_index.publish_metadata_index(self.data, {
            '472683':{'name':'NIKKE '+'x'*200,'brand':'weiss_schwarz'}},root_limit_bytes=150)
        root = json.loads((self.data/'cards-meta-index.json').read_bytes())
        self.assertEqual(root, legacy)
        self.assertLessEqual(stats['rootBytes'],150)
        self.assertIn('472683', metadata_index.load_metadata_index(self.data))
        self.assertIn('472683', json.loads((self.data/'cards-meta-index/83.json').read_bytes()))

    def test_missing_root_can_load_all_retained_buckets(self):
        metadata_index.publish_metadata_index(self.data, {'123':{'name':'Card','brand':'digimon'}})
        (self.data/'cards-meta-index.json').unlink()
        self.assertEqual(metadata_index.load_metadata_index(self.data)['123']['brand'], 'digimon')

    def test_wrong_bucket_rejected_before_overwriting_any_index(self):
        metadata_index.publish_metadata_index(self.data, {'123':{'name':'Card','brand':'digimon'}})
        wrong = self.data/'cards-meta-index/99.json'
        wrong.write_text(json.dumps({'456':{'name':'Wrong bucket'}}),encoding='utf-8')
        before = {path:path.read_bytes() for path in self.data.rglob('*.json')}
        with self.assertRaises(ValueError):
            metadata_index.publish_metadata_index(self.data, {})
        self.assertEqual(before,{path:path.read_bytes() for path in self.data.rglob('*.json')})

    def test_oversized_bucket_fails_before_any_replacement(self):
        with mock.patch.object(metadata_index,'BUCKET_LIMIT_BYTES',5):
            with self.assertRaises(ValueError):
                metadata_index.publish_metadata_index(self.data, {'123':{'name':'Card','brand':'digimon'}})
        self.assertEqual(list(self.data.rglob('*.json')), [])


if __name__ == '__main__':
    unittest.main()
