import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from '../games/kanto151/vendor/three.module.js';
import * as core from '../games/kanto151/src/core.mjs';
import * as locale from '../games/kanto151/src/i18n.mjs';
import * as cooldowns from '../games/kanto151/src/cooldowns.mjs';
import * as combatRules from '../games/kanto151/src/combat-rules.mjs';
import * as statusRules from '../games/kanto151/src/status-rules.mjs';
import * as escapeActions from '../games/kanto151/src/escape-action.mjs';
import * as targeting from '../games/kanto151/src/target-selection.mjs';
import {createCaptureBall} from '../games/kanto151/src/ball-visuals.mjs';

// Run the published class and its actual combat/targeting helpers without a
// browser, GPU, network, player storage or a copy of the gameplay algorithms.
const root = new URL('../games/kanto151/', import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(`data/${name}.json`, root), 'utf8'));
const species = read('species'), moves = read('moves'), chart = read('type-chart');
const byId = new Map(species.map(p => [p.id, p]));
const moveById = new Map(moves.map(m => [m.id, m]));
locale.configureLocale({messages: read('locale-messages'), entities: read('locale-entities'), literals: read('locale-literals')});
const noop = () => {};
function runtimeModule(file, names, dependencies) {
  const source = readFileSync(new URL(`src/${file}`, root), 'utf8')
    .replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '');
  return new Function(...Object.keys(dependencies), `${source}\nreturn {${names.join(',')}};`)(...Object.values(dependencies));
}
const combatFeedback = runtimeModule('combat-feedback.mjs', ['feedbackProfile', 'actorRadius', 'contactReach'], {...core, THREE});
const {cancelFieldAction} = runtimeModule('field-actions.mjs', ['cancelFieldAction'], {THREE, statusRules, ...locale});
const {Game} = runtimeModule('game.mjs', ['Game'], {
  THREE, ...core, ...locale, ...cooldowns, ...combatRules, ...combatFeedback,
  ...targeting, statusRules, escapeActions, createCaptureBall, cancelFieldAction,
  journey: {fieldRuns: {cancelRunSurvey: noop}},
});

function actor(id, x, pokemon = null) {
  const model = new THREE.Group();
  model.position.set(x, 0, 0);
  model.userData = {height: 1, release: noop};
  return {faction: pokemon ? 'player' : 'wild', id, species: byId.get(id), pokemon,
    model, home: model.position.clone(), level: 5, hp: 1000, maxHp: 1000,
    status: null, statusTime: 0, action: null, actionTime: 0, buff: 0, debuff: 0, shield: 0};
}
function fixture({other = true} = {}) {
  const save = core.newSave(), pokemon = core.makePokemon(byId.get(1), 5);
  core.registerCaught(save, pokemon); save.starter = pokemon.id;
  save.inventory['poke-ball'] = 3;
  const g = Object.create(Game.prototype);
  Object.assign(g, {save, byId, moveById, chart, phase: 'playing', panel: null,
    regionEpoch: 1, ball: 'poke-ball', tasks: [], projectiles: [], capture: null,
    basicCooldown: 0, cooldowns: [0], activeMoves: [moveById.get(10)],
    player: actor(1, 0, pokemon), wild: [], target: null,
    world: {actors: new THREE.Group(), effects: new THREE.Group(), height: () => 0,
      ring: noop, burst: noop},
    audio: {play: noop, combat: noop}, emit: noop, notify: noop,
    feedback: {windup: noop, travel: noop, impact: noop},
  });
  const captured = actor(19, 3), next = other ? actor(19, 1.4) : null;
  g.wild = next ? [captured, next] : [captured];
  for (const a of [g.player, ...g.wild]) g.world.actors.add(a.model);
  g.target = captured;
  g.throwBall();
  assert.ok(g.capture, 'the real throw must begin capture');
  return {g, captured, next, capture: g.capture};
}
function resolvePendingHits(g) {
  // Execute the real callbacks scheduled by cast(), without starting the field
  // simulation, AI, rendering or browser frame loop.
  for (const task of g.tasks.splice(0).sort((a, b) => a.delay - b.delay)) task.fn();
}

for (const slot of [-1, 0]) test(`a ${slot < 0 ? 'basic attack' : 'skill'} immediately starts and hits the next opponent during capture`, () => {
  const {g, captured, next, capture} = fixture(), hp = next.hp;
  g.attack(slot);
  assert.equal(capture.time, 0, 'no throw recovery or capture timer advance is required');
  assert.equal(g.target, next); assert.equal(g.player.action, 'attack');
  assert.ok(slot < 0 ? g.basicCooldown > 0 : g.cooldowns[0] > 0);
  assert.ok(g.tasks.length > 0);
  resolvePendingHits(g);
  assert.ok(next.hp < hp, 'the actual cast callback and hit must apply damage');
  assert.equal(captured.hp, captured.maxHp); assert.equal(g.capture, capture);
});

test('target changes and repeated throws retain the original capture and consume exactly one ball', () => {
  const {g, captured, next, capture} = fixture();
  const from = capture.from.clone(), to = capture.to.clone();
  for (const elapsed of [0, .5, 1.3]) {
    capture.time = elapsed; g.target = next; g.throwBall();
    assert.equal(g.capture, capture); assert.equal(capture.target, captured);
    assert.ok(capture.from.equals(from)); assert.ok(capture.to.equals(to));
    assert.equal(g.save.inventory['poke-ball'], 2); assert.equal(next.capturing, undefined);
  }
});

test('capture permits cycling and real raycast click selection while excluding its own opponent', () => {
  const {g, captured, next, capture} = fixture(), third = actor(25, 5);
  captured.model.position.x = -3; next.model.position.x = 2;
  g.wild.push(third); g.world.actors.add(third.model);
  assert.equal(g.lockTarget(), true); assert.equal(g.target, next);
  assert.equal(g.lockTarget(), true); assert.equal(g.target, third);
  assert.equal(g.lockTarget(-1), true); assert.equal(g.target, next);
  for (const a of g.wild) a.model.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial()));
  g.world.camera = new THREE.PerspectiveCamera(45, 1000 / 600, .1, 100);
  g.world.camera.position.set(0, 3, 12); g.world.camera.lookAt(0, 0, 0);
  g.world.camera.updateMatrixWorld(true);
  g.world.renderer = {domElement: {getBoundingClientRect: () => ({left: 20, top: 30, width: 1000, height: 600})}};
  const click = a => {
    const point = a.model.position.clone().project(g.world.camera);
    return g.selectTargetAt(20 + (point.x + 1) * 500, 30 + (1 - point.y) * 300);
  };
  g.target = third; assert.equal(click(next), true); assert.equal(g.target, next);
  assert.equal(click(captured), false); assert.equal(g.target, next);
  assert.equal(capture.time, 0); assert.equal(capture.target, captured);
});

test('capture without another available opponent spends neither basic nor skill cooldown', () => {
  const {g, captured, capture} = fixture({other: false});
  g.attack(-1); g.attack(0);
  assert.equal(g.basicCooldown, 0); assert.deepEqual(g.cooldowns, [0]);
  assert.equal(g.tasks.length, 0); assert.equal(captured.hp, captured.maxHp);
  assert.equal(g.capture, capture); assert.equal(g.save.inventory['poke-ball'], 2);
});

test('capture does not bypass sleep, freeze or stun, while a movement root still permits attacks', () => {
  for (const status of ['sleep', 'freeze', 'stun', 'trap']) {
    const {g, next} = fixture();
    g.player.status = status; g.player.statusTime = 5; g.attack(0);
    if (status === 'trap') {
      assert.equal(g.target, next); assert.ok(g.cooldowns[0] > 0);
      resolvePendingHits(g); assert.ok(next.hp < next.maxHp);
    } else {
      assert.equal(g.tasks.length, 0); assert.equal(g.cooldowns[0], 0);
      assert.equal(next.hp, next.maxHp);
    }
  }
});

test('capture keeps existing basic and skill cooldowns instead of creating another cast', () => {
  const {g, next} = fixture(); g.target = next;
  g.basicCooldown = .4; g.cooldowns[0] = 1.2;
  g.attack(-1); g.attack(0);
  assert.equal(g.tasks.length, 0); assert.equal(g.player.castSerial, undefined);
  assert.equal(g.basicCooldown, .4); assert.deepEqual(g.cooldowns, [1.2]);
});

test('the captured opponent stays protected from direct hits and actual area damage to another opponent', () => {
  const {g, captured, next, capture} = fixture();
  g.hit(g.player, captured, moveById.get(33));
  assert.equal(captured.hp, captured.maxHp); assert.equal(captured.angry, undefined);
  g.activeMoves = [moveById.get(89)]; g.attack(0); assert.equal(g.target, next);
  resolvePendingHits(g);
  assert.ok(next.hp < next.maxHp); assert.equal(captured.hp, captured.maxHp);
  assert.equal(captured.capturing, true); assert.equal(g.capture, capture);
});
