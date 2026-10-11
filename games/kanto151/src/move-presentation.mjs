// Move identity is independent of damage data and localized names.
const groups={
 slash:'scratch,slash,cut,fury-swipes,fury-cutter,false-swipe,metal-claw,crush-claw,dragon-claw,air-cutter,aerial-ace',
 bite:'bite,crunch,hyper-fang,super-fang,poison-fang,fire-fang',
 punch:'pound,mega-punch,karate-chop,comet-punch,fire-punch,ice-punch,thunder-punch,mach-punch,dynamic-punch,focus-punch,shadow-punch,sky-uppercut,cross-chop,brick-break',
 kick:'double-kick,mega-kick,jump-kick,rolling-kick,high-jump-kick,low-kick',
 needle:'poison-sting,twineedle,pin-missile,spike-cannon,bullet-seed',
 leaf:'razor-leaf,magical-leaf,petal-dance,frenzy-plant',
 vine:'vine-whip,bind,wrap,constrict,leech-seed',
 bubble:'bubble,bubble-beam,water-pulse',
 jet:'water-gun,hydro-pump,hydro-cannon,octazooka',
 flame:'flamethrower,fire-blast,heat-wave,overheat,blast-burn',
 ember:'ember,fire-spin,flame-wheel',
 spark:'thunder-shock,thunderbolt,thunder,zap-cannon,shock-wave,spark',
 frost:'ice-beam,aurora-beam,icy-wind,powder-snow,blizzard,icicle-spear,sheer-cold,ice-ball',
 stone:'rock-throw,rock-slide,rock-blast,rock-tomb,ancient-power,rollout',
 fault:'earthquake,magnitude,fissure,dig,bone-club,bone-rush,bonemerang,mud-shot,mud-slap,sand-tomb',
 shadow:'shadow-ball,night-shade,lick,astonish,dream-eater,nightmare,confuse-ray',
 psychic:'confusion,psychic,psybeam,psywave,future-sight,hypnosis',
 gust:'gust,razor-wind,whirlwind,twister,silver-wind,wing-attack,fly,steel-wing',
 sound:'growl,roar,screech,sing,supersonic,snore,uproar,hyper-voice,perish-song,metal-sound,grass-whistle,heal-bell',
 powder:'poison-powder,stun-spore,sleep-powder,spore,smog,poison-gas,sweet-scent,smokescreen',
 sludge:'acid,sludge,sludge-bomb,toxic',
 star:'swift,tri-attack,signal-beam',
 drain:'absorb,mega-drain,giga-drain,leech-life',
 solar:'solar-beam',
 rush:'tackle,take-down,quick-attack,extreme-speed,waterfall,volt-tackle,flare-blitz',
 wave:'surf', explosion:'self-destruct,explosion', beam:'hyper-beam,dragon-breath,dragon-rage'
};
const named=new Map(Object.entries(groups).flatMap(([family,list])=>list.split(',').map(slug=>[slug,family])));
export const MOVE_FAMILIES=Object.freeze([...Object.keys(groups),'heal','shield','buff','status','contact','projectile','area']);
export function movePresentation(move){const template=move.engine.template;if(['heal','shield','buff'].includes(template))return template;return named.get(move.slug)||({debuff:'status',trap:'area','ground-aoe':'area','radial-aoe':'area',dash:'rush',beam:'beam',cone:'gust',melee:'contact','multi-hit':'contact'}[template]||'projectile');}
export function projectileShape(move){const f=movePresentation(move);return f==='star'?'star':['needle','frost','stone','fault'].includes(f)?'shard':f==='leaf'?'leaf':['psychic','shadow','bubble','sound'].includes(f)?'ring':'orb';}
// Named action identity stays stable across language changes and evolution.
export const ELEMENTAL_VARIANTS=Object.freeze(['ember','flamethrower','fire-blast','fire-spin','heat-wave','overheat','blast-burn','bubble','bubble-beam','water-pulse','water-gun','hydro-pump','hydro-cannon','thunder-shock','thunderbolt','thunder','ice-beam','blizzard']);
export function moveEffectVariant(move){return ELEMENTAL_VARIANTS.includes(move.slug)?move.slug:movePresentation(move);}
