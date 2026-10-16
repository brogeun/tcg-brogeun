import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as core from '../games/kanto151/src/core.mjs';
import * as locale from '../games/kanto151/src/i18n.mjs';
import * as cooldowns from '../games/kanto151/src/cooldowns.mjs';
import * as recovery from '../games/kanto151/src/checkpoints.mjs';
import {recordActivity} from '../games/kanto151/src/journey-state.mjs';

// Execute the published class bodies intact, without a browser, GPU, network,
// or player storage. The runtime's actual EXP, save, move and locale modules
// remain in use; only rendering/browser surfaces are supplied by this harness.
const root = new URL('../games/kanto151/', import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(`data/${name}.json`, root), 'utf8'));
const species = read('species'), moves = read('moves');
const byId = new Map(species.map(p => [p.id, p]));
const moveById = new Map(moves.map(m => [m.id, m]));
locale.configureLocale({messages: read('locale-messages'), entities: read('locale-entities'), literals: read('locale-literals')});

function runtimeClass(file, name, dependencies) {
  const source = readFileSync(new URL(`src/${file}`, root), 'utf8')
    .replace(/^import[^\n]*\n/gm, '').replace(/^export /gm, '');
  return new Function(...Object.keys(dependencies), `${source}\nreturn ${name};`)(...Object.values(dependencies));
}
const Game = runtimeClass('game.mjs', 'Game', {
  ...core, ...locale, ...cooldowns, recovery, journey: {recordActivity},
  supplies: {shouldDropFood: () => false},
});
const noop = () => {};
function model() {
  return {position: {x: 0, y: 0, z: 0}, visible: true,
    scale: {setScalar: noop}, userData: {release: noop}};
}
function fixture() {
  const save = core.newSave(), lead = core.makePokemon(byId.get(1), 5);
  const other = core.makePokemon(byId.get(7), 5), fainted = core.makePokemon(byId.get(4), 5);
  for (const p of [lead, other, fainted]) core.registerCaught(save, p);
  fainted.hp = 0; save.starter = lead.id;
  const events = [], sounds = [], notices = [], g = Object.create(Game.prototype);
  Object.assign(g, {save, byId, moveById, storage: recovery.memoryStorage(),
    wild: [], target: null, capture: null, cooldowns: [0, 0, 0, 0], basicCooldown: 0,
    emit: (...args) => events.push(args), notify: (...args) => notices.push(args),
    audio: {play: sound => sounds.push(sound)},
    world: {effects: {remove: noop}, actors: {remove: noop}, burst: noop},
  });
  g.player = {pokemon: lead, species: byId.get(lead.id), level: lead.level,
    hp: lead.hp, maxHp: lead.hp, status: null, model: model()};
  g.activeMoves = core.pokemonMoves(lead, byId.get(lead.id), moveById);
  return {g, lead, other, fainted, events, sounds, notices};
}
function capture(g, success = true) {
  const target = {id: 19, species: byId.get(19), level: 5,
    shiny: false, capturing: true, model: model()};
  const mesh = {traverse: callback => callback({geometry: {dispose: noop}, material: {dispose: noop}})};
  const result = {target, mesh, to: {}, success, finished: false};
  g.wild.push(target); g.target = target; g.capture = result;
  return result;
}
const amountFor = target => Math.round(target.species.baseExperience * (.5 + target.level / 12));

test('real reward grants 100% to the lead and rounded 40% to healthy party members', () => {
  const {g, lead, other, fainted} = fixture(), c = capture(g), amount = amountFor(c.target);
  g.player.hp = 1;
  const reward = g.reward(c.target, true);
  assert.equal(reward.amount, amount);
  assert.equal(lead.exp, amount); assert.equal(other.exp, Math.round(amount * .4));
  assert.equal(fainted.exp, 0); assert.equal(lead.hp, 1); assert.equal(g.player.hp, 1);
  assert.deepEqual(reward.changes.map(p => [p.uid, p.experience, p.levels]),
    [[lead.uid, amount, 0], [other.uid, Math.round(amount * .4), 0]]);
});

for (const repeat of [false, true]) test(`${repeat ? 'repeat' : 'first'} capture reports actual level-up and retains EXP through real save/load`, async () => {
  const {g, lead, other, fainted, events, sounds} = fixture();
  if (repeat) core.registerCaught(g.save, core.makePokemon(byId.get(19), 5));
  lead.exp = core.expNeeded(lead.level) - 1; g.player.hp = 1;
  const c = capture(g), amount = amountFor(c.target);
  await g.finishCapture(c);
  const results = events.filter(e => e[0] === 'captureResult');
  assert.equal(results.length, 1); assert.equal(results[0][2], !repeat);
  assert.equal(lead.level, 6); assert.equal(lead.exp, amount - 1);
  assert.equal(other.exp, Math.round(amount * .4)); assert.equal(fainted.exp, 0);
  assert.equal(g.player.level, 6); assert.equal(g.player.hp, core.maxHP(byId.get(1), 6));
  assert.ok(sounds.includes('level'));
  const reward = results[0][3];
  assert.deepEqual(reward.changes.find(p => p.uid === lead.uid),
    {uid: lead.uid, id: lead.id, experience: amount, levels: 1, level: 6});
  assert.ok(!reward.changes.some(p => p.uid === fainted.uid));
  const restored = core.loadSave(g.storage);
  assert.ok(restored);
  for (const p of [lead, other, fainted]) {
    const saved = restored.collection.find(q => q.uid === p.uid);
    assert.equal(saved.exp, p.exp); assert.equal(saved.level, p.level); assert.equal(saved.hp, p.hp);
  }
  assert.equal(restored.collection.filter(p => p.id === 19).length, repeat ? 2 : 1);
});

test('failed and cancelled captures do not grant EXP or publish a capture result', async () => {
  for (const cancelled of [false, true]) {
    const {g, events} = fixture(), before = core.serialize(g.save), c = capture(g, cancelled);
    if (cancelled) assert.equal(g.cancelCapture(), true);
    await g.finishCapture(c);
    const after = JSON.parse(core.serialize(g.save)), original = JSON.parse(before);
    delete after.savedAt; delete original.savedAt;
    assert.deepEqual(after, original);
    assert.equal(events.filter(e => e[0] === 'captureResult').length, 0);
    assert.equal(c.target.model.visible, true); assert.equal(c.target.capturing, false);
  }
});

test('repeated or stale completion cannot award twice or capture an unrelated encounter', async () => {
  const {g, events} = fixture(), c = capture(g);
  await g.finishCapture(c);
  const before = JSON.stringify(g.save), eventCount = events.length;
  await g.finishCapture(c);
  assert.equal(JSON.stringify(g.save), before); assert.equal(events.length, eventCount);
  const stale = capture(g); g.capture = null;
  await g.finishCapture(stale);
  assert.equal(JSON.stringify(g.save), before); assert.equal(events.length, eventCount);
  assert.equal(stale.finished, false);
});

for (const selected of ['ko-KR', 'en-US']) test(`${selected} capture result displays each reward and only actual level-ups`, () => {
  locale.setLocale(selected);
  const {g} = fixture(), nodes = new Map();
  const document = {querySelector: key => {
    if (!nodes.has(key)) nodes.set(key, {innerHTML: '', onclick: null});
    return nodes.get(key);
  }};
  const UI = runtimeClass('ui.mjs', 'UI', {...core, ...locale, document, localizeDOM: noop});
  const ui = Object.assign(Object.create(UI.prototype), {game: g, shell: noop, preview: noop});
  const pokemon = core.makePokemon(byId.get(19), 5);
  const reward = {changes: [{id: 1, experience: 47, levels: 1, level: 6},
    {id: 7, experience: 19, levels: 0, level: 5}]};
  for (const fresh of [false, true]) {
    ui.captureResult(pokemon, fresh, reward);
    const html = document.querySelector('#panel-body').innerHTML;
    assert.ok(html.includes(locale.t('capture.experience')));
    for (const change of reward.changes) assert.ok(html.includes(locale.t('capture.experienceGain',
      {pokemon: byId.get(change.id).name, exp: change.experience})));
    assert.ok(html.includes(`↑ ${locale.t('common.levelLabel', {level: 6})}`));
    assert.ok(!html.includes(`↑ ${locale.t('common.levelLabel', {level: 5})}`));
    assert.equal(g.panel, 'capture-result');
  }
  ui.captureResult(pokemon, false);
  assert.ok(!document.querySelector('#panel-body').innerHTML.includes('capture-experience'));
});
