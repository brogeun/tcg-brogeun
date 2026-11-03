"""Offline reproduction, identity preservation and real Git publication boundaries."""
from __future__ import annotations

import concurrent.futures
import copy
import gzip
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error

from PIL import Image

import materialize_vintage_pokemon_release as target
import publish_data_snapshot as publisher


class Fixture:
    def __init__(self, root):
        self.root = root
        buffer = io.BytesIO()
        Image.new('RGB', (250, 350), '#a5bac8').save(buffer, format='WEBP')
        self.body = buffer.getvalue()
        self.row = {
            'setCode': 'Neo1', 'sourceId': '29518',
            'sourceUrl': 'https://www.tcgcollector.com/cards/29518/oddish-gold-silver-to-a-new-world-no-001',
            'sourceName': 'Oddish (Gold, Silver, to a New World... No. 001)',
            'originalImage': 'https://static.tcgcollector.com/content/images/11/22/33/' + 'a' * 64 + '.jpg',
            'imageSourceUrl': 'https://static.tcgcollector.com/content/images/11/22/33/' + 'b' * 64 + '.webp',
            'localImage': '/images/pokemon-vintage/Neo1/tcg-29518.webp',
            'sha256': hashlib.sha256(self.body).hexdigest(), 'width': 250, 'height': 350,
            'bytes': len(self.body), 'method': 'exact-source-page-canonical-id-and-image-alt',
        }
        self.card = {'name': self.row['sourceName'], 'image': self.row['originalImage'],
                     'url': self.row['sourceUrl'], 'number': '', 'rarity': 'C',
                     'freshRarityEvidence': 'concurrent authoritative review', 'marketProductId': '4321'}
        self.review = {'schemaVersion': 1, 'images': [self.row], 'errors': []}
        self.save_review()
        self.write('data/cards-by-set/Neo1.json', {'brand': 'pokemon', 'code': 'Neo1',
                   'cards': [self.card], 'untouchedCurrentMetadata': {'value': 1}})
        self.write(target.CATALOGUE, {'cards': [{**self.card, 'boxCode': 'Neo1',
                    'sourceUrl': self.row['sourceUrl']}], 'audit': {'preserve': True}})

    def write(self, name, value):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding='utf-8')

    def save_review(self):
        path = self.root / target.REVIEW
        path.parent.mkdir(parents=True, exist_ok=True)
        with gzip.open(path, 'wt', encoding='utf-8') as stream:
            json.dump(self.review, stream)


class PacingClock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now


class PacingStop:
    def __init__(self, clock):
        self.clock = clock
        self.event = threading.Event()
        self.waits = []

    def is_set(self):
        return self.event.is_set()

    def set(self):
        self.event.set()

    def wait(self, delay):
        self.waits.append(delay)
        self.clock.now += delay
        return self.event.is_set()


class MaterializationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='vintage-release-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.fixture = Fixture(self.root)

    def materialize(self):
        with patch.object(target, 'download_asset', return_value=self.fixture.body):
            return target.run(self.root)

    def test_exact_assets_materialize_and_current_rarity_metadata_and_identity_survive(self):
        self.materialize()
        current = target.read_json(self.root / 'data/cards-by-set/Neo1.json')
        card = current['cards'][0]
        self.assertEqual({k: card[k] for k in self.fixture.card}, self.fixture.card)
        self.assertEqual(current['untouchedCurrentMetadata'], {'value': 1})
        self.assertEqual(card['localImage'], self.fixture.row['localImage'])
        self.assertEqual(card['imageSourceUrl'], self.fixture.row['imageSourceUrl'])
        self.assertEqual(card['currentSourceUrl'], self.fixture.row['sourceUrl'])
        catalogue = target.read_json(self.root / target.CATALOGUE)
        self.assertEqual(catalogue['audit'], {'preserve': True})
        self.assertEqual(catalogue['cards'][0]['rarity'], 'C')
        self.assertEqual(catalogue['cards'][0]['currentSourceUrl'], self.fixture.row['sourceUrl'])
        self.assertEqual((self.root / self.fixture.row['localImage'][1:]).read_bytes(), self.fixture.body)
        result = target.run(self.root, validate_only=True)
        self.assertEqual(result['files'], 4)
        self.assertEqual(result['artworks'], 1)

    def test_failed_download_leaves_original_data_and_images_untouched(self):
        before = {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        with patch.object(target, 'download_asset', side_effect=ValueError('reviewed hash mismatch')):
            with self.assertRaisesRegex(ValueError, 'reviewed hash mismatch'):
                target.run(self.root)
        after = {str(p.relative_to(self.root)): p.read_bytes() for p in self.root.rglob('*') if p.is_file()}
        self.assertEqual(after, before)

    def test_inventory_identity_change_is_rejected_before_any_network_or_writes(self):
        doc = target.read_json(self.root / 'data/cards-by-set/Neo1.json')
        doc['cards'][0]['image'] = 'another artwork'
        self.fixture.write('data/cards-by-set/Neo1.json', doc)
        with patch.object(target, 'download_asset') as download:
            with self.assertRaisesRegex(ValueError, 'exact reviewed identity'):
                target.run(self.root)
            download.assert_not_called()

    def test_partial_set_review_is_rejected(self):
        doc = target.read_json(self.root / 'data/cards-by-set/Neo1.json')
        doc['cards'].append({**self.fixture.card, 'url': self.fixture.row['sourceUrl'].replace('29518', '29519')})
        self.fixture.write('data/cards-by-set/Neo1.json', doc)
        with self.assertRaisesRegex(ValueError, 'exact reviewed identity'):
            target.patch_documents(self.root, target.load_review(self.root))

    def test_hash_modified_existing_image_is_rejected_and_never_overwritten(self):
        path = self.root / self.fixture.row['localImage'][1:]
        path.parent.mkdir(parents=True)
        path.write_bytes(b'other user asset')
        with patch.object(target, 'download_asset') as download:
            with self.assertRaisesRegex(ValueError, 'Artwork bytes changed'):
                target.run(self.root)
            download.assert_not_called()
        self.assertEqual(path.read_bytes(), b'other user asset')

    def test_review_rejects_foreign_hosts_paths_id_mismatch_and_duplicate_outputs(self):
        changes = [
            {'imageSourceUrl': self.fixture.row['imageSourceUrl'].replace('static.tcgcollector.com', 'attacker.invalid')},
            {'imageSourceUrl': self.fixture.row['imageSourceUrl'].replace('https://', 'http://')},
            {'localImage': '/images/pokemon-vintage/Neo1/../../secret.webp'},
            {'sourceId': '29519'},
            {'metadataRepair': {'correctedName': 'unapproved rename'}},
        ]
        for change in changes:
            with self.subTest(change=change):
                self.fixture.review['images'] = [{**self.fixture.row, **change}]
                self.fixture.save_review()
                with self.assertRaises(ValueError):
                    target.load_review(self.root)
        self.fixture.review['images'] = [self.fixture.row, self.fixture.row]
        self.fixture.save_review()
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            target.load_review(self.root)

    def test_pooka_requires_same_existing_card_id_and_original_image_path(self):
        row = {**self.fixture.row, 'sourceId': 'ja-dp1-108', 'setCode': 'DP1',
               'sourceUrl': 'https://pooka.app/card/ja-dp1-108/Darkness%20Energy',
               'sourceName': 'Darkness Energy', 'originalImage': 'https://cdn.pooka.app/card/ja-dp1-108.png?size=small',
               'imageSourceUrl': 'https://cdn.pooka.app/card/ja-dp1-108.png',
               'localImage': '/images/pokemon-vintage/DP1/pooka-ja-dp1-108.png',
               'method': 'exact-existing-pooka-source-image-card-id'}
        self.fixture.review['images'] = [row]
        self.fixture.save_review()
        self.assertEqual(target.load_review(self.root)['images'][0], row)
        row['imageSourceUrl'] = row['imageSourceUrl'].replace('108', '109')
        self.fixture.save_review()
        with self.assertRaisesRegex(ValueError, 'Unexpected reviewed source URL'):
            target.load_review(self.root)

    def test_reviewed_dawn_dash_source_id_migration_keeps_legacy_identity(self):
        row = {**self.fixture.row, 'setCode': 'DP4-Bd', 'sourceId': '27058',
               'sourceUrl': 'https://www.tcgcollector.com/cards/27058/eevee-dawn-dash-no-049',
               'sourceName': 'Eevee (Dawn Dash No. 049)',
               'sourceCurrentName': 'Eevee (Moonlit Pursuit & Dawn Dash No. 101)',
               'canonicalSourceUrl': 'https://www.tcgcollector.com/cards/27125/eevee-moonlit-pursuit-and-dawn-dash-no-101',
               'localImage': '/images/pokemon-vintage/DP4-Bd/tcg-27058.webp',
               'method': 'exact-source-page-canonical-id-and-title-set',
               'sourceTitleMatch': 'exact-unique-title-in-reviewed-split-set',
               'sourceReplacementSet': 'https://www.tcgcollector.com/sets/12146/dawn-dash',
               'sourceReplacementSetSHA256': 'c' * 64, 'sourceReplacementId': '27125'}
        self.fixture.review['images'] = [row]
        self.fixture.save_review()
        card = {**self.fixture.card, 'name': row['sourceName'], 'url': row['sourceUrl']}
        self.fixture.write('data/cards-by-set/DP4-Bd.json', {'brand': 'pokemon', 'code': 'DP4-Bd', 'cards': [card]})
        self.fixture.write(target.CATALOGUE, {'cards': [{**card, 'boxCode': 'DP4-Bd', 'sourceUrl': row['sourceUrl']}]})
        with patch.object(target, 'download_asset', return_value=self.fixture.body):
            target.run(self.root)
        current = target.read_json(self.root / 'data/cards-by-set/DP4-Bd.json')['cards'][0]
        self.assertEqual(current['url'], row['sourceUrl'])
        self.assertEqual(current['name'], row['sourceName'])
        self.assertEqual(current['image'], row['originalImage'])
        self.assertEqual(current['localImage'], row['localImage'])
        self.assertEqual(current['currentSourceUrl'], row['canonicalSourceUrl'])
        catalogue_card = target.read_json(self.root / target.CATALOGUE)['cards'][0]
        self.assertEqual(catalogue_card['sourceUrl'], row['sourceUrl'])
        self.assertEqual(catalogue_card['currentSourceUrl'], row['canonicalSourceUrl'])
        target.run(self.root, validate_only=True)
        row['sourceCurrentName'] = 'Vaporeon (Moonlit Pursuit & Dawn Dash No. 101)'
        self.fixture.save_review()
        with self.assertRaisesRegex(ValueError, 'Unreviewed split-set'):
            target.load_review(self.root)

    def test_validation_rejects_missing_or_stale_display_source_url(self):
        self.fixture.row['canonicalSourceUrl'] = self.fixture.row['sourceUrl'].replace('no-001', 'no-002')
        self.fixture.save_review()
        self.materialize()
        for name in ('data/cards-by-set/Neo1.json', target.CATALOGUE):
            saved = target.read_json(self.root / name)
            for value in (None, self.fixture.row['sourceUrl']):
                with self.subTest(path=name, value=value):
                    changed = copy.deepcopy(saved)
                    if value is None:
                        changed['cards'][0].pop('currentSourceUrl')
                    else:
                        changed['cards'][0]['currentSourceUrl'] = value
                    self.fixture.write(name, changed)
                    with self.assertRaisesRegex(ValueError, 'reviewed display source URL'):
                        target.run(self.root, validate_only=True)
                    self.fixture.write(name, saved)

    def test_explicit_canonical_original_artwork_is_preserved_independently(self):
        catalogue = target.read_json(self.root / target.CATALOGUE)
        original = 'https://static.tcgcollector.com/content/images/11/22/33/' + 'c' * 64 + '.jpg'
        catalogue['cards'][0]['image'] = original
        catalogue['cards'][0]['sourceId'] = 'ja-existing-evidence-id'
        self.fixture.write(target.CATALOGUE, catalogue)
        self.fixture.row['canonicalOriginalImage'] = original
        self.fixture.row['canonicalSourceId'] = 'ja-existing-evidence-id'
        self.fixture.save_review()
        self.materialize()
        current = target.read_json(self.root / target.CATALOGUE)['cards'][0]
        self.assertEqual(current['image'], original)
        self.assertEqual(current['sourceId'], 'ja-existing-evidence-id')
        self.assertEqual(current['localImage'], self.fixture.row['localImage'])
        current['number'] = 'another printed number'
        self.fixture.write(target.CATALOGUE, {'cards': [current]})
        with self.assertRaisesRegex(ValueError, 'exact title or number'):
            target.run(self.root, validate_only=True)

    def test_http_403_and_429_open_circuit_without_retries(self):
        for status in (403, 429):
            with self.subTest(status=status):
                stop = threading.Event()
                error = urllib.error.HTTPError(self.fixture.row['imageSourceUrl'], status, 'blocked', {}, None)
                with patch.object(target.urllib.request, 'urlopen', side_effect=error) as open_url:
                    with self.assertRaises(urllib.error.HTTPError):
                        target.download_asset(self.fixture.row, stop)
                    self.assertTrue(stop.is_set())
                    self.assertEqual(open_url.call_count, 1)
                    with self.assertRaisesRegex(RuntimeError, 'circuit is open'):
                        target.download_asset(self.fixture.row, stop)
                    self.assertEqual(open_url.call_count, 1)

    def test_shared_pacer_spaces_four_worker_request_starts(self):
        clock = PacingClock()
        stop = PacingStop(clock)
        pacer = target.RequestPacer()
        barrier = threading.Barrier(4)
        starts = []
        response = object()
        request = target.urllib.request.Request(self.fixture.row['imageSourceUrl'])

        def open_url(request, timeout):
            starts.append(clock.monotonic())
            self.assertEqual(timeout, 30)
            return response

        def worker():
            barrier.wait(timeout=5)
            return pacer.open(request, stop)

        with patch.object(target.time, 'monotonic', side_effect=clock.monotonic):
            with patch.object(target.urllib.request, 'urlopen', side_effect=open_url):
                with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                    results = list(pool.map(lambda _: worker(), range(4)))
        self.assertEqual(results, [response] * 4)
        self.assertEqual(starts, [0.0, 0.25, 0.5, 0.75])
        self.assertEqual(stop.waits, [0.25] * 3)

    def test_every_transient_retry_uses_the_same_request_pacer(self):
        clock = PacingClock()
        stop = PacingStop(clock)
        pacer = target.RequestPacer()
        starts, addresses, agents = [], [], []
        response = io.BytesIO(self.fixture.body)
        response.url = self.fixture.row['imageSourceUrl']
        response.headers = {'Content-Type': 'image/webp'}

        def open_url(request, timeout):
            starts.append(clock.monotonic())
            addresses.append(request.full_url)
            agents.append(request.get_header('User-agent'))
            if len(starts) < 3:
                raise urllib.error.HTTPError(request.full_url, 503, 'temporary', {}, None)
            return response

        with patch.object(target.time, 'monotonic', side_effect=clock.monotonic):
            with patch.object(target.time, 'sleep') as backoff:
                with patch.object(target.urllib.request, 'urlopen', side_effect=open_url):
                    body = target.download_asset(self.fixture.row, stop, pacer)
        self.assertEqual(body, self.fixture.body)
        self.assertEqual(starts, [0.0, 0.25, 0.5])
        self.assertEqual(addresses, [self.fixture.row['imageSourceUrl']] * 3)
        self.assertEqual(agents, ['TCGHUB reviewed artwork release/1.0'] * 3)
        self.assertEqual([call.args[0] for call in backoff.call_args_list], [0.5, 1.0])
        self.assertFalse(stop.is_set())

    def test_pacing_wait_and_queued_worker_stop_without_new_requests(self):
        clock = PacingClock()
        entered = threading.Event()

        class InterruptedStop(PacingStop):
            def wait(self, delay):
                self.waits.append(delay)
                entered.set()
                return self.event.wait(timeout=5)

        stop = InterruptedStop(clock)
        pacer = target.RequestPacer()
        request = target.urllib.request.Request(self.fixture.row['imageSourceUrl'])
        with patch.object(target.time, 'monotonic', side_effect=clock.monotonic):
            with patch.object(target.urllib.request, 'urlopen', return_value=object()) as open_url:
                pacer.open(request, stop)
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    waiting = pool.submit(pacer.open, request, stop)
                    queued = None
                    try:
                        self.assertTrue(entered.wait(timeout=5))
                        queued = pool.submit(pacer.open, request, stop)
                    finally:
                        stop.set()
                    for future in (waiting, queued):
                        with self.assertRaisesRegex(RuntimeError, 'circuit is open'):
                            future.result(timeout=5)
                self.assertEqual(open_url.call_count, 1)
        self.assertEqual(stop.waits, [0.25])

    def test_denial_closes_circuit_before_other_workers_can_start(self):
        for status in (403, 429):
            with self.subTest(status=status):
                stop = threading.Event()
                pacer = target.RequestPacer()
                barrier = threading.Barrier(4)
                request = target.urllib.request.Request(self.fixture.row['imageSourceUrl'])
                error = urllib.error.HTTPError(request.full_url, status, 'blocked', {}, None)

                def worker():
                    barrier.wait(timeout=5)
                    try:
                        pacer.open(request, stop)
                    except (RuntimeError, urllib.error.HTTPError) as failure:
                        return type(failure)
                    raise AssertionError('Denied source unexpectedly completed')

                with patch.object(target.urllib.request, 'urlopen', side_effect=error) as open_url:
                    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
                        failures = list(pool.map(lambda _: worker(), range(4)))
                self.assertEqual(failures.count(urllib.error.HTTPError), 1)
                self.assertEqual(failures.count(RuntimeError), 3)
                self.assertTrue(stop.is_set())
                self.assertEqual(open_url.call_count, 1)

    def test_materialization_shares_one_pacer_for_all_downloads(self):
        rows = []
        cards = []
        for ident in ('29518', '29519', '29520'):
            row = {**self.fixture.row, 'sourceId': ident,
                   'sourceUrl': self.fixture.row['sourceUrl'].replace('29518', ident),
                   'localImage': self.fixture.row['localImage'].replace('29518', ident)}
            rows.append(row)
            cards.append({**self.fixture.card, 'url': row['sourceUrl']})
        self.fixture.review['images'] = rows
        self.fixture.save_review()
        self.fixture.write('data/cards-by-set/Neo1.json',
                           {'brand': 'pokemon', 'code': 'Neo1', 'cards': cards})
        self.fixture.write(target.CATALOGUE, {'cards': [
            {**card, 'boxCode': 'Neo1', 'sourceUrl': card['url']} for card in cards]})
        seen = []
        seen_lock = threading.Lock()

        def download(row, stop, pacer):
            with seen_lock:
                seen.append((stop, pacer))
            return self.fixture.body

        with patch.object(target, 'download_asset', side_effect=download):
            target.run(self.root, workers=4)
        self.assertEqual(len(seen), 3)
        self.assertIsInstance(seen[0][1], target.RequestPacer)
        self.assertTrue(all(stop is seen[0][0] and pacer is seen[0][1] for stop, pacer in seen))

    def test_only_exact_officially_reviewed_pt1_metadata_correction_is_applied(self):
        row = {**self.fixture.row, 'setCode': 'Pt1', 'sourceId': '26775',
               'sourceUrl': 'https://www.tcgcollector.com/cards/26775/pluspower-galactics-conquest-084-096',
               'sourceName': target.PT1_METADATA_REPAIR['correctedName'],
               'originalSourceName': target.PT1_METADATA_REPAIR['originalName'],
               'metadataRepair': copy.deepcopy(target.PT1_METADATA_REPAIR),
               'localImage': '/images/pokemon-vintage/Pt1/tcg-26775.webp'}
        self.fixture.review['images'] = [row]
        self.fixture.save_review()
        card = {**self.fixture.card, 'name': target.PT1_METADATA_REPAIR['originalName'],
                'url': row['sourceUrl'], 'number': '084/096'}
        self.fixture.write('data/cards-by-set/Pt1.json', {'brand': 'pokemon', 'code': 'Pt1', 'cards': [card]})
        self.fixture.write(target.CATALOGUE, {'cards': [{**card, 'boxCode': 'Pt1', 'sourceUrl': row['sourceUrl']}]})
        with patch.object(target, 'download_asset', return_value=self.fixture.body):
            target.run(self.root)
        current = target.read_json(self.root / 'data/cards-by-set/Pt1.json')['cards'][0]
        self.assertEqual(current['name'], target.PT1_METADATA_REPAIR['correctedName'])
        self.assertEqual(current['rarity'], 'C')
        self.assertEqual(current['image'], self.fixture.card['image'])
        self.assertEqual(current['metadataRepair'], target.PT1_METADATA_REPAIR)
        target.run(self.root, validate_only=True)


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='vintage-publication-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.remote, self.writer, self.runner = [self.root / value for value in ('remote.git', 'writer', 'runner')]
        self.writer.mkdir()
        self.git(self.root, 'init', '--bare', str(self.remote))
        self.git(self.writer, 'init', '-b', 'main')
        self.git(self.writer, 'config', 'user.name', 'Fixture')
        self.git(self.writer, 'config', 'user.email', 'fixture@example.invalid')
        self.fixture = Fixture(self.writer)
        (self.writer / 'notes.txt').write_text('original')
        self.git(self.writer, 'add', '.')
        self.git(self.writer, 'commit', '-m', 'Fixture baseline')
        self.git(self.writer, 'remote', 'add', 'origin', str(self.remote))
        self.git(self.writer, 'push', '-u', 'origin', 'main')
        self.git(self.root, 'clone', '--branch', 'main', str(self.remote), str(self.runner))
        self.base = self.git(self.runner, 'rev-parse', 'HEAD')
        with patch.object(target, 'download_asset', return_value=self.fixture.body):
            target.run(self.runner)

    def git(self, root, *args):
        result = subprocess.run(['git', '-c', 'safe.directory=*', '-C', str(root), *args],
                                capture_output=True, text=True, encoding='utf-8', errors='replace')
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def publish(self, files=None):
        env = {'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'safe.directory', 'GIT_CONFIG_VALUE_0': '*'}
        with patch.dict(os.environ, env):
            return publisher.publish(self.runner, self.base, files or publisher.vintage_release_files(self.runner, self.base),
                                     'Verified vintage fixture', vintage=True, temp_parent=self.root)

    def advance(self, name, content):
        (self.writer / name).write_text(content, encoding='utf-8')
        self.git(self.writer, 'add', '--', name)
        self.git(self.writer, 'commit', '-m', 'Concurrent fixture update')
        self.git(self.writer, 'push', 'origin', 'main')

    def test_current_main_unrelated_changes_survive_full_generation_publication(self):
        self.advance('notes.txt', 'new user-owned value')
        result = self.publish()
        self.assertEqual(result['status'], 'published')
        self.assertEqual(self.git(self.root, '--git-dir', str(self.remote), 'show', 'refs/heads/main:notes.txt'), 'new user-owned value')
        self.assertEqual(len(result['files']), 4)
        self.assertEqual(self.git(self.runner, 'rev-parse', 'HEAD'), self.base)

    def test_concurrent_rarity_change_on_target_inventory_stops_publication(self):
        doc = target.read_json(self.writer / 'data/cards-by-set/Neo1.json')
        doc['cards'][0]['rarity'] = 'R'
        self.advance('data/cards-by-set/Neo1.json', json.dumps(doc))
        with self.assertRaisesRegex(publisher.PublicationError, 'target files changed'):
            self.publish()
        current = self.git(self.root, '--git-dir', str(self.remote), 'show', 'refs/heads/main:data/cards-by-set/Neo1.json')
        self.assertEqual(json.loads(current)['cards'][0]['rarity'], 'R')

    def test_incomplete_or_unrelated_file_selection_is_rejected(self):
        files = publisher.vintage_release_files(self.runner, self.base)
        for choice in (files[:-1], files + ['notes.txt'], files + [files[0]]):
            with self.subTest(choice=choice):
                with self.assertRaisesRegex(publisher.PublicationError, 'output selection changed'):
                    self.publish(choice)


if __name__ == '__main__':
    unittest.main()
