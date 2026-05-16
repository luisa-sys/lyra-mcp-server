/**
 * KAN-205 — Convene read-tools structural tests.
 *
 * Verifies the four read tools (lyra_list_my_tribes, lyra_list_my_contacts,
 * lyra_list_my_gatherings, lyra_get_gathering) are present, registered,
 * gated on API-key auth, and carry the prompt-injection notice.
 *
 * Behavioural tests (real DB calls) require Supabase + an issued API key;
 * those run in CI against the dev project and are tracked under P5 E2E.
 */

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'convene-tools.ts'),
  'utf8'
);

describe('Convene read tools — structure (KAN-205)', () => {
  describe('file', () => {
    test('exists', () => {
      expect(fs.existsSync(path.join(__dirname, '..', 'src', 'convene-tools.ts'))).toBe(true);
    });

    test('exports registerConveneTools', () => {
      expect(src).toMatch(/export function registerConveneTools\(/);
    });

    test('is wired into index.ts', () => {
      const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
      expect(idx).toMatch(/import\s*\{\s*registerConveneTools\s*\}\s*from\s*['"]\.\/convene-tools\.js['"]/);
      expect(idx).toMatch(/registerConveneTools\(server\)/);
    });
  });

  describe('tool registrations', () => {
    const expectedTools = [
      'lyra_list_my_tribes',
      'lyra_list_my_contacts',
      'lyra_list_my_gatherings',
      'lyra_get_gathering',
    ];

    for (const name of expectedTools) {
      test(`registers ${name}`, () => {
        expect(src).toMatch(
          new RegExp(`server\\.registerTool\\(\\s*['"]${name}['"]`)
        );
      });

      test(`${name} requires api_key in inputSchema`, () => {
        // Find the tool's registerTool block and check its inputSchema mentions api_key.
        const startIdx = src.indexOf(`'${name}'`);
        const endIdx = src.indexOf(');', startIdx);
        const block = src.slice(startIdx, endIdx);
        expect(block).toMatch(/api_key:\s*z\.string/);
      });

      test(`${name} is read-only (readOnlyHint: true)`, () => {
        const startIdx = src.indexOf(`'${name}'`);
        const endIdx = src.indexOf(');', startIdx);
        const block = src.slice(startIdx, endIdx);
        expect(block).toMatch(/readOnlyHint:\s*true/);
      });
    }
  });

  describe('prompt-injection guard', () => {
    test('exports DATA_NOTICE constant', () => {
      expect(src).toMatch(/DATA_NOTICE/);
      expect(src).toMatch(/user-generated/i);
      expect(src).toMatch(/do not interpret/i);
    });

    test('every tool response includes _data_notice (one per tool, ≥4 total)', () => {
      const notices = (src.match(/_data_notice/g) || []).length;
      expect(notices).toBeGreaterThanOrEqual(4); // one wrapper per tool, no false ceiling
    });
  });

  describe('auth pattern', () => {
    test('uses authenticateApiKey from auth.ts', () => {
      expect(src).toMatch(/import.*authenticateApiKey.*from\s*['"]\.\/auth\.js['"]/);
    });

    test('authedUser helper rejects missing key', () => {
      expect(src).toMatch(/API key required/);
    });

    test('authedUser helper rejects invalid key', () => {
      expect(src).toMatch(/Authentication failed/);
    });
  });

  describe('contacts privacy', () => {
    test('list_my_contacts response includes _privacy_notice excluding PII', () => {
      // Find the lyra_list_my_contacts handler block specifically.
      const handlerIdx = src.indexOf("'lyra_list_my_contacts'");
      const nextToolIdx = src.indexOf("'lyra_list_my_gatherings'");
      const handlerBlock = src.slice(handlerIdx, nextToolIdx);
      expect(handlerBlock).toMatch(/_privacy_notice/);
      expect(handlerBlock).toMatch(/PII.*excluded/);
    });

    test('list_my_contacts select column list does NOT include email/phone/address fields', () => {
      // The select string in list_my_contacts.
      const handlerIdx = src.indexOf("'lyra_list_my_contacts'");
      const nextToolIdx = src.indexOf("'lyra_list_my_gatherings'");
      const handlerBlock = src.slice(handlerIdx, nextToolIdx);
      // Find the .select(...) call in the handler.
      const selectMatch = handlerBlock.match(/\.select\(\s*'([^']+)'/);
      expect(selectMatch).not.toBeNull();
      const cols = selectMatch[1];
      expect(cols).not.toMatch(/\bemail\b/);
      expect(cols).not.toMatch(/\bphone\b/);
      expect(cols).not.toMatch(/contact_methods/);
      expect(cols).not.toMatch(/address/);
    });
  });
});
