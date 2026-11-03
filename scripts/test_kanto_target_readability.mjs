import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {positionSelectedLabel,selectedTargetDetail} from '../games/kanto151/src/target-readability.mjs';
import {visibleWildLabels} from '../games/kanto151/src/hud-layout.mjs';
import {installCanopyVisibility,updateCanopyFocus} from '../games/kanto151/src/canopy-visibility.mjs';

const vector=(x=0,y=0,z=0)=>({x,y,z,clone(){return vector(this.x,this.y,this.z);},copy(p){this.x=p.x;this.y=p.y;this.z=p.z;return this;}});
const overlap=(a,b)=>a.x<b.x+b.w&&a.x+a.w>b.x&&a.y<b.y+b.h&&a.y+a.h>b.y;

test('selected label remains inside a narrow mobile viewport at all four edges',()=>{
 for(const anchor of [{x:0,y:3},{x:319,y:3},{x:0,y:550},{x:319,y:550}]){
  const p=positionSelectedLabel(anchor,{w:160,h:55},[],{width:320,height:568});
  assert.ok(p.x>=8&&p.y>=8&&p.x+p.w<=312&&p.y+p.h<=560);
 }
 assert.equal(positionSelectedLabel({x:50,y:50},{w:400,h:50},[],{width:320,height:568}),null);
});

test('selected label moves below an actor when the default position would cover HUD',()=>{
 const obstacles=[{x:84,y:68,w:145,h:60}],viewport={width:360,height:640};
 const p=positionSelectedLabel({x:160,y:120},{w:130,h:45},obstacles,viewport);
 assert.equal(p.clear,true);assert.equal(obstacles.some(o=>overlap(p,o)),false);
 const visible=visibleWildLabels([{...p,id:'target',selected:true,distance:8}],obstacles,viewport);
 assert.ok(visible.has('target'));
});

test('selected label wins over another nearby label without adding target or capture rules',()=>{
 const viewport={width:390,height:700},p=positionSelectedLabel({x:180,y:230},{w:140,h:55},[],viewport);
 const visible=visibleWildLabels([{...p,id:'ordinary',selected:false,distance:2},{...p,id:'target',selected:true,distance:20}],[],viewport);
 assert.deepEqual([...visible],['target']);
 assert.deepEqual(selectedTargetDetail({hp:8.2,maxHp:23},11.6),{label:'선택 대상',detail:'12m · HP 9/23'});
 assert.equal(selectedTargetDetail({hp:23,maxHp:23},4,'en-US').label,'Selected target');
});

test('foliage keeps both player and selected target sightline references live',()=>{
 const world={camera:{position:vector(8,10,12)},cameraTarget:vector()},material={userData:{}};
 assert.equal(installCanopyVisibility(material,world),true);
 const shader={uniforms:{},vertexShader:'#include <project_vertex>',fragmentShader:'#include <clipping_planes_fragment>'};
 material.onBeforeCompile(shader);
 assert.equal(shader.uniforms.canopySightTarget.value,world.cameraTarget);
 assert.equal(shader.uniforms.canopySelectedActive.value,0);
 const actor={hp:20,model:{position:vector(6,2,4),visible:true,userData:{height:2}}};
 assert.equal(updateCanopyFocus(world,actor),true);
 assert.equal(shader.uniforms.canopySelectedActive.value,1);
 assert.deepEqual([shader.uniforms.canopySelectedTarget.value.x,shader.uniforms.canopySelectedTarget.value.y,shader.uniforms.canopySelectedTarget.value.z],[6,2.9,4]);
 actor.model.position.x=9;updateCanopyFocus(world,actor);
 assert.equal(shader.uniforms.canopySelectedTarget.value.x,9);
 for(const invalid of [null,{...actor,hp:0},{...actor,capturing:true},{...actor,model:{...actor.model,visible:false}}]){
  assert.equal(updateCanopyFocus(world,invalid),false);assert.equal(shader.uniforms.canopySelectedActive.value,0);
 }
 assert.match(shader.fragmentShader,/if \(canopySelectedActive > 0\.5\)/);
 assert.match(shader.fragmentShader,/canopyOpening\(canopySelectedTarget/);
});

test('canopy shader hooks preserve inherited code and install once per material',()=>{
 const world={camera:{position:vector()},cameraTarget:vector()},material={userData:{},onBeforeCompile(s){s.fragmentShader='// wind\n'+s.fragmentShader;},customProgramCacheKey(){return 'wind';}};
 installCanopyVisibility(material,world);const hook=material.onBeforeCompile;installCanopyVisibility(material,world);assert.equal(material.onBeforeCompile,hook);
 const shader={uniforms:{},vertexShader:'#include <project_vertex>',fragmentShader:'#include <clipping_planes_fragment>'};material.onBeforeCompile(shader);
 assert.match(shader.fragmentShader,/\/\/ wind/);assert.equal(material.customProgramCacheKey(),'wind|canopy-sightline-v2');
 const custom={uniforms:{},vertexShader:'custom',fragmentShader:'custom'};material.onBeforeCompile(custom);assert.deepEqual(custom.uniforms,{});
});

test('readability changes leave capture controls and chance calculation unchanged',()=>{
 const ui=readFileSync(new URL('../games/kanto151/src/ui.mjs',import.meta.url),'utf8');
 assert.match(ui,/\$\('#throw-button'\)\.onclick=\(\)=>this\.game\.throwBall\(\)/);
 assert.match(ui,/updateCanopyFocus\(g\.world,focus\)/);
 assert.match(ui,/a\.tacticalTellUntil>g\.save\.playTime/);
 assert.doesNotMatch(ui,/aim-range|precisionBonus|perfectThrow/);
});

test('an obsolete dex preview cannot overwrite the next species shiny button',async()=>{
 const source=readFileSync(new URL('../games/kanto151/src/ui.mjs',import.meta.url),'utf8').replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,'');
 const nodes=new Map(),node=key=>{if(!nodes.has(key))nodes.set(key,{innerHTML:'',onclick:null,classList:{toggle(){}},addEventListener(){}});return nodes.get(key);};
 const document={querySelector:node},UI=new Function('document','currentLocale','t','TYPE_COLORS','localizeDOM','entity',source+'\nreturn UI;')(document,()=> 'ko-KR',key=>key,{normal:'#aaa'},()=>{},(_,key)=>key);
 const species={id:1,name:'이상해씨',types:['normal'],evolutions:[],baseStats:{},habitatHint:'숲',genus:'씨앗',height:1,weight:1};
 const pending=[],ui=Object.assign(Object.create(UI.prototype),{game:{byId:new Map([[1,species],[2,{...species,id:2}]]),save:{dex:{1:{seen:true,shinySeen:true},2:{seen:true,shinySeen:true}}}},cleanupPreviews(){},preview:()=>new Promise(resolve=>pending.push(resolve))});
 ui.dexDetail(1);ui.dexDetail(2);
 pending[0](undefined);await Promise.resolve();assert.equal(node('#dex-shiny').onclick,null);
 let applied=null;pending[1]({model:{userData:{setShiny:async next=>{applied=next;}}}});await Promise.resolve();
 assert.equal(typeof node('#dex-shiny').onclick,'function');
 node('#dex-shiny').isConnected=true;ui.previewEpoch=2;await node('#dex-shiny').onclick();
 assert.equal(applied,true);assert.equal(node('#dex-shiny').disabled,false);
});
