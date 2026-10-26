import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Capacitor writes native Windows separators into Swift path literals. Keep the
// generated manifest portable without changing plugin identities or versions.
const file = fileURLToPath(new URL('../ios/App/CapApp-SPM/Package.swift', import.meta.url));
const original = await readFile(file, 'utf8');
const normalized = original.replace(/(\bpath:\s*")([^"\r\n]*)(")/g,
  (_, prefix, value, suffix) => prefix + value.replace(/\\/g, '/') + suffix);
if (normalized !== original) await writeFile(file, normalized);
console.log('Capacitor SPM paths are portable.');
