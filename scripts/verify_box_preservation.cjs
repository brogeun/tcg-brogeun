'use strict';
// Preserves an explicitly reviewed snapshot. Does not contact image/price sources.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

function indexed(rows, key, label) {
  const result = new Map();
  for (const row of rows) {
    const id = key(row);
    assert(id && !result.has(id), label + ': duplicate or missing identity ' + id);
    result.set(id, row);
  }
  return result;
}
function hasAll(current, saved, label) {
  for (const item of saved) assert(current.has(item), label + ': removed ' + item);
}
function sourceCoverUpdate(saved, current, io) {
  // A vendor may replace the photo URL of the same sealed SKU. Preserve local
  // reviewed covers strictly; accept remote changes only from that SKU's saved
  // source snapshot, never from another box, a card, a logo or the derived UI.
  const cdn = value => {
    try { const u = new URL(value); return u.protocol === 'https:' &&
      u.hostname === 'cdn.snkrdunk.com' && !u.username && !u.password &&
      u.pathname.startsWith('/upload_bg_removed/'); } catch { return false; }
  };
  if (!cdn(saved.image) || !cdn(current.image) || typeof io.boxProduct !== 'function') return false;
  const source = io.boxProduct(saved.sourceGame, saved.id.slice(4));
  if (!source || source.source !== 'SNKRDUNK' || source.brand !== saved.sourceGame || source.kind !== 'box') return false;
  const p = source.product;
  if (!p || 'BOX:' + String(p.id) !== saved.id || p.brand !== saved.sourceGame || p.kind !== 'box' ||
      p.url !== 'https://snkrdunk.com/apparels/' + String(p.id) || p.name !== current.name ||
      !/(?:\bBox\b|ボックス)/i.test(p.name || '') || (p.image || p.thumbnailUrl) !== current.image) return false;
  const code = String(p.productNumber || p.code || '').toUpperCase().replace(
    /^(?:WS-TCG-|UATCG-|DBSC-TCG-|DBSCG-|DBFW-|YGO-OCG-TCG-|YGO-OCG-|YGO-TCG-|DGCG-TCG-|DGCG-)/, '');
  return code === String(saved.code).toUpperCase();
}
function checkSnapshot(baseline, io) {
  assert.equal(baseline.schemaVersion, 1, 'Unsupported preservation baseline');
  const load = name => io.json(name);
  const art = load('data/english-set-images.json');
  const english = indexed(load('data/english-catalog.json').sets, s => s.code, 'English');
  const localCover = (url, label) => {
    if (typeof url === 'string' && url.startsWith('/')) assert(io.exists(url.slice(1)), label + ': missing local cover ' + url);
  };
  for (const saved of baseline.english) {
    const current = english.get(saved.code);
    assert(current, 'English set removed: ' + saved.code);
    for (const key of ['sourceId','url']) assert.equal(current[key], saved[key], saved.code + ': source identity changed');
    assert(current.cardCount >= saved.minCards, saved.code + ': inventory shrank');
    const sources = art.sets[saved.code]?.sources || [];
    const tuples = new Set(sources.map(s => JSON.stringify([s.kind,String(s.productId || ''),s.image,s.sourceUrl || ''])));
    hasAll(tuples, saved.sources.map(s => JSON.stringify(s)), saved.code + ' cover');
    for (const source of sources) localCover(source.image, saved.code);
  }
  const catalog = load('data/tcg-card-info.json');
  const games = indexed(catalog.games, g => g.id, 'Game');
  let linkedFiles = 0;
  const sourceCoverUpdates = [];
  for (const saved of baseline.boxes) {
    const game = games.get(saved.game);
    assert(game, 'Game removed: ' + saved.game);
    const boxes = indexed(game.boxes || [], b => b.id, saved.game + ' box');
    const current = boxes.get(saved.id);
    assert(current, 'Box removed: ' + saved.game + '/' + saved.id);
    for (const key of ['code','sourceGame','coverType']) assert.equal(current[key], saved[key], saved.id + ': ' + key + ' changed');
    if (current.image !== saved.image) {
      assert(sourceCoverUpdate(saved,current,io), saved.id + ': image changed without matching sealed-product source');
      sourceCoverUpdates.push({id:saved.id,sourceGame:saved.sourceGame,previous:saved.image,current:current.image});
    }
    assert(current.cardCount >= saved.minCards, saved.id + ': inventory shrank');
    localCover(current.image, saved.id);
    const sets = indexed(game.sets || [], s => s.id, saved.game + ' set');
    for (const expected of saved.setIds) {
      assert((current.setIds || []).includes(expected.id), saved.id + ': printed set relationship removed ' + expected.id);
      const set = sets.get(expected.id);
      assert(set, saved.id + ': linked set missing ' + expected.id);
      for (const key of ['code','sourceGame']) assert.equal(set[key], expected[key], expected.id + ': source changed');
      assert(set.cardCount >= expected.minCards, expected.id + ': inventory shrank');
      assert(typeof set.file === 'string' && set.file.startsWith('/data/tcg-card-info/'), expected.id + ': missing source file');
      const doc = io.cardInfo(set.file.slice(1));
      assert.equal(doc.game, saved.game, expected.id + ': file game changed');
      assert.equal(doc.set.id, expected.id, expected.id + ': file set changed');
      assert(Array.isArray(doc.cards) && doc.cards.length >= expected.minCards, expected.id + ': printed inventory file shrank');
      linkedFiles++;
    }
  }
  const manifest = indexed(load('data/pokemon-vintage-image-repairs.json').images, r => r.localImage, 'Vintage artwork');
  for (const saved of baseline.vintage) {
    const current = manifest.get(saved.localImage);
    assert(current, 'Reviewed artwork removed: ' + saved.localImage);
    for (const key of ['setCode','sourceId','sourceUrl','sha256','bytes']) assert.equal(current[key], saved[key], saved.localImage + ': reviewed ' + key + ' changed');
    assert(io.vintage(saved), 'Reviewed artwork missing from output: ' + saved.localImage);
  }
  return {passed:true,englishSets:baseline.english.length,boxes:baseline.boxes.length,
    vintageArtworks:baseline.vintage.length,linkedInventoryReferences:linkedFiles,sourceCoverUpdates,networkRequests:0};
}
function diskIO(root) {
  root = path.resolve(root);
  const cache = new Map();
  const file = name => {
    assert(typeof name === 'string' && !name.includes('\\') && !name.startsWith('/') && !name.split('/').some(p => p === '..' || !p), 'Unsafe preservation path');
    const resolved = path.resolve(root, name);
    assert(resolved.startsWith(root + path.sep), 'Preservation path escapes root');
    return resolved;
  };
  const exists = name => fs.existsSync(file(name)) && fs.statSync(file(name)).isFile();
  const json = name => {
    if (!cache.has(name)) cache.set(name, JSON.parse(fs.readFileSync(file(name),'utf8').replace(/^\uFEFF/,'')));
    return cache.get(name);
  };
  const boxCache = new Map();
  return {exists,json,boxProduct(game,id) {
    assert(/^[a-z_]+$/.test(game), 'Unsafe box source game');
    if (!boxCache.has(game)) {
      const doc = json('data/price-' + game + '-box.json');
      const products = [...(doc.products || [])];
      for (const part of doc.shards || []) {
        const name = typeof part === 'string' ? part : part.file || part.url;
        assert(typeof name === 'string' && /^\/data\/snkrdunk-games\/[A-Za-z0-9_-]+\.json$/.test(name), 'Unsafe box source shard');
        const shard = json(name.slice(1));
        if (!Array.isArray(shard)) {
          for (const [key,value] of [['source','SNKRDUNK'],['brand',game],['kind','box']])
            assert(shard[key] === undefined || shard[key] === value, 'Box source shard identity changed');
        }
        const rows = Array.isArray(shard) ? shard : shard.products;
        assert(Array.isArray(rows), 'Invalid box source shard');
        products.push(...rows);
      }
      boxCache.set(game,{doc,products:indexed(products,p=>String(p.id),'Box source')});
    }
    const {doc,products} = boxCache.get(game);
    return {source:doc.source,brand:doc.brand,kind:doc.kind,product:products.get(String(id))};
  },cardInfo(name) {
    if (exists(name)) return json(name);
    const match = name.match(/^data\/tcg-card-info\/([a-z_]+)\/([0-9a-f]{16}(?:-part[0-9]{2,6})?\.json)$/);
    assert(match, 'Unexpected Card Info source path: ' + name);
    const pack = json('data/tcg-card-info-packs/' + match[1] + '/' + match[2][0] + '.json');
    assert.equal(pack.game, match[1], 'Card Info pack game changed');
    assert(typeof pack.files?.[match[2]] === 'string', 'Card Info pack lost source: ' + name);
    return JSON.parse(pack.files[match[2]]);
  },vintage(row) {
    if (exists(row.localImage.slice(1))) return true;
    const match = row.localImage.match(/^\/images\/pokemon-vintage\/([A-Za-z0-9+_-]+)\/(tcg-([0-9]+)|pooka-ja-[a-z0-9-]+)\.(?:png|webp|jpg)$/);
    assert(match, 'Unexpected reviewed artwork path');
    const bucket = match[3] ? String(Math.floor(Number(match[3]) / 64)) : 'pooka';
    const pack = json('data/pokemon-vintage-packs-v2/' + match[1] + '/' + bucket + '.json');
    assert.equal(pack.schemaVersion, 2, 'Vintage pack schema changed');
    assert.equal(pack.setCode, row.setCode, 'Vintage pack set changed');
    const item = pack.files?.[path.posix.basename(row.localImage)];
    return !!item && item.sha256 === row.sha256 && item.bytes === row.bytes && typeof item.data === 'string' && item.data.length > 0;
  }};
}
function loadBaseline(filename) {
  const header = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.equal(header.schemaVersion, 1, 'Unsupported preservation index');
  assert(Array.isArray(header.parts) && header.parts.length, 'Missing preservation baseline parts');
  const result = {...header, english:[], boxes:[], vintage:[]};
  const seen = new Set();
  const directory = path.resolve(path.dirname(filename));
  for (const part of header.parts) {
    assert(['english','boxes','vintage'].includes(part.kind), 'Unknown preservation part kind');
    const match = typeof part.file === 'string' && part.file.match(/^box-preservation-baseline\/(english|boxes|vintage)-[0-9]{2,3}\.json$/);
    assert(match && match[1] === part.kind, 'Unsafe preservation part path');
    assert(!seen.has(part.file), 'Duplicate preservation baseline part');
    seen.add(part.file);
    const target = path.resolve(directory, part.file);
    assert(target.startsWith(directory + path.sep), 'Baseline part escapes config');
    const rows = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert(Array.isArray(rows), 'Preservation part must contain an array');
    result[part.kind].push(...rows);
  }
  for (const kind of ['english','boxes','vintage']) {
    assert(Number.isInteger(header.counts?.[kind]) && header.counts[kind] >= 0, 'Missing preservation baseline count: ' + kind);
    assert.equal(result[kind].length, header.counts[kind], 'Preservation baseline part count changed: ' + kind);
  }
  return result;
}
module.exports = {checkSnapshot,diskIO,loadBaseline,sourceCoverUpdate};
if (require.main === module) {
  const args = process.argv.slice(2);
  assert(args.length === 0 || args.length === 2 && args[0] === '--bundle-dir', 'Usage: node scripts/verify_box_preservation.cjs [--bundle-dir DIRECTORY]');
  const baseline = loadBaseline(path.join(__dirname,'../config/box-preservation-baseline.json'));
  console.log(JSON.stringify(checkSnapshot(baseline,diskIO(args[1] || path.join(__dirname,'..')))));
}
