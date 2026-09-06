import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readText = path => readFileSync(join(root, path), 'utf8');
const readJson = path => JSON.parse(readText(path));

const html = readText('index.html');
const overrides = readJson('data/price-box-name-overrides.json');
const metaIndex = readJson('data/cards-meta-index.json');

let checkedInlineScripts = 0;
for (const match of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/gi)) {
  const attributes = match[1];
  if (/\bsrc\s*=|type\s*=\s*["']application\//i.test(attributes)) continue;
  new Function(match[2]);
  checkedInlineScripts += 1;
}

function cardInfoFor(brand) {
  const cardInfoStart = html.indexOf('const CARDINFO = {');
  assert.notEqual(cardInfoStart, -1, 'CARDINFO not found');
  const start = html.indexOf(`${brand}: [`, cardInfoStart);
  assert.notEqual(start, -1, `CARDINFO.${brand} not found`);
  const end = html.indexOf('\n  ],', start);
  assert.notEqual(end, -1, `CARDINFO.${brand} end not found`);
  const rows = new Map();
  const rowPattern = /\{code:"([^"]+)", name:"([^"]+)"[^\n}]*?boxId:"(\d+)"/g;
  for (const match of html.slice(start, end).matchAll(rowPattern)) {
    const fullName = match[2];
    const koreanName = (fullName.match(/^(.+?)\s*\((.+?)\)\s*$/)?.[1] || fullName).trim();
    rows.set(match[3], { code: match[1], fullName, koreanName });
  }
  return rows;
}

function classify(product, override, indexedMeta) {
  const explicitKind = String(override?.kind || indexedMeta?.kind || '').toLowerCase();
  if (explicitKind === 'card') return false;
  if (explicitKind === 'box' || explicitKind === 'sealed') return true;
  if (/^Card #\d+$/.test(String(product.name || '').trim())) return true;
  const text = `${product.name || ''} ${product.code || ''}`;
  if (/\[(?:OP|EB|ST|PRB|P)-?\d/i.test(text)) return false;
  return true;
}

assert(!html.includes('JP_PLACE_KR'), 'legacy English-name similarity mapping remains');
assert.match(html, /String\(product\.boxId \?\? product\.id \?\? ''\)/, 'direct product ID lookup missing');
assert.match(html, /String\(set\.boxId \?\? ''\)\.trim\(\) === productId/, 'CARDINFO.boxId equality lookup missing');
assert.match(html, /getBoxKoreanName\(p, PRICE_BRAND\) \|\| p\._koName/, 'direct lookup must precede override fallback');
assert.match(html, /-webkit-line-clamp:2/, 'two-line Korean name clamp missing');
assert.match(html, /price-card-name-primary[^}]+-webkit-line-clamp:2/s, 'two-line primary box name clamp missing');
assert.match(html, /price-card-name-original[^}]+text-overflow:ellipsis[^}]+white-space:nowrap/s, 'single-line original-name ellipsis missing');
assert.match(html, /price-card-name-box" title="\$\{fullNameTitle\}"/, 'full-name title attribute missing');

const expectedDirectByBrand = { pokemon: 0, onepiece: 0 };
const visibleByBrand = {};
const unknownKoreanByBrand = {};
const filteredCardsByBrand = {};

for (const brand of ['pokemon', 'onepiece']) {
  const cardInfo = cardInfoFor(brand);
  const current = readJson(`data/price-${brand}-box.json`).products;
  const manual = readJson(`data/manual-boxes-${brand}.json`).products;
  const currentIds = new Set(current.map(product => String(product.id)));

  for (const product of manual) {
    const id = String(product.id);
    if (!currentIds.has(id) || !product.code) continue;
    const direct = cardInfo.get(id);
    assert(direct, `${brand} current box ${id} (${product.code}) lacks CARDINFO.boxId`);
    assert.equal(direct.code.toLowerCase(), String(product.code).toLowerCase(), `${brand} box ${id} code mismatch`);
    expectedDirectByBrand[brand] += 1;
  }

  const visible = [];
  const filteredCards = [];
  for (const product of current) {
    const id = String(product.id);
    const override = overrides[id];
    const indexedMeta = metaIndex[id];
    const enriched = { ...product };
    if (/^Card #\d+$/.test(String(enriched.name || '').trim()) && (override || indexedMeta)?.name) {
      enriched.name = (override || indexedMeta).name;
    }
    if (classify(enriched, override, indexedMeta)) visible.push(enriched);
    else filteredCards.push(enriched);
  }

  const unknownKorean = visible.filter(product => {
    const id = String(product.id);
    return !cardInfo.has(id) && !overrides[id]?.koName;
  });
  visibleByBrand[brand] = visible.length;
  unknownKoreanByBrand[brand] = unknownKorean.map(product => ({ id: String(product.id), name: product.name }));
  filteredCardsByBrand[brand] = filteredCards.map(product => ({ id: String(product.id), name: product.name }));

  const cardProducts = readJson(`data/price-${brand}-card.json`).products;
  assert(cardProducts.length > 0, `${brand} card tab data is empty`);
}

const pokemonInfo = cardInfoFor('pokemon');
assert.equal(pokemonInfo.get('743533')?.koreanName, '무니키스 제로', '743533 must map directly to Korean name');
assert(expectedDirectByBrand.pokemon >= 17, 'known Pokémon boxes lost direct ID mappings');
assert(expectedDirectByBrand.onepiece >= 5, 'known One Piece boxes lost direct ID mappings');
for (const id of ['887992', '887994']) {
  assert(filteredCardsByBrand.onepiece.some(row => row.id === id), `individual One Piece card ${id} must stay out of box tab`);
}

console.log(JSON.stringify({
  ok: true,
  checkedInlineScripts,
  directBoxMatches: expectedDirectByBrand,
  visibleBoxProducts: visibleByBrand,
  productsWithoutProjectKoreanName: unknownKoreanByBrand,
  filteredIndividualCards: filteredCardsByBrand,
  specialProduct743533: pokemonInfo.get('743533'),
}, null, 2));
