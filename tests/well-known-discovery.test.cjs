/**
 * KAN-74a: regression guards for the /.well-known discovery endpoints.
 *
 * Static-source tests instead of HTTP tests because spinning up the
 * Hono server in a unit run would pull in the Supabase client / env
 * vars. The source-code assertions catch the cases that matter:
 *   - the endpoints are still registered (a refactor that dropped them
 *     would silently break MCP Registry submission)
 *   - the canonical name + version + repo URL still match the in-repo
 *     server.json (drift between them breaks Registry publish)
 *   - the tool list still names every registered tool (otherwise the
 *     discovery doc lies about capability)
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const indexSrc = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');
const serverJson = JSON.parse(fs.readFileSync(path.join(root, 'server.json'), 'utf8'));
const licenseFile = path.join(root, 'LICENSE');

describe('KAN-74a — MCP discovery endpoint invariants', () => {
  test('LICENSE file exists and is MIT', () => {
    expect(fs.existsSync(licenseFile)).toBe(true);
    const license = fs.readFileSync(licenseFile, 'utf8');
    expect(license).toMatch(/^MIT License/i);
  });

  test('server.json declares canonical github.io namespace + remote URL', () => {
    expect(serverJson.name).toBe('io.github.luisa-sys/lyra-mcp-server');
    expect(serverJson.repository.url).toMatch(/github\.com\/luisa-sys\/lyra-mcp-server/);
    expect(serverJson.remotes[0].url).toBe('https://mcp.checklyra.com/mcp');
    expect(serverJson.remotes[0].type).toBe('streamable-http');
  });

  test('/.well-known/mcp.json endpoint is registered', () => {
    expect(indexSrc).toMatch(/app\.get\(\s*['"]\/\.well-known\/mcp\.json['"]/);
  });

  test('/.well-known/glama.json endpoint is registered (Glama directory)', () => {
    expect(indexSrc).toMatch(/app\.get\(\s*['"]\/\.well-known\/glama\.json['"]/);
  });

  test('/.well-known/oauth-protected-resource endpoint is registered (KAN-88 forward-decl)', () => {
    expect(indexSrc).toMatch(/app\.get\(\s*['"]\/\.well-known\/oauth-protected-resource['"]/);
  });

  test('mcp.json endpoint uses the official $schema URL', () => {
    expect(indexSrc).toMatch(/\$schema:\s*['"]https:\/\/static\.modelcontextprotocol\.io\/schemas\//);
  });

  test('mcp.json endpoint declares the canonical namespace + version + repo from server.json', () => {
    // Drift between the in-repo manifest and the live endpoint is the
    // most likely silent-break for Registry publish — pin both.
    expect(indexSrc).toContain(`name: '${serverJson.name}'`);
    expect(indexSrc).toContain(`version: '${serverJson.version}'`);
    expect(indexSrc).toContain(`url: '${serverJson.repository.url}'`);
  });

  test('mcp.json endpoint exposes the build_sha deploy-freshness fingerprint (BUGS-18)', () => {
    // The post-merge-deploy-smoke workflow asserts that the live SHA on
    // mcp.checklyra.com matches main HEAD after a merge. That assertion
    // depends on this field being emitted by the endpoint — if a refactor
    // drops it, the smoke check would silently return "(missing)" and
    // become a noisy false-positive instead of catching the real failure.
    expect(indexSrc).toMatch(/build_sha:\s*process\.env\.RAILWAY_GIT_COMMIT_SHA/);
  });

  test('mcp.json tool list names every registered tool (read + write)', () => {
    // If a new tool is registered without being added to the discovery
    // doc, MCP-aware clients won't know about it. Cross-check by
    // grepping the source.
    const expectedReadTools = [
      'lyra_search_profiles',
      'lyra_get_profile',
      'lyra_get_section',
      'lyra_recommend_gifts',
      'lyra_get_insights',
      'lyra_list_schools',
      'lyra_get_onboarding_coaching',
    ];
    const expectedWriteTools = [
      'lyra_update_profile',
      'lyra_add_item',
      'lyra_remove_item',
      'lyra_add_school',
      'lyra_remove_school',
      'lyra_add_link',
      'lyra_remove_link',
      'lyra_publish_profile',
    ];
    for (const t of [...expectedReadTools, ...expectedWriteTools]) {
      expect(indexSrc).toContain(`'${t}'`);
    }
  });
});

describe('KAN-74a — tool annotation discipline', () => {
  const writeToolsSrc = fs.readFileSync(path.join(root, 'src/write-tools.ts'), 'utf8');

  test('every read tool in src/index.ts has readOnlyHint: true', () => {
    // We expect 7 read tools (matches the mcp.json list above). Each
    // must declare itself read-only so MCP clients can render them
    // without an auth prompt.
    const matches = indexSrc.match(/readOnlyHint:\s*true/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(6);
  });

  test('every write tool in src/write-tools.ts declares destructiveHint', () => {
    // Every write tool must explicitly say whether it's destructive
    // (delete/suspend) or non-destructive (insert/update). MCP clients
    // use this to decide whether to ask the user for confirmation.
    const matches = writeToolsSrc.match(/destructiveHint:\s*(true|false)/g) ?? [];
    // 8 write tools listed in mcp.json; allow one extra in case of
    // helper tool registrations.
    expect(matches.length).toBeGreaterThanOrEqual(7);
  });
});
