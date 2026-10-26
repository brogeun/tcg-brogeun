import { copyFile, cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
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
try { await stat(dest); throw new Error('webDir already exists; use a clean checkout.'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(dest, { recursive: true });
const files = ['index.html', 'mobile.html', 'manifest.json', 'sw.js', 'favicon.ico', 'privacy.html', 'terms.html'];
const directories = ['assets', 'images', 'img', 'public', 'static', 'ev-calculator', 'games'];
for (const name of [...files, ...directories]) {
  const source = join(root, name);
  try {
    const info = await stat(source);
    if (info.isDirectory()) await cp(source, join(dest, name), { recursive: true });
    else await copyFile(source, join(dest, name));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const index = await readFile(join(root, 'index.html'));
const copied = await readFile(join(dest, 'index.html'));
if (!index.equals(copied)) throw new Error('The native web snapshot differs from the source.');
const evidence = { appId: config.appId, hostedOrigin: config.server.url,
  sourceIndexSHA256: createHash('sha256').update(index).digest('hex'),
  exactSourceIndex: true, localMarketDataBundled: false,
  note: 'Production server.url remains active. Market data is fetched from the hosted origin; this is not an offline-mode validation.' };
await writeFile(join(dest, 'native-source-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify(evidence));
