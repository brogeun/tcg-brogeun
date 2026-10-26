import assert from 'node:assert/strict';
import { test } from 'node:test';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { hardenNativeSocialLogin } from '../native/harden-social-login-logging.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const spec = JSON.parse(await readFile(join(repo, 'scripts/native/social-login-log-patch.json'), 'utf8'));
const hash = value => createHash('sha256').update(value).digest('hex');
const exec = promisify(execFile);
let original = await readFile(join(repo, 'node_modules', spec.package, spec.relativeSource), 'utf8');
if (hash(original) === spec.patchedSHA256) {
  for (const item of spec.replacements) original = original.replace(item.to, item.from);
}
assert.equal(hash(original), spec.originalSHA256, 'npm ci must provide the reviewed SDK before these tests run');

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'tcghub-native-log-test-'));
  const packageRoot = join(root, 'node_modules', spec.package);
  const source = join(packageRoot, spec.relativeSource);
  try {
    await mkdir(dirname(source), { recursive: true });
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ version: spec.version }));
    await writeFile(join(root, 'package-lock.json'), JSON.stringify({ packages: {
      ['node_modules/' + spec.package]: { version: spec.version },
    } }));
    await writeFile(source, original);
    await run({ root, packageRoot, source });
  } finally {
    const target = resolve(root), parent = resolve(tmpdir());
    assert(target.startsWith(parent + sep) && basename(target).startsWith('tcghub-native-log-test-'));
    await rm(target, { recursive: true, force: true });
  }
}

test('the exact SDK patch removes only the three reviewed Apple token log statements', async () => fixture(async ({ root, source }) => {
  const result = await hardenNativeSocialLogin(root);
  assert.equal(result.status, 'hardened');
  const after = await readFile(source, 'utf8');
  assert.equal(hash(after), spec.patchedSHA256);
  let expected = original;
  for (const item of spec.replacements) {
    expected = expected.replace(item.from, item.to);
    assert(!after.includes(item.from));
  }
  assert.equal(after, expected);
}));

test('running the native patch again leaves the reviewed source unchanged', async () => fixture(async ({ root, source }) => {
  await hardenNativeSocialLogin(root);
  const before = await readFile(source);
  assert.equal((await hardenNativeSocialLogin(root)).status, 'already-hardened');
  assert.deepEqual(await readFile(source), before);
}));

test('an unknown SDK source hash fails without changing that source', async () => fixture(async ({ root, source }) => {
  await writeFile(source, original + '\n// unreviewed source\n');
  const before = await readFile(source);
  await assert.rejects(hardenNativeSocialLogin(root), /Unrecognized AppleProvider source hash/);
  assert.deepEqual(await readFile(source), before);
}));

test('a different installed SDK version fails without applying the old patch', async () => fixture(async ({ root, packageRoot, source }) => {
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ version: '8.3.23' }));
  await assert.rejects(hardenNativeSocialLogin(root), /requires the reviewed SocialLogin version/);
  assert.equal(await readFile(source, 'utf8'), original);
}));

test('a different lockfile version also refuses the old native patch', async () => fixture(async ({ root, source }) => {
  await writeFile(join(root, 'package-lock.json'), JSON.stringify({ packages: {
    ['node_modules/' + spec.package]: { version: '8.3.23' },
  } }));
  await assert.rejects(hardenNativeSocialLogin(root), /requires the reviewed SocialLogin version/);
  assert.equal(await readFile(source, 'utf8'), original);
}));

test('the explicit Node CLI entry applies and verifies the patch without npm lifecycle hooks', async () => fixture(async ({ root, source }) => {
  const scripts = join(root, 'scripts/native');
  await mkdir(scripts, { recursive: true });
  for (const name of ['harden-social-login-logging.mjs', 'social-login-log-patch.json']) {
    await copyFile(join(repo, 'scripts/native', name), join(scripts, name));
  }
  const first = await exec(process.execPath, [join(scripts, 'harden-social-login-logging.mjs')], { cwd: root });
  assert.equal(JSON.parse(first.stdout).status, 'hardened');
  assert.equal(hash(await readFile(source)), spec.patchedSHA256);
  const second = await exec(process.execPath, [join(scripts, 'harden-social-login-logging.mjs')], { cwd: root });
  assert.equal(JSON.parse(second.stdout).status, 'already-hardened');
}));
