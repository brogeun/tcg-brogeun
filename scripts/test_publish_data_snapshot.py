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


if __name__ == '__main__':
    unittest.main()
