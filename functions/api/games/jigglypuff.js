import { getCurrentUser,jsonResponse } from '../../_shared/auth.js';
import { VERSION,verifyReplay } from '../../../games/jigglypuff/engine.mjs';
const fail=(message,status=400)=>jsonResponse({ok:false,message},status);
const unavailable=()=>fail('회원 랭킹을 준비 중이에요. 연습 게임은 이용할 수 있어요.',503);
const validMode=mode=>mode==='speed'||mode==='endless';
const orderFor=mode=>mode==='speed'?'duration_ms ASC,achieved_at ASC,user_id ASC':'score DESC,duration_ms ASC,achieved_at ASC,user_id ASC';
export async function onRequestGet({request,env}){
 const mode=new URL(request.url).searchParams.get('mode')||'speed';if(!validMode(mode))return fail('게임 모드를 확인해 주세요.');
 if(!env.DB)return unavailable();try{const user=await getCurrentUser(request,env),order=orderFor(mode);
 const rows=await env.DB.prepare(`SELECT nickname,score,max_level,won,duration_ms,achieved_at,CASE WHEN user_id=? THEN 1 ELSE 0 END AS is_me FROM jigglypuff_mode_records WHERE mode=? ORDER BY ${order} LIMIT 20`).bind(user?.id||'',mode).all();
 const mine=user?await env.DB.prepare(`SELECT nickname,score,max_level,won,duration_ms,rank FROM (SELECT *,ROW_NUMBER() OVER (ORDER BY ${order}) AS rank FROM jigglypuff_mode_records WHERE mode=?) WHERE user_id=?`).bind(mode,user.id).first():null;
 return jsonResponse({ok:true,mode,loggedIn:!!user,rows:(rows.results||[]).map((r,i)=>({...r,rank:i+1})),mine});}catch{return unavailable();}
}
export async function onRequestPost({request,env}){
 const origin=request.headers.get('Origin');if(origin&&origin!==new URL(request.url).origin)return fail('같은 사이트에서 요청해 주세요.',403);
 if(!request.headers.get('Content-Type')?.startsWith('application/json'))return fail('JSON 요청이 필요합니다.',415);
 const user=await getCurrentUser(request,env);if(!user)return fail('로그인한 회원만 기록을 등록할 수 있어요.',401);if(!env.DB)return unavailable();
 let data;try{const reader=request.body?.getReader();if(!reader)return fail('요청 본문이 없습니다.');let length=0;const chunks=[];while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>131072){await reader.cancel();return fail('기록이 너무 큽니다.',413);}chunks.push(value);}const bytes=new Uint8Array(length);let offset=0;for(const c of chunks){bytes.set(c,offset);offset+=c.length;}data=JSON.parse(new TextDecoder().decode(bytes));if(!data||typeof data!=='object'||Array.isArray(data))return fail('요청을 확인해 주세요.');}catch{return fail('요청을 읽을 수 없습니다.');}
 const now=Date.now();try{
  if(data.action==='start'){
   if(!validMode(data.mode))return fail('게임 모드를 확인해 주세요.');
   if(data.version!==VERSION)return fail('게임을 새로고침해 주세요.');const nickname=typeof data.nickname==='string'?data.nickname.trim().normalize('NFC'):'';
   if([...nickname].length<2||[...nickname].length>16||! /^[\p{L}\p{N}_ -]+$/u.test(nickname))return fail('닉네임은 글자·숫자·공백·밑줄·하이픈으로 2~16자 입력해 주세요.');
   const recent=await env.DB.prepare('SELECT started_at FROM jigglypuff_mode_sessions WHERE user_id=?').bind(user.id).first();if(recent&&now-recent.started_at<5000)return fail('5초 뒤에 다시 시작해 주세요.',429);
   const id=crypto.randomUUID(),seed=crypto.getRandomValues(new Uint32Array(1))[0];
   await env.DB.prepare(`INSERT INTO jigglypuff_mode_sessions(id,user_id,mode,nickname,seed,rules_version,started_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET id=excluded.id,mode=excluded.mode,nickname=excluded.nickname,seed=excluded.seed,rules_version=excluded.rules_version,started_at=excluded.started_at,completed_at=NULL,score=NULL,max_level=NULL,won=NULL,duration_ms=NULL`).bind(id,user.id,data.mode,nickname,seed,VERSION,now).run();return jsonResponse({ok:true,sessionId:id,seed,mode:data.mode});
  }
  if(data.action!=='finish'||typeof data.sessionId!=='string')return fail('요청을 확인해 주세요.');
  const session=await env.DB.prepare('SELECT * FROM jigglypuff_mode_sessions WHERE id=? AND user_id=?').bind(data.sessionId,user.id).first();if(!session)return fail('경기 세션이 만료됐어요.',409);
  if(session.completed_at)return jsonResponse({ok:true,alreadySaved:true,ranked:session.mode==='endless'||!!session.won,score:session.score});
  if(session.rules_version!==VERSION)return fail('게임 규칙이 업데이트됐어요. 새로 시작해 주세요.',409);
  if(Number.isSafeInteger(data.replay?.ticks)&&data.replay.ticks*1000/120>now-session.started_at+2000)return fail('경기 시간과 기록이 일치하지 않습니다.');
  let verified;try{verified=verifyReplay(session.seed,data.replay,session.mode);}catch(e){return fail(e.message);}
  if(verified.durationMs>now-session.started_at+2000)return fail('경기 시간과 기록이 일치하지 않습니다.');
  await env.DB.batch([
   env.DB.prepare('UPDATE jigglypuff_mode_sessions SET completed_at=?,score=?,max_level=?,won=?,duration_ms=? WHERE id=? AND user_id=? AND completed_at IS NULL').bind(now,verified.score,verified.maxLevel,Number(verified.won),verified.durationMs,session.id,user.id),
   env.DB.prepare(`INSERT INTO jigglypuff_mode_records(user_id,mode,nickname,score,max_level,won,duration_ms,achieved_at) SELECT user_id,mode,nickname,score,max_level,won,duration_ms,completed_at FROM jigglypuff_mode_sessions WHERE id=? AND user_id=? AND completed_at IS NOT NULL AND (mode='endless' OR won=1) ON CONFLICT(user_id,mode) DO UPDATE SET nickname=excluded.nickname,score=excluded.score,max_level=excluded.max_level,won=excluded.won,duration_ms=excluded.duration_ms,achieved_at=excluded.achieved_at WHERE (excluded.mode='speed' AND excluded.duration_ms<jigglypuff_mode_records.duration_ms) OR (excluded.mode='endless' AND (excluded.score>jigglypuff_mode_records.score OR (excluded.score=jigglypuff_mode_records.score AND excluded.duration_ms<jigglypuff_mode_records.duration_ms)))`).bind(session.id,user.id)
  ]);return jsonResponse({ok:true,ranked:session.mode==='endless'||verified.won,...verified});
 }catch{return unavailable();}
}
