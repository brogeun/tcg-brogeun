import * as THREE from '../vendor/three.module.js';
import {containsBasePoint} from './base-layout.mjs';

// Cosmetic instances only: authored terrain, travel routes and encounter data
// remain the authority for movement. Every sample is derived from region/id.
const THEMES = {
 verdant: {cover: ['Grass_Wispy_Short', 'Clover_1', 'Fern_1', 'Flower_3_Group'], shrub: 'Bush_Common', stone: 'Pebble_Round_3', skyline: 'CommonTree_2', canopy: '#527545', rock: '#89907a'},
 waterside: {cover: ['Grass_Wispy_Tall', 'Grass_Common_Short', 'Plant_1', 'Flower_4_Group'], shrub: 'Bush_Common', stone: 'Pebble_Round_5', skyline: 'CommonTree_3', canopy: '#648568', rock: '#b6b29a'},
 highlands: {cover: ['Grass_Wispy_Short', 'Grass_Common_Short', 'Pebble_Round_5', 'Pebble_Square_3'], shrub: 'Rock_Medium_2', stone: 'Pebble_Square_3', skyline: 'Pine_2', canopy: '#5c776e', rock: '#919b98'},
 caldera: {cover: ['Pebble_Square_3', 'Pebble_Square_6', 'Pebble_Round_3'], shrub: 'Rock_Medium_1', stone: 'Pebble_Square_6', skyline: 'Rock_Medium_3', canopy: '#6f6755', rock: '#696259'},
 complex: {cover: ['Grass_Wispy_Short', 'Clover_2', 'Fern_1', 'Pebble_Square_3'], shrub: 'Bush_Common', stone: 'Pebble_Square_3', skyline: 'CommonTree_4', canopy: '#5b7769', rock: '#929f95'}
};
const TAU = Math.PI * 2;
// Conservative horizontal radius / height from the bundled model bounds. Flat
// pebbles and wide ferns need more clearance than upright flowers and grasses.
const FOOTPRINT = {Fern_1: 2.34, Pebble_Round_3: 3.4, Pebble_Round_5: 2.72, Pebble_Square_3: 1.57, Pebble_Square_6: 1.94, Grass_Wispy_Short: .86, Grass_Wispy_Tall: .68, Bush_Common: .89, Rock_Medium_1: .99, Rock_Medium_2: 1.05, Rock_Medium_3: 1.07, CommonTree_2: .42, CommonTree_3: .33, CommonTree_4: .3, Pine_2: .55};
const model = name => `quaternius/${name}`;
const hash = text => {let n = 2166136261; for (const char of text) n = Math.imul(n ^ char.charCodeAt(0), 16777619); return n >>> 0;};
const randomFrom = seed => () => {seed |= 0; seed = seed + 0x6d2b79f5 | 0; let n = Math.imul(seed ^ seed >>> 15, 1 | seed); n ^= n + Math.imul(n ^ n >>> 7, 61 | n); return ((n ^ n >>> 14) >>> 0) / 4294967296;};
const inPolygon = (x, z, points = []) => {let inside = false; for (let i = 0, j = points.length - 1; i < points.length; j = i++) {const a = points[i], b = points[j]; if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;} return inside;};
const distance = (x, z, a, b) => {const dx = b[0] - a[0], dz = b[1] - a[1], t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / Math.max(.0001, dx * dx + dz * dz))); return Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t);};
const pocketDistance = (p, x, z) => Math.hypot((x - p.center[0]) / p.radius[0], (z - p.center[1]) / p.radius[1]);

function wetOrBank(c, x, z, margin) {
 return (c.waterBodies || []).some(body => {
  const polygons = [body.polygon, ...(body.holes || []).map(h => h.polygon || h)];
  if (inPolygon(x, z, body.polygon) && !(body.holes || []).some(h => inPolygon(x, z, h.polygon || h))) return true;
  return polygons.some(polygon => polygon.some((a, i) => distance(x, z, a, polygon[(i + 1) % polygon.length]) < margin));
 });
}

function clearPoint(c, interactions, x, z, radius, backdrop = false) {
 const bounds = c.playableBounds, pad = backdrop ? radius + 1.4 : radius + .4;
 if (!backdrop && (x < bounds.min[0] + pad || x > bounds.max[0] - pad || z < bounds.min[1] + pad || z > bounds.max[1] - pad)) return false;
 if ([-radius, radius].some(dx => [-radius, radius].some(dz => containsBasePoint(x + dx, z + dz, c.id))) || wetOrBank(c, x, z, radius + .5)) return false;
 if ((c.paths || []).some(path => path.points.some((a, i) => i && distance(x, z, path.points[i - 1], a) < path.width / 2 + radius + .5))) return false;
 if (interactions.some(point => Math.hypot(point.x - x, point.z - z) < radius + 2.2)) return false;
 if ((c.entrances || []).some(entry => Math.hypot(entry.position.x - x, entry.position.z - z) < radius + 5)) return false;
 if (Math.hypot(c.safePoint.position.x - x, c.safePoint.position.z - z) < radius + 5) return false;
 return !(c.props || []).some(prop => {
  const dx = x - prop.x, dz = z - prop.z, co = Math.cos(prop.rotation || 0), si = Math.sin(prop.rotation || 0), b = prop.bounds;
  if (!b) return Math.hypot(dx, dz) < radius + (prop.collision?.radius || 1);
  // Tall crowns can shade undergrowth, while trunks and structures stay clear.
  const tree = /Tree|Pine/.test(prop.rendererKey || ''), w = tree ? 1.1 : b.width / 2, d = tree ? 1.1 : b.depth / 2;
  return Math.abs(dx * co - dz * si) < w + radius + .5 && Math.abs(dx * si + dz * co) < d + radius + .5;
 });
}

// Species sub-pockets share the scenery allocation of their original habitat.
// Their combined footprint sets one budget; every individual centre remains a
// reserved encounter clearing below, including overlapping sub-pockets.
function dressingGroups(pockets) {
 const groups = new Map();
 for (const pocket of pockets) {
  const id = pocket.habitatGroup || pocket.id;
  if (!groups.has(id)) groups.set(id, {id, pockets: [], min: [Infinity, Infinity], max: [-Infinity, -Infinity], area: 0});
  const group = groups.get(id), area = pocket.radius[0] * pocket.radius[1];
  group.pockets.push({pocket, area});group.area += area;
  for (let i = 0; i < 2; i++) {group.min[i] = Math.min(group.min[i], pocket.center[i] - pocket.radius[i]);group.max[i] = Math.max(group.max[i], pocket.center[i] + pocket.radius[i]);}
 }
 return [...groups.values()];
}

/** Deterministic plan, also used to verify route/encounter clearance without WebGL. */
export function landscapePlan(c, interactions = []) {
 const theme = THEMES[c.id];
 if (!theme || !c.playableBounds) return [];
 const plan = [], pockets = (c.ecologyPockets || []).filter(p => !p.indoor && p.method !== 'fishing');
 const emit = (name, x, z, height, random, role, radius) => {
  // Reservations may remove a candidate, but must never change the random
  // sequence which authors the next cluster or introduce replacement scenery.
  const rotation = random() * TAU, shade = .86 + random() * .2;
  // Authored expedition groves now own the habitat edge. Keep the old distant
  // backdrop and trail shoulder, avoiding a second ring of generic shrubs.
  if(c.expeditionRebuilt&&['groundcover','shrub-cluster'].includes(role))return;
  radius = Math.max(radius, height * (FOOTPRINT[name] || .95));
  if (!clearPoint(c, interactions, x, z, radius, role === 'backdrop')) return;
  // Keep a broad, readable centre in every overlapping encounter pocket.
  if (role !== 'backdrop' && pockets.some(p => pocketDistance(p, x, z) < .64)) return;
  plan.push({path: model(name), x, z, height, rotation, shade, role, radius});
 };
 const clusterAt = (x, z, random, role) => {
  const count = 6 + Math.floor(random() * 4), turn = random() * TAU;
  for (let i = 0; i < count; i++) {
   const angle = turn + i * 2.399963, spread = .25 + Math.sqrt(i / count) * (1.2 + random() * .55);
   const name = theme.cover[Math.floor(random() * theme.cover.length)], stone = /Pebble/.test(name);
   const height = stone ? .23 + random() * .3 : .48 + random() * .42;
   emit(name, x + Math.cos(angle) * spread, z + Math.sin(angle) * spread, height, random, role, .3);
  }
  // A low, broad mass anchors the grass cluster; two offset bushes form an
  // irregular silhouette instead of a uniform row of isolated tiny plants.
  for (let i = 0; i < 2; i++) {
   const angle = turn + i * 2.1, spread = .65 + random() * .8;
   const height = c.id === 'caldera' || c.id === 'highlands' ? .45 + random() * .35 : .95 + random() * .5;
   emit(theme.shrub, x + Math.cos(angle) * spread, z + Math.sin(angle) * spread, height, random, 'shrub-cluster', .65);
  }
 };
 for (const group of dressingGroups(pockets)) {
  const random = randomFrom(hash(`${c.id}/${group.id}/landscape-v2`));
  const count = Math.min(14, Math.max(7, Math.round((group.max[0] - group.min[0]) * (group.max[1] - group.min[1]) / 20)));
  const turn = random() * TAU;
  for (let i = 0; i < count; i++) {
   // Spread this fixed allocation across species habitats by footprint, rather
   // than giving every new species pocket another minimum of seven clusters.
   let ticket = (i + .5) / count * group.area, pocket = group.pockets.at(-1).pocket;
   for (const member of group.pockets) {ticket -= member.area;if (ticket <= 0) {pocket = member.pocket;break;}}
   const angle = turn + i * 2.399963 + (random() - .5) * .5, r = .8 + random() * .24;
   const x = pocket.center[0] + Math.cos(angle) * pocket.radius[0] * r, z = pocket.center[1] + Math.sin(angle) * pocket.radius[1] * r;
   clusterAt(x, z, random, 'groundcover');
  }
 }
 // These authored facility bounds also define a narrow dressing border. The
 // playable plaza stays open; low clusters frame it from beyond its footprint.
 const shelter = c.baseLayout?.bounds;
 if (shelter) {
  const random = randomFrom(hash(`${c.id}/shelter-border-v2`));
  for (let i = 0; i < 26; i++) {
   const side = i % 4, t = random(), gap = 2.5 + random() * 2.5;
   const x = side === 0 ? shelter[0] - gap : side === 1 ? shelter[2] + gap : shelter[0] + (shelter[2] - shelter[0]) * t;
   const z = side === 2 ? shelter[1] - gap : side === 3 ? shelter[3] + gap : shelter[1] + (shelter[3] - shelter[1]) * t;
   clusterAt(x, z, random, 'shelter-edge');
  }
  // Frame the far and side edges of the shelter, leaving the near/south camera
  // approach completely free of tall foliage.
  for (const [x, z] of [[shelter[0] - 4.5, shelter[1] - 4], [shelter[2] + 4.5, shelter[1] - 4], [shelter[0] - 5, shelter[1] + 1.5], [shelter[2] + 5, shelter[1] + 1.5]]) {
   emit(theme.skyline, x + (random() - .5) * 1.8, z + (random() - .5) * 1.8, 4.2 + random() * 1.8, random, 'shelter-silhouette', 2.6);
  }
 }
 // A few chipped stones and grass tufts follow existing trails only where they
 // meet authored habitat pockets. No plant instances are scattered over routes.
 const edgeRandom = randomFrom(hash(`${c.id}/trail-edge-v1`));
 for (const path of c.paths || []) for (let i = 1; i < path.points.length; i++) {
  const a = path.points[i - 1], b = path.points[i], dx = b[0] - a[0], dz = b[1] - a[1], length = Math.hypot(dx, dz);
  for (let along = 1.4; along < length; along += 2.2 + edgeRandom() * 1.3) for (const side of [-1, 1]) {
   const offset = path.width / 2 + .95 + edgeRandom() * .5, x = a[0] + dx * along / length - dz / length * offset * side, z = a[1] + dz * along / length + dx / length * offset * side;
   if (!pockets.some(p => pocketDistance(p, x, z) < 1.06)) continue;
   emit(theme.stone, x, z, .16 + edgeRandom() * .13, edgeRandom, 'trail-edge', .25);
  }
 }
 // Distant silhouettes sit outside traversable bounds and leave generous breaks
 // at every authored exit. They add depth without placing trees in the camera.
 const random = randomFrom(hash(`${c.id}/skyline-v1`)), b = c.playableBounds;
 for (const side of [0, 1, 2, 3]) for (let i = 0; i < 7; i++) {
  const t = (i + .4 + random() * .2) / 7, gap = 2.7 + random() * .7;
  const x = side === 0 ? b.min[0] - gap : side === 1 ? b.max[0] + gap : b.min[0] + (b.max[0] - b.min[0]) * t;
  const z = side === 2 ? b.min[1] - gap : side === 3 ? b.max[1] + gap : b.min[1] + (b.max[1] - b.min[1]) * t;
  // The south edge is nearest the default camera: use low stones there.
  const low = side === 3, name = low ? 'Rock_Medium_2' : theme.skyline, height = low ? .6 + random() * .8 : c.id === 'caldera' ? 3.6 + random() * 3.4 : 4.6 + random() * 2.4;
  emit(name, x, z, height, random, 'backdrop', low ? .9 : 2.5);
 }
 return plan;
}

export async function buildLandscapeDressing(world, c) {
 const theme = THEMES[c.id], plan = landscapePlan(c, world.interactions || []);
 if (!theme) return world.landscapeStats = {region: c.id, instances: 0, meshes: 0, batches: 0, byRole: {}};
 const batches = new Map();
 for (const placement of plan) {if (!batches.has(placement.path)) batches.set(placement.path, []); batches.get(placement.path).push(placement);}
 let instances = 0, meshes = 0;
 for (const [path, placements] of batches) {
  const template = await world.template(path), bounds = template.userData.bounds, size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3());
  const align = new THREE.Matrix4().makeTranslation(-center.x, -bounds.min.y, -center.z), transform = new THREE.Object3D(), matrix = new THREE.Matrix4(), sources = [];
  template.traverse(source => {if (source.isMesh) sources.push(source);});
  for (const source of sources) {
   const original = source.material, materials = (Array.isArray(original) ? original : [original]).map(material => {
    const copy = material.clone(), leafy = /Leaves|Leaf|Pine/i.test(material.name) && !!material.map;
    copy.onBeforeCompile = (shader, renderer) => {
     material.onBeforeCompile.call(copy, shader, renderer);
     if (leafy) {
      shader.uniforms.landscapeCanopy = {value: new THREE.Color(theme.canopy)};
      shader.fragmentShader = 'uniform vec3 landscapeCanopy;\n' + shader.fragmentShader.replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.rgb=landscapeCanopy*(.70+dot(diffuseColor.rgb,vec3(.2126,.7152,.0722))*.45);');
     }
    };
    if (/Pebble|Rock/.test(path)) copy.color.lerp(new THREE.Color(theme.rock), .42);
    copy.roughness = 1;
    copy.customProgramCacheKey = () => `landscape-v1-${c.id}-${material.name}-${leafy ? 'leaf' : 'solid'}-${material.userData.wind ? 'wind' : 'still'}`;
    (world.ownedMaterials ??= []).push(copy);
    return copy;
   });
   const mesh = new THREE.InstancedMesh(source.geometry, Array.isArray(original) ? materials : materials[0], placements.length);
   mesh.userData.shared = true;
   mesh.userData.landscapeDressing = true;
   mesh.userData.landscapeAsset = path;
   mesh.receiveShadow = true;
   mesh.castShadow = /Tree|Pine/.test(path);
   for (let i = 0; i < placements.length; i++) {
    const p = placements[i], scale = p.height / Math.max(.05, size.y), tall = p.role === 'backdrop' || p.role === 'shelter-silhouette';
    const root = Math.min(1.4, p.radius * .45);
    // Seat broad distant bases into the lowest nearby ground so a shelf/ramp
    // cannot leave one side of the root or boulder visibly hanging in the air.
    const y = tall ? Math.min(world.height(p.x, p.z), world.height(p.x - root, p.z), world.height(p.x + root, p.z), world.height(p.x, p.z - root), world.height(p.x, p.z + root)) : world.height(p.x, p.z);
    transform.position.set(p.x, y - (tall ? .16 : .025), p.z);
    transform.rotation.set(0, p.rotation, 0);
    transform.scale.setScalar(scale);
    transform.updateMatrix();
    matrix.copy(transform.matrix).multiply(align).multiply(source.matrixWorld);
    mesh.setMatrixAt(i, matrix);
    mesh.setColorAt(i, new THREE.Color().setScalar(p.shade));
   }
   mesh.instanceMatrix.needsUpdate = true;
   if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
   mesh.computeBoundingSphere();
   world.level.add(mesh);
   meshes++;
  }
  instances += placements.length;
 }
 const byRole = {};
 for (const p of plan) byRole[p.role] = (byRole[p.role] || 0) + 1;
 return world.landscapeStats = {region: c.id, instances, meshes, batches: batches.size, byRole};
}
