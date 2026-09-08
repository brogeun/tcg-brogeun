import {MergeGame,VERSION,STEP,NAMES,RADII,FIELD} from './engine.mjs';
import * as rankings from './leaderboard.js';
import {createGameAudio} from './audio.js';

const $=id=>document.getElementById(id);
const canvas=$('board'),ctx=canvas.getContext('2d'),audio=createGameAudio();
const files=['meowth','eevee','squirtle','pikachu','psyduck','gengar','snorlax','jigglypuff'];
const images=files.map(()=>new Image()),keys=new Set(),reducedMotion=matchMedia('(prefers-reduced-motion:reduce)');
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const assign=(el,key,value)=>{if(el[key]!==value)el[key]=value;};
const time=ms=>rankings.duration(ms),bestKey=()=>`jigglypuff-best-v3-${mode}`;
let mode='speed',game=new MergeGame(1,mode),ready=false,begun=false,paused=false;
let aim=240,raf=0,last=0,accumulator=0,session=null,drops=[],demo=false,reported=false,starting=false;
let best=0,particles=[],rings=[],labels=[],births=new Map(),previous=new Map(),visualTime=0;
let chain=0,maxChain=0,lastMergeTick=-1000,clearCount=0,dropQueue=null,drag=null,dialogAction=null;
let cachedScore='',cachedTime='',cachedStatus='',cachedProgress=-1,cachedDanger='';
const sequence=[];

for(let i=0;i<files.length;i++){
 const el=document.createElement('div'),img=document.createElement('img'),label=document.createElement('span');
 img.src=`./sprites/${files[i]}.svg`;img.alt=NAMES[i];label.textContent=`${i+1}. ${NAMES[i]}`;
 el.append(img,label);$('sequence').append(el);sequence.push(el);
}
function status(text){if(text!==cachedStatus){$('status').textContent=text;cachedStatus=text;}}
function loadBest(){
 best=0;try{const saved=Number(localStorage.getItem(bestKey()));if(Number.isFinite(saved)&&saved>0)best=saved;}catch{}
 $('best-label').textContent=mode==='speed'?'이 기기 최단 시간':'이 기기 최고 점수';
 $('local-best').textContent=best?(mode==='speed'?time(best):best.toLocaleString('ko-KR')):'—';
}
function soundLabel(){$('sound').textContent=audio.enabled?'소리 켬':'소리 끔';$('sound').setAttribute('aria-pressed',String(audio.enabled));}
function face(g,x,y,r,level,angle=0,alpha=1){
 if(!ready)return;g.save();g.translate(x,y);g.rotate(angle);g.globalAlpha=alpha;
 g.imageSmoothingEnabled=true;g.imageSmoothingQuality='high';g.drawImage(images[level],-r,-r,2*r,2*r);g.restore();
}
function nextPreview(){
 const c=$('next'),g=c.getContext('2d'),dpr=Math.min(devicePixelRatio||1,3),size=Math.max(128,Math.round(c.clientWidth*dpr));
 if(c.width!==size)c.width=c.height=size;g.setTransform(size/160,0,0,size/160,0,0);g.clearRect(0,0,160,160);
 face(g,80,80,71,game.next);$('next-name').textContent=NAMES[game.next];
}
function resize(){
 const w=canvas.getBoundingClientRect().width;if(w<1)return;const dpr=Math.min(devicePixelRatio||1,3);
 const width=Math.round(w*dpr),height=Math.round(w*550/480*dpr);
 if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
 nextPreview();draw();
}
function landingY(){
 let y=FIELD.floor-RADII[game.current];
 for(const b of game.balls){const dx=Math.abs(b.x-aim),sum=b.r+RADII[game.current];if(dx<sum)y=Math.min(y,b.y-Math.sqrt(sum*sum-dx*dx));}
 return Math.max(73,y);
}
function draw(){
 ctx.setTransform(canvas.width/480,0,0,canvas.height/550,0,0);ctx.clearRect(0,0,480,550);
 ctx.fillStyle='#F7F6F2';ctx.fillRect(0,0,480,550);
 ctx.fillStyle='#fff';ctx.beginPath();ctx.roundRect(25,99,430,426,12);ctx.fill();
 ctx.strokeStyle='#D9D8D3';ctx.lineWidth=6;ctx.lineCap='round';ctx.lineJoin='round';
 ctx.beginPath();ctx.moveTo(28,106);ctx.lineTo(28,522);ctx.lineTo(452,522);ctx.lineTo(452,106);ctx.stroke();
 const danger=game.overflow>0;
 if(danger){ctx.fillStyle=`rgba(231,92,107,${.06+Math.min(.16,game.overflow*.08)})`;ctx.fillRect(31,105,418,40);}
 ctx.save();ctx.setLineDash([5,7]);ctx.strokeStyle=danger?'#D4475B':'#C7969C';ctx.lineWidth=danger?2:1.2;
 ctx.beginPath();ctx.moveTo(36,132);ctx.lineTo(444,132);ctx.stroke();ctx.restore();
 if(!game.over){
  const r=RADII[game.current],landing=landingY();
  if(!paused){
   face(ctx,aim,landing,r,game.current,0,.13);ctx.save();ctx.strokeStyle='#169D93';ctx.globalAlpha=.45;ctx.lineWidth=1.5;ctx.setLineDash([3,5]);
   ctx.beginPath();ctx.arc(aim,landing,r,0,Math.PI*2);ctx.stroke();ctx.beginPath();ctx.moveTo(aim,73+r+7);ctx.lineTo(aim,Math.max(73+r+7,landing-r-5));ctx.stroke();ctx.restore();
  }
  face(ctx,aim,73,r,game.current,0,game.cooldown>0?.45:1);
  if(game.cooldown>0){ctx.strokeStyle='#BDE9E4';ctx.lineWidth=3;ctx.beginPath();ctx.arc(aim,73,r+7,-Math.PI/2,-Math.PI/2+Math.PI*2*clamp(1-game.cooldown/60,0,1));ctx.stroke();}
  if(dropQueue){ctx.fillStyle='#066666';ctx.beginPath();ctx.arc(aim,73+r+10,3,0,Math.PI*2);ctx.fill();}
 }
 const alpha=clamp(accumulator/STEP,0,1);
 for(const b of game.balls){
  const old=previous.get(b.id),x=old?old.x+(b.x-old.x)*alpha:b.x,y=old?old.y+(b.y-old.y)*alpha:b.y;
  const birth=births.get(b.id),age=birth===undefined?1:visualTime-birth;
  const scale=!reducedMotion.matches&&age<.24?1+Math.sin(age/.24*Math.PI)*.12:1;
  face(ctx,x,y,b.r*scale,b.level,b.angle);
  if(danger&&b.age>1.8&&b.y-b.r<FIELD.danger&&Math.abs(b.vy)<65){ctx.strokeStyle='#D4475B';ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y,b.r+2,0,Math.PI*2);ctx.stroke();}
 }
 for(const r of rings){ctx.save();ctx.globalAlpha=r.life/r.total*.65;ctx.strokeStyle=r.color;ctx.lineWidth=r.clear?4:2;ctx.beginPath();ctx.arc(r.x,r.y,r.r+(1-r.life/r.total)*26,0,Math.PI*2);ctx.stroke();ctx.restore();}
 for(const p of particles){ctx.globalAlpha=clamp(p.life/p.total,0,1);ctx.fillStyle=p.color;ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fill();}ctx.globalAlpha=1;
 for(const l of labels){ctx.save();ctx.globalAlpha=Math.min(1,l.life/.3);ctx.textAlign='center';ctx.font=`700 ${l.big?23:17}px system-ui`;ctx.lineWidth=4;ctx.strokeStyle='#fff';ctx.strokeText(l.text,l.x,l.y);ctx.fillStyle=l.big?'#066666':'#147C72';ctx.fillText(l.text,l.x,l.y);ctx.restore();}
 if(paused&&!game.over){
  ctx.fillStyle='rgba(255,255,255,.92)';ctx.beginPath();ctx.roundRect(79,205,322,92,14);ctx.fill();ctx.fillStyle='#0D0D0D';ctx.textAlign='center';ctx.font='700 24px system-ui';ctx.fillText('일시정지',240,244);ctx.font='14px system-ui';ctx.fillStyle='#666560';ctx.fillText('계속하기를 누르면 이어져요',240,272);
 }
}
function effect(e){
 chain=game.ticks-lastMergeTick<=108?chain+1:1;maxChain=Math.max(maxChain,chain);lastMergeTick=game.ticks;
 const clear=e.type==='clear',points=clear?1280:2**e.level*5;if(clear)clearCount++;
 for(const b of game.balls)if(!births.has(b.id))births.set(b.id,visualTime);
 const color=clear?'#14B8A6':'#72CBB7';
 if(!reducedMotion.matches){
  rings.push({...e,color,clear,life:.5,total:.5});
  for(let i=0;i<(clear?24:10);i++){const a=i*2.399963+(e.level*.4),v=35+(i%5)*18;particles.push({x:e.x,y:e.y,vx:Math.cos(a)*v,vy:Math.sin(a)*v-35,r:2+i%3,color:i%3?'#60C7B0':'#EFCA57',life:.5+i%3*.12,total:.74});}
 }
 labels.push({x:clamp(e.x,80,400),y:Math.max(110,e.y-15),text:chain>1?`${chain}연속 합성 · +${points.toLocaleString('ko-KR')}`:`+${points.toLocaleString('ko-KR')}`,big:clear,life:1});
 status(clear?'푸린 두 개! +1,280점 · 공간이 생겼어요.':`${NAMES[e.level]} 합성!${chain>1?` ${chain}연속으로 이어졌어요.`:''}`);
 audio.play(clear?'clear':'merge',e.level);
}
function controls(){
 const unavailable=!ready||game.over||paused||starting||!!dialogAction;
 assign($('drop'),'disabled',unavailable);assign($('drop'),'textContent',game.over?'경기 종료':paused?'일시정지':dropQueue?'낙하 예약':game.cooldown>0?'준비 중…':'떨어뜨리기');
 assign($('pause'),'disabled',!ready||game.over||starting);assign($('pause'),'textContent',paused?'계속하기':'일시정지');
 for(const id of ['demo','mode-speed','mode-endless','restart'])assign($(id),'disabled',starting);
 assign($('left'),'disabled',unavailable);assign($('right'),'disabled',unavailable);
}
function updateUI(){
 const score=String(game.points),clock=mode==='speed'?time(game.result().durationMs):time(game.result().durationMs).split('.')[0];
 if(score!==cachedScore){$('score').textContent=score;cachedScore=score;}
 if(clock!==cachedTime){$('timer').textContent=clock;cachedTime=clock;}
 const progress=Math.max(game.maxLevel,...game.balls.map(b=>b.level));
 if(progress!==cachedProgress){
  $('progress-name').textContent=mode==='speed'?(progress===7?'푸린 완성':`다음 목표 · ${NAMES[Math.min(7,progress+1)]}`):`최고 합성 · ${NAMES[progress]}`;
  $('progress-count').textContent=`${progress+1} / 8`;sequence.forEach((el,i)=>{el.classList.toggle('reached',i<=progress);el.classList.toggle('current',i===progress);});cachedProgress=progress;
 }
 const danger=game.overflow>0?Math.min(1,game.overflow/1.6):0;
 assign($('danger-fill').style,'transform',`scaleX(${danger})`);
 const warning=game.over?(game.won?'푸린 완성!':'경기 종료'):danger>0?'위험! 한계선 아래로 내려야 해요.':'한계선 아래에 공간을 남겨두세요.';
 if(warning!==cachedDanger){$('danger-text').textContent=warning;cachedDanger=warning;}
 $('danger-fill').parentElement.classList.toggle('danger',danger>0);controls();
}
function finish(){
 if(reported)return;reported=true;dropQueue=null;drag=null;keys.clear();rankings.lock(false);
 const result=game.result(),oldBest=best;
 const improved=!demo&&((mode==='speed'&&result.won&&(!best||result.durationMs<best))||(mode==='endless'&&result.score>best));
 if(improved){best=mode==='speed'?result.durationMs:result.score;try{localStorage.setItem(bestKey(),String(best));}catch{}loadBest();}
 const title=game.won?'푸린 완성!':mode==='speed'?'한 번 더 도전해요':'이번 경기 결과';
 const value=game.won?time(result.durationMs):`${result.score.toLocaleString('ko-KR')}점`;
 $('result-title').textContent=demo?'합성 미리보기':title;$('result-value').textContent=value;
 $('result-detail').textContent=demo?'예시 기록은 저장되지 않아요.':improved?(oldBest?'내 최고 기록을 갱신했어요!':'첫 최고 기록을 세웠어요!'):mode==='speed'?(result.won?'푸린 완성! 다음에는 더 빠른 기록에 도전해 보세요.':'푸린 완성까지 다시 도전해 보세요.'):`최대 ${maxChain}연속 합성 · 푸린 보너스 ${clearCount}회`;
 $('result-panel').hidden=false;status(`${title} · ${value}${demo?' · 합성 예시':''}`);audio.play(game.won?'win':'lose');
 if(session&&drops.length){const completed=session,replay={version:VERSION,ticks:game.ticks,drops:drops.map(a=>[...a])};session=null;rankings.submit(completed,replay);}else if(session){session=null;$('submission').textContent='낙하 기록이 없어 이번 경기는 등록하지 않았어요.';}
}
function step(){
 previous=new Map(game.balls.map(b=>[b.id,{x:b.x,y:b.y}]));game.step();
 for(const e of game.events)effect(e);game.events.length=0;
 const liveIds=new Set(game.balls.map(b=>b.id));for(const id of births.keys())if(!liveIds.has(id))births.delete(id);
 if(dropQueue){if(performance.now()>dropQueue.until)dropQueue=null;else if(game.cooldown===0){const queued=dropQueue;dropQueue=null;aimAt(queued.x);performDrop();}}
}
function frame(ts){
 const elapsed=last?(ts-last)/1000:0;last=ts;
 if(elapsed>.25&&begun&&!paused&&!game.over){setPaused(true);status('화면이 잠시 멈춰 자동으로 일시정지했어요.');}
 const dt=Math.min(elapsed,.05);visualTime+=dt;
 if(!paused){if(keys.has('ArrowLeft'))aimAt(aim-240*dt);if(keys.has('ArrowRight'))aimAt(aim+240*dt);}
 if(!paused&&begun){
  accumulator+=Math.min(elapsed,.25);
  while(accumulator>=STEP&&!game.over){step();accumulator-=STEP;}
  if(game.over)finish();
 }
 if(!paused){
  particles=particles.filter(p=>{p.life-=dt;p.x+=p.vx*dt;p.y+=p.vy*dt;p.vy+=120*dt;return p.life>0;});
  rings=rings.filter(r=>(r.life-=dt)>0);labels=labels.filter(l=>{l.life-=dt;l.y-=24*dt;return l.life>0;});
 }
 updateUI();draw();
 raf=!paused&&((!game.over&&(begun||keys.size||drag!==null))||particles.length||rings.length||labels.length)?requestAnimationFrame(frame):0;
}
function wake(){if(!raf){last=0;raf=requestAnimationFrame(frame);}}
function aimAt(x){aim=clamp(x,FIELD.left+RADII[game.current],FIELD.right-RADII[game.current]);}
function performDrop(){
 const x=Math.round(aim);if(!game.drop(x))return false;
 if(!begun){begun=true;last=performance.now();accumulator=0;}
 drops.push([game.ticks,x]);births.set(game.balls.at(-1).id,visualTime);aimAt(aim);nextPreview();audio.play('drop');
 status('같은 얼굴을 붙여보세요.');controls();wake();return true;
}
function requestDrop(){
 if(!ready||starting||paused||game.over||dialogAction)return;
 audio.unlock();if(game.cooldown>0){if(game.cooldown<=22)dropQueue={x:aim,until:performance.now()+250};else status('곧 떨어뜨릴 수 있어요. 원이 차면 다시 놓아주세요.');controls();wake();return;}
 performDrop();
}
function reset(seed=crypto.getRandomValues(new Uint32Array(1))[0],ranked=null){
 cancelAnimationFrame(raf);raf=0;game=new MergeGame(seed,mode);begun=false;session=ranked;drops=[];demo=false;reported=false;paused=false;accumulator=0;
 particles=[];rings=[];labels=[];births.clear();previous.clear();visualTime=0;chain=0;maxChain=0;lastMergeTick=-1000;clearCount=0;dropQueue=null;drag=null;aim=240;keys.clear();
 cachedProgress=-1;cachedScore='';cachedTime='';cachedDanger='';$('result-panel').hidden=true;
 $('mode-label').textContent=ranked?'회원 랭킹':'연습';loadBest();status('위치를 고르고 놓으면 시작해요.');rankings.lock(!!ranked);rankings.matchStatus(!!ranked);nextPreview();updateUI();draw();wake();
}
function setPaused(value){
 if(game.over||starting)return;paused=value;keys.clear();dropQueue=null;drag=null;cancelAnimationFrame(raf);raf=0;if(paused)audio.suspend();controls();draw();if(!paused)wake();
}
function resumeGesture(){setPaused(false);audio.unlock();canvas.focus({preventScroll:true});}
function safeChange(action,label){
 if(starting)return;if(!begun||game.over||demo){action();return;}
 const wasPaused=paused;setPaused(true);dialogAction={action,wasPaused};
 $('leave-title').textContent=label;$('leave-detail').textContent='현재 경기는 종료되고 기록은 등록되지 않아요.';$('leave-dialog').showModal();controls();
}
function cancelChange(){const pending=dialogAction;dialogAction=null;$('leave-dialog').close();if(pending&&!pending.wasPaused)resumeGesture();else controls();}
function changeMode(selected){
 mode=selected;document.title=(mode==='speed'?'푸린 만들기':'무한 만들기')+' · TCG Hub';
 $('mode-speed').setAttribute('aria-pressed',String(mode==='speed'));$('mode-endless').setAttribute('aria-pressed',String(mode==='endless'));
 $('game-title').textContent=mode==='speed'?'푸린 만들기':'무한 만들기';$('game-description').textContent=mode==='speed'?'푸린 완성까지, 나만의 최단 기록에 도전하세요.':'합성은 계속, 점수는 더 높게.';
 $('mode-rule').textContent=mode==='speed'?'첫 낙하부터 실제 플레이 시간 측정 · 푸린 완성 시 종료':'시간제한 없음 · 푸린 두 개는 사라지며 +1,280점';$('goal-label').textContent=mode==='speed'?'최종 목표':'두 개면 보너스';rankings.setMode(mode);reset();
}
function demoGame(){
 reset();demo=true;begun=true;$('mode-label').textContent='합성 예시 · 랭킹 제외';
 game.balls=mode==='speed'?[game.make(2,75,493),game.make(4,386,478),game.make(5,126,468),game.make(6,258,456),game.make(6,258,224)]:[game.make(7,240,430),game.make(7,240,244)];
 game.balls.forEach(b=>b.age=2);game.cooldown=240;status(mode==='speed'?'잠만보 + 잠만보 → 푸린':'푸린 + 푸린 → 1,280점 · 계속 진행');audio.unlock();
}
function pointerAim(e){const r=canvas.getBoundingClientRect();aimAt((e.clientX-r.left)/r.width*480);}
canvas.addEventListener('pointerdown',e=>{
 if((e.pointerType==='mouse'&&e.button!==0)||!ready||paused||game.over||starting||drag!==null)return;
 e.preventDefault();canvas.focus({preventScroll:true});canvas.setPointerCapture(e.pointerId);drag=e.pointerId;pointerAim(e);audio.unlock();draw();
});
canvas.addEventListener('pointermove',e=>{if(drag===e.pointerId||e.pointerType==='mouse'&&drag===null){pointerAim(e);if(paused||!begun)draw();}});
canvas.addEventListener('pointerup',e=>{if(drag!==e.pointerId)return;e.preventDefault();pointerAim(e);drag=null;requestDrop();});
for(const name of ['pointercancel','lostpointercapture'])canvas.addEventListener(name,e=>{if(drag===e.pointerId){drag=null;dropQueue=null;}});
$('drop').addEventListener('click',()=>{requestDrop();canvas.focus({preventScroll:true});});
$('pause').addEventListener('click',()=>{if(paused)resumeGesture();else setPaused(true);});
$('restart').addEventListener('click',()=>{if(!ready){location.reload();return;}safeChange(()=>{audio.unlock();reset();},'새 게임을 시작할까요?');});
$('demo').addEventListener('click',()=>safeChange(demoGame,'합성 예시를 볼까요?'));
$('result-retry').addEventListener('click',()=>{audio.unlock();reset();canvas.focus({preventScroll:true});});
$('result-close').addEventListener('click',()=>{$('result-panel').hidden=true;draw();});
$('leave-cancel').addEventListener('click',cancelChange);$('leave-dialog').addEventListener('cancel',e=>{e.preventDefault();cancelChange();});
$('leave-confirm').addEventListener('click',()=>{const pending=dialogAction;dialogAction=null;$('leave-dialog').close();pending?.action();controls();});
$('sound').addEventListener('click',()=>{audio.setEnabled(!audio.enabled);soundLabel();});
$('focus').addEventListener('click',()=>{
 const expanded=document.body.classList.toggle('game-focus');$('focus').textContent=expanded?'화면 축소':'화면 확대';$('focus').setAttribute('aria-pressed',String(expanded));
 const panel=document.querySelector('.rank-panel');if(panel)panel.inert=expanded;
 requestAnimationFrame(resize);if(!expanded&&begun&&!game.over)setPaused(true);
});
$('rank-start').addEventListener('click',()=>safeChange(async()=>{
 if(!ready||starting)return;setPaused(true);starting=true;rankings.lock(true);controls();
 try{audio.unlock();const ranked=await rankings.prepare();reset(ranked.seed,ranked);canvas.focus({preventScroll:true});}
 catch(e){$('submission').textContent=e.message;rankings.lock(false);}
 finally{starting=false;controls();}
},'랭킹 경기를 시작할까요?'));
for(const selected of ['speed','endless'])$('mode-'+selected).addEventListener('click',()=>{if(mode!==selected)safeChange(()=>changeMode(selected),'모드를 바꿀까요?');});
for(const [id,key] of [['left','ArrowLeft'],['right','ArrowRight']]){
 const b=$(id);b.addEventListener('pointerdown',e=>{e.preventDefault();b.setPointerCapture(e.pointerId);aimAt(aim+(key==='ArrowLeft'?-24:24));draw();keys.add(key);wake();});
 for(const name of ['pointerup','pointercancel','lostpointercapture'])b.addEventListener(name,()=>keys.delete(key));
 b.addEventListener('click',e=>{if(e.detail===0){aimAt(aim+(key==='ArrowLeft'?-24:24));draw();}});
}
canvas.addEventListener('keydown',e=>{
 if(!['ArrowLeft','ArrowRight','Space','KeyP','Escape'].includes(e.code))return;e.preventDefault();keys.add(e.code);wake();
 if(e.repeat)return;if(e.code==='Space')requestDrop();if(['KeyP','Escape'].includes(e.code)){if(paused)resumeGesture();else setPaused(true);}
});
window.addEventListener('keyup',e=>keys.delete(e.code));
function background(){keys.clear();dropQueue=null;drag=null;audio.suspend();if(ready&&begun&&!paused&&!game.over)setPaused(true);}
window.addEventListener('blur',background);window.addEventListener('pagehide',background);document.addEventListener('visibilitychange',()=>{if(document.hidden)background();});
window.addEventListener('resize',resize);window.visualViewport?.addEventListener('resize',resize);new ResizeObserver(resize).observe(canvas);
loadBest();soundLabel();rankings.init();
Promise.all(images.map((img,i)=>new Promise((resolve,reject)=>{
 const timer=setTimeout(()=>reject(Error('이미지 로딩이 지연돼요. 새로고침해 주세요.')),12000);
 img.onload=()=>{clearTimeout(timer);resolve();};img.onerror=()=>{clearTimeout(timer);reject(Error('이미지를 불러오지 못했어요. 새 게임을 눌러 다시 불러오세요.'));};img.src=`./sprites/${files[i]}.svg`;
}))).then(()=>{ready=true;reset();resize();}).catch(e=>{status(e.message);$('restart').textContent='다시 불러오기';});
