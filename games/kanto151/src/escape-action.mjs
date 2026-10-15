import {TYPE_COLORS} from './core.mjs';

export const ESCAPE_ACTION=Object.freeze({castTime:.2,radius:3,cooldown:8,power:15,knockback:1.5,bossKnockback:.25});
const hardStatus=p=>['sleep','freeze','stun'].includes(p?.status);
const busy=g=>g.phase!=='playing'||!g.player||g.player.hp<=0||g.capture||g.transitioning||g.partnerChanging||g.restoring||g.survivalDying||g.importApplying||g.fieldAction||g.runSurvey||g.journeyBusy||g.nestBusy;
const cooldown=g=>Number.isFinite(g.save?.escapeCooldown)?Math.max(0,g.save.escapeCooldown):0;

function engaged(g,a){return a.angry||a.boss||(a.attackCycle||0)>0||a.action==='attack'||(g.projectiles||[]).some(q=>q.actor===a&&q.target===g.player&&q.life>0);}
function nearbyThreats(g){
 const p=g.player;if(!p)return [];
 return (g.wild||[]).filter(a=>a.faction==='wild'&&a.hp>0&&!a.capturing&&engaged(g,a)&&a.model.position.distanceTo(p.model.position)<=ESCAPE_ACTION.radius+1e-8);
}
export function escapeActionInfo(g){
 const targetCount=nearbyThreats(g).length,remaining=cooldown(g);
 const reason=busy(g)||g.panel||g.escapePending?'escape.blocked.busy':hardStatus(g.player)?'escape.blocked.status':remaining>0?'escape.blocked.cooldown':!targetCount?'escape.blocked.noTargets':'';
 return {ready:!reason,cooldown:remaining,reason,targetCount};
}

function validPending(g,pending){return pending&&!pending.finished&&!busy(g)&&!hardStatus(pending.actor)&&pending.actor===g.player&&pending.save===g.save&&pending.epoch===g.regionEpoch&&pending.serial===pending.actor.castSerial;}
export function protectedEscapeCast(g,actor){return actor===g.player&&validPending(g,g.escapePending);}
export function cancelEscapeAction(g){
 const pending=g.escapePending;if(!pending)return false;pending.finished=true;g.escapePending=null;
 if(pending.actor.castSerial===pending.serial&&pending.actor.action==='attack'){pending.actor.action=null;pending.actor.actionTime=0;}
 return true;
}

function virtualMove(p){return {id:'escape-pulse',slug:'escape-pulse',name:'밀쳐내기',type:p.species.types[0]||'normal',power:ESCAPE_ACTION.power,damageClass:'physical',
 engine:{template:'radial-aoe',power:ESCAPE_ACTION.power,radius:ESCAPE_ACTION.radius,range:ESCAPE_ACTION.radius,castTime:ESCAPE_ACTION.castTime,cooldown:ESCAPE_ACTION.cooldown},feedback:{tier:'heavy'}};}

export function startEscapeAction(g){
 if(!escapeActionInfo(g).ready)return false;
 const p=g.player,move=virtualMove(p);g.bufferedAttack=null;p.castSerial=(p.castSerial||0)+1;p.dash=null;
 p.action='attack';p.actionTime=ESCAPE_ACTION.castTime;
 g.escapePending={actor:p,save:g.save,epoch:g.regionEpoch,serial:p.castSerial,remaining:ESCAPE_ACTION.castTime,finished:false,move};
 g.save.escapeCooldown=ESCAPE_ACTION.cooldown;
 g.feedback?.windup?.(p,null,move);g.world?.ring?.(p.model.position.clone(),TYPE_COLORS[move.type],ESCAPE_ACTION.radius,ESCAPE_ACTION.castTime);
 g.persist?.();g.emit?.('escapeStarted');return true;
}

function pushTarget(actor,target,serialBefore){
 const direction=target.model.position.clone().sub(actor.model.position);direction.y=0;
 if(direction.lengthSq()<1e-10)direction.set(Math.sin(actor.model.rotation.y||0),0,Math.cos(actor.model.rotation.y||0));
 direction.normalize();
 // Physical displacement is separate from type damage: an immune engaged target can still be pushed.
 // Boss casts and interrupt resistance retain their ordinary non-signature hit rules.
 if(!target.boss&&(target.castSerial||0)===serialBefore)target.castSerial=serialBefore+1;
 target.recoil={direction,time:0,duration:target.boss?.11:.2,distance:target.boss?ESCAPE_ACTION.bossKnockback:ESCAPE_ACTION.knockback};
 target.action='recoil';target.actionTime=target.recoil.duration;target.dash=null;
}

export function updateEscapeAction(g,dt){
 if(!Number.isFinite(dt)||dt<=0)return;
 if(g.escapePending&&!validPending(g,g.escapePending))cancelEscapeAction(g);
 if(g.phase!=='playing'||g.panel||!g.player||g.player.hp<=0||g.transitioning||g.partnerChanging||g.restoring||g.survivalDying||g.importApplying)return;
 if(g.save.escapeCooldown!==undefined){const previous=cooldown(g),next=previous-dt;g.save.escapeCooldown=next>1e-8?next:0;if(previous>0&&g.save.escapeCooldown===0)g.emit?.('escapeReady');}
 if(busy(g))return;
 const pending=g.escapePending;if(!pending)return;
 pending.remaining-=dt;if(pending.remaining>1e-8)return;
 const threats=nearbyThreats(g),actor=pending.actor,move=pending.move;
 cancelEscapeAction(g);
 g.feedback?.area?.(move,actor.model.position.clone(),ESCAPE_ACTION.radius);
 for(const target of threats){
  if(g.save!==pending.save||g.player!==actor||g.regionEpoch!==pending.epoch)break;
  if((target.invincible||0)>0)continue;
  const serial=target.castSerial||0;g.hit(actor,target,move);
  if(target.hp>0&&!target.capturing)pushTarget(actor,target,serial);
 }
 g.emit?.('escapeFinished');
}
