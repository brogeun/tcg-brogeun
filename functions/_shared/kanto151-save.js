// Account saves preserve the original serialized journal and recovery checkpoint.
// Validation never migrates, repairs, combines or rewrites a player's Pokémon.
export const MAX_SAVE_BODY_BYTES = 2 * 1024 * 1024;
const IDS = /^[A-Za-z0-9_.-]{1,80}$/;
const REGIONS = new Set(['camp','grassland','forest','lake','coast','mountain','cave','wetland','powerplant','ruins','safari','volcano','frozen','laboratory','verdant','waterside','highlands','caldera','complex','harbor']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(message); };
const number = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isFinite(value) && value >= min && value <= max;
const id = value => typeof value === 'string' && IDS.test(value);
const integerList = (value, maxLength, maxValue = 1000) => Array.isArray(value) && value.length <= maxLength && new Set(value).size === value.length && value.every(n => Number.isInteger(n) && n > 0 && n <= maxValue);

function parseFiniteJson(text) {
  if (typeof text !== 'string') fail('저장 기록은 JSON 문자열이어야 합니다.');
  let parsed;
  try { parsed = JSON.parse(text); } catch { fail('저장 기록의 JSON을 읽을 수 없습니다.'); }
  // JSON.parse accepts overflowing exponents such as 1e999. Do not store them.
  const pending = [parsed];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'number' && !Number.isFinite(value)) fail('저장 기록의 숫자가 올바르지 않습니다.');
    if (value && typeof value === 'object') for (const child of Object.values(value)) pending.push(child);
  }
  return parsed;
}

export function validateKantoSave(text) {
  const save = parseFiniteJson(text);
  if (!object(save) || ![2,3].includes(save.version) || ![1,4,7,25].includes(save.starter)) fail('시작 포켓몬을 선택한 관동 저장 기록만 등록할 수 있습니다.');
  if (!Array.isArray(save.collection) || !save.collection.length || save.collection.length > 20000 || !Array.isArray(save.party) || !save.party.length || save.party.length > 6 || !object(save.dex)) fail('포켓몬과 동행 기록이 있는 저장만 등록할 수 있습니다.');
  if (save.checkpointId !== undefined && !id(save.checkpointId)) fail('복귀 기록 식별자가 올바르지 않습니다.');
  const uids = new Set();
  for (const pokemon of save.collection) {
    if (!object(pokemon) || !id(pokemon.uid) || uids.has(pokemon.uid) || !Number.isInteger(pokemon.id) || pokemon.id < 1 || pokemon.id > 151 || !Number.isInteger(pokemon.level) || pokemon.level < 1 || pokemon.level > 100 || !number(pokemon.hp,0,10000) || !number(pokemon.exp) || typeof pokemon.shiny !== 'boolean') fail('포켓몬 기록이 올바르지 않습니다.');
    uids.add(pokemon.uid);
    if (pokemon.status !== undefined && pokemon.status !== null && (typeof pokemon.status !== 'string' || pokemon.status.length > 40)) fail('포켓몬 상태가 올바르지 않습니다.');
    if (pokemon.friendship !== undefined && !number(pokemon.friendship,0,255)) fail('친밀도 기록이 올바르지 않습니다.');
    const fields = ['moveIds','knownMoveIds','pendingMoveIds'];
    if (fields.some(key => pokemon[key] !== undefined) && (!integerList(pokemon.moveIds,4) || !pokemon.moveIds.length || !integerList(pokemon.knownMoveIds,1000) || !integerList(pokemon.pendingMoveIds,1000) || pokemon.moveIds.some(move => !pokemon.knownMoveIds.includes(move)) || pokemon.pendingMoveIds.some(move => !pokemon.knownMoveIds.includes(move) || pokemon.moveIds.includes(move)))) fail('기술 기록이 올바르지 않습니다.');
    if (pokemon.basicCooldown !== undefined && !number(pokemon.basicCooldown,0,120)) fail('기술 대기 기록이 올바르지 않습니다.');
    if (pokemon.cooldowns !== undefined && (!object(pokemon.cooldowns) || Object.entries(pokemon.cooldowns).some(([key,value]) => !/^\d+$/.test(key) || +key < 1 || +key > 1000 || !number(value,0,120)))) fail('기술 대기 기록이 올바르지 않습니다.');
  }
  if (new Set(save.party).size !== save.party.length || save.party.some(uid => !uids.has(uid))) fail('동행 포켓몬 기록이 올바르지 않습니다.');
  for (const [key, entry] of Object.entries(save.dex)) {
    if (!/^\d+$/.test(key) || +key < 1 || +key > 151 || !object(entry) || typeof entry.caught !== 'boolean' || ['seen','shinySeen','shinyCaught'].some(field => entry[field] !== undefined && typeof entry[field] !== 'boolean')) fail('도감 기록이 올바르지 않습니다.');
  }
  if (!object(save.inventory) || Object.values(save.inventory).some(value => !number(value)) || !number(save.coins) || !number(save.playTime) || !number(save.worldTime,0,24) || save.worldTime === 24) fail('아이템 또는 진행 기록이 올바르지 않습니다.');
  if (!REGIONS.has(save.region) || !Array.isArray(save.position) || save.position.length !== 2 || save.position.some(value => !number(value,-70,70)) || (save.worldId !== undefined && save.worldId !== 'kanto-five-v1')) fail('관동 탐험 위치가 올바르지 않습니다.');
  if (!Array.isArray(save.bosses) || save.bosses.some(value => ![144,145,146,150,151].includes(value)) || !Array.isArray(save.discovered) || save.discovered.some(value => !REGIONS.has(value))) fail('탐험 기록이 올바르지 않습니다.');
  if (save.survival !== undefined) {
    const needs = save.survival;
    if (!object(needs) || !number(needs.hunger,0,100) || !number(needs.thirst,0,100) || !Array.isArray(needs.drops) || needs.drops.length > 24) fail('생존 기록이 올바르지 않습니다.');
    const drops = new Set();
    for (const drop of needs.drops) {
      if (!object(drop) || !id(drop.id) || drops.has(drop.id) || !REGIONS.has(drop.region) || !number(drop.x,-70,70) || !number(drop.z,-70,70) || !number(drop.createdAt)) fail('채집 기록이 올바르지 않습니다.');
      drops.add(drop.id);
    }
  }
  if (save.settings !== undefined && (!object(save.settings) || !number(save.settings.volume,0,1) || !['auto','high','low'].includes(save.settings.quality) || !number(save.settings.camera,0.2,3) || typeof save.settings.motion !== 'boolean')) fail('설정 기록이 올바르지 않습니다.');
  return save;
}

export function checkpointDigest(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i),16777619);
  return (hash >>> 0).toString(16);
}

export function validateSaveBundle(bundle) {
  if (!object(bundle) || bundle.schema !== 1 || typeof bundle.save !== 'string' || !(bundle.checkpoint === null || typeof bundle.checkpoint === 'string')) fail('계정 저장 묶음이 올바르지 않습니다.');
  const save = validateKantoSave(bundle.save);
  if (bundle.checkpoint !== null) {
    const checkpoint = parseFiniteJson(bundle.checkpoint);
    if (!object(checkpoint) || checkpoint.schema !== 1 || checkpoint.owner !== save.collection[0].uid || typeof checkpoint.snapshot !== 'string' || checkpoint.checksum !== checkpointDigest(checkpoint.snapshot) || typeof checkpoint.savedAt !== 'string' || !Number.isFinite(Date.parse(checkpoint.savedAt))) fail('복귀 기록의 원본을 확인할 수 없습니다.');
    const snapshot = validateKantoSave(checkpoint.snapshot);
    if (snapshot.collection[0].uid !== checkpoint.owner || (snapshot.checkpointId ?? null) !== (save.checkpointId ?? null) || checkpoint.region !== snapshot.region) fail('다른 탐험의 복귀 기록은 등록할 수 없습니다.');
  }
  // Keep only the wire-format fields; save and checkpoint strings remain exact.
  return {schema:1,save:bundle.save,checkpoint:bundle.checkpoint};
}

export function recordFromRow(row) {
  if (!row) return null;
  if (!Number.isSafeInteger(row.revision) || row.revision < 1 || typeof row.updated_at !== 'string' || !Number.isFinite(Date.parse(row.updated_at))) fail('서버 저장 기록을 확인할 수 없습니다.');
  return {revision:row.revision,updatedAt:row.updated_at,bundle:validateSaveBundle(JSON.parse(row.bundle_json))};
}

export async function readBoundedJson(request) {
  const length = request.headers.get('Content-Length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_SAVE_BODY_BYTES)) return {status:413};
  if (!request.body) return {status:400};
  const reader = request.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const {value,done} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_SAVE_BODY_BYTES) { await reader.cancel(); return {status:413}; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk,offset); offset += chunk.byteLength; }
    return {body:JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes))};
  } catch { return {status:400}; }
  finally { reader.releaseLock(); }
}
