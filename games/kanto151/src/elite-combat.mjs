export const ELITE_STYLES=Object.freeze({
 'coast-guard':{name:'집게의 넓은 휩쓸기',hint:'부채꼴 공격 앞에서 벗어나세요',patterns:['projectile','cone'],interval:2.7},
 'stone-guard':{name:'바위 돌진과 충격파',hint:'돌진 선을 피하고 주변 원 밖으로 나가세요',patterns:['dash','radial-aoe'],interval:3.2},
 'circuit-guard':{name:'반복 전류와 직선 광선',hint:'전류 원은 여러 번 울려요. 광선은 옆으로 피하세요',patterns:['trap','beam'],interval:3.1},
 'ember-guard':{name:'불꽃 돌진과 지열 폭발',hint:'돌진을 피한 뒤 지열 원 밖에서 공격하세요',patterns:['dash','ground-aoe'],interval:2.8}
});
export function eliteAttack(actor,base){const style=ELITE_STYLES[actor.eliteStyle||actor.eliteId];if(!style)return null;const cycle=actor.attackCycle||1,phase=actor.hp<actor.maxHp*.5,template=style.patterns[(cycle-1)%style.patterns.length],engine={...base.engine,template,range:template==='cone'?10:20,castTime:template==='dash'?.8:template==='beam'?1:template==='trap'?1.05:.9};if(['radial-aoe','ground-aoe','trap'].includes(template))engine.radius=template==='trap'?2.2:phase?3.6:2.8;if(template==='projectile')engine.projectileSpeed=13;if(template==='trap')engine.power=Math.round(engine.power*.75);return {move:{...base,engine,feedback:{...base.feedback,tier:'heavy'}},interval:style.interval-(phase?.35:0),guard:template==='radial-aoe'?.9:0,hint:style.hint};}

// AI selects the next announced pattern using that pattern's real reach.
export function nextAttackReach(actor,base){return eliteAttack({...actor,attackCycle:(actor.attackCycle||0)+1},base)?.move.engine.range??base.engine.range;}
