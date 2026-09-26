// Rare nests reuse authored habitat, time, weather and collection requirements.
export function rareNestInfo(save,entry){
 if(entry?.rarity!=='rare')return null;
 const key=entry.biomeId+':'+entry.speciesId,record=save.expedition?.rareNests?.[key];
 const readyAt=Number.isFinite(record?.readyAt)?record.readyAt:0,misses=Number.isInteger(record?.misses)?record.misses:0;
 return {key,readyAt,misses,remaining:Math.max(0,Math.ceil(readyAt-save.playTime)),chance:entry.encounterChance,cooldown:entry.respawnSeconds,pityAt:entry.pityAt,guaranteed:misses>=entry.pityAt-1};
}
export function rollRareNest(save,entry,rng=Math.random){
 const info=rareNestInfo(save,entry);if(!info||info.remaining)return null;
 const found=info.guaranteed||rng()<info.chance;
 return {key:info.key,found,record:{readyAt:save.playTime+info.cooldown,misses:found?0:info.misses+1}};
}
