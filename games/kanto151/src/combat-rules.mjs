// Pure combat reach rules, shared by player input, impact checks and AI.
export function moveReach(move){return move.engine.range;}
export function withinMoveReach(actor,target,move){return actor.model.position.distanceTo(target.model.position)<=moveReach(move)+.001;}
export const CAPTURE_SAFETY_SECONDS=.7;
// The initial retaliation must allow the initiating move to become a real attack.
export const WILD_OPENING_REACTION_SECONDS=.9;
export function openingResponseDelay(move,{basic=false,distance=0,contact=0}={}){
 const e=move.engine;let lead=basic?.1:e.castTime;
 if(['ground-aoe','radial-aoe','trap'].includes(e.template))lead=Math.max(.5,e.castTime);
 else if(['projectile','homing'].includes(e.template))lead=(basic?.06:e.castTime)+distance/(e.projectileSpeed||18);
 else if(e.template==='dash')lead=(basic?.08:e.castTime)+Math.min(.42,Math.max(0,distance-contact)/19+.04);
 else if(e.template==='multi-hit')lead+=(Math.max(1,e.hitCount||3)-1)*.14;
 return Math.max(WILD_OPENING_REACTION_SECONDS,lead+.12);
}
