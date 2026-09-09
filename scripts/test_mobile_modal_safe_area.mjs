import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const read = path => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const html = read('index.html');
const classes = new Set();
let back, focusCount = 0;
const modal = {
  id:'anyModal', innerHTML:'',
  style:{display:'none', removeProperty(key){delete this[key];}},
  classList:{add(...names){names.forEach(n=>classes.add(n));}, remove(...names){names.forEach(n=>classes.delete(n));}, contains(n){return classes.has(n);}},
  removeAttribute(){}, _ciOpener:{focus(){focusCount++;}}
};
const body = {style:{overflow:''}};
const context = vm.createContext({
  document:{body,getElementById:()=>modal,querySelector:()=>classes.has('open')?modal:null,addEventListener(){}},
  window:{Capacitor:{Plugins:{App:{addListener(name, handler){assert.equal(name,'backButton');back=handler;}}}}},
  location:{hash:'#cardinfo'}, CI_PANEL_REQUEST:0
});
vm.runInContext(html.slice(html.indexOf('function openAnyModal('), html.indexOf('let CURRENT_USER =')),context);
vm.runInContext(html.match(/\(function setupCapacitorBack\(\) \{[\s\S]*?\r?\n\}\)\(\);/)[0],context);
for (const set of ['M6','OP17','M5','OP16']) {
  context.openAnyModal(set,'wide'); classes.add('ci-panel');
  assert.ok(classes.has('open'));
  assert.notEqual(modal.style.display,'none','reopening must clear legacy inline hiding');
  assert.equal(body.style.overflow,'hidden');
  back({canGoBack:true});
  assert.ok(!classes.has('open'));
  assert.equal(body.style.overflow,'','native back restores scroll');
}
assert.equal(context.CI_PANEL_REQUEST,4,'native back cancels old card requests');
assert.equal(focusCount,4);

const safeScript = read('games/shared/safe-area.js');
for (const platform of ['web','android','ios']) {
  const root = {dataset:{}};
  let tick, cleared = false;
  const native = {isNativePlatform:()=>platform!=='web',getPlatform:()=>platform};
  const sandbox = vm.createContext({window:{Capacitor:native},document:{documentElement:root},setInterval(fn){tick=fn;return 1;},clearInterval(){cleared=true;}});
  vm.runInContext(safeScript,sandbox);
  assert.equal(root.dataset.gamePlatform,platform==='web'?undefined:platform);
  if(platform==='web'){for(let n=0;n<20;n++)tick();assert.ok(cleared);}
}
const lateRoot={dataset:{}};let lateTick;
const lateWindow={};
vm.runInNewContext(safeScript,{window:lateWindow,document:{documentElement:lateRoot},setInterval(fn){lateTick=fn;return 1;},clearInterval(){}});
lateWindow.Capacitor={isNativePlatform:()=>true,getPlatform:()=> 'android'};lateTick();
assert.equal(lateRoot.dataset.gamePlatform,'android','late bridge injection');
const css=read('games/shared/brand.css');
assert.match(css,/body\s*\{[^}]*padding-top: var\(--game-safe-top\);[^}]*padding-bottom: var\(--game-safe-bottom\)/);
assert.match(css,/\.arena\.expanded\s*\{[^}]*--game-safe-top[^}]*--game-safe-bottom/);
assert.match(css,/\.game-focus \.arena\s*\{[^}]*--game-safe-top[^}]*--game-safe-bottom/);
for(const game of ['volleyball','jigglypuff']) {
  assert.match(read(`games/${game}/index.html`),/shared\/safe-area.js\?v=1/);
  assert.match(read(`games/${game}/index.html`),/shared\/brand.css\?v=2/);
}
console.log('PASS: native-back/reopen x4, stale hide recovery, request cancellation, scroll/focus restoration; web/iOS/Android + late native bridge; both games and expanded layouts');
