"""Source preservation and failure-boundary checks for public history packing."""
import hashlib
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch

import pack_card_history as target


class CardHistoryBundleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='history-pack-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.deploy = self.root / '_deploy'
        (self.root / 'data/history').mkdir(parents=True)
        (self.root / 'functions').mkdir(parents=True)
        (self.deploy / 'functions').mkdir(parents=True)
        (self.root / 'functions/_middleware.js').write_text(target.RUNTIME_MARKER, encoding='utf-8')
        shutil.copyfile(self.root / 'functions/_middleware.js', self.deploy / 'functions/_middleware.js')
        (self.deploy / '_routes.json').write_text(json.dumps({'include':['/data/history/*'],'exclude':[]}))
        self.original = {
            '1.json': b'{\r\n "id":"1", "raw_price":1e+4,"volume":0,"history":[]\r\n}\r\n',
            '2.json': ('\ufeff{"id":"2","name":"한국어 日本語","history":[{"date":"2026-11-06","raw_price":null}]}\n').encode(),
            '64.json': b'{"id":"64","history":[]}',
        }
        self.seed()

    def seed(self):
        for name, raw in self.original.items():
            (self.root / 'data/history' / name).write_bytes(raw)
        shutil.copytree(self.root / 'data/history', self.deploy / 'data/history', dirs_exist_ok=True)

    def assert_original(self):
        for name, raw in self.original.items():
            self.assertEqual((self.root / 'data/history' / name).read_bytes(), raw)

    def test_exact_bytes_and_all_fields_survive_packing_and_large_id_boundaries(self):
        for ident in ('63', '65', '99999999999999999998', '99999999999999999999'):
            self.original[ident + '.json'] = json.dumps({'id':ident,'raw_price':12.34,'history':[]}).encode()
        self.seed()
        result = target.pack(self.root, self.deploy)
        self.assertEqual(result['status'], 'passed')
        self.assertEqual(result['sourceFiles'], len(self.original))
        self.assertEqual(result['packedFiles'] + result['unpackedFiles'], len(self.original))
        self.assertEqual(target.verify(self.root, self.deploy), result)
        self.assert_original()
        destination = self.deploy / 'data' / target.PACK_DIRECTORY / result['generation']
        restored = {path.name:path.read_bytes() for path in (self.deploy / 'data/history').iterdir()}
        for path in destination.iterdir():
            pack = json.loads(path.read_bytes())
            for name, row in pack['files'].items():
                restored[name] = row['body'].encode()
                self.assertEqual(row['sha256'], hashlib.sha256(restored[name]).hexdigest())
        self.assertEqual(restored, self.original)

    def test_generation_changes_when_a_price_changes_and_is_deterministic(self):
        source = target.records(self.root / 'data/history')
        before = target.generation_for(source)
        self.assertEqual(before, target.generation_for(dict(reversed(list(source.items())))))
        changed = dict(source)
        changed['1.json'] = {**changed['1.json'], 'sha256':'0'*64}
        self.assertNotEqual(before, target.generation_for(changed))

    def test_oversized_groups_keep_large_originals_and_never_truncate(self):
        self.original['1.json'] = json.dumps({'history':['x'*5000]}).encode()
        self.original['3.json'] = b'{"id":"3"}'
        self.original['4.json'] = b'{"id":"4"}'
        self.seed()
        with patch.object(target, 'MAX_PACK_BYTES', 1100):
            result = target.pack(self.root, self.deploy)
            self.assertLessEqual(result['largestPackBytes'], 1100)
            self.assertEqual((self.deploy / 'data/history/1.json').read_bytes(), self.original['1.json'])
            self.assertEqual(target.verify(self.root, self.deploy)['status'], 'passed')
        self.assert_original()

    def test_invalid_json_and_unexpected_files_stop_before_removing_any_copy(self):
        for name, raw in [('3.json', b'{broken'), ('notes.txt', b'not a price history')]:
            with self.subTest(name=name):
                bad = self.deploy / 'data/history' / name
                bad.write_bytes(raw)
                with self.assertRaises((ValueError, json.JSONDecodeError)):
                    target.pack(self.root, self.deploy)
                for old, body in self.original.items():
                    self.assertEqual((self.deploy / 'data/history' / old).read_bytes(), body)
                self.assertFalse((self.deploy / 'data' / target.PACK_DIRECTORY).exists())
                bad.unlink()
        self.assert_original()

    def test_changed_copy_cannot_replace_the_repository_history(self):
        (self.deploy / 'data/history/1.json').write_bytes(b'{"changed":true}')
        with self.assertRaisesRegex(ValueError, 'differ from the repository'):
            target.pack(self.root, self.deploy)
        self.assert_original()

    def test_original_directory_and_symlinked_inputs_are_rejected(self):
        with self.assertRaisesRegex(ValueError, 'Only the generated'):
            target.pack(self.root, self.root / 'data')
        alias = self.deploy / 'data/history/3.json'
        try:
            alias.symlink_to(self.root / 'data/history/1.json')
        except OSError:
            self.skipTest('This Windows owner cannot create symlinks; Linux CI covers the same boundary')
        with self.assertRaisesRegex(ValueError, 'unsafe public history'):
            target.pack(self.root, self.deploy)
        self.assert_original()

    def test_missing_route_or_runtime_marker_stops_before_removal(self):
        routes = self.deploy / '_routes.json'
        routes.write_text('{"include":[],"exclude":[]}')
        with self.assertRaisesRegex(ValueError, 'routes'):
            target.pack(self.root, self.deploy)
        routes.write_text('{"include":["/data/history/*"],"exclude":[]}')
        (self.deploy / 'functions/_middleware.js').write_text('missing marker')
        with self.assertRaisesRegex(ValueError, 'runtime marker'):
            target.pack(self.root, self.deploy)
        self.assert_original()

    def test_unrelated_route_exclusions_are_allowed_and_history_exclusions_are_not(self):
        routes = self.deploy / '_routes.json'
        routes.write_text('{"include":["/data/history/*"],"exclude":["/images/*"]}')
        self.assertEqual(target.pack(self.root, self.deploy)['status'], 'passed')
        for pattern in ('/*', '/data/*', '/data/history/*', '/data/history/1.json'):
            with self.subTest(pattern=pattern):
                routes.write_text(json.dumps({'include':['/data/history/*'],'exclude':[pattern]}))
                with self.assertRaisesRegex(ValueError, 'routes'):
                    target.verify(self.root, self.deploy)

    def test_existing_output_is_not_overwritten(self):
        target.pack(self.root, self.deploy)
        before = (self.deploy / 'data' / target.PACK_DIRECTORY / 'manifest.json').read_bytes()
        with self.assertRaises(ValueError):
            target.pack(self.root, self.deploy)
        self.assertEqual((self.deploy / 'data' / target.PACK_DIRECTORY / 'manifest.json').read_bytes(), before)
        self.assert_original()

    def test_verify_rejects_lost_history_tampered_packs_and_stale_generation(self):
        result = target.pack(self.root, self.deploy)
        folder = self.deploy / 'data' / target.PACK_DIRECTORY / result['generation']
        pack = folder / '0.json'
        old = pack.read_bytes()
        data = json.loads(old)
        data['files']['1.json']['body'] = '{"invented":true}'
        pack.write_bytes(target.encode(data))
        with self.assertRaisesRegex(ValueError, 'exact source bytes'):
            target.verify(self.root, self.deploy)
        pack.write_bytes(old)
        (self.deploy / 'data/history/64.json').unlink()
        with self.assertRaisesRegex(ValueError, 'lost, changed or duplicated'):
            target.verify(self.root, self.deploy)
        (self.deploy / 'data/history/64.json').write_bytes(self.original['64.json'])
        (self.deploy / 'functions/_middleware.js').write_text(target.RUNTIME_MARKER + '\n// changed runtime')
        with self.assertRaisesRegex(ValueError, 'runtime differs'):
            target.verify(self.root, self.deploy)
        self.assert_original()


if __name__ == '__main__':
    unittest.main()
