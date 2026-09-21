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
  assert.equal(url.hostname, 'm.place.naver.com');
  assert.equal(url.protocol, 'https:');
  assert.match(url.pathname, /^\/place\/\d+\/home$/);
  assert.ok(!url.href.includes('/search'));
  assert.equal(shop.imageFit, shop===gangneung ? 'cover' : 'contain');
  assert.ok(!('stock' in shop));
}
assert.equal(gangneung.map, 'https://m.place.naver.com/place/2022221043/home');
assert.equal(gangneung.imageCrop, 'shop-logo');
assert.equal(gangneung.phone, '070-8680-8510');
const verifiedPlaces = [
  ['옵티멈존 강남 1호점','1064489588','강남대로94길 10'],
  ['옵티멈존 산본역점','1545573674','산본로323번길 10-6'],
  ['옵티멈존 신촌점','1912135247','명물길 23'],
  ['옵티멈존 강남 2호점','2030875583','서초대로78길 44'],
  ['옵티멈존 방배역점','1051340093','방배로 83'],
  ['옵티멈존 서울대입구역점','2145901241','남부순환로 1808'],
  ['오즈보드게임 구래점','2008779906','김포한강9로 80'],
  ['오즈보드게임 노원점','2085925033','노해로81길 12-15'],
  ['오즈보드게임 고대점','2077232291','고려대로24길 51'],
  ['오즈보드게임 서현점','2045982777','분당로53번길 21'],
  ['오즈보드게임 성신여대점','2043674790','동소문로20가길 12']
];
assert.equal(new Set(shops.riftbound.map(s=>s.naverPlaceId)).size,11);
for (const [name,id,road] of verifiedPlaces) {
  const shop=shops.riftbound.find(s=>s.name===name);
  assert.equal(shop.map, `https://m.place.naver.com/place/${id}/home`);
  assert.ok(shop.addr.includes(road));
  assert.ok(shop.mapName);
}
// 같은 건물의 PC방으로 잘못 연결되지 않아야 한다.
assert.ok(!shops.riftbound.some(s=>['4221493829','2047966109'].includes(s.naverPlaceId)));
vm.runInContext('renderShops()',context);
assert.match(elements.shopList.innerHTML,/object-position:center top; transform:scale\(1\.035\)/);
assert.match(elements.shopList.innerHTML,/href="tel:07086808510"/);
for (const [brand, count] of [['pokemon',12],['onepiece',23],['riftbound',11]]) {
  assert.ok(html.includes('data-shop-brand="'+brand+'"'));
  vm.runInContext('SHOP_BRAND='+JSON.stringify(brand)+';renderShops()', context);
  assert.equal((elements.shopList.innerHTML.match(/🗺 네이버지도 열기/g)||[]).length, count);
  assert.match(elements.shopList.innerHTML, /target="_blank"/);
  assert.ok(!elements.shopList.innerHTML.includes('undefined'));
  assert.ok(!elements.shopList.innerHTML.includes('공식 안내 확인'));
  assert.equal((elements.shopList.innerHTML.match(/class="shop-contact"/g)||[]).length,count);
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
