import assert from 'node:assert/strict';
import {readFileSync, existsSync} from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');
const elements = {shopList:{innerHTML:''}, shopSrc:{innerHTML:''}};
const context = vm.createContext({window:{}, document:{getElementById:id=>elements[id]}});
const start = html.indexOf('const SHOPS =');
const end = html.indexOf('\nrenderShops();', start);
assert.ok(start > 0 && end > start);
vm.runInContext(html.slice(start, end), context);
const shops = vm.runInContext('SHOPS', context);
assert.equal(shops.pokemon.length, 12);
assert.equal(shops.onepiece.length, 23);
assert.equal(shops.riftbound.length, 11);
assert.equal(new Set(shops.riftbound.map(s=>s.name)).size, 11);
assert.equal(shops.riftbound.filter(s=>s.hours==='연중무휴 24시간').length, 6);
assert.equal(shops.riftbound.filter(s=>s.hours.includes('미확인')).length, 5);
const gangneung = shops.pokemon.find(s=>s.name.includes('강릉'));
assert.match(gangneung.addr, /솔올로 40/);
assert.match(gangneung.hours, /월 휴무/);
assert.equal(gangneung.source, 'https://pokemonkorea.co.kr/pokemon_cardshop/menu809');
const expected = {'강남 1호점':'29','산본역점':'11','신촌점':'3','강남 2호점':'18','방배역점':'25','서울대입구역점':'54'};
for (const [name, id] of Object.entries(expected)) {
  assert.equal(shops.riftbound.find(s=>s.name==='옵티멈존 '+name).source, 'https://zetpl.com/find-store/'+id);
}
for (const shop of [gangneung, ...shops.riftbound]) {
  assert.ok(existsSync(new URL(shop.image, root)), shop.image);
  const url = new URL(shop.map);
  assert.equal(url.hostname, 'map.naver.com');
  assert.equal(url.protocol, 'https:');
  assert.ok(decodeURIComponent(url.pathname).includes(shop.name.replace('포켓몬 카드샵 ', '')));
  assert.equal(shop.imageFit, 'contain');
  assert.ok(!('stock' in shop));
}
for (const [brand, count] of [['pokemon',12],['onepiece',23],['riftbound',11]]) {
  assert.ok(html.includes('data-shop-brand="'+brand+'"'));
  vm.runInContext('SHOP_BRAND='+JSON.stringify(brand)+';renderShops()', context);
  assert.equal((elements.shopList.innerHTML.match(/🗺 네이버지도 열기/g)||[]).length, count);
  assert.match(elements.shopList.innerHTML, /target="_blank"/);
  assert.ok(!elements.shopList.innerHTML.includes('undefined'));
}
assert.match(elements.shopList.innerHTML, /리프트바운드 카드 공식 상품/);
assert.ok(!elements.shopList.innerHTML.includes('원피스 카드 공식 상품'));
assert.match(elements.shopSrc.innerHTML, /zetpl.com\/riftbound/);
context.window.Capacitor = {isNativePlatform:()=>true};
vm.runInContext('renderShops()', context);
assert.ok(!elements.shopList.innerHTML.includes('target="_blank"'));
assert.match(elements.shopList.innerHTML, /target="_self"/);
assert.match(elements.shopSrc.innerHTML, /target="_self"/);
assert.match(html, /max-width: 460px[^}]+auto-shop[^}]+grid-template-columns: 1fr/s);
console.log('PASS: 12 Pokemon / 23 One Piece / 11 Riftbound; sources, hours status, images, map URLs, brand rendering, native targets, mobile grid');
