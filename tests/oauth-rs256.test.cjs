/**
 * SEC-33 — dual-accept verifier guards (user MCP). Mirrors the admin MCP guard.
 * Static-source checks; behavioural proof is the web-AS unit tests + dev E2E.
 */
const fs = require('fs');
const path = require('path');
const jwt = fs.readFileSync(path.join(__dirname, '..', 'src', 'oauth-jwt.ts'), 'utf8');

describe('SEC-33 dual-accept OAuth verifier', () => {
  test('RS256 via the AS JWKS is the PRIMARY path', () => {
    expect(jwt).toMatch(/createRemoteJWKSet/);
    expect(jwt).toMatch(/algorithms:\s*\['RS256'\]/);
    expect(jwt).toMatch(/OAUTH_JWKS_URI/);
    expect(jwt).toMatch(/\.well-known\/jwks\.json/);
  });

  test('HS256 is a gated, secret-null-safe fallback (never throws on missing secret)', () => {
    expect(jwt).toMatch(/OAUTH_ALLOW_HS256_FALLBACK/);
    expect(jwt).toMatch(/algorithms:\s*\['HS256'\]/);
    expect(jwt).toMatch(/return null/);
    expect(jwt).not.toMatch(/must be set to at least 32 chars/);
  });

  test('algorithm-confusion safe: only single-element alg allow-lists, never combined', () => {
    expect(jwt).not.toMatch(/\[\s*'RS256'\s*,\s*'HS256'\s*\]/);
    expect(jwt).not.toMatch(/\[\s*'HS256'\s*,\s*'RS256'\s*\]/);
  });

  test('RS256 is tried before HS256', () => {
    expect(jwt.indexOf("algorithms: ['RS256']")).toBeLessThan(jwt.indexOf("algorithms: ['HS256']"));
  });

  test('issuer is enforced on every verification', () => {
    expect(jwt).toMatch(/issuer:\s*expectedIssuer\(\)/);
  });
});
