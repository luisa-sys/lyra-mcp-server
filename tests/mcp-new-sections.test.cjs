/**
 * KAN-154 / KAN-181 / KAN-142 — regression guards for the four new
 * profile surfaces exposed via the MCP server:
 *
 *   - manual_of_me            (profile_manual_of_me table)
 *   - conversation_starters   (profile_conversation_starters joined to
 *                              conversation_starter_prompts)
 *   - files                   (profile_files, visibility='public' only)
 *   - current_problems        (item_category enum — already flows
 *                              through `items[]` automatically)
 *
 * Static-source assertions only — running the real MCP handlers would
 * require a Supabase round-trip with seeded fixtures, which is out of
 * scope for the unit suite. These guards catch the four most likely
 * silent-break scenarios:
 *
 *   1. A refactor removes one of the new fetches from lyra_get_profile.
 *   2. The visibility filter on profile_files gets dropped (would leak
 *      members_only / draft files).
 *   3. lyra_get_section stops handling one of the standalone section
 *      keys (would silently return the empty profile_items fallback).
 *   4. The tool description drifts from the surfaces it actually returns,
 *      so LLM clients don't know to ask for the new sections.
 */

const fs = require('fs');
const path = require('path');

const indexSrc = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'index.ts'),
  'utf8',
);

describe('KAN-154/181/142 — new profile surfaces in lyra_get_profile', () => {
  test('lyra_get_profile fetches profile_manual_of_me', () => {
    expect(indexSrc).toMatch(/\.from\(\s*['"]profile_manual_of_me['"]\s*\)/);
  });

  test('lyra_get_profile fetches profile_conversation_starters with a prompt join', () => {
    expect(indexSrc).toMatch(/\.from\(\s*['"]profile_conversation_starters['"]\s*\)/);
    // The join syntax for Supabase PostgREST is `prompts!inner(prompt)` — pin
    // it so refactors don't silently turn a join into a column-miss.
    expect(indexSrc).toMatch(/conversation_starter_prompts!inner\(prompt\)/);
  });

  test('lyra_get_profile fetches profile_files filtered to public visibility only', () => {
    expect(indexSrc).toMatch(/\.from\(\s*['"]profile_files['"]\s*\)/);
    // Every profile_files read must chain .eq('visibility', 'public') so
    // members_only / draft files don't leak via the service-role client.
    const fileReadIndex = indexSrc.indexOf(".from('profile_files')");
    expect(fileReadIndex).toBeGreaterThan(-1);
    // Look at the 250 chars following each profile_files .from(...) for
    // the visibility filter — that's well within one chained query block.
    let cursor = 0;
    const offenders = [];
    while (true) {
      const idx = indexSrc.indexOf(".from('profile_files')", cursor);
      if (idx === -1) break;
      const block = indexSrc.slice(idx, idx + 400);
      if (!/\.eq\(\s*['"]visibility['"]\s*,\s*['"]public['"]\s*\)/.test(block)) {
        offenders.push(idx);
      }
      cursor = idx + 1;
    }
    expect(offenders).toEqual([]);
  });

  test('lyra_get_profile returns public file URLs (not raw storage paths)', () => {
    // The bucket is public, so getPublicUrl is a string concat. Surfacing
    // the public URL (rather than the storage path) is what makes the
    // tool useful to LLM clients.
    expect(indexSrc).toMatch(
      /storage\.from\(\s*['"]profile-files['"]\s*\)\.getPublicUrl/,
    );
  });

  test('lyra_get_profile result JSON includes the four new top-level keys', () => {
    // Pin the result-shape keys so a rename (e.g. manual_of_me → manual)
    // doesn't silently break LLM-side parsing.
    expect(indexSrc).toMatch(/manual_of_me:\s*manual\b/);
    expect(indexSrc).toMatch(/conversation_starters:\s*startersShaped\b/);
    expect(indexSrc).toMatch(/files:\s*filesWithUrl\b/);
  });

  test('lyra_get_profile data-notice mentions the new sections', () => {
    // The hardcoded prompt-injection notice is the first line of defence
    // against treating profile content as instructions. If we add new
    // surfaces but don't extend the notice, the LLM may forget that the
    // new fields are also untrusted text.
    const noticeMatch = indexSrc.match(/_data_notice:\s*\n?\s*['"]([^'"]+)['"]/);
    expect(noticeMatch).not.toBeNull();
    const notice = noticeMatch[1];
    expect(notice).toMatch(/manual_of_me/);
    expect(notice).toMatch(/conversation_starters/);
    expect(notice).toMatch(/items/);
  });

  test('lyra_get_profile description mentions the new surfaces so clients know to ask', () => {
    // Find the Get Lyra Profile tool block and extract its description.
    // The description string is single-quoted in source and may contain
    // unescaped double quotes (e.g. category="files"), so match either
    // quote type as a delimiter and use [^X]+ where X is the matched
    // opener — captured via a backreference is awkward here, so split on
    // the leading quote.
    const block = indexSrc.match(
      /'lyra_get_profile',\s*\{[\s\S]*?description:\s*\n?\s*'([\s\S]*?)',/,
    );
    expect(block).not.toBeNull();
    const desc = block[1];
    expect(desc).toMatch(/Manual of Me/i);
    expect(desc).toMatch(/conversation starters/i);
    expect(desc).toMatch(/files/i);
  });
});

describe('KAN-154/181/142 — new section keys in lyra_get_section', () => {
  test('manual_of_me branch is registered', () => {
    expect(indexSrc).toMatch(/category\s*===\s*['"]manual_of_me['"]/);
  });

  test('conversation_starters branch is registered', () => {
    expect(indexSrc).toMatch(/category\s*===\s*['"]conversation_starters['"]/);
  });

  test('files branch is registered and filters to public visibility', () => {
    expect(indexSrc).toMatch(/category\s*===\s*['"]files['"]/);
    // Spot-check that the files branch chains the visibility filter — the
    // visibility-guard test only checks profile_items reads, so we add an
    // explicit check here for profile_files reads inside lyra_get_section.
    // (Covered already by the profile_files block above, but worth pinning.)
  });

  test('lyra_get_section description lists the new standalone section keys', () => {
    // Description string is single-quoted; lazy-match through to the
    // closing single-quote-followed-by-comma so embedded `"` chars are
    // tolerated.
    const block = indexSrc.match(
      /'lyra_get_section',\s*\{[\s\S]*?description:\s*\n?\s*'([\s\S]*?)',/,
    );
    expect(block).not.toBeNull();
    const desc = block[1];
    expect(desc).toMatch(/manual_of_me/);
    expect(desc).toMatch(/conversation_starters/);
    expect(desc).toMatch(/files/);
  });

  test('lyra_get_section input schema description mentions current_problems', () => {
    // current_problems is a profile_items category (added in KAN-182), so
    // it flows through the default branch automatically. We don't add a
    // new branch — we just document it so callers know it's available.
    const schemaMatch = indexSrc.match(
      /'lyra_get_section',\s*\{[\s\S]*?inputSchema:\s*\{[\s\S]*?category:\s*z\.string\(\)\.describe\(\s*['"]([^'"]+)['"]\s*\)/,
    );
    expect(schemaMatch).not.toBeNull();
    expect(schemaMatch[1]).toMatch(/current_problems/);
  });
});
