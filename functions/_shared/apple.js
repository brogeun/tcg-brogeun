/**
 * Apple Sign In — ID token (JWT) 검증 유틸
 *
 * Apple identityToken 은 RS256 으로 서명된 JWT.
 * 검증 절차:
 *   1) header.kid 로 Apple JWKS 에서 public key 찾기
 *   2) RSASSA-PKCS1-v1_5 SHA-256 서명 검증
 *   3) iss = "https://appleid.apple.com"
 *   4) aud ∈ 허용된 audience 목록 (iOS bundle id, web services id)
 *   5) exp > 현재시각
 *
 * 참고: https://developer.apple.com/documentation/sign_in_with_apple/verifying_a_user
 */

const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';
const APPLE_ISSUER = 'https://appleid.apple.com';

// 메모리 캐시 (Worker 인스턴스 살아있는 동안만)
let _jwksCache = null;
let _jwksCachedAt = 0;
const JWKS_TTL_MS = 60 * 60 * 1000; // 1시간

async function fetchAppleJwks() {
  const now = Date.now();
  if (_jwksCache && now - _jwksCachedAt < JWKS_TTL_MS) {
    return _jwksCache;
  }
  const res = await fetch(APPLE_JWKS_URL);
  if (!res.ok) throw new Error(`Failed to fetch Apple JWKS: ${res.status}`);
  const json = await res.json();
  _jwksCache = json;
  _jwksCachedAt = now;
  return json;
}

function b64urlDecodeToBytes(s) {
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return arr;
}

function b64urlDecodeToString(s) {
  return new TextDecoder().decode(b64urlDecodeToBytes(s));
}

export async function verifyAppleIdToken(idToken, allowedAudiences = []) {
  if (!idToken || typeof idToken !== 'string') {
    throw new Error('idToken (string) is required');
  }
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format');
  }
  const [headerB64, payloadB64, signatureB64] = parts;

  let header, payload;
  try {
    header = JSON.parse(b64urlDecodeToString(headerB64));
    payload = JSON.parse(b64urlDecodeToString(payloadB64));
  } catch (e) {
    throw new Error('Failed to parse JWT header/payload');
  }

  if (header.alg !== 'RS256') {
    throw new Error(`Unsupported alg: ${header.alg}`);
  }
  if (!header.kid) {
    throw new Error('Missing kid in header');
  }

  // Apple JWKS 에서 public key 찾기
  const jwks = await fetchAppleJwks();
  const key = (jwks.keys || []).find(k => k.kid === header.kid && (k.alg || 'RS256') === 'RS256');
  if (!key) {
    // 캐시 무효화 후 재시도 (키 로테이션 가능성)
    _jwksCache = null;
    const refreshed = await fetchAppleJwks();
    const key2 = (refreshed.keys || []).find(k => k.kid === header.kid);
    if (!key2) throw new Error(`Matching public key not found for kid=${header.kid}`);
  }
  const matchedKey = key || (await fetchAppleJwks()).keys.find(k => k.kid === header.kid);

  // JWK → CryptoKey
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    {
      kty: matchedKey.kty,
      n: matchedKey.n,
      e: matchedKey.e,
      alg: 'RS256',
      ext: true,
    },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );

  // 서명 검증
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const signature = b64urlDecodeToBytes(signatureB64);
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    signature,
    data
  );
  if (!valid) throw new Error('Invalid signature');

  // 페이로드 검증
  if (payload.iss !== APPLE_ISSUER) {
    throw new Error(`Invalid issuer: ${payload.iss}`);
  }
  if (allowedAudiences.length > 0 && !allowedAudiences.includes(payload.aud)) {
    throw new Error(`Invalid audience: ${payload.aud}`);
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < now) {
    throw new Error('Token expired');
  }
  if (typeof payload.iat === 'number' && payload.iat > now + 60) {
    throw new Error('Token issued in the future');
  }
  if (!payload.sub) {
    throw new Error('Missing sub in payload');
  }

  return payload;
}
