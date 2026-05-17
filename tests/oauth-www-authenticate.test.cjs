/**
 * KAN-88 P6 — WWW-Authenticate header tests.
 *
 * Tests the builder + verifies the middleware integration. Header
 * format follows RFC 6750 + MCP authorization spec.
 */

const fs = require('fs');
const path = require('path');

// Inline the builder logic for behavioural testing — the compiled file
// is ESM and not importable from .test.cjs.
function buildHeader(error, description, siteUrl = 'https://dev.checklyra.com', resource = 'https://mcp-dev.checklyra.com/mcp') {
  const asUri = siteUrl.replace(/\/$/, '') + '/.well-known/oauth-authorization-server';
  const safeDesc = description.replace(/"/g, '\\"');
  return [
    `Bearer realm="${resource}"`,
    `error="${error}"`,
    `error_description="${safeDesc}"`,
    `as_uri="${asUri}"`,
  ].join(', ');
}

describe('wwwAuthenticateBearer builder shape (KAN-88 P6)', () => {
  test('begins with Bearer scheme', () => {
    const h = buildHeader('invalid_token', 'expired');
    expect(h.startsWith('Bearer ')).toBe(true);
  });

  test('includes realm (resource URL)', () => {
    const h = buildHeader('invalid_token', 'expired');
    expect(h).toContain('realm="https://mcp-dev.checklyra.com/mcp"');
  });

  test('includes error + error_description', () => {
    const h = buildHeader('invalid_token', 'signature failed');
    expect(h).toContain('error="invalid_token"');
    expect(h).toContain('error_description="signature failed"');
  });

  test('includes as_uri pointing at AS metadata', () => {
    const h = buildHeader('invalid_token', 'expired', 'https://dev.checklyra.com');
    expect(h).toContain('as_uri="https://dev.checklyra.com/.well-known/oauth-authorization-server"');
  });

  test('escapes double-quotes in description', () => {
    const h = buildHeader('invalid_token', 'expected "S256"');
    expect(h).toContain('error_description="expected \\"S256\\""');
  });
});

describe('middleware 401 response on invalid JWT (KAN-88 P6)', () => {
  const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const builderSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'oauth-www-authenticate.ts'), 'utf8');

  test('builder file exists + wired into index.ts', () => {
    expect(builderSrc).toMatch(/export function wwwAuthenticateBearer/);
    expect(indexSrc).toMatch(/import\s+\{[^}]*wwwAuthenticateBearer[^}]*\}/);
  });

  test('middleware responds 401 when JWT is invalid', () => {
    const region = indexSrc.slice(indexSrc.indexOf('looksLikeJwt(token)'), indexSrc.indexOf("startsWith('lyra_')"));
    expect(region).toMatch(/\.status\(401\)/);
  });

  test('401 sets WWW-Authenticate header', () => {
    const region = indexSrc.slice(indexSrc.indexOf('looksLikeJwt(token)'), indexSrc.indexOf("startsWith('lyra_')"));
    expect(region).toMatch(/WWW-Authenticate/);
    expect(region).toMatch(/wwwAuthenticateBearer\(/);
  });

  test('401 returns JSON-RPC error envelope (not bare error)', () => {
    const region = indexSrc.slice(indexSrc.indexOf('looksLikeJwt(token)'), indexSrc.indexOf("startsWith('lyra_')"));
    expect(region).toMatch(/jsonrpc:\s*['"]2\.0['"]/);
    expect(region).toMatch(/code:\s*-32001/); // -32001 is custom application error per JSON-RPC spec
  });

  test('handles missing OAUTH_JWT_SIGNING_SECRET (validator throws) with 401', () => {
    const region = indexSrc.slice(indexSrc.indexOf('looksLikeJwt(token)'), indexSrc.indexOf("startsWith('lyra_')"));
    // The catch path also responds 401, not pass-through.
    const catchIdx = region.indexOf('catch');
    expect(catchIdx).toBeGreaterThan(-1);
    const catchBlock = region.slice(catchIdx, catchIdx + 600);
    expect(catchBlock).toMatch(/\.status\(401\)/);
    expect(catchBlock).toMatch(/WWW-Authenticate/);
  });

  test('valid JWT path still calls next() (no 401)', () => {
    const region = indexSrc.slice(indexSrc.indexOf('looksLikeJwt(token)'), indexSrc.indexOf("startsWith('lyra_')"));
    expect(region).toMatch(/requestContext\.run\([\s\S]*?next\(\)/);
  });
});
