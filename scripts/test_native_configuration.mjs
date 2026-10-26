import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
for (const identity of ['alamofire', 'facebook-ios-sdk', 'googlesignin-ios', 'ion-ios-camera', 'ion-ios-filesystem']) {
  assert(resolved.pins.some(pin => pin.identity === identity),
    'The committed native Swift lock must include the resolved provider graph: ' + identity);
}
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
assert.match(pkg.scripts['sync:ios'] || '', /node scripts\/native\/harden-social-login-logging\.mjs\s*&&\s*node scripts\/native\/prepare-hosted-web\.mjs\s*&&\s*cap sync ios/,
  'Native iOS sync must harden SDK logs and prepare the reviewed web source before copying native assets');
assert.match(pkg.scripts['sync:android'] || '', /node scripts\/native\/harden-social-login-logging\.mjs\s*&&\s*node scripts\/native\/prepare-hosted-web\.mjs\s*&&\s*node scripts\/prepare-native-android\.mjs/,
  'Native Android sync must use the same hardened dependencies and reviewed web source');
const logPatch = json('scripts/native/social-login-log-patch.json');
const appleProviderSource = readFileSync(join(root, 'node_modules', logPatch.package, logPatch.relativeSource));
assert.equal(createHash('sha256').update(appleProviderSource).digest('hex'), logPatch.patchedSHA256,
  'The reviewed native Apple token log patch must be applied before native configuration validation');
assert.equal(nativeConfig.server.url, 'https://tcghub.kr');
assert.equal(nativeConfig.server.cleartext, false);
assert.equal(nativeConfig.android.allowMixedContent, false);
assert.equal(nativeConfig.android.webContentsDebuggingEnabled, false);
const info = readFileSync(join(root, 'ios/App/App/Info.plist'), 'utf8');
const appDelegate = readFileSync(join(root, 'ios/App/App/AppDelegate.swift'), 'utf8');
const appHTML = readFileSync(join(root, 'index.html'), 'utf8');
const plistValue = key => info.match(new RegExp('<key>' + key + '</key>\\s*<string>([^<]+)</string>'))?.[1];
const googleConfig = nativeConfig.plugins.SocialLogin.google;
assert.equal(plistValue('GIDClientID'), googleConfig.iOSClientId,
  'Google native iOS client ID must agree with the app plist');
assert.equal(plistValue('GIDServerClientID'), googleConfig.iOSServerClientId,
  'Google backend audience must agree with the app plist');
assert.equal(googleConfig.iOSServerClientId, googleConfig.webClientId);
assert(info.includes('<string>' + googleConfig.iOSClientId.split('.').reverse().join('.') + '</string>'),
  'The registered Google callback scheme must reverse the configured iOS client ID');
for (const key of ['webClientId', 'iOSClientId', 'iOSServerClientId']) {
  const actual = appHTML.match(new RegExp(key + ":\\s*'([^']+)'"))?.[1];
  assert.equal(actual, googleConfig[key], 'The hosted SDK init must preserve native ' + key);
}
assert.equal(nativeConfig.plugins.SocialLogin.apple.clientId, nativeConfig.appId);
const projectText = readFileSync(join(root, 'ios/App/App.xcodeproj/project.pbxproj'), 'utf8');
const bundleIDs = [...projectText.matchAll(/PRODUCT_BUNDLE_IDENTIFIER\s*=\s*"?([^";\r\n]+)"?;/g)]
  .map(match => match[1].trim());
assert(bundleIDs.filter(value => value === nativeConfig.appId).length >= 2,
  'The native Debug and Release bundle IDs must agree with the Apple app audience');
const appleEntitlements = readFileSync(join(root, 'ios/App/App/App.entitlements'), 'utf8');
assert.match(appleEntitlements, /<key>com\.apple\.developer\.applesignin<\/key>\s*<array>\s*<string>Default<\/string>\s*<\/array>/,
  'Native Apple sign-in must declare its required entitlement');
const entitlementPaths = [...projectText.matchAll(/CODE_SIGN_ENTITLEMENTS\s*=\s*"?([^";\r\n]+)"?;/g)]
  .map(match => match[1].trim());
assert.equal(entitlementPaths.filter(value => value === 'App/App.entitlements').length, 2,
  'Both App configurations must include their Apple sign-in entitlement');
assert(projectText.includes('com.apple.SignInWithApple'), 'The App target must retain its Apple sign-in capability');
assert(info.includes('<string>' + nativeConfig.appId + '</string>'), 'Native email and Kakao callbacks need their app scheme');
assert.match(appDelegate, /^import GoogleSignIn\s*$/m);
const googleForward = appDelegate.indexOf('GIDSignIn.sharedInstance.handle(url)');
const capacitorForward = appDelegate.indexOf('return ApplicationDelegateProxy.shared.application(app, open: url, options: options)');
assert(googleForward >= 0 && capacitorForward > googleForward,
  'Google callbacks must reach its SDK before the existing Capacitor fallback');
assert(appDelegate.includes('ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)'),
  'Universal link forwarding must remain available');

console.log(JSON.stringify({ ok: true, capacitorVersion: version, nativePlugins: nativePlugins.length,
  lockMatches: true, portablePaths: true, localPluginGraphMatches: true, runtimePinMatches: true,
  secureHostedOriginPreserved: true, nativeOAuthConfigurationMatches: true, appleSignInEntitlement: true, googleCallbackForwarding: true,
  nativeAppleTokenLogSitesRedacted: 3 }));
