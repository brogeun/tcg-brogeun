const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

let automaticScans = 0;
const context = vm.createContext({window: {}, URL,
  document: {querySelectorAll() { automaticScans++; throw new Error('automatic scan'); }},
});
vm.runInContext(fs.readFileSync('assets/card-thumbnails.js', 'utf8'), context);
const thumbnails = context.window.CardThumbnails;
assert.equal(automaticScans, 0, 'loading the helper must do no DOM or network work');
assert.equal(thumbnails.apply(null), 0);

class ImageFixture {
  constructor(src, {listed = true, detail = false, srcset = null, onerror = null} = {}) {
    this.tagName = 'IMG'; this.listed = listed; this.detail = detail; this.onerror = onerror;
    this.attrs = new Map([['src', src]]); this.dataset = {};
    if (srcset !== null) this.attrs.set('srcset', srcset);
  }
  get src() { return this.getAttribute('src'); }
  getAttribute(name) { return this.attrs.get(name) || null; }
  setAttribute(name, value) { this.attrs.set(name, value); if (name === 'data-original-src') this.dataset.originalSrc = value; }
  hasAttribute(name) { return this.attrs.has(name); }
  matches(selector) { assert(selector.includes('.gs-row > img.gs-thumb')); return this.listed; }
  closest(selector) {
    assert(selector.includes('#priceDetailPanel') && selector.includes('.ci-card-detail') && selector.includes('.enc-detail'));
    return this.detail ? {} : null;
  }
}
const base = 'https://cdn.snkrdunk.com/upload_bg_removed/4bfe7bdb-4f7e-4398-9689-334e15831532.webp';
const scope = (...images) => ({querySelectorAll: () => images});
const original = base + '?signature=a%2Fb%2B%3D&size=l&token=x+y&keep=%7e#original';
const image = new ImageFixture(original);
assert.equal(thumbnails.apply(scope(image)), 1);
const smaller = original.replace('size=l', 'size=m');
assert.equal(image.src, smaller, 'only the proven provider size parameter changes');
assert.equal(image.dataset.originalSrc, original);
assert.equal(thumbnails.original(image), original);
assert.equal(thumbnails.original(smaller), original);
assert.equal(thumbnails.apply(scope(image)), 0, 'reapplying must not stack error wrappers or rewrite again');
assert.equal(thumbnails.original(base + '?size=s'), base + '?size=s', 'unseen small URLs are never guessed to be originals');

const unchanged = [
  base + '?size=m', base + '?size=s', base + '?size=l856x856', base + '?size=m398x398',
  base + '?size=l&size=l', base + '?size=%6c', base,
  base.replace('https:', 'http:') + '?size=l',
  base.replace('cdn.snkrdunk.com', 'cdn.snkrdunk.com.example.test') + '?size=l',
  base.replace('cdn.snkrdunk.com', 'example.test@cdn.snkrdunk.com') + '?size=l',
  base.replace('cdn.snkrdunk.com', 'cdn.snkrdunk.com:444') + '?size=l',
  base.replace('/upload_bg_removed/', '/different/') + '?size=l',
  '/images/onepiece-official/EB01-003_p2.webp?size=l',
  '/images/pokemon-en-sheets/SV01-000-fixture.webp?size=l',
  'https://www.onepiece-cardgame.com/images/cardlist/card/EB01-003.png?size=l',
  '/api/img?u=' + encodeURIComponent(base + '?size=l'),
];
for (const src of unchanged) {
  const fixture = new ImageFixture(src);
  assert.equal(thumbnails.apply(scope(fixture)), 0, src);
  assert.equal(fixture.src, src);
  assert.equal(thumbnails.original(fixture), src);
}
for (const options of [{detail: true}, {listed: false}, {srcset: base + '?size=l 856w'}]) {
  const fixture = new ImageFixture(base + '?size=l', options);
  assert.equal(thumbnails.apply(scope(fixture)), 0, 'detail, unsupported profiles, and existing srcset are untouched');
}

let priorErrors = 0, priorThis, priorEvent;
const fallback = new ImageFixture(base + '?size=l', {onerror(event) { priorErrors++; priorThis = this; priorEvent = event; }});
thumbnails.apply(scope(fallback));
const firstError = {type: 'error'}, secondError = {type: 'error', originalFailed: true};
fallback.onerror(firstError);
assert.equal(fallback.src, base + '?size=l', 'a failed thumbnail retries the exact original once');
assert.equal(priorErrors, 0, 'legacy hide/remove fallback waits until the original also fails');
assert.equal(thumbnails.apply(scope(fallback)), 0, 'an intentional original retry must not turn into a thumbnail retry loop');
fallback.onerror(secondError);
assert.equal(priorErrors, 1);
assert.equal(priorThis, fallback);
assert.equal(priorEvent, secondError);

const reused = new ImageFixture(base + '?size=l');
thumbnails.apply(scope(reused));
const replacement = base.replace('4bfe7bdb', '9e6e18b1') + '?size=l';
reused.setAttribute('src', replacement);
assert.equal(thumbnails.original(reused), replacement, 'reused list nodes cannot retain stale artwork identity');
assert.equal(thumbnails.apply(scope(reused)), 1);
assert.equal(thumbnails.original(reused), replacement);

// A long browsing session cannot retain an unbounded URL table. Elements retain
// their own exact originals even after older string lookups are evicted.
const first = new ImageFixture(base + '?size=l&fixture=first');
thumbnails.apply(scope(first));const oldVariant = first.src;
for (let i = 0; i < 520; i++) thumbnails.apply(scope(new ImageFixture(base + '?size=l&fixture=' + i)));
assert.equal(thumbnails.original(oldVariant), oldVariant, 'reverse URL lookup is bounded');
assert.equal(thumbnails.original(first), base + '?size=l&fixture=first', 'element original survives URL-map eviction');
const restored = new ImageFixture(first.src);
restored.setAttribute('data-original-src', base + '?size=l&fixture=first');
assert.equal(thumbnails.original(restored), base + '?size=l&fixture=first', 'preserved data attribute is sufficient after a helper reload');

console.log('PASS: explicit scoped thumbnails, exact provider query preservation, detail/atlas exclusions, original artwork identity, one-shot original fallback, existing error chain, bounded reverse lookup, no automatic work');

// Legacy Japanese set markup uses this list hook before the user opens a detail.
const gridPhoto = new ImageFixture(base + '?size=m');
gridPhoto.parentElement = {classList:{contains:name=>name==='set-card-img'},closest:selector=>selector==='.set-card-grid'};
const gridProxy='/api/img?u='+encodeURIComponent(gridPhoto.src);
context.window.CardArtwork={
  gridURL:url=>url===base+'?size=m'?gridProxy:url,
  proxyOriginal:img=>img?.src===gridProxy?img.getAttribute('data-artwork-original'):''
};
assert.equal(thumbnails.apply(scope(gridPhoto)),1);
assert.equal(gridPhoto.src,gridProxy);
assert.equal(thumbnails.original(gridPhoto),base+'?size=m');
assert.equal(thumbnails.apply(scope(gridPhoto)),0);
gridPhoto.setAttribute('src',base+'?size=m');gridPhoto.setAttribute('data-artwork-direct',gridPhoto.src);
assert.equal(thumbnails.apply(scope(gridPhoto)),0,'a failed proxy must not be selected again on rescans');

const largeGridSource=base+'?size=l';
const preselectedGrid=new ImageFixture(base+'?size=m');
preselectedGrid.parentElement=gridPhoto.parentElement;
preselectedGrid.setAttribute('data-original-src',largeGridSource);
context.window.CardArtwork={
  gridURL:url=>url===largeGridSource?gridProxy:url,
  proxyOriginal:img=>img?.src===gridProxy?img.getAttribute('data-artwork-original'):''
};
assert.equal(thumbnails.apply(scope(preselectedGrid)),1);
assert.equal(preselectedGrid.src,gridProxy);
assert.equal(thumbnails.original(preselectedGrid),largeGridSource,'preselected catalogue thumbnails keep full-resolution details');
