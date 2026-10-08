/**
 * SEC-09 (TDD 2026-06-21): lyra_search_profiles must sanitise the free-text query
 * before interpolating it into a PostgREST .or() filter, because the service-role
 * client bypasses RLS and `.or()` is parsed as a filter DSL.
 *
 * Importing the compiled ESM dist from a .cjs test is not viable here (see the
 * note in oauth-jwt-validator.test.cjs), so this is a structural guard in the
 * style of mcp-visibility-guard.test.cjs: it asserts the sanitiser exists, strips
 * the dangerous metacharacters, and is wired into the search tool ahead of the
 * .or() call. Behavioural assertions on the identical algorithm live in the lyra
 * repo's tests/unit/sanitise.test.ts.
 */
const fs = require('fs');
const path = require('path');

const sanitiseSrc = fs.readFileSync(path.join(__dirname, '../src/sanitise.ts'), 'utf8');
const indexSrc = fs.readFileSync(path.join(__dirname, '../src/index.ts'), 'utf8');

describe('SEC-09 — search query sanitisation', () => {
  test('sanitiseSearchTerm is exported and strips PostgREST/ilike metacharacters', () => {
    expect(sanitiseSrc).toContain('export function sanitiseSearchTerm');
    // character class must cover the filter-tree chars , ( ) and ilike wildcards % _
    expect(sanitiseSrc).toContain('[,()*%_');
  });

  // SEC-59 (2026-07-13): the strip-set is unified with the web + admin-MCP
  // surfaces — it must also cover the PostgREST operator separators . and : and
  // the quote " (the fuller defensive set the admin-MCP sanitiser already used).
  test('strip-set is unified with the other surfaces (covers . : and ")', () => {
    const cls = sanitiseSrc.match(/\.replace\((\/\[[^\]]*\]\/g)/);
    expect(cls).not.toBeNull();
    const charClass = cls[1];
    for (const ch of ['.', ':', '"']) {
      expect(charClass).toContain(ch);
    }
  });

  test('the search tool sanitises the query before the .or() interpolation', () => {
    expect(indexSrc).toContain('sanitiseSearchTerm(query');
    // the .or() interpolates the sanitised term, never the raw `query`
    expect(indexSrc).toContain('${safeQuery}');
    expect(indexSrc).not.toContain('ilike.%${query}%');
  });
});
