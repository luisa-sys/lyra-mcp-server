/**
 * KAN-334 — MCP homepage-example exclusion guard.
 *
 * Curated "homepage example" profiles (is_homepage_example = true) are demo
 * accounts shown on the PUBLIC logged-out homepage. They must NEVER surface as
 * real people through agent discovery: an agent calling lyra_search_profiles
 * should only ever get real, published, non-suspended members — never the
 * seeded demo profiles.
 *
 * The MCP server uses SUPABASE_SERVICE_ROLE_KEY, which bypasses RLS, so — as
 * with the BUGS-21 suspension filter and the KAN-143 visibility filter — this
 * exclusion has to be applied in app code on every profiles read that backs
 * search. lyra_search_profiles has two such reads: the main keyword query and
 * the school-filter (Find-Someone) fetch. Both must chain
 * `.eq('is_homepage_example', false)`.
 *
 * This is a static-source guard (mirror of mcp-redesign-data-points.test.cjs's
 * Find-Someone assertions): if a refactor drops the filter from either read,
 * this test fails before the regression can reach production.
 *
 * NOTE: the exclusion is scoped to lyra_search_profiles only (per KAN-334 queue
 * slice) — direct fetch-by-slug (lyra_get_profile) is intentionally NOT gated,
 * so a demo profile is still viewable if its slug is known; it just never
 * appears in aggregate discovery. Hence this is a targeted test, not a blanket
 * every-profiles-read guard.
 */

const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, '..', 'src', 'index.ts');
const indexSrc = fs.readFileSync(indexPath, 'utf8');
const indexLines = indexSrc.split('\n');

// Extract the lyra_search_profiles registerTool block: from its name literal
// to the terminating `\n);` of the registration call.
function searchProfilesBlock() {
  const m = indexSrc.match(/'lyra_search_profiles'[\s\S]*?\n\);/);
  return m ? m[0] : null;
}

const FILTER_RE = /\.eq\(\s*['"]is_homepage_example['"]\s*,\s*false\s*\)/g;

describe('KAN-334 MCP homepage-example exclusion (lyra_search_profiles)', () => {
  test('source is readable and the search_profiles block is found', () => {
    expect(indexSrc.length).toBeGreaterThan(100);
    expect(searchProfilesBlock()).not.toBeNull();
  });

  test('both profiles reads in lyra_search_profiles exclude is_homepage_example=true', () => {
    const block = searchProfilesBlock();
    // The tool reads `profiles` twice: the main keyword query and the
    // school-filter fetch. Both must carry the exclusion, so require at
    // least two occurrences of the false-filter inside the tool block.
    const matches = block.match(FILTER_RE) || [];
    expect(matches.length).toBeGreaterThanOrEqual(2);

    // Belt-and-braces: assert the school branch specifically carries it, so a
    // future edit can't satisfy the count by double-filtering only the main
    // query while leaving Find-Someone leaking demo profiles.
    const schoolBranch = block.match(/if\s*\(\s*school\s*\)\s*\{([\s\S]*?)\n\s{4}\}/);
    expect(schoolBranch).not.toBeNull();
    expect(schoolBranch[1]).toMatch(/\.from\(\s*['"]profiles['"]\s*\)/);
    expect(schoolBranch[1]).toMatch(/\.eq\(\s*['"]is_homepage_example['"]\s*,\s*false\s*\)/);
  });

  test('no search read inverts the rule with is_homepage_example=true', () => {
    // A filter using `true` would return ONLY demo profiles — the opposite of
    // what we want. Catch that typo anywhere in the source.
    const re = /\.eq\(\s*['"]is_homepage_example['"]\s*,\s*true\s*\)/;
    const offenders = [];
    indexLines.forEach((line, idx) => {
      if (re.test(line)) offenders.push({ line: idx + 1, snippet: line.trim() });
    });
    if (offenders.length > 0) {
      throw new Error(
        'is_homepage_example filter uses TRUE value (should be false):\n' +
          offenders.map((o) => `  line ${o.line}: ${o.snippet}`).join('\n'),
      );
    }
    expect(offenders.length).toBe(0);
  });
});
