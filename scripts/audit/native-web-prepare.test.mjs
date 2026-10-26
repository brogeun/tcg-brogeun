import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
async function fixture(run, { existingWWW = true } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'tcghub-native-web-test-'));
  const root = join(base, 'project'), outside = join(base, 'outside');
  try {
    await mkdir(join(root, 'scripts/native'), { recursive: true });
    await mkdir(outside);
    await copyFile(join(repo, 'scripts/native/prepare-hosted-web.mjs'), join(root, 'scripts/native/prepare-hosted-web.mjs'));
    await writeFile(join(root, 'capacitor.config.json'), JSON.stringify({ appId: 'kr.tcghub.app',
      appName: 'TCG Hub', webDir: 'www', server: { url: 'https://tcghub.kr', cleartext: false } }));
    await writeFile(join(root, 'index.html'), '<!doctype html><title>current source one</title>');
    if (existingWWW) {
      await mkdir(join(root, 'www'));
      await writeFile(join(root, 'www/index.html'), '<!doctype html><title>original tracked web</title>');
    }
    const prepare = () => exec(process.execPath, [join(root, 'scripts/native/prepare-hosted-web.mjs')], { cwd: root });
    await run({ root, outside, prepare });
  } finally {
    const target = resolve(base), parent = resolve(tmpdir());
    assert(target.startsWith(parent + sep) && basename(target).startsWith('tcghub-native-web-test-'));
    await rm(target, { recursive: true, force: true });
  }
}

test('Android then iOS preparation can repeat while preserving the first original web backup', async () => fixture(async ({ root, prepare }) => {
  for (const name of ['assets', 'images', 'games']) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, 'payload-marker.txt'), 'hosted source payload');
  }
  await writeFile(join(root, 'assets/screen.css'), 'body{color:black}');
  await writeFile(join(root, 'www/user-kept.txt'), 'keep unknown webDir files');
  const original = await readFile(join(root, 'www/index.html'));
  await prepare();
  assert.deepEqual(await readFile(join(root, 'native-evidence/preexisting-web/index.html')), original);
  for (const name of ['assets', 'images', 'games']) {
    await assert.rejects(readFile(join(root, 'www', name, 'payload-marker.txt')), { code: 'ENOENT' });
  }
  await writeFile(join(root, 'index.html'), '<!doctype html><title>current source two</title>');
  await writeFile(join(root, 'assets/screen.css'), 'body{color:blue}');
  const second = JSON.parse((await prepare()).stdout);
  assert.equal(second.reusedExistingBackup, true);
  assert.deepEqual(await readFile(join(root, 'www/index.html')), await readFile(join(root, 'index.html')));
  assert.equal(second.localAssetsBundled, false);
  assert.deepEqual(second.preparedFiles, ['index.html', 'native-source-evidence.json']);
  await assert.rejects(readFile(join(root, 'www/assets/screen.css')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'www/user-kept.txt'), 'utf8'), 'keep unknown webDir files');
  assert.equal(await readFile(join(root, 'native-evidence/preexisting-web/user-kept.txt'), 'utf8'), 'keep unknown webDir files');
  assert.deepEqual(await readFile(join(root, 'native-evidence/preexisting-web/index.html')), original);
  await prepare();
  assert.deepEqual(await readFile(join(root, 'native-evidence/preexisting-web/index.html')), original);
}));

test('a checkout without www also supports successive source preparations', async () => fixture(async ({ root, prepare }) => {
  await prepare();
  const first = await readFile(join(root, 'www/index.html'));
  await writeFile(join(root, 'index.html'), '<!doctype html><title>source after first build</title>');
  await prepare();
  assert.deepEqual(await readFile(join(root, 'native-evidence/preexisting-web/index.html')), first);
  assert.deepEqual(await readFile(join(root, 'www/index.html')), await readFile(join(root, 'index.html')));
}, { existingWWW: false }));

test('a www symlink is rejected before writing outside the checkout', async () => fixture(async ({ root, outside, prepare }) => {
  await writeFile(join(outside, 'index.html'), 'outside sentinel');
  await symlink(outside, join(root, 'www'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepare(), /native webDir.*ordinary directory/);
  assert.equal(await readFile(join(outside, 'index.html'), 'utf8'), 'outside sentinel');
}, { existingWWW: false }));

test('a native-evidence symlink is rejected before backing up outside the checkout', async () => fixture(async ({ root, outside, prepare }) => {
  await symlink(outside, join(root, 'native-evidence'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepare(), /Native evidence.*ordinary directory/);
  assert.equal(await readFile(join(root, 'www/index.html'), 'utf8'), '<!doctype html><title>original tracked web</title>');
}));

test('an existing backup symlink is rejected instead of reused or overwritten', async () => fixture(async ({ root, outside, prepare }) => {
  await mkdir(join(root, 'native-evidence'));
  await writeFile(join(outside, 'index.html'), 'outside backup sentinel');
  await symlink(outside, join(root, 'native-evidence/preexisting-web'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(prepare(), /original native web backup.*ordinary directory/);
  assert.equal(await readFile(join(outside, 'index.html'), 'utf8'), 'outside backup sentinel');
}));

test('an existing non-directory backup is rejected without overwriting the first web source', async () => fixture(async ({ root, prepare }) => {
  await mkdir(join(root, 'native-evidence'));
  await writeFile(join(root, 'native-evidence/preexisting-web'), 'keep original backup file');
  await assert.rejects(prepare(), /original native web backup.*ordinary directory/);
  assert.equal(await readFile(join(root, 'native-evidence/preexisting-web'), 'utf8'), 'keep original backup file');
  assert.equal(await readFile(join(root, 'www/index.html'), 'utf8'), '<!doctype html><title>original tracked web</title>');
}));
