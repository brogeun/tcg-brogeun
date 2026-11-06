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
  // These exact existing assets were already used by the main set list. Share
  // the same registry with synthesized catalogue/search boxes and detail views.
  const legacy = Object.freeze(Object.fromEntries([
    'S6H','S6K','S5a','S5R','S5I','S4a','S4','S3a','S3','S2a','S2','S1a','S1H','S1W',
    'SM12a','SM12','SM11b','SM11a','SM11','SM10b','SM10a','SM10','SM9b','SM9a','SM9',
    'SM8b','SM8a','SM8','SM7b','SM7a','SM7','SM6b','SM6a','SM6','SM5+','SM5M','SM5S',
    'SM4+','SM4S','SM4A','SM3+','SM3H','SM3N','SM2+','SM2L','SM2K','SM1+','SM1M','SM1S',
    'XY11-Br','XY11-Bb','XY10','XY9','XY8-Br','XY8-Bb','XY7','XY6','XY5-Bt','XY5-Bg',
    'XY4','XY3','XY2','XY1-By','XY1-Bx','BW9','BW8-Brn','BW8-Brf','BW7','BW6-Bf',
    'BW6-Bc','BW5-Brz','BW5-Brn','BW4','BW3-Bh','BW3-Bp','BW2','BW1-Bw','BW1-Bb',
    'L3','L2','L1-Bss','L1-Bhg','Pt4','Pt3','Pt2','Pt1','DP6','DP5','DP4-Bd','DP4-Bm',
    'DP3','DP2','DP1','PCG9','PCG8','PCG7','PCG6','PCG5','PCG4','PCG3','PCG2','PCG1',
    'ADV4','ADV3','ADV2','ADV1','e5','e4','e3','e2','e1','Neo4','Neo3','Neo2','Neo1',
    'Gym2','Gym1','CL4','CL3','CL2','CL1'
  ].map(code => [code, '/images/box2/' + code + '.webp'])));
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
  const recovered = Object.freeze({
  "SMP2": {
    "image": "https://cdn.snkrdunk.com/upload_bg_removed/715702d8-8d33-44ac-ae99-43280802ab04.webp?size=l",
    "kind": "box",
    "sourceUrl": "https://snkrdunk.com/apparels/15555"
  },
  "EBB": {
    "image": "https://cdn.snkrdunk.com/upload_bg_removed/4d1292bb-7fa5-40a7-b5bf-32ed28775beb.webp?size=l",
    "kind": "box",
    "edition": "1ED",
    "sourceUrl": "https://snkrdunk.com/apparels/480863"
  },
  "SC": {
    "image": "https://cdn.snkrdunk.com/upload_bg_removed/7ed5eae7-239a-47e3-b835-2344b5709b35.webp?size=l",
    "kind": "box",
    "edition": "1ED",
    "sourceUrl": "https://snkrdunk.com/apparels/480865"
  },
  "DS": {
    "image": "https://cdn.snkrdunk.com/upload_bg_removed/dad06e44-e4de-4319-8fa0-fb42080c13b7.webp?size=l",
    "kind": "box",
    "edition": "1ED",
    "sourceUrl": "https://snkrdunk.com/apparels/480861"
  },
  "SD": {
    "image": "https://www.pokemon-card.com/ex/sd/assets/images/hero-mv-550.png",
    "kind": "deck-group",
    "sourceUrl": "https://www.pokemon-card.com/ex/sd/index.html"
  },
  "VS": {
    "image": "/images/japanese-products/VS.webp",
    "kind": "box",
    "sourceUrl": "https://www.artofpkm.com/products/2944"
  },
  "WEB": {
    "image": "/images/japanese-products/WEB.jpg",
    "kind": "pack",
    "sourceUrl": "https://www.cardrush-pokemon.jp/product/14787"
  },
  "ADV4-SEAL": {
    "image": "/images/japanese-products/ADV4-SEAL.png",
    "kind": "box",
    "sourceUrl": "https://crownrareco.com/products/japanese-undone-seal-booster-box"
  },
  "VS-MANAPHY": {
    "image": "/images/japanese-products/VS-MANAPHY.jpg",
    "kind": "pack",
    "sourceUrl": "https://www.cardrush-pokemon.jp/product/14849"
  },
  "WCP": {
    "image": "/images/japanese-products/WCP.jpg",
    "kind": "pack",
    "sourceUrl": "https://jp.mercari.com/item/m95180942453"
  },
  "DP5-TW": {
    "image": "/images/japanese-products/DP5-TW.png",
    "kind": "box",
    "sourceUrl": "https://www.japan2uk.com/products/pokemon-temple-of-anger-dp5-japanese-booster-box?open-restock=1"
  },
  "DPt-MRP09": {
    "image": "/images/japanese-products/DPt-MRP09.png",
    "kind": "pack",
    "sourceUrl": "https://www.cardshop-hanjou.jp/product/20777"
  },
  "LL": {
    "image": "/images/japanese-products/LL.webp",
    "kind": "box",
    "sourceUrl": "https://snkrdunk.com/apparels/86000"
  }
});
  function image(set, fallback = '') {
    if (!set || typeof set !== 'object') return fallback;
    const explicit = String(set.image || '').trim();
    // Only the exact known nonexistent generated path may be superseded.
    // A verified explicit photo, even on an external source, always wins.
    const generated = '/images/sets/' + encodeURIComponent(String(set.code || '')) + '.jpg';
    if (explicit && explicit.replace(/^\/?/, '/') !== generated) return explicit;
    return local[set.code] || recovered[set.code]?.image || legacy[set.code] || packs[set.code]?.image || explicit || fallback;
  }
  function kind(set) {
    if (recovered[set?.code] && image(set) === recovered[set.code].image) return recovered[set.code].kind;
    return packs[set?.code] && image(set) === packs[set.code].image ? 'pack' : '';
  }
  return {image, kind, local, legacy, packs, recovered};
});
