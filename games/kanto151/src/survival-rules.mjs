// Assistance uses saved active exploration time; menus and closed tabs do not consume it.
export const BEGINNER_SURVIVAL_RULES=Object.freeze({seconds:600,drainScale:.5,depletionScale:.25});
export function beginnerSurvivalRemaining(save){const elapsed=Number.isFinite(save?.playTime)?Math.max(0,save.playTime):0;return Math.max(0,BEGINNER_SURVIVAL_RULES.seconds-elapsed);}
export const survivalDrainScale=save=>beginnerSurvivalRemaining(save)>0?BEGINNER_SURVIVAL_RULES.drainScale:1;
export const survivalDepletionScale=save=>beginnerSurvivalRemaining(save)>0?BEGINNER_SURVIVAL_RULES.depletionScale:1;
