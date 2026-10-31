"""Real local Git-remote checks; no network or production repository writes."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import publish_data_snapshot as target


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='snapshot-publication-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.remote, self.writer, self.runner = [self.root / name for name in ('remote.git', 'writer', 'runner')]
        self.writer.mkdir()
        self.git(self.root, 'init', '--bare', str(self.remote))
        self.git(self.writer, 'init', '-b', 'main')
        self.git(self.writer, 'config', 'user.name', 'Fixture')
        self.git(self.writer, 'config', 'user.email', 'fixture@example.invalid')
        (self.writer / 'data').mkdir()
        self.files = sorted(target.ALLOWED - {'data/chinese-market.json'})
        for name in self.files:
            (self.writer / name).write_text('{"old":true}', encoding='utf-8')
        (self.writer / 'notes.txt').write_text('original', encoding='utf-8')
        self.git(self.writer, 'add', '.')
        self.git(self.writer, 'commit', '-m', 'Fixture baseline')
        self.git(self.writer, 'remote', 'add', 'origin', str(self.remote))
        self.git(self.writer, 'push', '-u', 'origin', 'main')
        self.git(self.root, 'clone', '--branch', 'main', str(self.remote), str(self.runner))
        self.base = self.git(self.runner, 'rev-parse', 'HEAD')
        for name in self.files:
            (self.runner / name).write_text('{"verified":true}', encoding='utf-8')

    def test_official_assets_require_reviewed_hash_and_exclude_other_paths(self):
        import hashlib
        (self.runner / 'config').mkdir()
        (self.runner / 'images/onepiece-official').mkdir(parents=True)
        image = 'images/onepiece-official/OP01-001.webp'
        (self.runner / image).write_bytes(b'reviewed image fixture')
        record = {'image': '/' + image, 'sha256': hashlib.sha256(b'reviewed image fixture').hexdigest()}
        for name, value in [('onepiece-local-artworks.json', {'OP01-001': record}), ('onepiece-product-images.json', {})]:
            (self.runner / 'config' / name).write_text(json.dumps(value), encoding='utf-8')
        (self.runner / 'data/onepiece-official-manifest.json').write_text('{"sets":[]}', encoding='utf-8')
        selected = target.official_release_files(self.runner, self.base)
        self.assertIn(image, selected)
        self.assertNotIn('notes.txt', selected)
        (self.runner / image).write_bytes(b'unreviewed replacement')
        with self.assertRaises(target.PublicationError):
            target.official_release_files(self.runner, self.base)

    def git(self, root, *args):
        result = subprocess.run(['git', '-c', 'safe.directory=*', '-C', str(root), *args],
                                capture_output=True, text=True, encoding='utf-8', errors='replace')
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout.strip()

    def advance(self, name, content):
        (self.writer / name).write_text(content, encoding='utf-8')
        self.git(self.writer, 'add', '--', name)
        self.git(self.writer, 'commit', '-m', 'Concurrent fixture change')
        self.git(self.writer, 'push', 'origin', 'main')

    def publish(self):
        # Only these disposable fixture repos are trusted for this subprocess tree.
        env = {'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'safe.directory', 'GIT_CONFIG_VALUE_0': '*'}
        with patch.dict(os.environ, env):
            return target.publish(self.runner, self.base, self.files, 'Verified fixture snapshot',
                                  temp_parent=self.root)

    def remote_content(self, name):
        return self.git(self.root, '--git-dir', str(self.remote), 'show', 'refs/heads/main:' + name)

    def test_unrelated_new_commit_is_preserved(self):
        self.advance('notes.txt', 'new user-owned content')
        result = self.publish()
        self.assertEqual(result['status'], 'published')
        self.assertEqual(self.remote_content('notes.txt'), 'new user-owned content')
        self.assertTrue(all(json.loads(self.remote_content(name)) == {'verified': True} for name in self.files))
        self.assertEqual(self.git(self.runner, 'rev-parse', 'HEAD'), self.base)
        self.assertTrue(all((self.runner / name).read_text('utf-8') == '{"verified":true}' for name in self.files))

    def test_concurrent_target_change_is_rejected(self):
        self.advance(self.files[0], '{"user":true}')
        before = self.git(self.writer, 'rev-parse', 'HEAD')
        with self.assertRaisesRegex(target.PublicationError, 'target files changed'):
            self.publish()
        after = self.git(self.root, '--git-dir', str(self.remote), 'rev-parse', 'refs/heads/main')
        self.assertEqual(after, before)
        self.assertEqual(json.loads(self.remote_content(self.files[0])), {'user': True})

    def test_push_race_retries_without_losing_disjoint_commit(self):
        real_git = target.git
        raced = False
        def race(root, *args, **kwargs):
            nonlocal raced
            if args[0] == 'push' and not raced:
                raced = True
                self.advance('notes.txt', 'arrived immediately before push')
            return real_git(root, *args, **kwargs)
        with patch.object(target, 'git', race):
            result = self.publish()
        self.assertEqual(result['attempt'], 2)
        self.assertEqual(self.remote_content('notes.txt'), 'arrived immediately before push')

    def test_rejected_push_keeps_remote_and_stops_after_three(self):
        hook = self.remote / 'hooks/pre-receive'
        hook.write_text('#!/bin/sh\nexit 1\n', encoding='utf-8', newline='\n')
        hook.chmod(0o755)
        with self.assertRaisesRegex(target.PublicationError, 'after bounded retries'):
            self.publish()
        self.assertEqual(self.git(self.root, '--git-dir', str(self.remote), 'rev-parse', 'refs/heads/main'), self.base)
        self.assertEqual(len(list(self.root.glob('tcg-data-publication-*/attempt-*'))), 3)

    def daily_fixture(self):
        self.search = ['data/all-cards.json', 'data/cards-meta.json', 'data/cards-prices.json']
        for name in [*self.search, 'data/chinese-market.json', 'data/history/123.json',
                     'data/cards-meta-index.json', 'data/cards-meta-index/00.json']:
            path = self.writer / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('{"old":true}', encoding='utf-8')
        self.git(self.writer, 'add', 'data')
        self.git(self.writer, 'commit', '-m', 'Daily fixture baseline')
        self.git(self.writer, 'push', 'origin', 'main')
        self.runner = self.root / 'daily-runner'
        self.git(self.root, 'clone', '--branch', 'main', str(self.remote), str(self.runner))
        self.base = self.git(self.runner, 'rev-parse', 'HEAD')
        for name in self.search:
            (self.runner / name).write_text('{"verified":true}', encoding='utf-8')
        (self.runner / 'data/update-health.json').write_text('{"status":"healthy"}', encoding='utf-8')

    def publish_daily(self):
        env = {'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'safe.directory', 'GIT_CONFIG_VALUE_0': '*'}
        with patch.dict(os.environ, env):
            files = target.daily_files(self.runner, self.base)
            return target.publish(self.runner, self.base, files, 'Daily verified fixture',
                                  temp_parent=self.root, daily=True)

    def test_daily_search_and_new_health_commit_preserves_concurrent_chinese_snapshot(self):
        self.daily_fixture()
        self.advance('data/chinese-market.json', '{"newChinese":true}')
        result = self.publish_daily()
        self.assertEqual(self.remote_content('data/chinese-market.json'), '{"newChinese":true}')
        self.assertTrue(all(json.loads(self.remote_content(name)) == {'verified': True} for name in self.search))
        expected = set(self.search + ['data/update-health.json'])
        changed = set(self.git(self.root, '--git-dir', str(self.remote), 'diff-tree', '--no-commit-id', '--name-only', '-r', result['commit']).splitlines())
        self.assertEqual(changed, expected)

    def test_daily_untracked_unrelated_paths_are_not_selected(self):
        self.daily_fixture()
        ignored = ['data/unrelated-user-document.json', 'data/secrets.json', 'notes.txt',
                   'scripts/unrelated.py', 'data/cards-by-set/OTHER.json', 'data/_source-cache/raw.json']
        for name in ignored:
            path = self.runner / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('{"preserve":true}', encoding='utf-8')
        selected = target.daily_files(self.runner, self.base)
        self.assertEqual(set(selected), set(self.search + ['data/update-health.json']))
        self.publish_daily()
        self.assertEqual(self.remote_content('notes.txt'), 'original')
        for name in ignored:
            if name != 'notes.txt':
                self.assertEqual(self.git(self.root, '--git-dir', str(self.remote), 'ls-tree', 'refs/heads/main', '--', name), '')
            self.assertEqual((self.runner / name).read_text('utf-8'), '{"preserve":true}')

    def test_daily_true_history_overlap_rejects_all_outputs(self):
        self.daily_fixture()
        (self.runner / 'data/history/123.json').write_text('{"generated":true}', encoding='utf-8')
        self.advance('data/history/123.json', '{"userHistory":true}')
        with self.assertRaisesRegex(target.PublicationError, 'target files changed'):
            self.publish_daily()
        self.assertEqual(self.remote_content('data/history/123.json'), '{"userHistory":true}')
        self.assertTrue(all(self.remote_content(name) == '{"old":true}' for name in self.search))

    def test_daily_metadata_root_and_exact_buckets_publish_together(self):
        self.daily_fixture()
        generated = ['data/cards-meta-index.json', 'data/cards-meta-index/00.json',
                     'data/cards-meta-index/83.json']
        excluded = ['data/cards-meta-index/1.json', 'data/cards-meta-index/001.json',
                    'data/cards-meta-index/ab.json', 'data/cards-meta-index/config.json',
                    'data/cards-meta-index/nested/00.json']
        for name in generated + excluded:
            path = self.runner / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('{"generated":true}', encoding='utf-8')
        self.assertFalse(target.daily_path('data/cards-meta-index/../secrets.json'))
        self.assertFalse(target.daily_path(r'data\cards-meta-index\00.json'))
        self.assertEqual(set(target.daily_files(self.runner, self.base)),
                         set(self.search + ['data/update-health.json'] + generated))
        self.publish_daily()
        for name in generated:
            self.assertEqual(json.loads(self.remote_content(name)), {'generated': True})
        for name in excluded:
            self.assertEqual(self.git(self.root, '--git-dir', str(self.remote), 'ls-tree', 'refs/heads/main', '--', name), '')

    def test_daily_metadata_concurrent_bucket_change_rejects_all_outputs(self):
        self.daily_fixture()
        name = 'data/cards-meta-index/00.json'
        (self.runner / name).write_text('{"generated":true}', encoding='utf-8')
        self.advance(name, '{"userMetadata":true}')
        with self.assertRaisesRegex(target.PublicationError, 'target files changed'):
            self.publish_daily()
        self.assertEqual(self.remote_content(name), '{"userMetadata":true}')
        self.assertTrue(all(self.remote_content(path) == '{"old":true}' for path in self.search))

    def test_daily_invalid_json_fails_before_publication(self):
        self.daily_fixture()
        (self.runner / 'data/update-health.json').write_text('invalid JSON', encoding='utf-8')
        with self.assertRaises(ValueError):
            self.publish_daily()
        self.assertTrue(all(self.remote_content(name) == '{"old":true}' for name in self.search))

    def test_daily_retains_concurrent_detail_cache_and_publishes_independent_outputs(self):
        self.daily_fixture()
        name = 'data/cards-detail.json'
        (self.runner / name).write_text('{"daily":true}', encoding='utf-8')
        self.advance(name, '{"newReference":true}')
        result = self.publish_daily()
        self.assertEqual(result['status'], 'published')
        self.assertEqual(result['retainedConcurrentFiles'], [name])
        self.assertEqual(json.loads(self.remote_content(name)), {'newReference': True})
        self.assertTrue(all(json.loads(self.remote_content(path)) == {'verified': True} for path in self.search))

    def test_deploy_source_contains_latest_ui_chinese_and_published_search(self):
        self.daily_fixture()
        self.advance('data/chinese-market.json', '{"newChinese":true}')
        self.advance('index.html', '<main>New user UI</main>')
        publication = self.publish_daily()
        env = {'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'safe.directory', 'GIT_CONFIG_VALUE_0': '*'}
        with patch.dict(os.environ, env):
            result = target.prepare_deploy(self.runner, temp_parent=self.root)
        source = Path(result['source'])
        self.assertEqual(result['commit'], publication['commit'])
        self.assertEqual((source / 'index.html').read_text('utf-8'), '<main>New user UI</main>')
        self.assertEqual(json.loads((source / 'data/chinese-market.json').read_bytes()), {'newChinese': True})
        self.assertTrue(all(json.loads((source / name).read_bytes()) == {'verified': True} for name in self.search))
        self.assertEqual(self.git(self.runner, 'rev-parse', 'HEAD'), self.base)
        self.assertEqual((self.runner / 'data/chinese-market.json').read_text('utf-8'), '{"old":true}')
        self.assertTrue(all((self.runner / name).read_text('utf-8') == '{"verified":true}' for name in self.search))

    def reference_fixture(self):
        self.reference_targets = ['data/us-market.json', 'data/us-market/pokemon/base.json',
                                  'data/yuyutei-market.json', 'data/mercari-references.json']
        for name in self.reference_targets:
            path = self.writer / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('{"oldReference":true}', encoding='utf-8')
        self.git(self.writer, 'add', '--', *self.reference_targets)
        self.git(self.writer, 'commit', '-m', 'Reference fixture baseline')
        self.git(self.writer, 'push', 'origin', 'main')
        self.runner = self.root / 'reference-runner'
        self.git(self.root, 'clone', '--branch', 'main', str(self.remote), str(self.runner))
        self.base = self.git(self.runner, 'rev-parse', 'HEAD')
        for name in self.reference_targets:
            (self.runner / name).write_text('{"reference":true}', encoding='utf-8')

    def publish_references(self):
        env = {'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'safe.directory', 'GIT_CONFIG_VALUE_0': '*'}
        with patch.dict(os.environ, env):
            files = target.reference_files(self.runner, self.base)
            return target.publish(self.runner, self.base, files, 'Reference fixture snapshot',
                                  temp_parent=self.root, references=True)

    def test_references_publish_preserves_unrelated_new_main_and_dirty_worktree(self):
        self.reference_fixture()
        self.advance('notes.txt', 'latest unrelated user edit')
        (self.runner / self.files[0]).write_text('{"localUnrelated":true}', encoding='utf-8')
        result = self.publish_references()
        self.assertEqual(result['status'], 'published')
        self.assertEqual(self.remote_content('notes.txt'), 'latest unrelated user edit')
        self.assertTrue(all(json.loads(self.remote_content(name)) == {'reference': True} for name in self.reference_targets))
        self.assertEqual(json.loads(self.remote_content(self.files[0])), {'old': True})
        self.assertEqual(json.loads((self.runner / self.files[0]).read_bytes()), {'localUnrelated': True})
        self.assertEqual(self.git(self.runner, 'rev-parse', 'HEAD'), self.base)

    def test_references_reject_concurrent_target_change_without_any_publication(self):
        self.reference_fixture()
        self.advance('data/us-market.json', '{"userReference":true}')
        before = self.git(self.writer, 'rev-parse', 'HEAD')
        with self.assertRaisesRegex(target.PublicationError, 'target files changed'):
            self.publish_references()
        self.assertEqual(self.git(self.root, '--git-dir', str(self.remote), 'rev-parse', 'refs/heads/main'), before)
        self.assertEqual(self.remote_content('data/us-market.json'), '{"userReference":true}')
        self.assertEqual(self.remote_content('data/mercari-references.json'), '{"oldReference":true}')

    def test_references_select_only_explicit_generated_roots_and_files(self):
        self.reference_fixture()
        allowed = ['data/us-market/digimon/new-set.json', 'data/yuyutei-market/weiss/cards.json',
                   'data/snkrdunk-games.json', 'data/price-weiss_schwarz-card.json',
                   'data/snkrdunk-history/123.json', 'data/reference-market-health.json',
                   'data/cards-meta-index.json', 'data/cards-meta-index/00.json',
                   'data/cards-meta-index/83.json', 'data/snkrdunk-games/weiss_schwarz-card-0000.json',
                   'data/snkrdunk-games/digimon-box-12.json']
        excluded = ['data/mercari-reference-watchlist.json', 'data/us-market-watchlist.json',
                    'data/unrelated-user-document.json', 'data/secrets.json',
                    'data/us-market/credentials.local.json', 'data/us-market/private-key.json',
                    'data/price-pokemon-card.json', 'data/snkrdunk-history/not-numeric.json',
                    'data/us-market/watchlist.json', 'data/yuyutei-market/config.json',
                    'data/snkrdunk-games/pokemon-card-1.json', 'data/snkrdunk-games/unknown-box-1.json',
                    'data/snkrdunk-games/config.json', 'data/cards-meta-index/config.json',
                    'data/cards-meta-index/1.json', 'data/cards-meta-index/001.json',
                    'data/cards-meta-index/ab.json', 'data/cards-meta-index/nested/83.json',
                    'scripts/not-data.json']
        for name in allowed + excluded:
            path = self.runner / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text('{"new":true}', encoding='utf-8')
        self.assertEqual(set(target.reference_files(self.runner, self.base)), set(self.reference_targets + allowed))
        self.publish_references()
        for name in allowed:
            self.assertEqual(json.loads(self.remote_content(name)), {'new': True})
        for name in excluded:
            self.assertEqual(self.git(self.root, '--git-dir', str(self.remote), 'ls-tree', 'refs/heads/main', '--', name), '')
            self.assertTrue((self.runner / name).exists())

    def test_references_reject_deletion_and_symlink_ancestor(self):
        self.reference_fixture()
        (self.runner / 'data/us-market.json').unlink()
        with self.assertRaisesRegex(target.PublicationError, 'deletions are not published'):
            target.reference_files(self.runner, self.base)
        (self.runner / 'data/us-market.json').write_text('{"reference":true}', encoding='utf-8')
        original_is_symlink = Path.is_symlink
        def simulated_symlink(path):
            return path == self.runner / 'data/us-market' or original_is_symlink(path)
        with patch.object(Path, 'is_symlink', simulated_symlink):
            with self.assertRaisesRegex(target.PublicationError, 'symlinks'):
                target.reference_files(self.runner, self.base)

    def card_info_fixture(self):
        self.reference_fixture()
        self.card_manifest = target.CARD_INFO_MANIFEST
        self.card_set = 'data/tcg-card-info/weiss_schwarz/0a1b2c3d4e5f6789.json'
        self.card_part = 'data/tcg-card-info/weiss_schwarz/0a1b2c3d4e5f6789-part02.json'
        self.card_unused = 'data/tcg-card-info/weiss_schwarz/1111111111111111.json'
        values = {
            self.card_manifest: {'games':[{'id':'weiss_schwarz','sets':[{'id':'0a1b2c3d4e5f6789','file':'/'+self.card_set}]}]},
            self.card_set: {'cards':[{'id':'472683'}],'shards':['/'+self.card_part]},
            self.card_part: {'cards':[{'id':'472684'}]},
            self.card_unused: {'cards':[{'id':'old-retained'}]},
        }
        for name, value in values.items():
            path = self.writer/name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(value),encoding='utf-8')
        self.git(self.writer,'add','--',*values)
        self.git(self.writer,'commit','-m','Compact card info fixture')
        self.git(self.writer,'push','origin','main')
        self.runner = self.root/'card-info-runner'
        self.git(self.root,'clone','--branch','main',str(self.remote),str(self.runner))
        self.base = self.git(self.runner,'rev-parse','HEAD')

    def change_card_info_set(self):
        (self.runner/self.card_set).write_text(json.dumps({'cards':[{'id':'new'}],'shards':['/'+self.card_part]}),encoding='utf-8')

    def publish_card_info(self):
        env = {'GIT_CONFIG_COUNT':'1','GIT_CONFIG_KEY_0':'safe.directory','GIT_CONFIG_VALUE_0':'*'}
        with patch.dict(os.environ,env):
            return target.publish(self.runner,self.base,[self.card_manifest],'Compact catalog fixture',temp_parent=self.root)

    def test_card_info_catalog_is_whitelisted_and_published_as_complete_active_group(self):
        self.card_info_fixture()
        self.change_card_info_set()
        self.assertEqual(set(target.reference_files(self.runner,self.base)),{self.card_manifest,self.card_set,self.card_part})
        self.advance('notes.txt','concurrent unrelated edit retained')
        result = self.publish_references()
        self.assertEqual(result['status'],'published')
        self.assertEqual(json.loads(self.remote_content(self.card_set))['cards'],[{'id':'new'}])
        self.assertEqual(json.loads(self.remote_content(self.card_part))['cards'],[{'id':'472684'}])
        self.assertEqual(json.loads(self.remote_content(self.card_unused))['cards'],[{'id':'old-retained'}])
        self.assertEqual(self.remote_content('notes.txt'),'concurrent unrelated edit retained')

    def test_card_info_unchanged_part_is_protected_from_concurrent_catalog_edit(self):
        self.card_info_fixture()
        self.change_card_info_set()
        self.advance(self.card_part,'{"cards":[{"id":"user-edited"}]}')
        with self.assertRaisesRegex(target.PublicationError,'target files changed'):
            self.publish_references()
        self.assertEqual(json.loads(self.remote_content(self.card_part))['cards'],[{'id':'user-edited'}])
        self.assertEqual(json.loads(self.remote_content(self.card_set))['cards'],[{'id':'472683'}])

    def test_card_info_rejects_missing_or_unsafe_declared_parts_before_any_publication(self):
        self.card_info_fixture()
        for url in ['/'+self.card_part.replace('part02','part03'),
                    '/data/tcg-card-info/weiss_schwarz/../../secrets.json',
                    '/data/tcg-card-info/yugioh/0a1b2c3d4e5f6789-part02.json']:
            with self.subTest(url=url):
                (self.runner/self.card_set).write_text(json.dumps({'cards':[],'shards':[url]}),encoding='utf-8')
                with self.assertRaises(target.PublicationError):
                    self.publish_references()
                self.assertEqual(json.loads(self.remote_content(self.card_set))['cards'],[{'id':'472683'}])
        self.assertEqual(list(self.root.glob('tcg-data-publication-*')),[])

    def test_card_info_path_allows_only_builder_games_and_exact_hash_keys(self):
        for game in target.CARD_INFO_GAMES:
            self.assertTrue(target.reference_path('data/tcg-card-info/'+game+'/0a1b2c3d4e5f6789.json'))
            self.assertTrue(target.reference_path('data/tcg-card-info/'+game+'/0a1b2c3d4e5f6789-part02.json'))
        for name in ['data/tcg-card-info/pokemon/0a1b2c3d4e5f6789.json',
                     'data/tcg-card-info/weiss/0a1b2c3d4e5f6789.json',
                     'data/tcg-card-info/nikke/config.json',
                     'data/tcg-card-info/nikke/../../secrets.json',
                     'data/tcg-card-info/nikke/0A1B2C3D4E5F6789.json',
                     'data/tcg-card-info/nikke/0a1b2c3d4e5f6789-part2.json',
                     'data/tcg-card-info/nikke/0a1b2c3d4e5f6789/nested.json',
                     r'data\tcg-card-info\nikke\0a1b2c3d4e5f6789.json']:
            self.assertFalse(target.reference_path(name),name)

    def test_explicit_manifest_bootstrap_expands_group_and_daily_excludes_catalog(self):
        self.card_info_fixture()
        self.change_card_info_set()
        path = self.runner/self.card_manifest
        manifest = json.loads(path.read_bytes())
        manifest['generatedAt'] = 'new-bootstrap'
        path.write_text(json.dumps(manifest),encoding='utf-8')
        self.assertFalse(target.daily_path(self.card_manifest))
        self.assertFalse(target.daily_path(self.card_set))
        self.assertEqual(target.daily_files(self.runner,self.base),[])
        result = self.publish_card_info()
        self.assertEqual(result['status'],'published')
        self.assertEqual(set(result['files']),{self.card_manifest,self.card_set,self.card_part})
        self.assertEqual(json.loads(self.remote_content(self.card_set))['cards'],[{'id':'new'}])
        self.assertEqual(json.loads(self.remote_content(self.card_manifest))['generatedAt'],'new-bootstrap')
        self.assertEqual(json.loads(self.remote_content(self.card_unused))['cards'],[{'id':'old-retained'}])

    def test_explicit_manifest_bootstrap_rejects_concurrent_unchanged_part(self):
        self.card_info_fixture()
        self.change_card_info_set()
        self.advance(self.card_part,'{"cards":[{"id":"concurrent-part"}]}')
        with self.assertRaisesRegex(target.PublicationError,'target files changed'):
            self.publish_card_info()
        self.assertEqual(json.loads(self.remote_content(self.card_set))['cards'],[{'id':'472683'}])
        self.assertEqual(json.loads(self.remote_content(self.card_part))['cards'],[{'id':'concurrent-part'}])

    def test_references_validate_json_before_creating_publication_worktree(self):
        self.reference_fixture()
        for invalid in ('invalid JSON', '{"price":NaN}'):
            (self.runner / 'data/us-market.json').write_text(invalid, encoding='utf-8')
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                self.publish_references()
        self.assertEqual(list(self.root.glob('tcg-data-publication-*')), [])
        self.assertEqual(self.remote_content('data/us-market.json'), '{"oldReference":true}')

    def test_references_reject_selection_change_or_arbitrary_explicit_file(self):
        self.reference_fixture()
        selected = target.reference_files(self.runner, self.base)
        (self.runner / 'data/snkrdunk-games.json').write_text('{"new":true}', encoding='utf-8')
        with self.assertRaisesRegex(target.PublicationError, 'selection changed'):
            target.publish(self.runner, self.base, selected, 'Fixture', temp_parent=self.root, references=True)
        with self.assertRaisesRegex(target.PublicationError, 'selection changed'):
            target.publish(self.runner, self.base, ['data/secrets.json'], 'Fixture', temp_parent=self.root, references=True)

    def test_reference_path_rejects_traversal_secrets_and_unsupported_outputs(self):
        allowed = ['data/us-market.json', 'data/mercari-references.json',
                   'data/us-market/pokemon/group-123.json', 'data/yuyutei-market/weiss/quote.json',
                   'data/price-dragon_ball_fusion_world-box.json', 'data/snkrdunk-games.json',
                   'data/all-cards.json', 'data/cards-detail.json', 'data/snkrdunk-history/123.json',
                   'data/reference-market-health.json', 'data/cards-meta-index.json',
                   'data/cards-meta-index/00.json', 'data/cards-meta-index/01.json', 'data/cards-meta-index/99.json',
                   'data/snkrdunk-games/union_arena-card-0000.json', 'data/snkrdunk-games/dragon_ball_fusion_world-box-2.json']
        forbidden = ['data/us-market/../secrets.json', 'data/us-market/../../scripts/out.json',
                     'data/us-market/.env.json', 'data/us-market/secrets.prod.json',
                     'data/us-market/credentials.json', 'data/us-market/tokens.json',
                     'data/us-market/price.json/../../../secrets.json',
                     r'data\us-market\out.json', '/data/us-market/out.json',
                     'data/mercari-reference-watchlist.json', 'data/us-market/source-config.json',
                     'data/yuyutei-market/catalog-watchlist.json', 'data/us-market/config/products.json',
                     'data/price-unknown-card.json', 'data/snkrdunk-history/not-numeric.json',
                     'data/snkrdunk-games/pokemon-card-1.json', 'data/snkrdunk-games/weiss-card-1.json',
                     'data/snkrdunk-games/digimon-card--1.json', 'data/snkrdunk-games/digimon-card-../secrets.json',
                     'data/snkrdunk-games/nested/digimon-card-1.json', 'data/snkrdunk-games/config.json',
                     'data/cards-meta-index/../secrets.json', 'data/cards-meta-index/00/../../secrets.json',
                     'data/cards-meta-index/nested/00.json', 'data/cards-meta-index/.00.json',
                     'data/cards-meta-index/0.json', 'data/cards-meta-index/000.json',
                     'data/cards-meta-index/0a.json', 'data/cards-meta-index/00.JSON',
                     r'data\cards-meta-index\00.json', 'data/cards-meta-index/config.json']
        self.assertTrue(all(target.reference_path(name) for name in allowed))
        self.assertTrue(all(not target.reference_path(name) for name in forbidden))

    def test_references_with_no_changes_is_a_noop(self):
        self.reference_fixture()
        for name in self.reference_targets:
            (self.runner / name).write_text('{"oldReference":true}', encoding='utf-8')
        result = self.publish_references()
        self.assertEqual(result['status'], 'unchanged')
        self.assertEqual(result['files'], [])

    def reference_group_fixture(self):
        self.reference_fixture()
        self.reference_search = sorted(target.REFERENCE_SEARCH_FILES)
        for name in self.reference_search:
            (self.writer / name).write_text('{"legacy":true,"unknownBrand":{"preserve":true}}', encoding='utf-8')
        self.git(self.writer, 'add', '--', *self.reference_search)
        self.git(self.writer, 'commit', '-m', 'Atomic reference search baseline')
        self.git(self.writer, 'push', 'origin', 'main')
        self.runner = self.root / 'reference-group-runner'
        self.git(self.root, 'clone', '--branch', 'main', str(self.remote), str(self.runner))
        self.base = self.git(self.runner, 'rev-parse', 'HEAD')
        (self.runner / 'data/cards-prices.json').write_text('{"legacy":true,"unknownBrand":{"preserve":true},"quote":123}', encoding='utf-8')

    def test_reference_shared_search_selects_and_checks_complete_group(self):
        self.reference_group_fixture()
        self.assertEqual(set(target.reference_files(self.runner, self.base)), set(self.reference_search))
        result = self.publish_references()
        self.assertEqual(set(result['files']), set(self.reference_search))
        self.assertEqual(json.loads(self.remote_content('data/cards-prices.json'))['quote'], 123)
        for name in self.reference_search:
            content = json.loads(self.remote_content(name))
            self.assertTrue(content['legacy'])
            self.assertEqual(content['unknownBrand'], {'preserve': True})
        changed = self.git(self.root, '--git-dir', str(self.remote), 'diff-tree', '--no-commit-id', '--name-only', '-r', result['commit']).splitlines()
        self.assertEqual(changed, ['data/cards-prices.json'])

    def test_reference_shared_unchanged_group_member_concurrent_edit_rejects_all(self):
        self.reference_group_fixture()
        self.advance('data/cards-meta.json', '{"userMeta":true}')
        before = self.git(self.writer, 'rev-parse', 'HEAD')
        with self.assertRaisesRegex(target.PublicationError, 'target files changed'):
            self.publish_references()
        self.assertEqual(self.git(self.root, '--git-dir', str(self.remote), 'rev-parse', 'refs/heads/main'), before)
        self.assertEqual(self.remote_content('data/cards-meta.json'), '{"userMeta":true}')
        self.assertNotIn('quote', json.loads(self.remote_content('data/cards-prices.json')))

    def test_reference_shared_group_missing_member_is_rejected(self):
        self.reference_group_fixture()
        (self.runner / 'data/cards-meta.json').unlink()
        with self.assertRaisesRegex(target.PublicationError, 'deletions are not published'):
            target.reference_files(self.runner, self.base)


if __name__ == '__main__':
    unittest.main()
