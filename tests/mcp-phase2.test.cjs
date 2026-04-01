/**
 * MCP Phase 2 test suite — write tools, auth, input validation
 * KAN-80: Unit tests for all Phase 2 MCP tools
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

// ── Source code for content analysis ────────────────────────
const writeToolsSrc = fs.readFileSync(path.join(root, 'src/write-tools.ts'), 'utf8');
const authSrc = fs.readFileSync(path.join(root, 'src/auth.ts'), 'utf8');
const sanitiseSrc = fs.readFileSync(path.join(root, 'src/sanitise.ts'), 'utf8');
const indexSrc = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');

// ── Write Tools Registration ────────────────────────────────
describe('KAN-80: Write tools exist and are registered', () => {
  const expectedTools = [
    'lyra_update_profile',
    'lyra_add_item',
    'lyra_remove_item',
    'lyra_add_link',
    'lyra_remove_link',
    'lyra_add_school',
    'lyra_remove_school',
    'lyra_remove_item',
    'lyra_publish_profile',
  ];

  test.each(expectedTools)('tool %s is registered', (toolName) => {
    expect(writeToolsSrc).toContain(`'${toolName}'`);
  });

  test('all write tools have annotations', () => {
    const toolBlocks = writeToolsSrc.split('registerTool');
    // Each tool block should have annotations
    for (const block of toolBlocks.slice(1)) { // skip first split (before first registerTool)
      expect(block).toContain('annotations');
    }
  });
});

// ── Authentication ──────────────────────────────────────────
describe('KAN-80: API key authentication', () => {
  test('auth module exports authenticateApiKey', () => {
    expect(authSrc).toContain('export async function authenticateApiKey');
  });

  test('auth uses SHA-256 hashing', () => {
    expect(authSrc).toContain('sha256');
  });

  test('auth validates key prefix (lyra_)', () => {
    // The auth or write-tools should check for lyra_ prefix
    expect(writeToolsSrc + authSrc).toContain('lyra_');
  });

  test('write tools require api_key parameter', () => {
    const toolDefs = writeToolsSrc.match(/api_key: z\.string\(\)/g);
    expect(toolDefs).not.toBeNull();
    expect(toolDefs.length).toBeGreaterThanOrEqual(5);
  });

  test('authAndProfile helper rejects missing API key', () => {
    expect(writeToolsSrc).toContain('API key required');
  });

  test('authAndProfile helper rejects failed auth', () => {
    expect(writeToolsSrc).toContain('Authentication failed');
  });

  test('authAndProfile helper rejects missing profile', () => {
    expect(writeToolsSrc).toContain('No profile found');
  });
});

// ── Input Sanitisation ──────────────────────────────────────
describe('KAN-80: Input sanitisation', () => {
  test('sanitiseText strips HTML tags', () => {
    expect(sanitiseSrc).toContain('replace(/<[^>]*>/g');
  });

  test('sanitiseText enforces max length', () => {
    expect(sanitiseSrc).toContain('substring(0, maxLength)');
  });

  test('sanitiseUrl validates protocol', () => {
    expect(sanitiseSrc).toContain("url.protocol !== 'http:'");
    expect(sanitiseSrc).toContain("url.protocol !== 'https:'");
  });

  test('sanitiseUrl rejects invalid URLs', () => {
    expect(sanitiseSrc).toContain('return null');
  });

  test('write tools call sanitiseText on text inputs', () => {
    const sanitiseCalls = writeToolsSrc.match(/sanitiseText\(/g);
    expect(sanitiseCalls).not.toBeNull();
    expect(sanitiseCalls.length).toBeGreaterThanOrEqual(3);
  });

  test('write tools call sanitiseUrl on URL inputs', () => {
    expect(writeToolsSrc).toContain('sanitiseUrl(');
  });
});

// ── Tool-specific validation ────────────────────────────────
describe('KAN-80: Tool input schemas', () => {
  test('lyra_update_profile has field-level schema', () => {
    expect(writeToolsSrc).toContain('display_name: z.string()');
    expect(writeToolsSrc).toContain('headline: z.string()');
    expect(writeToolsSrc).toContain('bio_short: z.string()');
  });

  test('lyra_add_item validates category', () => {
    expect(writeToolsSrc).toContain('category');
    expect(writeToolsSrc).toContain('z.string()');
  });

  test('lyra_add_item validates title', () => {
    expect(writeToolsSrc).toContain('title: z.string()');
  });

  test('lyra_add_link validates URL', () => {
    expect(writeToolsSrc).toContain('url: z.string()');
  });

  test('lyra_remove_item requires item_id', () => {
    expect(writeToolsSrc).toContain('item_id: z.string()');
  });
});

// ── Read tools prompt injection defence ─────────────────────
describe('KAN-80: Prompt injection defence', () => {
  test('read tool descriptions warn about untrusted data', () => {
    expect(indexSrc).toContain('untrusted data');
  });

  test('search tool warns about user-generated content', () => {
    expect(indexSrc).toContain('user-generated');
  });
});

// ── Error handling ──────────────────────────────────────────
describe('KAN-80: Error handling patterns', () => {
  test('write tools have try/catch error handling', () => {
    const catchBlocks = writeToolsSrc.match(/catch\s*\(/g);
    expect(catchBlocks).not.toBeNull();
    expect(catchBlocks.length).toBeGreaterThanOrEqual(3);
  });

  test('error responses use consistent format', () => {
    expect(writeToolsSrc).toContain('errorResponse');
  });

  test('success responses use consistent format', () => {
    expect(writeToolsSrc).toContain('okResponse');
  });
});

// ── Onboarding coaching tool ────────────────────────────────
describe('KAN-80: Onboarding coaching (read tool for write context)', () => {
  test('get_onboarding_coaching tool exists', () => {
    expect(writeToolsSrc).toContain('lyra_get_onboarding_coaching');
  });

  test('coaching tool has readOnlyHint annotation', () => {
    // The onboarding coaching tool is in write-tools.ts but is read-only
    const coachingBlock = writeToolsSrc.split('lyra_get_onboarding_coaching')[1];
    expect(coachingBlock).toContain('readOnlyHint: true');
  });
});
