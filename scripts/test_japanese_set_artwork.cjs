const test = require('node:test');
const assert = require('node:assert/strict');
const artwork = require('../assets/japanese-set-artwork.js');

test('the exact Scarlet and Violet sets use their real existing product images', () => {
  assert.equal(artwork.image({code:'SV1S'}), '/images/box/SV1S.webp');
  assert.equal(artwork.image({code:'SV1V'}), '/images/box/SV1V.webp');
  assert.equal(artwork.image({code:'SV1S',image:'/images/sets/SV1S.jpg'}), '/images/box/SV1S.webp');
  assert.equal(artwork.image({code:'SV1V',image:'images/sets/SV1V.jpg'}), '/images/box/SV1V.webp');
});
test('Sword and Shield asset case matches deployed filenames exactly', () => {
  assert.equal(artwork.image({code:'S12a'}), '/images/box/s12a.webp');
  assert.equal(artwork.image({code:'S7R'}), '/images/box/s7R.webp');
  assert.equal(artwork.image({code:'S7D'}), '/images/box/s7D.webp');
});
test('unrelated products and explicit verified photos cannot be replaced', () => {
  const photo = 'https://cdn.snkrdunk.com/upload_bg_removed/verified-edition.webp';
  const set = {code:'S12a',image:photo,id:'101885',lastPrice:191,currency:'USD'};
  const before = JSON.stringify(set);
  assert.equal(artwork.image(set),photo);
  assert.equal(JSON.stringify(set),before);
  assert.equal(artwork.image({code:'S12a',image:'/images/sets/s12a.jpg'}), '/images/sets/s12a.jpg');
  assert.equal(artwork.image({code:'Neo1'},'/images/box2/Neo1.webp'), '/images/box2/Neo1.webp');
  assert.equal(artwork.image({code:'SV1S-EN'}),'');
  assert.equal(artwork.image({code:'WEB'}),'');
});
test('verified official packaging is explicitly identified as a pack photo', () => {
  assert.equal(artwork.image({code:'BSTXY'}), 'https://www.pokemon-card.com/products/xy/best_of_xy/images/20170330/SM_XY_pillow_1221.jpg');
  assert.equal(artwork.kind({code:'BSTXY'}), 'pack');
  assert.equal(artwork.kind({code:'CP3'}), 'pack');
  assert.equal(artwork.kind({code:'S10P'}), 'pack');
  assert.equal(artwork.kind({code:'S10D'}), 'pack');
  for(const code of ['CP1','CP2','CP4','CP5','CP6','S8a']) assert.equal(artwork.kind({code}), 'pack');
  assert.equal(artwork.kind({code:'BSTXY',image:'https://cdn.snkrdunk.com/correct-box.webp'}), '');
});
