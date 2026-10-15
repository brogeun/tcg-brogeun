// Actor-local combat rules. No browser, save storage or shared actor registry.
export const HARD_STATUSES=Object.freeze(['sleep','freeze','stun']);
export const IMMOBILE_STATUSES=Object.freeze([...HARD_STATUSES,'trap']);
export const HARD_STATUS_RECOVERY_SECONDS=2;
export const DAMAGE_WAKE_PROTECTION_SECONDS=.3;
export const CROWD_DAMAGE_GRACE_SECONDS=.2;

export function canAct(actor){return !!actor&&actor.hp>0&&!HARD_STATUSES.includes(actor.status);}
export function canMove(actor){return !!actor&&actor.hp>0&&!IMMOBILE_STATUSES.includes(actor.status);}
export function canDodge(actor){return canMove(actor);}

function typeImmune(target,status){
 const types=target.species?.types||[];
 return status==='poison'&&types.some(type=>type==='poison'||type==='steel')||status==='burn'&&types.includes('fire')||status==='paralysis'&&types.includes('electric');
}
// occupiedAtHit is captured before direct damage can wake an existing status.
// It prevents that same hit's secondary effect from replacing the status it broke.
export function applyStatus(target,status,duration=6,{occupiedAtHit=false}={}){
 if(!target||typeof status!=='string'||!status||status==='none'||!Number.isFinite(duration)||duration<=0||occupiedAtHit||target.status)return false;
 if(HARD_STATUSES.includes(status)&&(target.hardStatusGuard||0)>0||typeImmune(target,status))return false;
 target.status=status;target.statusTime=duration;return true;
}

function recoverHardStatus(target,remaining=HARD_STATUS_RECOVERY_SECONDS){target.hardStatusGuard=Math.max(target.hardStatusGuard||0,remaining);}
// Medicine and camp recovery share the same hard-status recovery window.
// Return the cleared status; HP and damage invincibility are left to the caller.
export function clearCombatStatus(target){
 if(!target)return null;
 const previous=target.status||null;target.status=null;target.statusTime=0;
 if(HARD_STATUSES.includes(previous))recoverHardStatus(target);
 return previous;
}
// Call only from a direct damage hit; burn/poison ticking must not call this.
export function clearFrozenSleepByDamage(target,damage){
 if(!target||!Number.isFinite(damage)||damage<=0||!['sleep','freeze'].includes(target.status))return false;
 clearCombatStatus(target);
 target.invincible=Math.max(target.invincible||0,DAMAGE_WAKE_PROTECTION_SECONDS);return true;
}

// Query before hit side effects; commit only after positive damage is confirmed.
// The same attacker's multi-hit sequence remains eligible. Each positive hit
// starts a short window against other wild attackers; its reference expires.
export function crowdDamageGrace(target,attacker,{commit=false}={}){
 if(target?.faction!=='player'||attacker?.faction!=='wild')return true;
 if((target.crowdDamageTime||0)>0&&target.crowdDamageSource&&target.crowdDamageSource!==attacker)return false;
 if(commit){target.crowdDamageTime=CROWD_DAMAGE_GRACE_SECONDS;target.crowdDamageSource=attacker;}
 return true;
}

const remaining=(seconds,dt)=>{const value=Math.max(0,(Number.isFinite(seconds)?seconds:0)-dt);return value<1e-9?0:value;};
// Invincibility still belongs to updateActor's existing timer. This advances
// only status duration and the new recovery/crowd windows, once per game step.
export function tickCombatStatus(actor,dt){
 if(!actor||!Number.isFinite(dt)||dt<=0)return {expired:null};
 if(actor.hardStatusGuard!==undefined)actor.hardStatusGuard=remaining(actor.hardStatusGuard,dt);
 if(actor.crowdDamageTime!==undefined){actor.crowdDamageTime=remaining(actor.crowdDamageTime,dt);if(!actor.crowdDamageTime)actor.crowdDamageSource=null;}
 if(!actor.status)return {expired:null};
 const before=Number.isFinite(actor.statusTime)?Math.max(0,actor.statusTime):0;
 actor.statusTime=remaining(before,dt);if(actor.statusTime)return {expired:null};
 const expired=actor.status;actor.status=null;
 if(HARD_STATUSES.includes(expired))recoverHardStatus(actor,Math.max(0,HARD_STATUS_RECOVERY_SECONDS-Math.max(0,dt-before)));
 return {expired};
}
