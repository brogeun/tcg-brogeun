import { readFile } from 'node:fs/promises';

// Uses the existing deployment credentials inside CI. Never logs credentials/config.
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error('Cloudflare deployment credentials are missing.');
const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}`;
async function api(path, body) {
  const response = await fetch(base + path, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(60000),
  });
  const result = await response.json();
  if (!response.ok || !result.success) {
    throw new Error(`Cloudflare request failed (${response.status}; codes: ${(result.errors || []).map(e => e.code).join(',')}). Check Pages read and D1 edit permissions.`);
  }
  return result.result;
}
const project = await api('/pages/projects/tcghubrogeun');
const database = project.deployment_configs?.production?.d1_databases?.DB?.id;
if (!database) throw new Error('The existing production DB binding could not be resolved. No migration was run.');
const sql = await readFile(new URL('../functions/_schema/volleyball.sql', import.meta.url), 'utf8');
const result = await api(`/d1/database/${encodeURIComponent(database)}/query`, { sql });
if (!Array.isArray(result) || result.some(statement => statement.success === false)) {
  throw new Error('Volleyball migration did not complete successfully.');
}
console.log('Volleyball tables ready in the existing production DB.');
