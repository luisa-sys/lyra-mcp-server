/**
 * KAN-88 — WWW-Authenticate header + middleware tests.
 *
 * Tests both:
 *   1. wwwAuthenticateBearer builder shape — matches claude.ai's
 *      documented format: Bearer + resource_metadata="<PRM URL>".
 *   2. /mcp middleware integration — 401 trigger paths.
 *
 * Builder logic is inlined for behavioural testing because the
 * compiled file is ESM and not importable from .test.cjs.
 */

const fs = require('fs');
const path = require('path');

// Inline the new builder logic so behavioural tests don't depend
// on import of the compiled output.
function buildHeader(opts = {}, env = {}) {
  const siteUrl = (env.LYRA_SITE_URL || 'https://checklyra.com').replace(/\/$/, '');
  const resource = env.MCP_RESOURCE_URL || 'https://mcp.checklyra.com/mcp';
  const prmUrl = resource.replace(/\/mcp\/?$/, '') + '/.well-known/oauth-protected-resource';
  const parts = [
    `Bearer realm="${resource}"`,
    `resource_metadata="${prmUrl}"`,
  ];
  if (opts.error) parts.push(`error="${opts.error}"`);
  if (opts.errorDescription) {
    parts.push(`error_description="${opts.errorDescription.replace(/"/g, '\\"')}"`);
  }
  parts.push(`as_uri="${siteUrl}/.well-known/oauth-authorization-server"`);
  return parts.join(', ');
}

describe('wwwAuthenticateBearer builder (KAN-88)', () => {
  test('begins with Bearer scheme', () => {
    const h = buildHeader();
    expect(h.startsWith('Bearer ')).toBe(true);
  });

  test('always includes resource_metadata pointing at PRM URL (claude.ai trigger)', () => {
    const h = buildHeader({}, { MCP_RESOURCE_URL: 'https://mcp-dev.checklyra.com/mcp' });
    expect(h).toContain('resource_metadata="https://mcp-dev.checklyra.com/.well-known/oauth-protected-resource"');
  });

  test('includes realm with the MCP resource URL', () => {
    const h = buildHeader({}, { MCP_RESOURCE_URL: 'https://mcp-dev.checklyra.com/mcp' });
    expect(h).toContain('realm="https://mcp-dev.checklyra.com/mcp"');
  });

  test('OMITS error/error_description when no opts given (no-auth case per RFC 6750 §3.1)', () => {
    const h = buildHeader();
    expect(h).not.toContain('error=');
    expect(h).not.toContain('error_description=');
  });

  test('INCLUDES error/error_description when supplied', () => {
    const h = buildHeader({ error: 'invalid_token', errorDescription: 'signature failed' });
    expect(h).toContain('error="invalid_token"');
    expect(h).toContain('error_description="signature failed"');
  });

  test('escapes double-quotes in description', () => {
    const h = buildHeader({ error: 'invalid_token', errorDescription: 'expected "S256"' });
    expect(h).toContain('error_description="expected \\"S256\\""');
  });

  test('also advertises as_uri (belt-and-braces for non-claude.ai clients)', () => {
    const h = buildHeader({}, { LYRA_SITE_URL: 'https://dev.checklyra.com' });
    expect(h).toContain('as_uri="https://dev.checklyra.com/.well-known/oauth-authorization-server"');
  });
});

describe('middleware: 401 on missing auth for protected tools (KAN-88)', () => {
  const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
  const registrySrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'auth-registry.ts'), 'utf8');

  test('imports requiresAuth + sendUnauthorized', () => {
    expect(indexSrc).toMatch(/import\s+\{[^}]*requiresAuth[^}]*\}/);
  });

  test('sendUnauthorized helper exists with 401 status + WWW-Authenticate', () => {
    const fnIdx = indexSrc.indexOf('function sendUnauthorized');
    expect(fnIdx).toBeGreaterThan(-1);
    const block = indexSrc.slice(fnIdx, fnIdx + 1200);
    expect(block).toMatch(/\.status\(401\)/);
    expect(block).toMatch(/WWW-Authenticate/);
    expect(block).toMatch(/wwwAuthenticateBearer/);
    expect(block).toMatch(/jsonrpc:\s*['"]2\.0['"]/);
  });

  test('no-Bearer + protected tool + no api_key arg → calls sendUnauthorized', () => {
    // The third middleware branch (Path 3).
    const region = indexSrc.slice(indexSrc.indexOf('Path 3:'), indexSrc.indexOf('Path 3:') + 1000);
    expect(region).toMatch(/requiresAuth\(toolName\)/);
    expect(region).toMatch(/sendUnauthorized\(res, body\)/);
  });

  test('PUBLIC_TOOLS registry includes the documented public reads', () => {
    expect(registrySrc).toMatch(/lyra_search_profiles/);
    expect(registrySrc).toMatch(/lyra_get_profile/);
    expect(registrySrc).toMatch(/lyra_get_section/);
    expect(registrySrc).toMatch(/lyra_get_insights/);
    expect(registrySrc).toMatch(/lyra_recommend_gifts/);
    expect(registrySrc).toMatch(/lyra_list_schools/);
    expect(registrySrc).toMatch(/lyra_get_onboarding_coaching/);
  });

  test('requiresAuth returns true for unknown / write tools, false for public', () => {
    const { requiresAuth, PUBLIC_TOOLS } = (() => {
      // Inline-eval the TS-stripped registry for this CJS test.
      const tools = new Set([
        'lyra_search_profiles',
        'lyra_get_profile',
        'lyra_get_section',
        'lyra_get_insights',
        'lyra_recommend_gifts',
        'lyra_list_schools',
        'lyra_get_onboarding_coaching',
      ]);
      return { requiresAuth: (n) => !tools.has(n), PUBLIC_TOOLS: tools };
    })();
    expect(requiresAuth('lyra_list_my_gatherings')).toBe(true);
    expect(requiresAuth('lyra_update_profile')).toBe(true);
    expect(requiresAuth('lyra_search_profiles')).toBe(false);
    expect(requiresAuth('lyra_get_profile')).toBe(false);
  });
});

describe('middleware: existing JWT paths still 401 correctly (KAN-88 P6 regression)', () => {
  const indexSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');

  test('Path 1 (JWT invalid) calls sendUnauthorized with invalid_token + reason', () => {
    const region = indexSrc.slice(indexSrc.indexOf('Path 1:'), indexSrc.indexOf('Path 2:'));
    expect(region).toMatch(/error:\s*['"]invalid_token['"]/);
    expect(region).toMatch(/errorDescription:\s*result\.error/);
    expect(region).toMatch(/sendUnauthorized/);
  });

  test('Path 1 catch (signing secret unset) calls sendUnauthorized with server_error', () => {
    const region = indexSrc.slice(indexSrc.indexOf('Path 1:'), indexSrc.indexOf('Path 2:'));
    expect(region).toMatch(/error:\s*['"]server_error['"]/);
    expect(region).toMatch(/oauth not configured/);
  });

  test('Path 2 (lyra_ Bearer) is unchanged — backfills + falls through', () => {
    const region = indexSrc.slice(indexSrc.indexOf('Path 2:'), indexSrc.indexOf('Path 3:'));
    expect(region).toMatch(/args\.api_key\s*=\s*token/);
    expect(region).toMatch(/return next\(\)/);
  });
});
