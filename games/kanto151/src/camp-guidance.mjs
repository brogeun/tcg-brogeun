import {BALLS,caughtCount} from './core.mjs';
import {currentLocale} from './i18n.mjs';
const words=(ko,en,locale=currentLocale())=>locale==='ko-KR'?ko:en;
const arrows=['↑','↗','→','↘','↓','↙','←','↖'];
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));

export function facilityGuidance(game,interaction,name=interaction?.facilityName||interaction?.name||'',locale=currentLocale()){
 if(!interaction||!game.player)return name;
 const p=game.player.model.position,dx=interaction.x-p.x,dz=interaction.z-p.z,yaw=game.world.orbit.yaw;
 const right=dx*Math.cos(yaw)-dz*Math.sin(yaw),forward=-dx*Math.sin(yaw)-dz*Math.cos(yaw);
 const arrow=arrows[(Math.round(Math.atan2(right,forward)/(Math.PI/4))+8)%8];
 return name+' · '+arrow+' '+Math.round(Math.hypot(dx,dz))+'m';
}

// Keep explicit habitat/story selections intact; the first locked route teaches
// the collection action before pointing a new player at its closed exit.
export function discoveryGoal(game,goal,locale=currentLocale()){
 const save=game.save,e=game.expedition;
 if(!goal||!save||save.region!==game.homeRegion||save.discovered?.some(id=>id!==game.homeRegion)||!goal.additional||goal.region===save.region||e?.state?.habitatTarget||e?.selectedLandmark||goal.storyId||['run','expedition','elite'].includes(goal.kind))return goal;
 const count=caughtCount(save),required=Math.min(3,goal.required||3);
 if(count>=required)return goal;
 const needed=required-count,p=game.player?.model.position;
 const candidates=(game.wild||[]).filter(a=>a.hp>0&&!a.boss&&!a.capturing&&!a.runEncounter&&!a.eliteId&&!save.dex[a.id]?.caught);
 candidates.sort((a,b)=>p?Math.hypot(a.model.position.x-p.x,a.model.position.z-p.z)-Math.hypot(b.model.position.x-p.x,b.model.position.z-p.z):0);
 const nearest=candidates[0],point=nearest?{x:nearest.model.position.x,z:nearest.model.position.z}:null;
 return {...goal,id:'first-discoveries',kind:'capture',earlyDiscovery:true,region:save.region,required,additional:needed,point,
  name:words('새 친구 '+needed+'종 찾기','Meet '+needed+' new species',locale),
  description:words('주변의 아직 잡지 않은 포켓몬을 찾아 체력을 낮춘 뒤 볼을 던져요. 도감 '+required+'종을 채우면 다음 탐험로가 열려요.','Find an uncaught Pokémon nearby, weaken it, then throw a ball. Register '+required+' species to open the next route.',locale)};
}

export function campOverviewDistance(game,aspect=game.world.camera?.aspect||1){
 const p=game.player?.model.position,q=game.compositions?.regions[game.homeRegion]?.safePoint?.position;
 const offset=p&&q?Math.hypot(p.x-q.x,p.z-q.z):0;
 const fov=(game.world.camera?.fov||45)*Math.PI/360;
 return clamp((11+offset)/(Math.tan(fov)*Math.min(1,Math.max(.35,aspect)))*1.05,30,90);
}

export function captureBallAdvice(game){
 if((game.save.inventory[game.ball]||0)>0)return null;
 const alternatives=Object.keys(BALLS).filter(id=>(game.save.inventory[id]||0)>0);
 return alternatives.length?{alternatives,selected:game.ball}:null;
}

export function shouldDeferNotice(game,warn,coarse,combat=false){
 return !!coarse&&!warn&&!combat&&game.phase==='playing'&&!game.expedition?.state?.tutorial?.move;
}

export async function returnToTitle(ui,button){
 const g=ui.game;
 if(ui.returningToTitle)return false;
 ui.returningToTitle=true;if(button)button.disabled=true;
 const retry=()=>returnToTitle(ui,null);
 try{
  if(g.phase==='playing'&&g.persist()!==true){
   g.notify(words('저장하지 못했어요','Save failed'),words('기록과 현재 화면을 유지했어요. 다시 저장하거나 설정에서 기록을 내보내세요.','Your record and current screen are unchanged. Retry saving or export a copy in Settings.'),true);
   return false;
  }
  restoreCampView(ui);g.loadRetry=retry;g.closePanel();g.phase='loading';ui.loading(words('첫 화면을 준비하고 있어요','Preparing the title screen'));
  await g.world.build(g.biomeById.get(g.homeRegion));
  await g.loadShowcase();
  g.phase='title';g.loadRetry=null;g.failedMessage=null;
  globalThis.document?.querySelector('#hud')?.classList.add('hidden');
  ui.ready();return true;
 }catch(error){
  g.phase='loading';g.loadRetry=retry;g.failedMessage=null;g.fail(error);
  return false;
 }finally{ui.returningToTitle=false;if(button?.isConnected)button.disabled=false;}
}

function restoreCampView(ui){
 if(!ui.campView)return;
 Object.assign(ui.game.world.orbit,ui.campView.original);ui.campView=null;
}

export function updateFieldGuidance(ui){
 const g=ui.game,w=g.world,doc=globalThis.document,hud=doc?.querySelector('#hud');
 if(!hud||!g.player)return;
 let controls=doc.querySelector('#field-camera-controls');
 if(!controls){
  controls=doc.createElement('div');controls.id='field-camera-controls';controls.setAttribute('role','group');(doc.querySelector('.navigation-dock')||hud).append(controls);
  controls.addEventListener('keydown',event=>{if(event.key===' '||event.key==='Enter')event.stopPropagation();});
  controls.innerHTML='<span class="field-camera-label"></span><button id="camp-overview" type="button" aria-pressed="false"></button><button id="field-zoom-out" type="button">−</button><button id="field-zoom-in" type="button">+</button>';
  doc.querySelector('#camp-overview').onclick=()=>{
   if(ui.campView)restoreCampView(ui);else{ui.campView={region:g.save.region,epoch:g.regionEpoch,aspect:w.camera?.aspect,original:{...w.orbit}};Object.assign(w.orbit,{distance:campOverviewDistance(g),pitch:.8,yaw:.35});}
   ui.updateTimer=0;updateFieldGuidance(ui);
  };
  for(const [id,delta]of[['field-zoom-out',4],['field-zoom-in',-4]])doc.querySelector('#'+id).onclick=()=>{w.orbit.distance=clamp(w.orbit.distance+delta,9,90);ui.updateTimer=0;updateFieldGuidance(ui);};
 }
 const safe=g.compositions?.regions[g.homeRegion]?.safePoint?.position,p=g.player.model.position,atCamp=g.save.region===g.homeRegion&&safe&&Math.hypot(p.x-safe.x,p.z-safe.z)<15;
 const combat=hud.classList.contains('in-combat');
 if(ui.campView&&(ui.campView.region!==g.save.region||ui.campView.epoch!==g.regionEpoch||!atCamp||combat))restoreCampView(ui);
 if(ui.campView&&ui.campView.aspect!==w.camera?.aspect){ui.campView.aspect=w.camera?.aspect;w.orbit.distance=campOverviewDistance(g);}
 controls.classList.toggle('hidden',!!g.panel||combat||g.phase!=='playing');
 controls.setAttribute('aria-label',words('시점과 거리','View and camera distance'));
 controls.querySelector('.field-camera-label').textContent=words('시점 거리','Camera');
 const overview=doc.querySelector('#camp-overview');overview.classList.toggle('hidden',!atCamp);
 overview.textContent=words(ui.campView?'원래 시점':'캠프 전체보기',ui.campView?'Return to view':'View camp');
 overview.setAttribute('aria-pressed',String(!!ui.campView));
 overview.title=words('시설 배치를 넓게 보고 다시 누르면 이전 시점으로 돌아가요.','See the camp layout. Press again to restore your previous view.');
 for(const [id,ko,en,disabled]of[['field-zoom-out','시점 멀리 보기','Camera zoom out',w.orbit.distance>=90],['field-zoom-in','시점 가까이 보기','Camera zoom in',w.orbit.distance<=9]]){
  const b=doc.querySelector('#'+id),label=words(ko,en);b.title=label;b.setAttribute('aria-label',label);b.disabled=disabled;
 }
 let balls=doc.querySelector('#ball-stock-help');
 if(!balls){balls=doc.createElement('button');balls.id='ball-stock-help';balls.type='button';hud.append(balls);balls.addEventListener('keydown',event=>{if(event.key===' '||event.key==='Enter')event.stopPropagation();});balls.onclick=()=>{ui.bagPocket='balls';ui.bagSelection??={};ui.bagSelection.balls=captureBallAdvice(g)?.alternatives[0];g.openPanel('bag');};}
 const advice=captureBallAdvice(g);balls.classList.toggle('hidden',!advice||!!g.panel);balls.textContent=words('다른 볼 고르기','Choose another ball');
 balls.setAttribute('aria-label',words('선택한 볼이 없어요. 가방에서 보유한 다른 볼을 확인하세요.','The selected ball is empty. Review your other balls in the bag.'));
}

