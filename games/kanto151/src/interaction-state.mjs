export function interactionAvailable(game, i) {
 // Landmarks are discovered on approach; light is already automatic.
 if(i.kind==='landmark')return false;
 if(i.kind==='rune')return !game.save.flags?.['mew-puzzle'];
 if(i.kind==='door'&&game.world.gates?.find(g=>g.spec.id===i.door?.id)?.collider.disabled)return false;
 if(i.kind==='capability') {
  const s=i.shortcut;
  if(s?.capability==='flash')return false;
  if(s&&!['climb','surf'].includes(s.capability)&&game.expedition?.state.shortcuts?.includes(s.id))return false;
 }
 return !(i.kind==='pickup'&&i.usedUntil>game.save.playTime);
}
