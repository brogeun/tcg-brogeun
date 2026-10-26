import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

// The repository preserves application-specific native sources and branding.
// Supply the missing build scaffold from the exact npm-locked Capacitor template.
// Existing native files, signing material, and service credentials are never replaced.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exists = async path => access(path).then(() => true, () => false);
const config = JSON.parse(await readFile(join(root, 'capacitor.config.json'), 'utf8'));
const cli = join(root, 'node_modules/@capacitor/cli/bin/capacitor');
const runtime = JSON.parse(await readFile(join(root, 'node_modules/@capacitor/android/package.json'), 'utf8'));
assert.equal(config.appId, 'kr.tcghub.app');
assert.equal(config.server?.url, 'https://tcghub.kr');
assert.equal(config.server?.cleartext, false);
assert.equal(config.android?.allowMixedContent, false);
assert.equal(config.android?.webContentsDebuggingEnabled, false);
assert.equal(typeof config.webDir, 'string');
const web = resolve(root, config.webDir);
assert(web.startsWith(root + sep), 'webDir must remain inside the project');
assert(await exists(cli), 'Run npm ci before preparing Android');

const run = (args, cwd) => new Promise((resolveRun, reject) => {
  const child = spawn(process.execPath, [cli, ...args], { cwd, stdio: 'inherit', windowsHide: true });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolveRun() : reject(new Error(`Capacitor ${args.join(' ')} exited ${code}`)));
});
// server.url supplies the live application. Use the actual reviewed HTML as the
// native asset bootstrap; do not substitute a dummy page or enable WebView debugging.
await mkdir(web, { recursive: true });
if (!await exists(join(web, 'index.html'))) await copyFile(join(root, 'index.html'), join(web, 'index.html'));

const android = join(root, 'android');
const complete = await Promise.all(['gradlew', 'gradlew.bat', 'build.gradle', 'settings.gradle', 'variables.gradle',
  'gradle/wrapper/gradle-wrapper.jar', 'gradle/wrapper/gradle-wrapper.properties']
  .map(name => exists(join(android, name))));
let added = 0;
if (!complete.every(Boolean)) {
  const parent = resolve(tmpdir());
  const temporary = await mkdtemp(join(parent, 'tcghub-android-template-'));
  assert(temporary.startsWith(parent + sep + 'tcghub-android-template-'));
  try {
    for (const name of ['package.json', 'package-lock.json']) await copyFile(join(root, name), join(temporary, name));
    await writeFile(join(temporary, 'capacitor.config.json'), JSON.stringify({ ...config, webDir: 'www' }, null, 2) + '\n');
    await mkdir(join(temporary, 'www'));
    await copyFile(join(web, 'index.html'), join(temporary, 'www/index.html'));
    await symlink(join(root, 'node_modules'), join(temporary, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    await run(['add', 'android'], temporary);
    const copyMissing = async (source, destination) => {
      await mkdir(destination, { recursive: true });
      for (const entry of await readdir(source, { withFileTypes: true })) {
        if (['.gradle', 'build', 'local.properties', 'google-services.json'].includes(entry.name)
            || /\.(?:jks|keystore|p12|pem|key)$/i.test(entry.name)) continue;
        const from = join(source, entry.name), to = join(destination, entry.name);
        const resource = relative(android, to).split(sep).join('/');
        // Template examples hard-code a different application ID. Keep project
        // tests, but do not add template-only arithmetic/context placeholders.
        if (['app/src/test', 'app/src/androidTest'].includes(resource)) continue;
        if (entry.isDirectory()) { await copyMissing(from, to); continue; }
        if (!entry.isFile() || await exists(to)) continue;
        // A preserved .webp launcher and a template .png of the same resource
        // name must never coexist in one Android resource configuration.
        if (resource.startsWith('app/src/main/res/') && /\.(?:png|webp|jpg|xml)$/i.test(entry.name)) {
          const stem = entry.name.replace(/\.[^.]+$/, '');
          if ((await readdir(destination)).some(name => name.replace(/\.[^.]+$/, '') === stem)) continue;
        }
        await copyFile(from, to, constants.COPYFILE_EXCL);
        added++;
      }
    };
    await copyMissing(join(temporary, 'android'), android);
  } finally {
    // Only the task-created temporary directory is removable; symlinks are not followed.
    assert(temporary.startsWith(parent + sep + 'tcghub-android-template-'));
    await rm(temporary, { recursive: true, force: true });
  }
}
if (process.platform !== 'win32') await chmod(join(android, 'gradlew'), 0o755);
await run(['sync', 'android'], root);
console.log(JSON.stringify({ ok: true, capacitorAndroid: runtime.version, generatedMissingFiles: added,
  nativeSourcesPreserved: true, server: config.server.url, webBootstrap: 'reviewed-index', releaseSigning: false }));
