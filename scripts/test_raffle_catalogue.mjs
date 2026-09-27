import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('const APPLIES =');
const end=html.indexOf('const ORIPAS =',start);
assert.ok(start>=0&&end>start);
const applies=vm.runInNewContext(html.slice(start,end)+'APPLIES');
assert.equal(applies.length,3);
const anniversary=applies.find(a=>a.title.includes('30주년'));
const onepiece=applies.find(a=>a.brand==='원피스');
assert.equal(anniversary.multi.length,11);
assert.equal(onepiece.multi.length,3);
assert.equal(anniversary.multi[0].url,'https://www.amazon.co.jp/dp/B0GXCRBL5J');
assert.equal(onepiece.multi[0].url,'https://www.amazon.co.jp/dp/B0HFVPJF4Q');
assert.match(anniversary.prize,/30th CELEBRATION 박스/);
assert.match(onepiece.prize,/OP-18 신의 지배/);
assert.match(onepiece.boxLabelKo,/OP-16\/OP-17\/OP-18/);
for(const a of applies){
  assert.equal(parseInt(a.boxLabelKo,10),a.multi.length,'displayed count matches links');
  assert.equal(new Set(a.multi.map(m=>m.url)).size,a.multi.length,'no duplicate links');
  for(const m of a.multi)assert.equal(new URL(m.url).protocol,'https:');
}
assert.equal(applies.reduce((n,a)=>n+a.multi.length,0),23);
assert.ok(anniversary.multi.some(m=>m.url==='https://amzn.asia/d/00LwULlw'));
assert.ok(onepiece.multi.some(m=>m.url==='https://amzn.asia/d/004tSPRy'));
assert.ok(onepiece.multi.some(m=>m.url==='https://amzn.asia/d/04idlHpw'));
console.log('PASS: 3 raffle groups, 23 links, new BOX/OP-18 URLs, counts and existing links');
