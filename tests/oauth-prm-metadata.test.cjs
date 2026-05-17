/**
 * KAN-88 — Protected Resource Metadata endpoint structural tests.
 *
 * Validates the /.well-known/oauth-protected-resource handler shape
 * in src/index.ts. A full integration test (boot the server, hit
 * the endpoint) is overkill for what's effectively a JSON document.
 */

const fs = require('fs');
const path = require('path');

const indexSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'index.ts'),
  'utf8'
);

describe('OAuth PRM endpoint (KAN-88)', () => {
  test('endpoint is registered at the canonical RFC 9728 path', () => {
    expect(indexSrc).toMatch(/app\.get\(\s*['"]\/\.well-known\/oauth-protected-resource['"]/);
  });

  test('points clients at LYRA_SITE_URL as the AS', () => {
    expect(indexSrc).toMatch(/process\.env\.LYRA_SITE_URL/);
    expect(indexSrc).toMatch(/authorization_servers:\s*\[/);
  });

  test('advertises resource + scopes_supported + bearer_methods_supported', () => {
    expect(indexSrc).toMatch(/resource:/);
    expect(indexSrc).toMatch(/scopes_supported:.*\[.*lyra:full/);
    expect(indexSrc).toMatch(/bearer_methods_supported:\s*\[\s*['"]header['"]/);
  });

  test('sets CORS open (clients are off-origin)', () => {
    const handlerStart = indexSrc.indexOf("app.get('/.well-known/oauth-protected-resource'");
    expect(handlerStart).toBeGreaterThan(-1);
    const region = indexSrc.slice(handlerStart, handlerStart + 1200);
    expect(region).toMatch(/Access-Control-Allow-Origin/);
  });

  test('cache-control allows brief caching (config is static-ish)', () => {
    const handlerStart = indexSrc.indexOf("app.get('/.well-known/oauth-protected-resource'");
    expect(handlerStart).toBeGreaterThan(-1);
    const region = indexSrc.slice(handlerStart, handlerStart + 1200);
    expect(region).toMatch(/Cache-Control.*max-age=\d+/);
  });

  test('endpoint is BEFORE the /mcp POST handler so it bypasses MCP routing', () => {
    const prmIdx = indexSrc.indexOf("'/.well-known/oauth-protected-resource'");
    const mcpIdx = indexSrc.indexOf("app.post('/mcp'");
    expect(prmIdx).toBeGreaterThan(-1);
    expect(mcpIdx).toBeGreaterThan(-1);
    // PRM is in the GET handler section. /mcp POST is later in the file.
    expect(prmIdx).toBeLessThan(mcpIdx);
  });
});
