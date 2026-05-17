/**
 * KAN-207 P3 (venue side) — structural tests for lyra_suggest_venues +
 * the Places adapter + the duplicated venue scoring lib.
 *
 * Behavioural tests against the real Google Places API live in E2E once
 * we have a dev fixture; structural coverage here ensures the wiring +
 * ownership filters are right.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const adapterSrc = fs.readFileSync(path.join(root, 'src/convene-places-adapter.ts'), 'utf8');
const scoringSrc = fs.readFileSync(path.join(root, 'src/convene-recommend-venue-scoring.ts'), 'utf8');
const toolSrc = fs.readFileSync(path.join(root, 'src/convene-suggest-venues-tool.ts'), 'utf8');

describe('Convene venue MCP tool — structure (KAN-207 venue side)', () => {
  describe('Places adapter', () => {
    test('file exists', () => {
      expect(adapterSrc).toBeTruthy();
    });
    test('reads GOOGLE_PLACES_API_KEY from env', () => {
      expect(adapterSrc).toMatch(/process\.env\.GOOGLE_PLACES_API_KEY/);
    });
    test('clear error when env not set', () => {
      expect(adapterSrc).toMatch(/Server misconfiguration: GOOGLE_PLACES_API_KEY/);
    });
    test('uses Places v1 endpoints (searchNearby + searchText)', () => {
      expect(adapterSrc).toMatch(/places\.googleapis\.com\/v1/);
      expect(adapterSrc).toMatch(/searchNearby/);
      expect(adapterSrc).toMatch(/searchText/);
    });
    test('passes X-Goog-FieldMask header', () => {
      expect(adapterSrc).toMatch(/X-Goog-FieldMask/);
    });
    test('caps radius at 50km, results at 20', () => {
      expect(adapterSrc).toMatch(/Math\.min\(input\.radiusM \?\? \d+,\s*50000\)/);
      expect(adapterSrc).toMatch(/Math\.min\(input\.maxResults \?\? \d+,\s*20\)/);
    });
    test('maps Places types to internal venue_type enum', () => {
      expect(adapterSrc).toMatch(/mapPlaceTypeToVenueType/);
      expect(adapterSrc).toMatch(/'cafe'/);
      expect(adapterSrc).toMatch(/'pub'/);
      expect(adapterSrc).toMatch(/'park'/);
    });
    test('maps PRICE_LEVEL_* to 1-4 tier', () => {
      expect(adapterSrc).toMatch(/PRICE_LEVEL_INEXPENSIVE/);
      expect(adapterSrc).toMatch(/PRICE_LEVEL_VERY_EXPENSIVE/);
    });
  });

  describe('Venue scoring (duplicated lib)', () => {
    test('exports scoreVenue', () => {
      expect(scoringSrc).toMatch(/export function scoreVenue\(/);
    });
    test('weights sum to 1.0', () => {
      const weightsMatch = scoringSrc.match(/const WEIGHTS = \{([^}]+)\}/);
      expect(weightsMatch).not.toBeNull();
      const numbers = (weightsMatch[1].match(/0\.\d+/g) || []).map(Number);
      const sum = numbers.reduce((a, b) => a + b, 0);
      expect(sum).toBeCloseTo(1.0, 2);
    });
    test('hard filters return hardFilterFailed', () => {
      // Implemented via makeFailed(id, kind, reason) helper; verify all three kinds called.
      expect(scoringSrc).toMatch(/makeFailed\([^,]+,\s*['"]capacity['"]/);
      expect(scoringSrc).toMatch(/makeFailed\([^,]+,\s*['"]accessibility['"]/);
      expect(scoringSrc).toMatch(/makeFailed\([^,]+,\s*['"]dietary['"]/);
      // And the hardFilterFailed key is set in the helper itself.
      expect(scoringSrc).toMatch(/hardFilterFailed:\s*kind/);
    });
    test('drift-risk comment present', () => {
      expect(scoringSrc).toMatch(/DRIFT RISK/);
    });
  });

  describe('lyra_suggest_venues tool', () => {
    test('is registered', () => {
      expect(toolSrc).toMatch(/server\.registerTool\(\s*['"]lyra_suggest_venues['"]/);
    });
    test('requires api_key', () => {
      expect(toolSrc).toMatch(/api_key:\s*z\.string/);
    });
    test('requires intent + anchor + capacity_required', () => {
      expect(toolSrc).toMatch(/intent:[\s\S]*?z\.enum/);
      // Source may multi-line the z.string() — accept either inline or split.
      expect(toolSrc).toMatch(/anchor:[\s\S]{0,20}z[\s\S]{0,20}\.string/);
      expect(toolSrc).toMatch(/capacity_required:[\s\S]{0,20}z[\s\S]{0,20}\.number/);
    });
    test('upserts into public.venues by google_place_id', () => {
      expect(toolSrc).toMatch(/\.from\(['"]venues['"]\)[\s\S]*?\.upsert/);
      expect(toolSrc).toMatch(/onConflict:\s*['"]google_place_id['"]/);
    });
    test('joins venue_visits via gathering host_user_id', () => {
      expect(toolSrc).toMatch(/\.from\(['"]venue_visits['"]\)/);
      expect(toolSrc).toMatch(/gatherings\.host_user_id/);
    });
    test('filters venue_ratings by user_id', () => {
      expect(toolSrc).toMatch(/\.from\(['"]venue_ratings['"]\)[\s\S]*?\.eq\(['"]user_id['"],\s*userId\)/);
    });
    test('drops hard-filtered venues before returning', () => {
      expect(toolSrc).toMatch(/!score\.hardFilterFailed/);
    });
    test('caps limit at 15', () => {
      expect(toolSrc).toMatch(/\.max\(15\)/);
    });
    test('wired into index.ts', () => {
      const idx = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');
      expect(idx).toMatch(/import\s*\{\s*registerConveneSuggestVenuesTool\s*\}/);
      expect(idx).toMatch(/registerConveneSuggestVenuesTool\(server\)/);
    });
    test('response includes _data_notice', () => {
      expect(toolSrc).toMatch(/_data_notice/);
    });
  });
});
