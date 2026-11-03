import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile, writeFile, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {buildKantoRuntime, ESBUILD_VERSION} from './build_kanto_runtime.mjs';

const sourceRoot = fileURLToPath(new URL('..', import.meta.url));
const sourceHtmlPath = path.join(sourceRoot, 'games/kanto151/index.html');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
let temporary, deployRoot, report, htmlBefore;
before(async () => {
  await mkdir(path.join(sourceRoot, '.cache'), {recursive: true});
  temporary = await mkdtemp(path.join(sourceRoot, '.cache', 'tcghub-kanto-bundle-'));
  deployRoot = path.join(temporary, 'deploy');
  await mkdir(path.join(deployRoot, 'games/kanto151'), {recursive: true});
  htmlBefore = await readFile(sourceHtmlPath);
  await writeFile(path.join(deployRoot, 'games/kanto151/index.html'), htmlBefore);
  report = await buildKantoRuntime({sourceRoot, deployRoot});
});
after(async () => {
  // Cleanup is restricted to the exact temporary directory created by this test.
  if (temporary && path.dirname(path.resolve(temporary)) === path.join(sourceRoot, '.cache') && path.basename(temporary).startsWith('tcghub-kanto-bundle-')) {
    await rm(temporary, {recursive: true, force: true});
  }
});

test('one complete ESM materially reduces the module request graph and payload', async () => {
  assert.equal(ESBUILD_VERSION, '0.28.2');
  assert.equal(report.requestsAfter, 1);
  assert(report.requestsBefore > 80);
  assert(report.bundleBytes < report.sourceBytes * .75);
  assert(report.bundleGzipBytes < report.sourceGzipBytes * .85);
  const bundle = await readFile(path.join(deployRoot, 'games/kanto151', report.entry));
  assert.equal(digest(bundle), report.sha256);
  assert.match(report.entry, /^\.\/src\/runtime-[a-f0-9]{20}\.mjs$/);
  assert(bundle.toString('utf8').includes('Copyright 2010-2025 Three.js Authors'), 'retains vendored license attribution');
});

test('source data, save modules, and original HTML remain byte-identical', async () => {
  assert.deepEqual(await readFile(sourceHtmlPath), htmlBefore);
  for (const input of report.inputs) {
    assert.equal(digest(await readFile(path.join(sourceRoot, input.path))), input.sha256, input.path);
  }
  for (const suffix of ['src/game.mjs', 'src/pokemon.mjs', 'src/core.mjs', 'src/checkpoints.mjs', 'src/account-save.mjs']) {
    assert(report.inputs.some(input => input.path === 'games/kanto151/' + suffix));
  }
  const html = await readFile(path.join(deployRoot, 'games/kanto151/index.html'), 'utf8');
  assert.equal(html.replace(report.entry, './src/main.mjs'), htmlBefore.toString('utf8'));
  assert(html.includes('./boot.js?v=20261103-startup1'), 'classic watchdog remains outside module graph');
  assert(html.includes('type="importmap"'), 'unbundled original source retains its import map fallback');
});

test('the generated runtime requests the same thirteen JSON paths before any save access', async () => {
  const original = new Map(['window', 'document', 'fetch', 'localStorage', 'CustomEvent'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const requests = [], events = [];
  const previousError = console.error;
  try {
    Object.assign(globalThis, {window: {dispatchEvent: event => events.push(event.type)},
      document: {querySelector: () => ({textContent: ''})},
      fetch: async url => { requests.push(String(url)); return {ok: false, status: 503}; },
      CustomEvent: class { constructor(type, init = {}) { this.type = type; this.detail = init.detail; } },
    });
    Object.defineProperty(globalThis, 'localStorage', {configurable: true, get() { assert.fail('startup failure cannot access or mutate an existing save'); }});
    console.error = () => {};
    const bundlePath = path.join(deployRoot, 'games/kanto151', report.entry);
    await import(pathToFileURL(bundlePath));
    const names = ['species','moves','biomes','type-chart','pokemon-manifest','game-design','locale-entities','locale-messages','locale-literals','species-localized','regions-localized','region-compositions','moves-localized'];
    assert.deepEqual(requests, names.map(name => pathToFileURL(path.join(deployRoot, 'games/kanto151/data', name + '.json')).href));
    assert.equal(globalThis.window.__kantoStartupState, 'failed');
    assert.deepEqual(events, ['kanto151-startup-error']);
    // Both Cobblemon and environment loaders originate in /src, so their
    // compiled import.meta URL resolves to the original asset directories.
    const bundle = await readFile(bundlePath, 'utf8');
    assert(bundle.includes('../assets/cobblemon/'));
    assert(bundle.includes('../assets/environment/'));
  } finally {
    console.error = previousError;
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

test('repeated deployment builds are deterministic and do not add duplicate runtime entries', async () => {
  const html = await readFile(path.join(deployRoot, 'games/kanto151/index.html'));
  const second = await buildKantoRuntime({sourceRoot, deployRoot});
  assert.deepEqual(second, report);
  assert.deepEqual(await readFile(path.join(deployRoot, 'games/kanto151/index.html')), html);
});

test('the builder refuses to overwrite authored source', async () => {
  await assert.rejects(buildKantoRuntime({sourceRoot, deployRoot: sourceRoot}), /authored source/);
  await assert.rejects(buildKantoRuntime({sourceRoot}), /explicit deployment/);
});

test('a future vendor import.meta URL cannot silently acquire a different asset base', async () => {
  const fixture = path.join(temporary, 'fixture'), target = path.join(temporary, 'fixture-deploy');
  await mkdir(path.join(fixture, 'games/kanto151/src'), {recursive: true});
  await mkdir(path.join(fixture, 'games/kanto151/vendor'), {recursive: true});
  await mkdir(path.join(target, 'games/kanto151'), {recursive: true});
  await writeFile(path.join(fixture, 'games/kanto151/src/main.mjs'), "import '../vendor/asset.mjs';\n");
  await writeFile(path.join(fixture, 'games/kanto151/vendor/asset.mjs'), 'console.log(new URL("./asset.png",import.meta.url));\n');
  const html = '<script type="module" src="./src/main.mjs"></script>';
  await writeFile(path.join(target, 'games/kanto151/index.html'), html);
  await assert.rejects(buildKantoRuntime({sourceRoot: fixture, deployRoot: target}), /import.meta.url asset base/);
  assert.equal(await readFile(path.join(target, 'games/kanto151/index.html'), 'utf8'), html);
});
