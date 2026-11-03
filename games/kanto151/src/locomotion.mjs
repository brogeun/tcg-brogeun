import {speciesEcology} from './species-ecology.mjs';

const finite=value=>Number.isFinite(value)?value:0;
const hasClip=(animations,name)=>!!name&&!!animations[name];

/** Select a base pose for the actor's actual medium, leaving action layers alone. */
export function selectLocomotionClip(info,animations,state={}){
 const clips=info.clips||{},air=state.grounded!==true&&state.airborne!==false&&(state.airborne===true||['fly','hover'].includes(state.locomotion));
 if(air){
  const suffix=state.moving?'air_fly':'air_idle',authored=state.moving?clips.airWalk:clips.airIdle;
  if(hasClip(animations,authored))return authored;
  const native=(info.animations||Object.keys(animations)).find(name=>name.endsWith('.'+suffix)&&hasClip(animations,name));
  if(native)return native;
 }
 const semantic=state.moving?'walk':state.battle?'battle':'idle';
 return clips[semantic]||clips.idle;
}

/** Called after habitat/collision constraints, so blocked intent cannot walk in place. */
export function settleActorLocomotion(actor,previous,dt){
 if(!Number.isFinite(dt)||dt<=0||!previous||!actor.model?.position)return;
 const profile=speciesEcology(actor.id??actor.species?.id??actor.speciesId),position=actor.model.position;
 actor.locomotion=profile?.locomotion||'ground';
 actor.airborne=['fly','hover'].includes(actor.locomotion)&&!actor.grounded;
 const state=actor.locomotionState??={moving:false,stoppedFor:0,speed:0};
 const speed=Math.hypot(finite(position.x-previous.x),finite(position.z-previous.z))/dt;
 state.speed=speed;
 // A collision nudge or recoil is displacement, but is not voluntary locomotion.
 const intended=!!actor.moving&&!actor.recoil&&!actor.capturing&&!(actor.hp<=0);
 const moving=intended&&speed>(state.moving?.015:.035);
 if(moving){state.moving=true;state.stoppedFor=0;}
 else{
  state.stoppedFor+=dt;
  if(state.stoppedFor>=.09||actor.recoil||actor.capturing||actor.hp<=0)state.moving=false;
 }
 actor.moving=state.moving;
 return state;
}

/** Keep a chosen obstacle side briefly instead of switching on every frame. */
export function steeringCandidates(state,dt,turns){
 state.steeringHold=Math.max(0,(state.steeringHold||0)-dt);
 const held=state.steeringTurn;
 return state.steeringHold>0&&held&&turns.includes(held)?[held,...turns.filter(turn=>turn!==held)]:turns;
}
export function rememberSteering(state,turn){
 if(turn!==state.steeringTurn){state.steeringTurn=turn;state.steeringHold=turn===0?0:.24;}
}
