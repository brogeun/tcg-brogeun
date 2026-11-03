// Only visual bone sampling is throttled. The field simulation, status timers,
// collisions and AI continue at the normal step rate in Game.updateActor.
const clocks = new WeakMap();
export const ANIMATION_CADENCE = Object.freeze({near:18,visibleHz:15,hiddenHz:5});

export function actorAnimationDelta(game,actor,dt){
 if(!Number.isFinite(dt)||dt<=0)return 0;
 if(!actor||!actor.model)return dt;
 const p=actor.model.position,player=game.player?.model?.position;
 const distance=player?Math.hypot(p.x-player.x,p.z-player.z):0;
 const important=actor===game.player||actor===game.target||actor.angry||actor.action||actor.combatMotion||actor.recoil||actor.hit>0||actor.capturing||game.fieldAction?.actor===actor;
 const visible=distance<=ANIMATION_CADENCE.near||game.world.actorVisible?.(actor.model)!==false;
 const interval=important||distance<=ANIMATION_CADENCE.near?0:visible?1/ANIMATION_CADENCE.visibleHz:1/ANIMATION_CADENCE.hiddenHz;
 let clock=clocks.get(actor);
 if(!clock){clock={elapsed:0,visible};clocks.set(actor,clock);return dt;}
 clock.elapsed+=dt;
 const revealed=visible&&!clock.visible;clock.visible=visible;
 if(interval>0&&!revealed&&clock.elapsed+1e-8<interval)return 0;
 const elapsed=clock.elapsed;clock.elapsed=0;return elapsed;
}
