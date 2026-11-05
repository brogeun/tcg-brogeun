"""Disposable image packing preserves exact browser bytes and repository files."""
import base64
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import prepare_card_index_public_bundle as target


class VintageImageBundleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='vintage-pack-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.data = self.root / '_deploy/data'
        self.data.mkdir(parents=True)
        self.bodies = {}
        self.rows = []
        for code, ident, prefix, suffix in [('Neo1', '29518', 'tcg', 'webp'), ('Neo1', '29519', 'tcg', 'webp'),
                                          ('DP1', 'ja-dp1-108', 'pooka', 'png')]:
            local = f'/images/pokemon-vintage/{code}/{prefix}-{ident}.{suffix}'
            body = ('exact reviewed image bytes ' + ident).encode()
            self.bodies[local] = body
            self.rows.append({'setCode': code, 'sourceId': ident, 'localImage': local,
                              'sha256': hashlib.sha256(body).hexdigest(), 'bytes': len(body)})
            for base in (self.root, self.root / '_deploy'):
                path = base / local[1:]
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(body)
        self.save_review()

    def save_review(self):
        (self.data / 'pokemon-vintage-image-repairs.json').write_text(
            json.dumps({'schemaVersion': 1, 'images': self.rows, 'errors': []}), encoding='utf-8')

    def assert_source_retained(self):
        for local, body in self.bodies.items():
            self.assertEqual((self.root / local[1:]).read_bytes(), body)
            self.assertEqual((self.root / '_deploy' / local[1:]).read_bytes(), body)

    def test_every_image_round_trips_exactly_and_only_generated_sources_are_removed(self):
        report = target.pack_vintage_images(self.data)
        self.assertEqual(report['artworkFiles'], 3)
        self.assertEqual(report['packFiles'], 2)
        self.assertEqual(report['fileCountSaved'], 1)
        seen = {}
        for path in (self.data / 'pokemon-vintage-packs-v2').rglob('*.json'):
            pack = json.loads(path.read_bytes())
            self.assertEqual(pack['schemaVersion'], 2)
            self.assertEqual(pack['bucketSize'], 64)
            for name, image in pack['files'].items():
                local = '/images/pokemon-vintage/' + pack['setCode'] + '/' + name
                body = base64.b64decode(image['data'], validate=True)
                self.assertEqual(body, self.bodies[local])
                self.assertEqual(image['sha256'], hashlib.sha256(body).hexdigest())
                self.assertEqual(image['bytes'], len(body))
                self.assertEqual(image['contentType'], 'image/png' if name.endswith('.png') else 'image/webp')
                seen[local] = body
        self.assertEqual(seen, self.bodies)
        self.assertFalse((self.root / '_deploy/images/pokemon-vintage').exists())
        for local, body in self.bodies.items():
            self.assertEqual((self.root / local[1:]).read_bytes(), body)

    def test_hash_mismatch_stops_before_any_source_is_removed(self):
        self.rows[0]['sha256'] = 'a' * 64
        self.save_review()
        with self.assertRaisesRegex(ValueError, 'bytes differ'):
            target.pack_vintage_images(self.data)
        self.assert_source_retained()
        self.assertFalse((self.data / 'pokemon-vintage-packs-v2').exists())

    def test_unreviewed_files_and_duplicate_rows_cannot_disappear_from_the_bundle(self):
        extra = self.root / '_deploy/images/pokemon-vintage/Neo1/unreviewed.webp'
        extra.write_bytes(b'user image')
        with self.assertRaisesRegex(ValueError, 'Unreviewed or missing'):
            target.pack_vintage_images(self.data)
        self.assertEqual(extra.read_bytes(), b'user image')
        self.assert_source_retained()
        extra.unlink()
        self.rows.append(self.rows[0])
        self.save_review()
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            target.pack_vintage_images(self.data)
        self.assert_source_retained()

    def test_oversized_pack_is_rejected_before_source_removal(self):
        with patch.object(target, 'MAX_VINTAGE_PACK_BYTES', 64):
            with self.assertRaisesRegex(ValueError, 'runtime asset budget'):
                target.pack_vintage_images(self.data)
        self.assert_source_retained()
        self.assertFalse((self.data / 'pokemon-vintage-packs-v2').exists())

    def test_paths_and_existing_generated_packs_are_not_overwritten(self):
        original = self.rows[0]['localImage']
        for invalid in ('/images/pokemon-vintage/Neo1/../../private.webp',
                        '/images/pokemon-vintage/Neo1/tcg-29519.webp'):
            self.rows[0]['localImage'] = invalid
            self.save_review()
            with self.assertRaisesRegex(ValueError, 'path does not match'):
                target.pack_vintage_images(self.data)
            self.assert_source_retained()
        self.rows[0]['localImage'] = original
        self.save_review()
        destination = self.data / 'pokemon-vintage-packs-v2'
        destination.mkdir()
        (destination / 'retain.txt').write_text('already prepared')
        with self.assertRaisesRegex(ValueError, 'preexisting'):
            target.pack_vintage_images(self.data)
        self.assertEqual((destination / 'retain.txt').read_text(), 'already prepared')
        self.assert_source_retained()

    def test_64_card_buckets_merge_old_groups_and_preserve_the_next_boundary(self):
        for ident in ('29536', '29568'):
            local = f'/images/pokemon-vintage/Neo1/tcg-{ident}.webp'
            body = ('exact reviewed image bytes ' + ident).encode()
            self.bodies[local] = body
            self.rows.append({'setCode': 'Neo1', 'sourceId': ident, 'localImage': local,
                              'sha256': hashlib.sha256(body).hexdigest(), 'bytes': len(body)})
            for base in (self.root, self.root / '_deploy'):
                (base / local[1:]).write_bytes(body)
        self.save_review()
        report = target.pack_vintage_images(self.data)
        self.assertEqual(report['artworkFiles'], 5)
        self.assertEqual(report['packFiles'], 3)
        folder = self.data / 'pokemon-vintage-packs-v2/Neo1'
        merged = json.loads((folder / '461.json').read_bytes())
        self.assertEqual(set(merged['files']), {'tcg-29518.webp', 'tcg-29519.webp', 'tcg-29536.webp'})
        self.assertEqual(set(json.loads((folder / '462.json').read_bytes())['files']), {'tcg-29568.webp'})



class ReviewedContentsImageBundleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='reviewed-contents-pack-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.data = self.root / '_deploy/data'
        self.data.mkdir(parents=True)
        self.rows, self.bodies = [], {}
        for name in ('dp-grass.png', 'legend-water.jpg', 'hg-alph.webp'):
            local = '/images/pokemon-contained/' + name
            body = ('exact original artwork ' + name).encode()
            self.bodies[local] = body
            self.rows.append({'localImage':local,'sha256':hashlib.sha256(body).hexdigest(),'bytes':len(body)})
            for base in (self.root, self.root / '_deploy'):
                path = base / local[1:]
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(body)
        self.save_review()
    def save_review(self):
        (self.data / 'pokemon-contained-supplements.json').write_text(
            json.dumps({'schemaVersion':1,'reviewId':'test','assets':self.rows}), encoding='utf-8')
    def assert_retained(self):
        for local, body in self.bodies.items():
            for base in (self.root, self.root / '_deploy'):
                self.assertEqual((base / local[1:]).read_bytes(),body)
    def test_exact_original_bytes_and_urls_survive_in_one_bounded_pack(self):
        report = target.pack_reviewed_pokemon_images(self.data)
        self.assertEqual(report['artworkFiles'],3)
        self.assertEqual(report['fileCountSaved'],2)
        pack = json.loads((self.data / 'pokemon-vintage-packs-v2/reviewed-contents/originals.json').read_bytes())
        self.assertEqual((pack['schemaVersion'],pack['setCode'],pack['bucket']),(2,'reviewed-contents','originals'))
        for local, body in self.bodies.items():
            image = pack['files'][Path(local).name]
            self.assertEqual(base64.b64decode(image['data'],validate=True),body)
            self.assertEqual(image['sha256'],hashlib.sha256(body).hexdigest())
            self.assertEqual(image['bytes'],len(body))
            self.assertEqual((self.root / local[1:]).read_bytes(),body)
        self.assertFalse((self.root / '_deploy/images/pokemon-contained').exists())
    def test_changed_bytes_or_unreviewed_files_stop_before_removal(self):
        self.rows[0]['sha256']='a'*64
        self.save_review()
        with self.assertRaisesRegex(ValueError,'bytes differ'):
            target.pack_reviewed_pokemon_images(self.data)
        self.assert_retained()
        self.rows[0]['sha256']=hashlib.sha256(self.bodies[self.rows[0]['localImage']]).hexdigest()
        self.save_review()
        extra=self.root / '_deploy/images/pokemon-contained/unreviewed.png'
        extra.write_bytes(b'unreviewed artwork')
        with self.assertRaisesRegex(ValueError,'Unreviewed or missing'):
            target.pack_reviewed_pokemon_images(self.data)
        self.assertEqual(extra.read_bytes(),b'unreviewed artwork')
        self.assert_retained()
    def test_unsafe_duplicate_and_preexisting_destinations_are_rejected(self):
        original=self.rows[0]['localImage']
        self.rows[0]['localImage']='/images/pokemon-contained/../private.png'
        self.save_review()
        with self.assertRaisesRegex(ValueError,'Invalid reviewed'):
            target.pack_reviewed_pokemon_images(self.data)
        self.rows[0]['localImage']=original
        self.rows.append(self.rows[0])
        self.save_review()
        with self.assertRaisesRegex(ValueError,'Duplicate'):
            target.pack_reviewed_pokemon_images(self.data)
        self.rows.pop()
        self.save_review()
        destination=self.data / 'pokemon-vintage-packs-v2/reviewed-contents'
        destination.mkdir(parents=True)
        (destination / 'retain.txt').write_text('prior generation')
        with self.assertRaisesRegex(ValueError,'preexisting'):
            target.pack_reviewed_pokemon_images(self.data)
        self.assertEqual((destination / 'retain.txt').read_text(),'prior generation')
        self.assert_retained()
    def test_runtime_budget_is_enforced_before_any_generated_image_is_removed(self):
        with patch.object(target,'MAX_VINTAGE_PACK_BYTES',64):
            with self.assertRaisesRegex(ValueError,'runtime asset budget'):
                target.pack_reviewed_pokemon_images(self.data)
        self.assert_retained()
        self.assertFalse((self.data / 'pokemon-vintage-packs-v2/reviewed-contents').exists())


if __name__ == '__main__':
    unittest.main()

