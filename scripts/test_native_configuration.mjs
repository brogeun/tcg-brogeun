import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const json = name => JSON.parse(readFileSync(join(root, name), 'utf8'));
const pkg = json('package.json'), lock = json('package-lock.json');
assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies,
  'package.json and lock root must agree for reproducible npm ci');
const version = lock.packages['node_modules/@capacitor/core'].version;
for (const name of ['android', 'ios', 'core', 'cli']) {
  assert.equal(pkg.dependencies['@capacitor/' + name], version,
    'Capacitor platform, core and CLI versions must be aligned and pinned');
  assert.equal(lock.packages['node_modules/@capacitor/' + name].version, version);
}
const swiftRoot = join(root, 'ios/App/CapApp-SPM');
const swift = readFileSync(join(swiftRoot, 'Package.swift'), 'utf8');
assert.equal(swift.match(/capacitor-swift-pm\.git",\s*exact:\s*"([^"]+)"/)?.[1], version,
  'SPM runtime must match the npm iOS runtime');
const resolved = json('ios/App/App.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved');
const runtimePin = resolved.pins.find(pin => pin.identity === 'capacitor-swift-pm');
assert.equal(runtimePin?.state?.version, version, 'the committed SPM runtime pin must match its manifest');
assert.match(runtimePin?.state?.revision || '', /^[0-9a-f]{40}$/, 'SPM runtime must have a real commit revision');
const packages = [...swift.matchAll(/\.package\(name:\s*"([^"]+)",\s*path:\s*"([^"]+)"\)/g)]
  .map(match => ({ name: match[1], path: match[2] }));
const expectedNames = new Set();
const nativePlugins = Object.keys(pkg.dependencies).filter(name =>
  !['@capacitor/android', '@capacitor/ios', '@capacitor/core', '@capacitor/cli'].includes(name));
for (const name of nativePlugins) {
  const pluginRoot = join(root, 'node_modules', name);
  assert(existsSync(join(pluginRoot, 'Package.swift')), `npm ci required; ${name} must support SPM`);
  const pluginSwift = readFileSync(join(pluginRoot, 'Package.swift'), 'utf8');
  const pluginName = pluginSwift.match(/name:\s*"([^"]+)"/)?.[1];
  assert(pluginName, `${name} has no named Swift package`);
  expectedNames.add(pluginName);
  const row = packages.find(item => item.name === pluginName);
  assert(row, `${name} is missing from the iOS package manifest`);
  assert(!row.path.includes('\\'), `${name} contains invalid Windows Swift escapes`);
  assert.equal(resolve(swiftRoot, row.path), resolve(pluginRoot), `${name} has the wrong local path`);
  assert(swift.includes(`.product(name: "${pluginName}", package: "${pluginName}")`),
    `${name} is not linked into the app target`);
}
assert.deepEqual(new Set(packages.map(item => item.name)), expectedNames,
  'SPM must not retain removed plugins or omit installed plugins');
for (const removed of ['@capacitor/push-notifications', '@codetrix-studio/capacitor-google-auth']) {
  assert(!pkg.dependencies[removed] && !lock.packages['node_modules/' + removed]);
}
assert.equal(lock.packages['node_modules/@capawesome/capacitor-app-update'].version.split('.')[0],
  version.split('.')[0], 'App Update must use the supported Capacitor major');
const nativeConfig = json('capacitor.config.json');
assert.equal(nativeConfig.server.url, 'https://tcghub.kr');
assert.equal(nativeConfig.server.cleartext, false);
assert.equal(nativeConfig.android.allowMixedContent, false);
assert.equal(nativeConfig.android.webContentsDebuggingEnabled, false);
console.log(JSON.stringify({ ok: true, capacitorVersion: version, nativePlugins: nativePlugins.length,
  lockMatches: true, portablePaths: true, localPluginGraphMatches: true, runtimePinMatches: true,
  secureHostedOriginPreserved: true }));
