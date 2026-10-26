import assert from 'node:assert/strict';
import { test } from 'node:test';
import { onRequestGet, onRequestPost } from '../../functions/api/auth/verify.js';
import { sha256Hex } from '../../functions/_shared/jwt.js';

async function fixture() {
  const code = 'integration-kakao-code';
  const digest = await sha256Hex(code);
  const token = 'oauth-kakao:' + digest;
  const rows = new Map([[token, { email: 'owner@example.test', expires_at: Math.floor(Date.now() / 1000) + 300, used: 0 }]]);
  const reads = [];
  const env = { JWT_SECRET: 'namespace-test-secret', DB: {
    prepare(sql) {
      assert.match(sql, /^SELECT email, expires_at, used FROM magic_tokens WHERE token = \?$/);
      return { bind(value) { return { async first() { reads.push(value); return rows.get(value) || null; } }; } };
    },
  } };
  return { env, rows, reads, token, digest };
}

test('the email-link endpoint rejects a Kakao credential namespace before storage access', async () => {
  const f = await fixture();
  const response = await onRequestGet({ request: new Request('https://tcghub.kr/api/auth/verify?token=' + encodeURIComponent(f.token)), env: f.env });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.deepEqual(f.reads, []);
  assert.equal(f.rows.get(f.token).used, 0);
});

test('removing the Kakao namespace does not turn its digest into an email credential', async () => {
  const f = await fixture();
  const response = await onRequestGet({ request: new Request('https://tcghub.kr/api/auth/verify?token=' + f.digest), env: f.env });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.deepEqual(f.reads, [f.digest]);
  assert.equal(f.rows.get(f.token).used, 0);
});

test('the native email verifier cannot claim a Kakao credential in the shared table', async () => {
  const f = await fixture();
  const response = await onRequestPost({ request: new Request('https://tcghub.kr/api/auth/verify', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://tcghub.kr' },
    body: JSON.stringify({ verifier: f.digest }),
  }), env: f.env });
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.deepEqual(f.reads, ['app:' + await sha256Hex(f.digest)]);
  assert.equal(f.rows.get(f.token).used, 0);
});
