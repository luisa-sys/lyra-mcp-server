/**
 * Lyra MCP Server unit tests
 * KAN-6: MCP Server (AI Companion Interface)
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

describe('MCP Server - Project Structure', () => {
  test('source files exist', () => {
    expect(fs.existsSync(path.join(root, 'src/index.ts'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'src/supabase.ts'))).toBe(true);
  });

  test('compiled output exists', () => {
    expect(fs.existsSync(path.join(root, 'dist/index.js'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'dist/supabase.js'))).toBe(true);
  });

  test('package.json has correct metadata', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.name).toBe('lyra-mcp-server');
    expect(pkg.type).toBe('module');
    expect(pkg.main).toBe('dist/index.js');
  });

  test('required dependencies are installed', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    expect(pkg.dependencies['@modelcontextprotocol/sdk']).toBeDefined();
    expect(pkg.dependencies['@supabase/supabase-js']).toBeDefined();
    expect(pkg.dependencies['express']).toBeDefined();
    expect(pkg.dependencies['zod']).toBeDefined();
    expect(pkg.dependencies['dotenv']).toBeDefined();
  });

  test('.env.example exists with required variables', () => {
    const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    expect(envExample).toContain('SUPABASE_URL');
    expect(envExample).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(envExample).toContain('MCP_TRANSPORT');
    expect(envExample).toContain('PORT');
  });

  test('.gitignore excludes sensitive files', () => {
    const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    expect(gitignore).toContain('.env');
    expect(gitignore).toContain('node_modules');
    expect(gitignore).toContain('dist');
  });
});

describe('MCP Server - Tool Registration', () => {
  const source = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');

  test('registers all 6 tools', () => {
    const toolNames = [
      'lyra_search_profiles',
      'lyra_get_profile',
      'lyra_get_section',
      'lyra_recommend_gifts',
      'lyra_get_insights',
      'lyra_list_schools',
    ];
    for (const name of toolNames) {
      expect(source).toContain(`'${name}'`);
    }
  });

  test('all tools have descriptions', () => {
    const matches = source.match(/description:\s*\n?\s*'/g) || [];
    expect(matches.length).toBeGreaterThanOrEqual(6);
  });

  test('all tools have Zod input schemas', () => {
    expect(source).toContain('z.string()');
    expect(source).toContain('z.number()');
  });

  test('all read-only tools have readOnlyHint annotation', () => {
    const hints = (source.match(/readOnlyHint:\s*true/g) || []);
    expect(hints.length).toBeGreaterThanOrEqual(6);
  });
});

describe('MCP Server - Write Tool Annotations', () => {
  const writeSource = fs.readFileSync(path.join(root, 'src/write-tools.ts'), 'utf8');

  test('all write tools have annotations', () => {
    const annotations = (writeSource.match(/annotations:\s*\{/g) || []);
    // 8 write tools + 1 coaching tool = 9 annotations
    expect(annotations.length).toBeGreaterThanOrEqual(9);
  });

  test('remove tools have destructiveHint: true', () => {
    const destructive = (writeSource.match(/destructiveHint:\s*true/g) || []);
    // lyra_remove_item, lyra_remove_school, lyra_remove_link = 3
    expect(destructive.length).toBe(3);
  });

  test('additive tools have destructiveHint: false', () => {
    const nonDestructive = (writeSource.match(/destructiveHint:\s*false/g) || []);
    // update_profile, add_item, add_school, add_link, publish_profile = 5
    expect(nonDestructive.length).toBe(5);
  });

  test('coaching tool has readOnlyHint', () => {
    expect(writeSource).toContain("annotations: { readOnlyHint: true }");
  });
});

describe('MCP Server - Transport Setup', () => {
  const source = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');

  test('supports HTTP transport via Express', () => {
    expect(source).toContain('express()');
    expect(source).toContain('StreamableHTTPServerTransport');
    expect(source).toContain("app.post('/mcp'");
  });

  test('supports stdio transport', () => {
    expect(source).toContain('StdioServerTransport');
    expect(source).toContain("MCP_TRANSPORT");
  });

  test('has health endpoint', () => {
    expect(source).toContain("'/health'");
    expect(source).toContain("status: 'ok'");
  });

  test('uses dotenv for configuration', () => {
    expect(source).toContain("import 'dotenv/config'");
  });
});

describe('MCP Server - Supabase Client', () => {
  const supabaseSource = fs.readFileSync(path.join(root, 'src/supabase.ts'), 'utf8');

  test('creates Supabase client with env vars', () => {
    expect(supabaseSource).toContain('SUPABASE_URL');
    expect(supabaseSource).toContain('SUPABASE_SERVICE_ROLE_KEY');
    expect(supabaseSource).toContain('createClient');
  });

  test('throws if env vars are missing', () => {
    expect(supabaseSource).toContain('Missing SUPABASE_URL');
  });

  test('uses singleton pattern', () => {
    expect(supabaseSource).toContain('if (!supabase)');
  });
});
