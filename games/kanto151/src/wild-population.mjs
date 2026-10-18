import {ecologyPosition, habitatValid} from './ecology.mjs';

export const WILD_POPULATION_LIMIT = 12;
const distance = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const actorPosition = actor => actor.model?.position || actor.position || (Number.isFinite(actor.x) && Number.isFinite(actor.z) ? actor : null);
const actorId = actor => actor.id ?? actor.speciesId ?? actor.entry?.speciesId;
const boundedCount = (value, fallback) => Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
const insidePocket = (point, pocket) => !!point && Math.hypot((point.x - pocket.center[0]) / pocket.radius[0], (point.z - pocket.center[1]) / pocket.radius[1]) <= 1;

/**
 * Plan field encounters without changing the game, save, composition or actors.
 * `limit` bounds this batch; existing living encounters also consume the regional
 * budget. Ecology placement runs against a private list including planned actors.
 */
export function planWildPopulation(game, {limit = WILD_POPULATION_LIMIT, index = game.spawnIndex || 0} = {}) {
 const world = game.world || {}, region = game.save?.region || world.region || world.composition?.id;
 const biome = game.biomeById?.get(region) || game.biomes?.find(b => b.id === region) || world.biome || game.biome;
 const composition = world.composition || game.compositions?.regions?.[region] || null;
 const alive = (game.wild || []).filter(actor => actor.hp > 0);
 const budget = Math.min(WILD_POPULATION_LIMIT, boundedCount(composition?.budget?.maxActiveWild, WILD_POPULATION_LIMIT));
 const allowance = Math.min(boundedCount(limit, 0), Math.max(0, budget - alive.length));
 if (!allowance || !biome?.spawnTable || typeof game.eligible !== 'function') return [];
 index = boundedCount(index, 0);

 // Repeated rows in a source spawn table do not act as extra species tickets.
 const bySpecies = new Map();
 for (const entry of biome.spawnTable) if (entry.method === 'field' && game.eligible(entry) && !bySpecies.has(entry.speciesId)) bySpecies.set(entry.speciesId, entry);
 const entries = [...bySpecies.values()];
 if (!entries.length) return [];
 const pockets = (composition?.ecologyPockets || []).filter(p => p.method === 'field' && p.speciesIds?.some(id => bySpecies.has(id)));
 const groups = pockets.map((pocket, rank) => ({
  pocket, rank, count: 0, turn: 0, failed: new Set(),
  capacity: Math.min(budget, boundedCount(pocket.count?.[1], budget)),
  entries: entries.filter(entry => pocket.speciesIds.includes(entry.speciesId)),
 }));
 // Older fixtures have no authored composition. Keep their field population
 // usable, while an authored map with no field habitat correctly stays empty.
 if (!composition) groups.push({pocket: null, rank: 0, count: 0, turn: 0, failed: new Set(), capacity: budget, entries});
 if (!groups.length) return [];

 const speciesCounts = new Map();
 for (const actor of alive) {
  const id = actorId(actor);
  speciesCounts.set(id, (speciesCounts.get(id) || 0) + 1);
  let group = groups.find(g => g.pocket && actor.pocket && (g.pocket === actor.pocket || g.pocket.id && g.pocket.id === actor.pocket.id));
  if (!group && (!actor.entry?.method || actor.entry.method === 'field')) {
   const point = actorPosition(actor);
   group = groups.find(g => g.pocket?.speciesIds.includes(id) && insidePocket(point, g.pocket));
  }
  if (group) group.count++;
 }

 const virtualWild = alive.flatMap(actor => {
  const point = actorPosition(actor);
  return point && Number.isFinite(point.x) && Number.isFinite(point.z) ? [{...actor, model: {position: point}}] : [];
 });
 // Own writable properties also allow read-only/frozen fixtures to be planned.
 const virtualWorld = Object.create(world, {composition: {value: composition, writable: true}});
 const virtualGame = Object.create(game, {world: {value: virtualWorld}, wild: {value: virtualWild}});
 const plan = [], exhausted = new Set();
 let lastId = actorId(alive.at(-1) || {});
 const offset = index % groups.length;
 const rank = group => (group.rank - offset + groups.length) % groups.length;
 const canAlternate = group => group.entries.some(entry => entry.speciesId !== lastId && !group.failed.has(entry.speciesId));
 const separated = point => virtualWild.every(actor => distance(actor.model.position, point) >= 2.2);

 while (plan.length < allowance) {
  const available = groups.filter(group => group.count < group.capacity && !exhausted.has(group));
  available.sort((a, b) => a.count - b.count || Number(canAlternate(b)) - Number(canAlternate(a)) || rank(a) - rank(b));
  let placed = false;
  for (const group of available) {
   virtualWorld.composition = composition ? {...composition, ecologyPockets: [group.pocket]} : null;
   const start = (index + group.rank + group.turn) % group.entries.length;
   const candidates = group.entries.map((entry, i) => ({entry, rank: (i - start + group.entries.length) % group.entries.length})).filter(({entry}) => !group.failed.has(entry.speciesId));
   candidates.sort((a, b) => Number(a.entry.speciesId === lastId) - Number(b.entry.speciesId === lastId)
    || (speciesCounts.get(a.entry.speciesId) || 0) - (speciesCounts.get(b.entry.speciesId) || 0) || a.rank - b.rank);
   for (const {entry, rank: speciesRank} of candidates) {
    let point = null;
    const seed = index + plan.length + group.rank * 17 + speciesRank * 3;
    for (let attempt = 0; attempt < (composition ? 1 : 96); attempt++) {
     const slot = index % 97 + plan.length + attempt, angle = slot * 2.3999632297, radius = 3.3 * Math.sqrt(slot + 1);
     const origin = composition ? null : {x: 10 + Math.cos(angle) * radius, z: 14 + Math.sin(angle) * radius};
     const candidate = ecologyPosition(virtualGame, entry, seed + attempt, origin);
     if (!candidate || !Number.isFinite(candidate.x) || !Number.isFinite(candidate.z) || !separated(candidate)) continue;
     if (composition && !habitatValid(virtualGame, {id: entry.speciesId, pocket: group.pocket}, candidate.x, candidate.z, null, {spacing: true})) continue;
     if (!composition && typeof world.collision === 'function') {
      const resolved = virtualWorld.collision(candidate.x, candidate.z, .6);
      if (Math.hypot(resolved[0] - candidate.x, resolved[1] - candidate.z) > .05) continue;
     }
     if (!composition && typeof world.height === 'function' && !Number.isFinite(virtualWorld.height(candidate.x, candidate.z))) continue;
     point = candidate; break;
    }
    if (!point) {group.failed.add(entry.speciesId); continue;}
    const item = {entry, x: point.x, z: point.z, pocket: group.pocket || point.pocket || null};
    plan.push(item);
    virtualWild.push({hp: 1, id: entry.speciesId, entry, pocket: item.pocket, model: {position: {x: point.x, z: point.z}}});
    group.count++; group.turn++; lastId = entry.speciesId;
    speciesCounts.set(lastId, (speciesCounts.get(lastId) || 0) + 1);
    placed = true; break;
   }
   if (placed) break;
   exhausted.add(group);
  }
  if (!placed) break;
 }
 return plan;
}
