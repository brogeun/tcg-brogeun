// Engine cooldowns are seconds, already balanced in moves.json. Never convert PP or milliseconds.
export function cooldownSeconds(move){const value=move?.engine?.cooldown;if(!Number.isFinite(value)||value<=0)throw Error(`Invalid cooldown for move ${move?.id}`);return value;}
export function cooldownText(move){return String(Number(cooldownSeconds(move).toFixed(2)));}
export function remainingText(seconds){return seconds>0?(Math.ceil(seconds*10-1e-8)/10).toFixed(1):'';}
export function rememberCooldowns(game){const p=game.player?.pokemon;if(!p)return;p.cooldowns??={};for(const [i,m] of (game.activeMoves||[]).entries()){const v=game.cooldowns?.[i];if(Number.isFinite(v)&&v>=0)p.cooldowns[m.id]=v;}p.basicCooldown=Math.max(0,game.basicCooldown||0);}
export function readCooldowns(game){const p=game.player.pokemon;game.cooldowns=game.activeMoves.map(m=>Math.min(cooldownSeconds(m),p.cooldowns?.[m.id]||0));game.basicCooldown=p.basicCooldown||0;}
export function tickCooldowns(game,dt){rememberCooldowns(game);for(const p of game.save.collection){for(const id of Object.keys(p.cooldowns||{}))p.cooldowns[id]=Math.max(0,p.cooldowns[id]-dt);p.basicCooldown=Math.max(0,(p.basicCooldown||0)-dt);}const old=game.cooldowns;readCooldowns(game);game.cooldowns.forEach((v,i)=>{if(old[i]>0&&v===0)game.emit('cooldownReady',i);});}
