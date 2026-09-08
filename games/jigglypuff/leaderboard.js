import {VERSION} from './engine.mjs';

const $=id=>document.getElementById(id);
const pendingKey='jigglypuff-pending-v3',maxStoredLength=131072;
const validMode=value=>value==='speed'||value==='endless';
const modeName=value=>value==='endless'?'무한 만들기':'푸린 만들기';
let user=false,available=false,locked=false,pending=null,saving=false,generation=0,mode='speed';
let invalidStored=false,persisted=false,submissionState='idle';

export const duration=ms=>`${Math.floor(ms/60000)}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;

async function api(body,requestMode=mode){
 const r=await fetch('/api/games/jigglypuff?mode='+requestMode,{credentials:'same-origin',signal:AbortSignal.timeout(15000),...(body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
 let data;try{data=await r.json();}catch{throw Error('랭킹 서버에 연결할 수 없어요.');}
 if(!r.ok||!data.ok)throw Error(data.message||'기록을 불러오지 못했어요.');
 return data;
}

function controls(){
 const disabled=locked||!user||!available||!!pending||invalidStored||saving;
 $('rank-start').disabled=disabled;$('nickname').disabled=disabled;
 $('retry').disabled=saving;$('discard').disabled=saving;
}

function submission(message,state='finished'){$('submission').textContent=message;submissionState=state;}
function retryControls(show){$('retry').hidden=!show||invalidStored;$('discard').hidden=!show;}
function forgetStored(){try{sessionStorage.removeItem(pendingKey);}catch{}}
function persistPending(){try{sessionStorage.setItem(pendingKey,JSON.stringify(pending));return true;}catch{return false;}}

function restoredRecord(value){
 if(!value||typeof value!=='object'||Array.isArray(value)||value.action!=='finish'||!validMode(value.mode)||typeof value.sessionId!=='string'||!value.sessionId.length||value.sessionId.length>128)return null;
 const replay=value.replay;
 if(!replay||typeof replay!=='object'||Array.isArray(replay)||replay.version!==VERSION||!Number.isSafeInteger(replay.ticks)||replay.ticks<1||replay.ticks>Math.floor(Number.MAX_SAFE_INTEGER/1000)||!Array.isArray(replay.drops)||!replay.drops.length||replay.drops.length>4096)return null;
 let previous=-60;
 for(const drop of replay.drops){
  if(!Array.isArray(drop)||drop.length!==2||!Number.isSafeInteger(drop[0])||drop[0]<previous+60||drop[0]>=replay.ticks||!Number.isInteger(drop[1])||drop[1]<0||drop[1]>480)return null;
  previous=drop[0];
 }
 return{action:'finish',sessionId:value.sessionId,mode:value.mode,replay:{version:VERSION,ticks:replay.ticks,drops:replay.drops.map(drop=>[...drop])}};
}

function restorePending(){
 let raw;try{raw=sessionStorage.getItem(pendingKey);}catch{return;}
 if(raw===null)return;
 try{pending=raw.length<=maxStoredLength?restoredRecord(JSON.parse(raw)):null;}catch{pending=null;}
 if(pending){
  persisted=true;
  submission(`${modeName(pending.mode)} · 등록하지 못한 완료 기록을 복구했어요. 등록 재시도를 눌러 주세요.`);
 }else{
  invalidStored=true;
  submission('저장된 경기 기록을 읽을 수 없어요. 기록 등록 포기를 누르면 새 랭킹 경기를 시작할 수 있어요.');
 }
 retryControls(true);controls();
}

export function matchStatus(ranked){
 if(pending||invalidStored||saving)return;
 if(ranked)submission('랭킹 경기 · 종료 후 자동 등록','active');
 else if(submissionState==='active')submission('','idle');
}

export function setMode(value){
 mode=value;$('rank-rule').textContent=mode==='speed'?'완성 시간 TOP 20 · 빠른 순':'최고 점수 TOP 20 · 동점이면 빠른 기록 순';
 $('rank-primary').textContent=mode==='speed'?'시간':'점수';$('rank-secondary').textContent=mode==='speed'?'점수':'시간';
 $('rank-body').replaceChildren();$('my-rank').textContent='';refresh();
}

export function lock(value){locked=value;controls();}

export async function refresh(){
 const g=++generation;$('rank-status').textContent='순위를 불러오는 중…';
 try{
  const data=await api();if(g!==generation)return;
  user=data.loggedIn;available=true;$('auth-status').textContent=user?'공개 닉네임으로 회원 순위에 기록돼요.':'로그인하면 회원 랭킹에 등록돼요. 연습 게임은 바로 즐길 수 있어요.';
  $('login').hidden=user;$('rank-body').replaceChildren();
  for(const r of data.rows){
   const row=document.createElement('tr');if(r.is_me)row.className='is-me';
   for(const value of [r.rank,r.nickname+(r.is_me?' (나)':''),...(mode==='speed'?[duration(r.duration_ms),r.score]:[r.score,duration(r.duration_ms)])]){
    const td=document.createElement('td');td.textContent=value;row.append(td);
   }
   $('rank-body').append(row);
  }
  $('rank-status').textContent=data.rows.length?'':'아직 등록된 기록이 없어요.';
  $('my-rank').textContent=data.mine?`내 최고 · ${data.mine.rank}위 · ${mode==='speed'?duration(data.mine.duration_ms):data.mine.score+'점'}`:user?'아직 내 랭킹 기록이 없어요.':'';
 }catch(e){
  if(g!==generation)return;available=false;$('rank-status').textContent=e.message;
  $('auth-status').textContent='랭킹 연결 전에는 연습 게임으로 플레이할 수 있어요.';
 }
 controls();
}

export async function prepare(){
 if(pending||invalidStored||saving)throw Error('이전 기록을 등록하거나 등록을 포기해 주세요.');
 const nickname=$('nickname').value,data=await api({action:'start',version:VERSION,nickname,mode});
 try{localStorage.setItem('jigglypuff-nickname',nickname);}catch{}
 matchStatus(true);return data;
}

async function send(){
 if(!pending||saving)return;
 const record=pending,label=modeName(record.mode);
 saving=true;controls();submission(`${label} · 플레이를 검증하고 등록하는 중…`);
 try{
  // The saved mode labels this record; the server session remains authoritative.
  const response=await api({action:'finish',sessionId:record.sessionId,replay:record.replay},record.mode);
  pending=null;persisted=false;forgetStored();
  submission(`${label} · `+(response.ranked===false?'푸린을 완성하지 못해 시간 랭킹에는 등록되지 않았어요.':'등록 완료! 더 좋은 기록이면 내 최고 기록이 갱신돼요.'));
  retryControls(false);await refresh();
 }catch(e){
  submission(`${label} · 등록 실패 · ${e.message}`+(persisted?'':' · 이 브라우저에서는 새로고침하면 기록이 사라질 수 있어요.'));
  retryControls(true);
 }finally{saving=false;controls();}
}

export async function submit(session,replay){
 if(!session||pending||invalidStored||saving)return;
 pending={action:'finish',sessionId:session.sessionId,mode:validMode(session.mode)?session.mode:mode,replay:{version:replay.version,ticks:replay.ticks,drops:replay.drops.map(drop=>[...drop])}};
 persisted=persistPending();controls();await send();
}

export function init(){
 try{$('nickname').value=localStorage.getItem('jigglypuff-nickname')||'';}catch{}
 $('refresh').addEventListener('click',refresh);$('retry').addEventListener('click',send);
 $('discard').addEventListener('click',()=>{
  if(saving)return;
  const label=pending?modeName(pending.mode)+' · ':'';
  pending=null;invalidStored=false;persisted=false;forgetStored();retryControls(false);
  submission(label+'이번 기록의 등록을 포기했어요.');controls();
 });
 restorePending();refresh();
}
