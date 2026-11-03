'use strict';
const assert = require('node:assert/strict');

const required = [
  '/assets/contained-card-match.js',
  '/assets/price-expanded.js',
  '/assets/card-price-fallback.js',
  '/assets/contained-card-prices.js',
];

function scriptURLs(html) {
  return [...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi)]
    .map(match => new URL(match[2].replace(/&amp;/g, '&'), 'https://tcghub.kr'));
}

function assertPriceAssetReferences(remoteHTML, localHTML) {
  const remote = scriptURLs(remoteHTML), local = scriptURLs(localHTML);
  let previous = -1;
  for (const pathname of required) {
    const expected = local.filter(url => url.origin === 'https://tcghub.kr' && url.pathname === pathname);
    const actual = remote.filter(url => url.origin === 'https://tcghub.kr' && url.pathname === pathname);
    assert.equal(expected.length, 1, 'Source price script must occur once: ' + pathname);
    assert.equal(actual.length, 1, 'Deployed price script must occur once: ' + pathname);
    assert(expected[0].searchParams.get('v'), 'Source price script requires a release version: ' + pathname);
    assert.equal(actual[0].href, expected[0].href, 'Deployed price script release differs: ' + pathname);
    const position = remote.indexOf(actual[0]);
    assert(position > previous, 'Deployed price script order differs: ' + pathname);
    previous = position;
  }
  return required.length;
}

module.exports = {assertPriceAssetReferences};
