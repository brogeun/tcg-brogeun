// First two legacy routes stay recognizable; later rounds vary all three activity orders.
export const RUN_ORDERS=Object.freeze([[0,1,2],[0,1,2],[1,2,0],[2,0,1],[1,0,2],[2,1,0]]);
export const CIRCUIT_ORDERS=Object.freeze([[1,3,2],[3,2,1],[2,1,3],[2,3,1],[1,2,3],[3,1,2]]);
export function routeVariant(r){return ((Math.max(1,r.round)-1)%6);}
export function orderedRunSteps(d,r){return r.routeVersion===1?RUN_ORDERS[routeVariant(r)].map(i=>d.steps[i]).concat(d.steps.at(-1)):d.steps;}
export function runReward(r,rules){const bonus=r.routeVersion===1&&r.round%3===0;return {coins:rules.coins+(bonus?rules.coins:0),tokens:rules.tokens+(bonus?1:0),bonus};}
export function runRewardText(r,rules){const reward=runReward(r,rules);return '연구 기록 '+reward.tokens+' · 자금 '+reward.coins+(reward.bonus?' · 3회 단위 조사 보너스':'');}