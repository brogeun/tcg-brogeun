/* Exact existing Japanese product artwork. Printed cards and market IDs stay unchanged. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.JapaneseSetArtwork = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const local = Object.freeze({
    SV1S: '/images/box/SV1S.webp', SV1V: '/images/box/SV1V.webp',
    S12a: '/images/box/s12a.webp', S12: '/images/box/s12.webp',
    S11a: '/images/box/s11a.webp', S11: '/images/box/s11.webp',
    S10b: '/images/box/s10b.webp', S10a: '/images/box/s10a.webp',
    S9a: '/images/box/s9a.webp', S9: '/images/box/s9.webp',
    S8b: '/images/box/s8b.webp', S8: '/images/box/s8.webp',
    S7R: '/images/box/s7R.webp', S7D: '/images/box/s7D.webp',
    S6a: '/images/box/s6a.webp'
  });
  const packs = Object.freeze({
    BSTXY: {image:'https://www.pokemon-card.com/products/xy/best_of_xy/images/20170330/SM_XY_pillow_1221.jpg', sourceUrl:'https://www.pokemon-card.com/products/xy/best_of_xy.html'},
    CP3: {image:'https://www.pokemon-card.com/products/2016/images/1232_CP3_pillow_img_151102.jpg', sourceUrl:'https://www.pokemon-card.com/products/xy/cp3.html'},
    CP1: {image:'https://www.pokemon-card.com/products/2016/images/6c18f847b875b342a73ca676992af3a2b2dbb567.jpg', sourceUrl:'https://www.pokemon-card.com/products/xy/cp1.html'},
    CP2: {image:'https://www.pokemon-card.com/products/2016/images/b15cce99bb9203d5de6b9f614d6e5d926cc35cb4.jpg', sourceUrl:'https://www.pokemon-card.com/products/xy/cp2.html'},
    CP4: {image:'https://www.pokemon-card.com/products/2016/images/be01a69f5c4c10b49bdd57acc3aa404bbe5e5a5b.jpg', sourceUrl:'https://www.pokemon-card.com/products/xy/cp4.html'},
    CP5: {image:'https://www.pokemon-card.com/products/2016/images/9aa63484ccb024a7d40297b2fc9e488ed15d9356.jpg', sourceUrl:'https://www.pokemon-card.com/products/xy/cp5.html'},
    CP6: {image:'https://www.pokemon-card.com/20th/assets/images/products/1goodspackage.png', sourceUrl:'https://www.pokemon-card.com/products/xy/cp6.html'},
    S8a: {image:'https://www.pokemon-card.com/ex/25th/assets/images/products/20210625-1-1.png', sourceUrl:'https://www.pokemon-card.com/ex/25th/products/'},
    S10D: {image:'https://www.pokemon-card.com/ex/s10/assets/images/hero-img-2.png', sourceUrl:'https://www.pokemon-card.com/ex/s10/index.html'},
    S10P: {image:'https://www.pokemon-card.com/ex/s10/assets/images/hero-img-3.png', sourceUrl:'https://www.pokemon-card.com/ex/s10/index.html'}
  });
  function image(set, fallback = '') {
    if (!set || typeof set !== 'object') return fallback;
    const explicit = String(set.image || '').trim();
    // Only the exact known nonexistent generated path may be superseded.
    // A verified explicit photo, even on an external source, always wins.
    const generated = '/images/sets/' + encodeURIComponent(String(set.code || '')) + '.jpg';
    if (explicit && explicit.replace(/^\/?/, '/') !== generated) return explicit;
    return local[set.code] || packs[set.code]?.image || explicit || fallback;
  }
  function kind(set) {
    return packs[set?.code] && image(set) === packs[set.code].image ? 'pack' : '';
  }
  return {image, kind, local, packs};
});
