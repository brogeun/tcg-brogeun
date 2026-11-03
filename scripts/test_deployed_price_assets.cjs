'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {assertPriceAssetReferences} = require('./deployed_price_assets.cjs');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

test('the current deployed price dependency chain accepts release versions from the source', () => {
  assert.equal(assertPriceAssetReferences(html, html), 4);
  const changed = html.replace(/(contained-card-prices\.js\?v=)[^"']+/, '$1future-release');
  assert.equal(assertPriceAssetReferences(changed, changed), 4);
});

test('missing, duplicate, stale or foreign price scripts cannot pass publication checks', () => {
  const priceScript = html.match(/<script[^>]*src="\/assets\/contained-card-prices\.js[^>]*><\/script>/)[0];
  for (const changed of [
    html.replace(priceScript, ''),
    html.replace(priceScript, priceScript + priceScript),
    html.replace(/(contained-card-prices\.js\?v=)[^"']+/, '$1stale-release'),
    html.replace('/assets/contained-card-prices.js?', 'https://foreign.example/assets/contained-card-prices.js?'),
  ]) assert.throws(() => assertPriceAssetReferences(changed, html));
});

test('a reordered price bridge cannot pass even when every expected URL is present', () => {
  const priceScript = html.match(/<script[^>]*src="\/assets\/contained-card-prices\.js[^>]*><\/script>/)[0];
  const changed = priceScript + html.replace(priceScript, '');
  assert.throws(() => assertPriceAssetReferences(changed, html), /order differs/);
});
