import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';

const PROJECT = 'tcghubrogeun';
const TABLES = Object.freeze(['kanto151_save_backups','kanto151_saves']);
const ALLOWED_DDL = Object.freeze([
  'CREATE TABLE IF NOT EXISTS kanto151_saves ( user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, revision INTEGER NOT NULL CHECK(revision >= 1), updated_at TEXT NOT NULL, bundle_json TEXT NOT NULL )',
  'CREATE TABLE IF NOT EXISTS kanto151_save_backups ( user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, revision INTEGER NOT NULL CHECK(revision >= 1), updated_at TEXT NOT NULL, bundle_json TEXT NOT NULL, PRIMARY KEY (user_id, revision) )',
]);
const SCHEMA_CHECK = "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('kanto151_saves', 'kanto151_save_backups') ORDER BY name;";

// Only these two reviewed, additive statements may be sent to the existing DB.
// A changed schema must receive another review rather than widening this script.
export function reviewedSchema(sql) {
  if (typeof sql !== 'string') throw new Error('The account-save schema could not be read.');
  const statements = sql.replace(/--[^\r\n]*/g,'').split(';').map(value=>value.replace(/\s+/g,' ').trim()).filter(Boolean);
  if (statements.length !== ALLOWED_DDL.length || statements.some((value,index)=>value !== ALLOWED_DDL[index])) {
    throw new Error('The account-save schema differs from the two approved CREATE TABLE statements. No migration was run.');
  }
  return statements.join(';\n')+';\n';
}

export async function migrateKanto151({
  account = process.env.CLOUDFLARE_ACCOUNT_ID,
  token = process.env.CLOUDFLARE_API_TOKEN,
  fetchImpl = fetch,
  schema,
} = {}) {
  const sql = reviewedSchema(schema ?? await readFile(new URL('../functions/_schema/kanto151_saves.sql',import.meta.url),'utf8'));
  if (!account || !token) throw new Error('Cloudflare deployment credentials are missing. No migration was run.');
  const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}`;
  async function api(path,body) {
    let response;
    try {
      response = await fetchImpl(base+path,{
        method:body ? 'POST' : 'GET',
        headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
        ...(body ? {body:JSON.stringify(body)} : {}),
        signal:AbortSignal.timeout(60000),
      });
    } catch {
      throw new Error('Cloudflare could not be reached. Account-save migration stopped.');
    }
    let result;
    try { result = await response.json(); }
    catch { throw new Error(`Cloudflare returned an unreadable response (${response.status}). Account-save migration stopped.`); }
    if (!response.ok || result?.success !== true) {
      // Never print response/config/error bodies: they may contain private values.
      throw new Error(`Cloudflare request failed (${response.status}). Check Pages read and D1 edit permissions.`);
    }
    return result.result;
  }

  const project = await api(`/pages/projects/${PROJECT}`);
  const database = project?.deployment_configs?.production?.d1_databases?.DB?.id;
  if (typeof database !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(database)) {
    throw new Error('The existing production DB binding could not be resolved. No migration was run.');
  }
  const queryPath = `/d1/database/${encodeURIComponent(database)}/query`;
  const applied = await api(queryPath,{sql});
  if (!Array.isArray(applied) || applied.length !== ALLOWED_DDL.length || applied.some(statement=>statement.success !== true)) {
    throw new Error('The account-save table preparation was not confirmed. Deployment must stop.');
  }
  // Read schema names only. Never read user records, save contents or row counts.
  const checked = await api(queryPath,{sql:SCHEMA_CHECK});
  const names = checked?.[0]?.results?.map(row=>row.name).sort();
  if (!Array.isArray(checked) || checked.length !== 1 || checked[0].success !== true || !Array.isArray(names) || names.length !== TABLES.length || names.some((name,index)=>name !== TABLES[index])) {
    throw new Error('The two account-save table names could not be confirmed. Deployment must stop.');
  }
  return {ok:true,project:PROJECT,binding:'DB',tables:[...TABLES],userDataRead:false};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  migrateKanto151().then(()=>console.log('Kanto151 account-save tables are ready in the existing production DB. No user records were read.')).catch(error=>{
    console.error(error.message);
    process.exitCode = 1;
  });
}
