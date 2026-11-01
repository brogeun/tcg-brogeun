import {parseHTML} from './fixtures/linkedom.worker.mjs';
import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const root=new URL('../',import.meta.url),read=p=>fs.readFileSync(new URL(p,root),'utf8');
const {window,document}=parseHTML('<html><body><div id="ciTabs"></div><div id="cardInfoList"></div></body></html>');
const errors=[];
const context={window,document,renderCardInfo(){},CI_TAB:'pokemon',CI_QUERY:'',CI_PANEL_REQUEST:0,location:{search:'',hash:''},URLSearchParams,Date,Map,Set,console:{warn(...v){errors.push(v);}},ResizeObserver:class{observe(){}disconnect(){}},fetch:async url=>({ok:true,json:async()=>JSON.parse(read(url.split('?')[0].slice(1)))})};
vm.createContext(context);
const html=read('index.html'),start=html.indexOf('function openAnyModal('),end=html.indexOf("document.addEventListener('keydown', e => { if (e.key === 'Escape') closeAnyModal(); });",start);
vm.runInContext(html.slice(start,end),context);
vm.runInContext(read('assets/korean-promos.js'),context);
assert.equal(document.querySelector('#ciTabs button:last-child').textContent,'한국 프로모');
const manifest=JSON.parse(read('data/korean-promos.json'));
for(const c of manifest.cards){
 await context.window.KoreanPromos.open(c.id);
 assert.equal(document.getElementById('kpTitle').textContent,c.name);
 const select=document.getElementById('kpOption');
 const grade=document.getElementById('kpGrade'),api=context.window.KoreanPromos;
 assert.deepEqual(Array.from(grade.children).map(o=>o.value),Array.from(api.gradeOptions(Object.keys(c.counts_by_exact_option))));
 const initialOption=Object.keys(c.counts_by_exact_option).find(o=>o==='Ungraded A (Pack Ver.)')||Object.keys(c.counts_by_exact_option).find(o=>o.startsWith('Ungraded A'))||Object.keys(c.counts_by_exact_option)[0];
 assert.equal(document.querySelectorAll('#kpChart circle').length,c.counts_by_exact_option[initialOption]);
 assert(document.getElementById('kpRowCount').textContent.includes(c.counts_by_exact_option[initialOption].toLocaleString()));
 for(const option of Object.keys(c.counts_by_exact_option)){
  Object.defineProperty(grade,'value',{value:api.gradeKey(option),configurable:true});
  grade.dispatchEvent(new window.Event('change',{bubbles:true}));
  const variants=Object.keys(c.counts_by_exact_option).filter(o=>api.gradeKey(o)===api.gradeKey(option));
  assert.deepEqual(Array.from(select.children).map(o=>o.value),variants);
  assert.equal(document.getElementById('kpVariantLabel').hidden,variants.length<2);
  Object.defineProperty(select,'value',{value:option,configurable:true});
  select.dispatchEvent(new window.Event('change',{bubbles:true}));
  assert.equal(document.querySelectorAll('#kpChart circle').length,c.counts_by_exact_option[option]);
  const expected=c.latest_price_by_option[option].price_krw.toLocaleString('ko-KR')+'원';
  assert.equal(document.getElementById('kpPrice').textContent,expected);
  const trades=Array.from(document.querySelectorAll('#kpRows tr td:nth-child(2)'));
  assert(trades.every(cell=>cell.textContent.includes(api.gradeKey(option).replace('Ungraded A','미감정 A'))));
  assert(document.querySelectorAll('#kpRows tr').length<=50);
 }
 document.querySelector('[data-kp-days="30"]').click();
 assert.equal(document.querySelector('[data-kp-days="30"]').getAttribute('aria-pressed'),'true');
 document.querySelector('[data-kp-close]').click();
 assert(!document.getElementById('anyModal').classList.contains('open'));
}
assert.equal(errors.length,0,JSON.stringify(errors));
console.log(JSON.stringify({ok:true,cards:7,allExactOptions:true,brgGradeAndLabelIsolation:true,fullTradeSvg:true,periodControls:true,sharedModal:true}));
