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
        for path in (self.data / 'pokemon-vintage-packs').rglob('*.json'):
            pack = json.loads(path.read_bytes())
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
        self.assertFalse((self.data / 'pokemon-vintage-packs').exists())

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
        self.assertFalse((self.data / 'pokemon-vintage-packs').exists())

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
        destination = self.data / 'pokemon-vintage-packs'
        destination.mkdir()
        (destination / 'retain.txt').write_text('already prepared')
        with self.assertRaisesRegex(ValueError, 'preexisting'):
            target.pack_vintage_images(self.data)
        self.assertEqual((destination / 'retain.txt').read_text(), 'already prepared')
        self.assert_source_retained()


if __name__ == '__main__':
    unittest.main()
