/**
 * KAN-88 P5 — JWT validator + middleware structural tests.
 *
 * Strategy: the validator's *algorithm* is verified by signing +
 * verifying a JWT through jose directly (proves the math). The
 * validator's *integration with the MCP server* is verified by
 * structural source-grep tests against src/index.ts + src/auth.ts.
 *
 * Importing the compiled dist/ from .test.cjs is not viable — the
 * MCP server builds ESM. The lyra-side P4 tests cover the validator
 * in isolation against a TS test (which can import @/lib/oauth/jwt).
 */

const fs = require('fs');
const path = require('path');

// jose v6 is ESM-only (no CommonJS build), so `require('jose')` throws
// "SyntaxError: Unexpected token 'export'" from a .cjs test. Load it via a
// dynamic import() — which works from CommonJS — in a top-level beforeAll,
// before any test that calls signSample() / jwtVerify() runs. (BUGS-64)
let SignJWT, jwtVerify;
beforeAll(async () => {
  ({ SignJWT, jwtVerify } = await import('jose'));
});

const TEST_SECRET = '0'.repeat(32);
const TEST_ISSUER = 'https://dev.checklyra.com';

async function signSample(overrides = {}) {
  const secret = new TextEncoder().encode(TEST_SECRET);
  const builder = new SignJWT({
    scope: 'lyra:full',
    client_id: 'lyra_oauth_test',
    ...(overrides.extra || {}),
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(overrides.issuer ?? TEST_ISSUER)
    .setSubject(overrides.sub ?? 'user-uuid-test')
    .setAudience(overrides.aud ?? 'lyra_oauth_test')
    .setJti(overrides.jti ?? 'jti-test-123')
    .setIssuedAt();
  if (overrides.exp !== undefined) builder.setExpirationTime(overrides.exp);
  else builder.setExpirationTime('1h');
  return builder.sign(secret);
}

describe('JWT algorithm round-trip (KAN-88 P5)', () => {
  test('HS256 sign + verify matches with shared secret', async () => {
    const token = await signSample();
    const { payload } = await jwtVerify(token, new TextEncoder().encode(TEST_SECRET), {
      issuer: TEST_ISSUER,
      algorithms: ['HS256'],
    });
    expect(payload.sub).toBe('user-uuid-test');
    expect(payload.scope).toBe('lyra:full');
    expect(payload.client_id).toBe('lyra_oauth_test');
    expect(payload.aud).toBe('lyra_oauth_test');
    expect(payload.jti).toBe('jti-test-123');
  });

  test('verification fails with wrong secret', async () => {
    const token = await signSample();
    const wrong = new TextEncoder().encode('x'.repeat(32));
    await expect(
      jwtVerify(token, wrong, { issuer: TEST_ISSUER, algorithms: ['HS256'] })
    ).rejects.toThrow();
  });

  test('verification fails with wrong issuer claim', async () => {
    const token = await signSample({ issuer: 'https://evil.com' });
    await expect(
      jwtVerify(token, new TextEncoder().encode(TEST_SECRET), {
        issuer: TEST_ISSUER,
        algorithms: ['HS256'],
      })
    ).rejects.toThrow();
  });

  test('verification fails on expired token', async () => {
    const token = await signSample({ exp: Math.floor(Date.now() / 1000) - 60 });
    await expect(
      jwtVerify(token, new TextEncoder().encode(TEST_SECRET), {
        issuer: TEST_ISSUER,
        algorithms: ['HS256'],
      })
    ).rejects.toThrow();
  });
});

describe('oauth-jwt.ts source structure (KAN-88 P5)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'oauth-jwt.ts'), 'utf8');

  test('exports validateOAuthAccessToken + looksLikeJwt', () => {
    expect(src).toMatch(/export async function validateOAuthAccessToken/);
    expect(src).toMatch(/export function looksLikeJwt/);
  });

  test('reads OAUTH_JWT_SIGNING_SECRET from env + enforces ≥32 chars (null-safe, no throw — SEC-33)', () => {
    expect(src).toMatch(/OAUTH_JWT_SIGNING_SECRET/);
    // SEC-33: the ≥32 gate is preserved but now returns null instead of throwing,
    // so a JWKS-only (RS256) deploy with no shared secret can't mask a valid token.
    expect(src).toMatch(/length < 32/);
  });

  test('reads issuer from LYRA_SITE_URL', () => {
    expect(src).toMatch(/LYRA_SITE_URL/);
  });

  test('uses HS256 + verifies issuer', () => {
    expect(src).toMatch(/algorithms:\s*\[\s*['"]HS256['"]/);
    expect(src).toMatch(/issuer:\s*expectedIssuer\(\)/);
  });

  test('checks revocation if OAUTH_REVOCATION_CHECK=1', () => {
    expect(src).toMatch(/OAUTH_REVOCATION_CHECK/);
    expect(src).toMatch(/oauth_access_tokens/);
    expect(src).toMatch(/revoked_at/);
  });

  test('returns typed errors (expired, revoked, signature, invalid_token, malformed)', () => {
    expect(src).toMatch(/error:\s*'expired'/);
    expect(src).toMatch(/error:\s*'revoked'/);
    expect(src).toMatch(/error:\s*'signature'/);
    expect(src).toMatch(/error:\s*'malformed'/);
  });

  test('looksLikeJwt does a structural sniff (3 dot-separated base64url parts, first decodes to JSON)', () => {
    expect(src).toMatch(/split\(['"]\.['"]\)/);
    expect(src).toMatch(/parts\.length !== 3/);
    expect(src).toMatch(/base64url/);
  });
});

describe('middleware integration (KAN-88 P5)', () => {
  const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');

  test('imports validator + sentinel + context', () => {
    expect(indexSrc).toMatch(/import\s+\{[^}]*validateOAuthAccessToken[^}]*\}/);
    expect(indexSrc).toMatch(/import\s+\{[^}]*looksLikeJwt[^}]*\}/);
    expect(indexSrc).toMatch(/import\s+\{[^}]*requestContext[^}]*\}/);
    expect(indexSrc).toMatch(/import\s+\{[^}]*OAUTH_AUTHED_SENTINEL[^}]*\}/);
  });

  test('JWT path runs BEFORE the lyra_ path', () => {
    const jwtIdx = indexSrc.indexOf('looksLikeJwt(token)');
    const legacyIdx = indexSrc.indexOf("token.startsWith('lyra_')");
    expect(jwtIdx).toBeGreaterThan(-1);
    expect(legacyIdx).toBeGreaterThan(-1);
    expect(jwtIdx).toBeLessThan(legacyIdx);
  });

  test('OAuth path overwrites args.api_key with the sentinel', () => {
    const region = indexSrc.slice(
      indexSrc.indexOf('looksLikeJwt(token)'),
      indexSrc.indexOf("startsWith('lyra_')")
    );
    expect(region).toMatch(/args\.api_key\s*=\s*OAUTH_AUTHED_SENTINEL/);
  });

  test('OAuth path wraps next() in requestContext.run with the resolved user', () => {
    const region = indexSrc.slice(
      indexSrc.indexOf('looksLikeJwt(token)'),
      indexSrc.indexOf("startsWith('lyra_')")
    );
    expect(region).toMatch(/requestContext\.run\(/);
    expect(region).toMatch(/oauthUserId:\s*result\.userId/);
  });

  test('non-tools/call methods bypass the auth middleware', () => {
    expect(indexSrc).toMatch(/method !== ['"]tools\/call['"]/);
  });

  test('handles JWT validator throwing (e.g. missing OAUTH_JWT_SIGNING_SECRET) by falling through', () => {
    const region = indexSrc.slice(indexSrc.indexOf('looksLikeJwt(token)'), indexSrc.indexOf("startsWith('lyra_')"));
    expect(region).toMatch(/try\s*\{[\s\S]*?\}\s*catch/);
  });
});

describe('authenticateApiKey OAuth path (KAN-88 P5)', () => {
  const authSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'auth.ts'), 'utf8');

  test('imports requestContext + OAUTH_AUTHED_SENTINEL', () => {
    expect(authSrc).toMatch(/import\s+\{[^}]*requestContext[^}]*\}/);
    expect(authSrc).toMatch(/import\s+\{[^}]*OAUTH_AUTHED_SENTINEL[^}]*\}/);
  });

  test('checks sentinel BEFORE the lyra_ prefix check', () => {
    const sentinelIdx = authSrc.indexOf('OAUTH_AUTHED_SENTINEL');
    const legacyIdx = authSrc.indexOf("apiKey.startsWith('lyra_')");
    expect(sentinelIdx).toBeGreaterThan(-1);
    expect(legacyIdx).toBeGreaterThan(-1);
    expect(sentinelIdx).toBeLessThan(legacyIdx);
  });

  test('returns the user_id from request context when sentinel matches', () => {
    expect(authSrc).toMatch(/ctx\?\.oauthUserId/);
    expect(authSrc).toMatch(/authenticated:\s*true,\s*userId:\s*ctx\.oauthUserId/);
  });
});

describe('request-context module (KAN-88 P5)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'request-context.ts'), 'utf8');

  test('exports requestContext + OAUTH_AUTHED_SENTINEL', () => {
    expect(src).toMatch(/export const requestContext/);
    expect(src).toMatch(/export const OAUTH_AUTHED_SENTINEL/);
  });

  test('uses node AsyncLocalStorage', () => {
    expect(src).toMatch(/from\s+['"]async_hooks['"]/);
    expect(src).toMatch(/new AsyncLocalStorage/);
  });
});
