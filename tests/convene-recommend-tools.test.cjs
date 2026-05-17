/**
 * KAN-207 P3 — Convene recommend MCP tool tests (structural).
 *
 * Verifies lyra_propose_attendees is registered, gated on auth, scopes by
 * owner_user_id, uses scoreAttendee from the duplicated scoring lib.
 */

const fs = require('fs');
const path = require('path');

const toolSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'convene-recommend-tools.ts'), 'utf8');
const scoringSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'convene-recommend-scoring.ts'), 'utf8');

describe('Convene recommend tools — structure (KAN-207 P3)', () => {
  test('tools file exists', () => {
    expect(toolSrc).toBeTruthy();
  });

  test('scoring lib file exists with drift-risk notice', () => {
    expect(scoringSrc).toMatch(/DRIFT RISK/);
    expect(scoringSrc).toMatch(/lyra\/src\/lib\/recommend\/convene/);
  });

  test('wired into index.ts', () => {
    const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    expect(idx).toMatch(/import\s*\{\s*registerConveneRecommendTools\s*\}\s*from\s*['"]\.\/convene-recommend-tools\.js['"]/);
    expect(idx).toMatch(/registerConveneRecommendTools\(server\)/);
  });

  describe('lyra_propose_attendees', () => {
    test('is registered', () => {
      expect(toolSrc).toMatch(/server\.registerTool\(\s*['"]lyra_propose_attendees['"]/);
    });
    test('requires api_key', () => {
      expect(toolSrc).toMatch(/api_key:\s*z\.string/);
    });
    test('uses readOnlyHint=true', () => {
      const start = toolSrc.indexOf("'lyra_propose_attendees'");
      const block = toolSrc.slice(start, start + 2000);
      expect(block).toMatch(/readOnlyHint:\s*true/);
    });
    test('filters contacts by owner_user_id', () => {
      expect(toolSrc).toMatch(/\.from\(['"]contacts['"]\)[\s\S]*?\.eq\(['"]owner_user_id['"],\s*userId\)/);
    });
    test('filters relationship_signals by user_id', () => {
      expect(toolSrc).toMatch(/\.from\(['"]relationship_signals['"]\)[\s\S]*?\.eq\(['"]user_id['"],\s*userId\)/);
    });
    test('caps result limit at 20', () => {
      expect(toolSrc).toMatch(/\.max\(20\)/);
    });
    test('imports scoreAttendee from scoring lib', () => {
      expect(toolSrc).toMatch(/import[\s\S]*?scoreAttendee[\s\S]*?from\s*['"]\.\/convene-recommend-scoring\.js['"]/);
    });
  });

  describe('scoring lib (duplicated)', () => {
    test('exports scoreAttendee', () => {
      expect(scoringSrc).toMatch(/export function scoreAttendee\(/);
    });
    test('WEIGHTS sum to 1.0', () => {
      // Extract weight numbers and sum.
      const weightsMatch = scoringSrc.match(/const WEIGHTS = \{([^}]+)\}/);
      expect(weightsMatch).not.toBeNull();
      const numbers = (weightsMatch[1].match(/0\.\d+/g) || []).map(Number);
      const sum = numbers.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1.0, 2);
    });
    test('TRIBE_KEYWORDS_BY_INTENT defines an entry for every gathering type', () => {
      const types = ['coffee', 'lunch', 'dinner', 'drinks', 'party', 'kids_party', 'meeting', 'date', 'walk', 'cinema', 'other'];
      for (const t of types) {
        expect(scoringSrc).toMatch(new RegExp(`\\b${t}:\\s*\\[`));
      }
    });
    test('hard exclusion when contact already invited', () => {
      expect(scoringSrc).toMatch(/excluded:\s*true/);
      expect(scoringSrc).toMatch(/'already_invited'/);
    });
  });

  describe('prompt-injection notice', () => {
    test('response includes _data_notice', () => {
      expect(toolSrc).toMatch(/_data_notice/);
    });
  });
});
