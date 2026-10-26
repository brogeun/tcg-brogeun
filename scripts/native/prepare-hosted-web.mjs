import { copyFile, cp, lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This app loads its production HTTPS origin. Keep a real source snapshot in
// Capacitor's required webDir; never replace it with a successful mock screen.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const config = JSON.parse(await readFile(join(root, 'capacitor.config.json'), 'utf8'));
if (config.appId !== 'kr.tcghub.app' || config.server?.url !== 'https://tcghub.kr'
    || config.server?.cleartext !== false || config.webDir !== 'www') {
  throw new Error('Unexpected native identity or hosted origin; refusing a synthetic build.');
}
const dest = join(root, config.webDir);
const realRoot = await realpath(root);
async function requireOrdinaryDirectory(target, expectedRelative, label) {
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink()
      || relative(realRoot, await realpath(target)) !== expectedRelative) {
    throw new Error(label + ' must be an ordinary directory inside this checkout.');
  }
}
let preservedExistingWeb = false;
let reusedExistingBackup = false;
try {
  await requireOrdinaryDirectory(dest, 'www', 'The native webDir');
  // A full checkout contains a tracked www/index.html. Preserve it before
  // overlaying the actual current source; do not delete or relocate it.
  const evidenceDir = join(root, 'native-evidence');
  const backup = join(evidenceDir, 'preexisting-web');
  await mkdir(evidenceDir, { recursive: true });
  await requireOrdinaryDirectory(evidenceDir, 'native-evidence', 'Native evidence');
  try {
    await requireOrdinaryDirectory(backup, join('native-evidence', 'preexisting-web'), 'The original native web backup');
    reusedExistingBackup = true;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await cp(dest, backup, { recursive: true, force: false, errorOnExist: true });
  }
  preservedExistingWeb = true;
} catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(dest, { recursive: true });
// server.url loads the hosted site. Capacitor only requires this real index
// bootstrap; copying its image/game/catalogue trees duplicates the live site
// inside every native binary. Leave unknown existing webDir files untouched.
await copyFile(join(root, 'index.html'), join(dest, 'index.html'));
const index = await readFile(join(root, 'index.html'));
const copied = await readFile(join(dest, 'index.html'));
if (!index.equals(copied)) throw new Error('The native web snapshot differs from the source.');
const evidence = { appId: config.appId, hostedOrigin: config.server.url,
  sourceIndexSHA256: createHash('sha256').update(index).digest('hex'),
  exactSourceIndex: true, preservedExistingWeb, reusedExistingBackup,
  preparedFiles: ['index.html', 'native-source-evidence.json'],
  localMarketDataBundled: false, localAssetsBundled: false,
  note: 'Production server.url remains active. Only the real source index is prepared locally; assets and market data load from the hosted origin. This is not offline-mode validation.' };
await writeFile(join(dest, 'native-source-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence));
