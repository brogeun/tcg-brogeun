import {createHash} from 'node:crypto';
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync} from 'node:zlib';

export const ESBUILD_VERSION = '0.28.2';
const require = createRequire(import.meta.url);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const moduleTag = /<script\b(?=[^>]*\btype=["']module["'])(?=[^>]*\b(?:data-runtime-src|src)=["']\.\/src\/(?:main\.mjs|runtime-[a-f0-9]{20}\.mjs)["'])[^>]*><\/script>/gi;
const inside = (root, filename) => {
  const relative = path.relative(root, filename);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

// Only the disposable deployment copy is changed. The authored source, assets,
// saves, runtime data and all original third-party licenses remain untouched.
export async function buildKantoRuntime({sourceRoot = process.cwd(), deployRoot, esbuildModule} = {}) {
  if (!deployRoot) throw new Error('An explicit deployment directory is required');
  sourceRoot = path.resolve(sourceRoot);
  deployRoot = path.resolve(deployRoot);
  if (deployRoot === sourceRoot) throw new Error('Refusing to bundle over the authored source directory');
  const gameRoot = path.join(sourceRoot, 'games/kanto151');
  const deploymentGame = path.join(deployRoot, 'games/kanto151');
  const htmlPath = path.join(deploymentGame, 'index.html');
  const html = await readFile(htmlPath, 'utf8');
  const tags = [...html.matchAll(moduleTag)];
  if (tags.length !== 1) throw new Error('Expected exactly one Kanto runtime module entry');
  const esbuild = require(esbuildModule || process.env.KANTO_ESBUILD_MODULE || 'esbuild');
  if (esbuild.version !== ESBUILD_VERSION) throw new Error(`Kanto bundler requires esbuild ${ESBUILD_VERSION}`);
  const result = await esbuild.build({
    absWorkingDir: sourceRoot,
    entryPoints: ['games/kanto151/src/main.mjs'],
    outfile: path.join(deploymentGame, 'src/runtime.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    alias: {three: path.join(gameRoot, 'vendor/three.module.js')},
    minify: true,
    keepNames: true,
    charset: 'utf8',
    legalComments: 'eof',
    sourcemap: false,
    metafile: true,
    write: false,
    logLevel: 'silent',
  });
  if (result.outputFiles.length !== 1) throw new Error('Expected one self-contained runtime module');
  const outputs = Object.values(result.metafile.outputs);
  if (outputs.length !== 1 || outputs[0].imports.length) throw new Error('Bundled runtime contains unresolved module dependencies');
  const inputs = [];
  for (const [filename, metadata] of Object.entries(result.metafile.inputs)) {
    const absolute = path.resolve(sourceRoot, filename);
    if (!inside(gameRoot, absolute)) throw new Error('Kanto runtime unexpectedly imports a file outside its game directory');
    // Every use of import.meta.url must retain its authored directory after
    // bundling; changing ../data or ../assets bases would silently break saves
    // or asset loading. Vendor files currently contain no import.meta URLs.
    const content = await readFile(absolute);
    if (/\bimport\.meta\.url\b/.test(content.toString('utf8')) && path.dirname(absolute) !== path.join(gameRoot, 'src')) {
      throw new Error('Bundling would change an import.meta.url asset base');
    }
    inputs.push({path: path.relative(sourceRoot, absolute).split(path.sep).join('/'), bytes: metadata.bytes,
      gzipBytes: gzipSync(content).byteLength, sha256: hash(content)});
  }
  inputs.sort((a, b) => a.path.localeCompare(b.path));
  const bytes = result.outputFiles[0].contents;
  const digest = hash(bytes);
  const filename = `runtime-${digest.slice(0, 20)}.mjs`;
  const bundlePath = path.join(deploymentGame, 'src', filename);
  const sourceBytes = inputs.reduce((total, input) => total + input.bytes, 0);
  if (bytes.byteLength >= sourceBytes) throw new Error('Runtime bundling did not reduce the source payload');
  const patched = html.replace(moduleTag, tag => tag.replace(/\b(data-runtime-src|src)=(["'])[^"']+\2/i, (_match, attribute) => `${attribute}="./src/${filename}"`));
  const report = {schemaVersion: 1, esbuildVersion: esbuild.version, entry: `./src/${filename}`, sha256: digest,
    requestsBefore: inputs.length, requestsAfter: 1, initialRuntimeRequests: /\bdata-runtime-src=/.test(patched)?0:1, sourceBytes,
    sourceGzipBytes: inputs.reduce((total, input) => total + input.gzipBytes, 0),
    bundleBytes: bytes.byteLength, bundleGzipBytes: gzipSync(bytes).byteLength, inputs};
  await mkdir(path.dirname(bundlePath), {recursive: true});
  await writeFile(bundlePath, bytes);
  await writeFile(path.join(deploymentGame, 'runtime-manifest.json'), JSON.stringify(report) + '\n');
  await writeFile(htmlPath, patched);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!value || !['--source-root', '--deploy-dir', '--esbuild-module'].includes(key)) throw new Error('Unknown or incomplete Kanto build option');
    options[{'--source-root': 'sourceRoot', '--deploy-dir': 'deployRoot', '--esbuild-module': 'esbuildModule'}[key]] = value;
  }
  const report = await buildKantoRuntime(options);
  const {inputs, ...summary} = report;
  console.log(JSON.stringify(summary));
}
