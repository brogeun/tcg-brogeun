import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {join, dirname} from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const start = html.indexOf('const CARDINFO = {');
const end = html.indexOf('/* ─────────── 세트 카드 그리드 모달', start);
const list = {innerHTML:''};
const ctx = vm.createContext({
  document:{getElementById:() => list},
  escapeHtml:value => String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'),
});
vm.runInContext(html.slice(start,end),ctx);
const counts = {};
for (const brand of ['pokemon','onepiece']) {
  vm.runInContext(`CI_TAB='${brand}'; CI_QUERY=''; renderCardInfo();`,ctx);
  counts[brand] = vm.runInContext(`CARDINFO.${brand}.length`,ctx);
  assert.equal([...list.innerHTML.matchAll(/class="set-tile"/g)].length, counts[brand]);
  assert.equal([...list.innerHTML.matchAll(/발매일:/g)].length, counts[brand]);
  assert.equal([...list.innerHTML.matchAll(/class="set-tile-name" title=/g)].length, counts[brand]);
}
vm.runInContext("CI_TAB='pokemon'; CI_QUERY='무니키스'; renderCardInfo();",ctx);
assert.match(list.innerHTML, /data-set-code="M3"/);
assert.equal(vm.runInContext("CARDINFO.pokemon.find(s=>s.code==='M3').boxId",ctx),'743533');
vm.runInContext("CI_QUERY='<img src=x onerror=alert(1)>'; renderCardInfo();",ctx);
assert(!list.innerHTML.includes('<img src=x'));
assert(list.innerHTML.includes('&lt;img'));
vm.runInContext("CI_TAB='onepiece'; CI_QUERY='op15'; renderCardInfo();",ctx);
assert.match(list.innerHTML,/data-set-code="OP15"/);
let jsonFiles = 0;
for (const name of readdirSync(join(root,'data/cards-by-set'))) {
  if (!name.endsWith('.json')) continue;
  JSON.parse(readFileSync(join(root,'data/cards-by-set',name),'utf8').replace(/^\uFEFF/,''));
  jsonFiles++;
}
assert.match(html, /cards\.slice\(\(page - 1\) \* CI_CARD_PAGE_SIZE, page \* CI_CARD_PAGE_SIZE\)/);
console.log(JSON.stringify({ok:true,sets:counts,jsonFiles,searchAndEscaping:true,box743533:true}));
