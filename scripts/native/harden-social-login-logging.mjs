import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The pinned SDK prints Apple credentials even in Release. Keep the small
// audited patch explicit in sync:ios, including npm ci --ignore-scripts builds.
// Unknown SDK versions or bytes must be reviewed instead of patched blindly.
const script = fileURLToPath(import.meta.url);
const spec = JSON.parse(await readFile(new URL('./social-login-log-patch.json', import.meta.url), 'utf8'));
const sha256 = data => createHash('sha256').update(data).digest('hex');

export async function hardenNativeSocialLogin(root = resolve(dirname(script), '../..')) {
  if (spec.package !== '@capgo/capacitor-social-login' || spec.version !== '8.3.22'
      || spec.relativeSource !== 'ios/Sources/SocialLoginPlugin/AppleProvider.swift'
      || spec.replacements.length !== 3) throw new Error('Unexpected SDK patch specification.');
  const packageRoot = join(root, 'node_modules', spec.package);
  const installed = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(await readFile(join(root, 'package-lock.json'), 'utf8'));
  if (installed.version !== spec.version || lock.packages?.['node_modules/' + spec.package]?.version !== spec.version) {
    throw new Error('The native logging patch requires the reviewed SocialLogin version; review the SDK upgrade before building.');
  }
  const source = join(packageRoot, spec.relativeSource);
  const before = await readFile(source);
  const beforeSHA = sha256(before);
  if (beforeSHA === spec.patchedSHA256) {
    return { ok: true, status: 'already-hardened', redactedSites: 3, sourceSHA256: beforeSHA };
  }
  if (beforeSHA !== spec.originalSHA256) {
    throw new Error('Unrecognized AppleProvider source hash; refusing an unaudited native source patch.');
  }
  let patched = before.toString('utf8');
  for (const item of spec.replacements) {
    if (patched.split(item.from).length !== 2) throw new Error('A reviewed runtime log site changed.');
    patched = patched.replace(item.from, item.to);
  }
  if (sha256(patched) !== spec.patchedSHA256) throw new Error('The native log patch did not produce the reviewed bytes.');
  await writeFile(source, patched);
  if (sha256(await readFile(source)) !== spec.patchedSHA256) throw new Error('Native log patch verification failed.');
  return { ok: true, status: 'hardened', redactedSites: 3,
    originalSHA256: spec.originalSHA256, sourceSHA256: spec.patchedSHA256 };
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  console.log(JSON.stringify(await hardenNativeSocialLogin()));
}
