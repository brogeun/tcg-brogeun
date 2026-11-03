"""Failures preserve individual checkpoints without publishing partial artwork."""
import copy
import hashlib
import io
import unittest
from PIL import Image
import json
from pathlib import Path
import urllib.error
from unittest.mock import patch

import test_materialize_vintage_pokemon_release as fixture_tests
import materialize_vintage_pokemon_release as target


class ResumeTests(unittest.TestCase):
    setUp = fixture_tests.MaterializationTests.setUp
    materialize = fixture_tests.MaterializationTests.materialize

    def add_second(self, pooka=False):
        row = copy.deepcopy(self.fixture.row)
        if pooka:
            row.update(setCode='DP1', sourceId='ja-dp1-108',
                       sourceUrl='https://pooka.app/card/ja-dp1-108/Darkness%20Energy',
                       sourceName='Darkness Energy',
                       originalImage='https://cdn.pooka.app/card/ja-dp1-108.png?size=small',
                       imageSourceUrl='https://cdn.pooka.app/card/ja-dp1-108.png',
                       localImage='/images/pokemon-vintage/DP1/pooka-ja-dp1-108.png',
                       method='exact-existing-pooka-source-image-card-id')
        else:
            buffer = io.BytesIO()
            Image.new('RGB', (250, 350), '#d2a333').save(buffer, format='WEBP')
            self.other_body = buffer.getvalue()
            row.update(sha256=hashlib.sha256(self.other_body).hexdigest(), bytes=len(self.other_body))
            row.update(sourceId='29519', sourceUrl=row['sourceUrl'].replace('29518', '29519'),
                       localImage=row['localImage'].replace('29518', '29519'))
        self.fixture.review['images'].append(row)
        self.fixture.save_review()
        card = {**self.fixture.card, 'name': row['sourceName'], 'url': row['sourceUrl'], 'image': row['originalImage']}
        name = 'data/cards-by-set/' + row['setCode'] + '.json'
        doc = target.read_json(self.root / name) if (self.root / name).exists() else {'brand': 'pokemon', 'code': row['setCode'], 'cards': []}
        doc['cards'].append(card)
        self.fixture.write(name, doc)
        catalogue = target.read_json(self.root / target.CATALOGUE)
        catalogue['cards'].append({**card, 'boxCode': row['setCode'], 'sourceUrl': row['sourceUrl']})
        self.fixture.write(target.CATALOGUE, catalogue)
        return row

    def test_successful_download_survives_failure_and_second_run_never_requests_it(self):
        other = self.add_second()
        cache = self.root / 'cache'
        before = (self.root / target.CATALOGUE).read_bytes()
        calls = []
        def download(row, stop, pacer):
            calls.append(row['sourceId'])
            if row['sourceId'] == other['sourceId']:
                raise urllib.error.HTTPError(row['imageSourceUrl'], 404, 'missing', {}, None)
            return self.fixture.body
        with patch.object(target, 'download_asset', side_effect=download):
            with self.assertRaises(target.PartialDownloadError):
                target.run(self.root, workers=1, cache_dir=cache)
        self.assertEqual((cache / self.fixture.row['sha256']).read_bytes(), self.fixture.body)
        self.assertEqual((self.root / target.CATALOGUE).read_bytes(), before)
        self.assertFalse((self.root / target.MANIFEST).exists())
        with patch.object(target, 'download_asset', return_value=self.other_body) as retry:
            result = target.run(self.root, cache_dir=cache)
            self.assertEqual(retry.call_count, 1)
            self.assertEqual(retry.call_args.args[0]['sourceId'], other['sourceId'])
        self.assertEqual(result['assetsReproduced'], 1)
        target.run(self.root, validate_only=True)

    def test_one_denied_origin_does_not_cancel_an_independent_origin(self):
        denied = self.add_second(pooka=True)
        # Queue the denied source first so the independent source must finish
        # after the failure rather than merely racing it.
        self.fixture.review['images'].reverse()
        self.fixture.save_review()
        called = []
        def download(row, stop, pacer):
            called.append(row['sourceId'])
            if row['sourceId'] == denied['sourceId']:
                stop.set()
                raise urllib.error.HTTPError(row['imageSourceUrl'], 403, 'denied', {}, None)
            self.assertFalse(stop.is_set())
            return self.fixture.body
        with patch.object(target, 'download_asset', side_effect=download):
            with self.assertRaises(target.PartialDownloadError) as raised:
                target.run(self.root, workers=1)
        self.assertEqual(called, [denied['sourceId'], self.fixture.row['sourceId']])
        self.assertEqual(raised.exception.completed, 1)
        self.assertEqual(raised.exception.failures[0]['httpCode'], 403)
        self.assertFalse((self.root / target.MANIFEST).exists())

    def test_corrupt_cache_is_quarantined_and_only_that_asset_is_requested(self):
        cache = self.root / 'cache'
        cache.mkdir()
        saved = cache / self.fixture.row['sha256']
        saved.write_bytes(b'torn download')
        with patch.object(target, 'download_asset', return_value=self.fixture.body) as download:
            target.run(self.root, cache_dir=cache)
        self.assertEqual(download.call_count, 1)
        self.assertEqual(saved.read_bytes(), self.fixture.body)
        self.assertEqual(next(cache.glob('*.corrupt-*')).read_bytes(), b'torn download')

    def test_offline_deploy_never_requests_pending_artwork_or_changes_documents(self):
        before = {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        with patch.object(target.urllib.request, 'urlopen') as network:
            result = target.run(self.root, offline=True)
            network.assert_not_called()
        self.assertEqual(result['status'], 'deferred-local-backfill')
        self.assertEqual(result['networkRequests'], 0)
        self.assertEqual(before, {str(p): p.read_bytes() for p in self.root.rglob('*') if p.is_file()})

    def test_offline_deploy_validates_published_generation_even_with_new_pending_review(self):
        self.materialize()
        self.fixture.review['images'][0]['sha256'] = 'c' * 64
        self.fixture.save_review()
        with patch.object(target.urllib.request, 'urlopen') as network:
            result = target.run(self.root, offline=True)
            network.assert_not_called()
        self.assertEqual(result['status'], 'validated-published')
        (self.root / self.fixture.row['localImage'][1:]).write_bytes(b'changed published image')
        with self.assertRaisesRegex(ValueError, 'Artwork bytes changed'):
            target.run(self.root, offline=True)

    def test_offline_deploy_rejects_dangling_local_reference_without_manifest(self):
        doc = target.read_json(self.root / target.CATALOGUE)
        doc['cards'][0]['localImage'] = self.fixture.row['localImage']
        self.fixture.write(target.CATALOGUE, doc)
        with self.assertRaisesRegex(ValueError, 'reference exists without a published manifest'):
            target.run(self.root, offline=True)

    def test_normal_workflow_validates_published_release_without_new_source_collection(self):
        workflow = (Path(__file__).resolve().parents[1] / '.github/workflows/scrape.yml').read_text()
        self.assertIn('python scripts/materialize_vintage_pokemon_release.py --offline', workflow)
        self.assertNotIn('python scripts/materialize_vintage_pokemon_release.py --base', workflow)
        self.assertIn('python scripts/prepare_card_index_public_bundle.py --data-dir _deploy/data --pack-vintage-images', workflow)

    def test_published_manifest_cannot_hide_an_unreviewed_local_reference(self):
        self.materialize()
        doc = target.read_json(self.root / target.CATALOGUE)
        doc['cards'].append({'name': 'Unrelated card', 'localImage': '/images/pokemon-vintage/Neo1/tcg-99999.webp'})
        self.fixture.write(target.CATALOGUE, doc)
        with self.assertRaisesRegex(ValueError, 'without a published manifest entry'):
            target.run(self.root, offline=True)

    def test_reviewed_seeds_are_retained_offline_and_only_their_deploy_copies_are_omitted(self):
        import shutil
        import prepare_card_index_public_bundle as bundler
        seed = self.root / self.fixture.row['localImage'][1:]
        seed.parent.mkdir(parents=True)
        seed.write_bytes(self.fixture.body)
        result = target.run(self.root, offline=True)
        self.assertEqual(result['verifiedSeeds'], 1)
        data = self.root / '_deploy/data'
        data.mkdir(parents=True)
        shutil.copytree(self.root / 'images', self.root / '_deploy/images')
        report = bundler.pack_vintage_images(data)
        self.assertEqual(report['verifiedSeedsOmitted'], 1)
        self.assertEqual(seed.read_bytes(), self.fixture.body)
        self.assertFalse((self.root / '_deploy/images/pokemon-vintage').exists())
        seed.write_bytes(b'unreviewed bytes')
        with self.assertRaises(ValueError):
            target.run(self.root, offline=True)
