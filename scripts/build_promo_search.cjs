/* Metadata only: no catalogue quote is promoted to a current card price. */
'use strict';
const fs = require('node:fs'), path = require('node:path'), zlib = require('node:zlib');
const root = path.resolve(__dirname, '..');
const read = name => {const raw = fs.readFileSync(path.join(root, name)); return JSON.parse((name.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8'));};
// Individually verified multi-card products; keep these guards on a clean checkout.
const verifiedExcluded = ['93171','93176','126334','253254','337742','372816','407023','412560','412809','595510','761078','761079','826602','869148','869149','869150','892669','895665','724162','724163','756029','880575','880576','768195','777027','778628','787633','835600','861761'];
const family = /(?:^|[^a-z])(?:PMCG|PCG|ADV|DPt|SM|SV|XY|BW|neo|DP|M|S|L|e)-P(?:[^a-z]|$)/i;
const foreign = /\[[^\]]*\b(?:EN|ENG|FR|DE|ES|IT|PT|KO|KR|KOR|CN|CHN|ZH|TW|TH|ID|SC|TC|VI)\b[^\]]*\]|\b(?:English|Chinese|China|Korean|French|German|Italian|Spanish|Portuguese|Thai|Thailand|Taiwan|Indonesian|Indonesia|Vietnamese|Hong Kong|North America)\b|\b(?:Aisa|Asia)\s+ver\.(?=\s|\]|\)|$)|\[(?:SWSH|HGSS|SM|XY|BW|DP|SVP|MEP|BSP)\s*\d{2,4}\]|(?:英語|韓国語|中国語|簡体字|繁体字|フランス語|ドイツ語|イタリア語|スペイン語|タイ語|ポルトガル語|インドネシア語)版/i;

function eligibility(card, excluded = new Set()) {
  if (!card || excluded.has(String(card.id)) || !/^\d+$/.test(String(card.id)) || !['pokemon', 'onepiece'].includes(card.brand) || card.kind !== 'card') return false;
  const name = String(card.name || ''), number = String(card.productNumber || '');
  if (!name || foreign.test(name) || /(?:^|-)(?:EN|ENG|CN|CHN|ZH|KR|KO|KOR|SC|TC|VI)(?:-|$)/i.test(number)) return false;
  const title = name.split('(')[0];
  if (/complete set|\b\d+[- ](?:card|piece)s?\s+set\b|\b\d+\s+cards?\s*(?:set|bundle)\b|\b\d+\s*[-/]\s*language\s+set\b/i.test(title) || /(?:^|-)SET(?:-|$)/i.test(number)) return false;
  return /\bpromo(?:tion(?:al)?)?\b|プロモ/i.test(name) || (card.brand === 'pokemon' && family.test(name)) || (card.brand === 'onepiece' && /\[P-\d{3}(?:\s|\])/i.test(name));
}

function build(sources, exclusions) {
  const excluded = new Set([...verifiedExcluded, ...(exclusions?.exclusions || []).map(item => String(item.productId))]);
  const latest = new Map();
  for (const source of sources) for (const card of source.data.products || source.data.cards || []) {
    latest.set(String(card.id), card);
  }
  const cards = new Map();
  for (const card of latest.values()) {
    if (!eligibility(card, excluded)) continue;
    cards.set(String(card.id), {id: String(card.id), brand: card.brand, kind: 'card', language: 'ja', name: card.name, productNumber: card.productNumber || '', thumbnailUrl: card.thumbnailUrl || '', releasedAt: card.releasedAt || null});
  }
  return {schemaVersion: 1, generatedAt: new Date().toISOString(), sources: sources.map(source => ({path: source.name, collectedAt: source.data.generatedAt || source.data.checkedAt})), cards: [...cards.values()].sort((a,b) => Number(a.id) - Number(b.id))};
}

function retainAndSupplement(existing, feeds, exclusions) {
  if (existing.schemaVersion !== 1 || !Array.isArray(existing.cards) || existing.cards.length < 1000) throw new Error('No valid saved promo catalogue available.');
  const sources = feeds.map(feed => ({name: feed.name, data: {checkedAt: feed.data.fetchedAt, cards: (feed.data.products || []).map(card => ({id: card.id, name: card.name, productNumber: card.productNumber || '', thumbnailUrl: card.image || card.thumbnailUrl || '', releasedAt: card.releasedAt || null, brand: feed.brand, kind: 'card'}))}}));
  const known = new Set(existing.cards.map(card => String(card.id)));
  const additions = build(sources, exclusions).cards.filter(card => !known.has(card.id));
  if (!additions.length) return existing;
  return {...existing, generatedAt: new Date().toISOString(), sources: [...(existing.sources || []), ...sources.map(source => ({path: source.name, collectedAt: source.data.checkedAt}))], cards: [...existing.cards, ...additions].sort((a,b) => Number(a.id) - Number(b.id))};
}

if (require.main === module) {
  const universe = 'data/card-index-platform-universe-20261012.json';
  const names = ['docs/contained-catalogue-source.json', fs.existsSync(path.join(root, universe)) ? universe : universe + '.gz'];
  const sources = names.filter(name => fs.existsSync(path.join(root, name))).map(name => ({name, data: read(name)})).sort((a,b) => Date.parse(a.data.generatedAt || a.data.checkedAt) - Date.parse(b.data.generatedAt || b.data.checkedAt));
  const exclusions = 'data/card-index-platform-scope-exclusions-20261012.json';
  const guards = fs.existsSync(path.join(root, exclusions)) ? read(exclusions) : undefined;
  let output;
  if (sources.length) output = build(sources, guards);
  else {
    const feeds = ['pokemon','onepiece'].map(brand => ({brand, name: 'data/price-' + brand + '-card.json'})).filter(feed => fs.existsSync(path.join(root, feed.name))).map(feed => ({...feed, data:read(feed.name)}));
    const existing = read('data/promo-search.json');
    output = retainAndSupplement(existing, feeds, guards);
    if (output === existing) {console.log(JSON.stringify({cards:existing.cards.length,preserved:true,newPromoCards:0,fullCatalogueAvailable:false}));process.exit(0);}
  }
  if (output.cards.length < 1000) throw new Error('Incomplete promo catalogue; preserve the existing file.');
  fs.writeFileSync(path.join(root, 'data/promo-search.json'), JSON.stringify(output));
  console.log(JSON.stringify({cards: output.cards.length, byBrand: Object.fromEntries(['pokemon', 'onepiece'].map(brand => [brand, output.cards.filter(card => card.brand === brand).length])), metadataOnly: true}));
}
module.exports = {eligibility, build, retainAndSupplement};
