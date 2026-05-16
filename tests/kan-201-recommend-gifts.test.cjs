/**
 * KAN-201: tests for the monetised `lyra_recommend_gifts` MCP tool.
 *
 * The MCP server tests are file-content based (same pattern as
 * mcp-phase2.test.cjs) — they don't boot the server. They lock the
 * compliance + schema invariants on the source.
 *
 * What this PR is about:
 *   - The tool now calls the lyra web app's V2 endpoint (KAN-200) and
 *     returns monetised affiliate recommendations.
 *   - Disclosure copy (FTC + Sovrn ToS) is present on every response.
 *   - SubID prefix `lyra-mcp-` is set server-side by the lyra link service
 *     (KAN-189 / KAN-191); the MCP server doesn't generate click IDs itself,
 *     it just forwards them.
 *   - Backwards compatibility: the legacy `gift_ideas` / `likes` / `dislikes`
 *     / `boundaries` shape is preserved alongside the new fields.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const indexSrc = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

describe('KAN-201: lyra_recommend_gifts — schema + inputs', () => {
  test('tool is registered with the v2 description', () => {
    // The description must signal that the tool returns monetised links so
    // AI clients render it appropriately.
    expect(indexSrc).toContain("'lyra_recommend_gifts'");
    expect(indexSrc).toContain('monetisable gift recommendations');
  });

  test('legacy `budget` input is still accepted (backwards compat)', () => {
    // KAN-201 ticket requires backwards compatibility — clients passing
    // only the legacy `budget` string must keep working. Tolerant of
    // line breaks between `budget:` and `.optional()`.
    expect(indexSrc).toMatch(/budget:[\s\S]{0,80}z\s*\.?\s*string\(\)[\s\S]{0,80}\.optional\(\)/);
  });

  test('new structured inputs are accepted', () => {
    for (const input of [
      'buyer_country',
      'occasion',
      'budget_min',
      'budget_max',
      'budget_currency',
      'delivery_by_date',
      'relationship_to_recipient',
    ]) {
      expect(indexSrc).toContain(input);
    }
  });

  test('occasion uses a closed enum (not free text)', () => {
    // Free-text occasions would leak prose into the V2 ranker;
    // the enum is the canonical KAN-198 set.
    expect(indexSrc).toMatch(/occasion:[\s\S]{0,400}z\s*\.?\s*enum\(\[/);
    expect(indexSrc).toContain("'birthday'");
    expect(indexSrc).toContain("'christmas'");
    expect(indexSrc).toContain("'just_because'");
  });

  test('relationship_to_recipient uses a closed enum (not free text)', () => {
    expect(indexSrc).toMatch(/relationship_to_recipient:[\s\S]{0,400}z\s*\.?\s*enum\(\[/);
    expect(indexSrc).toContain("'partner'");
    expect(indexSrc).toContain("'friend'");
  });

  test('buyer_country is restricted to 2 chars (ISO-3166 alpha-2)', () => {
    expect(indexSrc).toMatch(/buyer_country:[\s\S]{0,400}\.length\(2\)/);
  });

  test('budget_currency is restricted to 3 chars (ISO-4217)', () => {
    expect(indexSrc).toMatch(/budget_currency:[\s\S]{0,400}\.length\(3\)/);
  });
});

describe('KAN-201: lyra_recommend_gifts — V2 endpoint call', () => {
  test('reads LYRA_APP_URL from env with checklyra.com default', () => {
    expect(indexSrc).toContain('LYRA_APP_URL');
    expect(indexSrc).toContain("'https://checklyra.com'");
  });

  test('calls the V2 endpoint, not the legacy /api/recommendations/{slug}', () => {
    expect(indexSrc).toContain('/api/recommendations/v2/');
  });

  test('passes buyer_country / budget_min / budget_max as query params', () => {
    expect(indexSrc).toContain("'buyer_country'");
    expect(indexSrc).toContain("'budget_min'");
    expect(indexSrc).toContain("'budget_max'");
  });

  test('limits requests to 5 recommendations', () => {
    expect(indexSrc).toContain("set('limit', '5')");
  });

  test('has a 5-second timeout on the upstream call (no infinite hang)', () => {
    expect(indexSrc).toMatch(/setTimeout\(.*abort.*5000\)/);
  });

  test('returns 404 unchanged from the upstream', () => {
    // Profile-not-found is a real user-facing error; don't swallow it
    // into the legacy-fallback path.
    expect(indexSrc).toMatch(/response\.status === 404/);
  });
});

describe('KAN-201: lyra_recommend_gifts — disclosure compliance', () => {
  test('global disclosure mentions commission + no extra cost', () => {
    expect(indexSrc).toContain('disclosure_global');
    expect(indexSrc).toContain('commission');
    expect(indexSrc).toMatch(/no extra cost/i);
  });

  test('global disclosure points at /partners for the long form', () => {
    expect(indexSrc).toContain('checklyra.com/partners');
  });

  test('each monetised recommendation carries a per-item disclosure', () => {
    expect(indexSrc).toContain('affiliate_disclosure');
    // For monetised:true items, the per-item disclosure must mention commission
    expect(indexSrc).toMatch(/affiliate_disclosure:[\s\S]{0,300}commission/);
  });

  test('un-monetised links honestly say "no commission"', () => {
    // KAN-192 + KAN-193 honesty principle — when Sovrn isn't live yet,
    // affiliate.monetised is false. The per-item disclosure must reflect
    // that, not claim commission.
    expect(indexSrc).toMatch(/no commission/i);
  });
});

describe('KAN-201: lyra_recommend_gifts — backwards compatibility', () => {
  test('response still includes legacy fields gift_ideas / likes / dislikes / boundaries', () => {
    for (const field of ['gift_ideas:', 'likes:', 'dislikes:', 'boundaries:']) {
      expect(indexSrc).toContain(field);
    }
  });

  test('legacy budget label is echoed back in buyer_context', () => {
    expect(indexSrc).toContain('legacy_budget_label');
  });

  test('response has a `version` field so clients can distinguish v1 fallback from v2', () => {
    expect(indexSrc).toMatch(/version:\s*v2\s*\?\s*['"]v2['"]\s*:\s*['"]v1['"]/);
  });
});

describe('KAN-201: lyra_recommend_gifts — visibility guard alignment', () => {
  test('legacy fallback still chains .eq("visibility", "public") on profile_items', () => {
    // KAN-143 / mcp-visibility-guard regression — the legacy branch reads
    // profile_items via the service-role client which bypasses RLS, so
    // the public filter MUST be present.
    //
    // The split-on-`from('profile_items')` includes the comment block at
    // the top of index.ts (which mentions the pattern in the warning).
    // We skip the first 600 chars of each fragment to avoid matching
    // inside that comment AND to allow whitespace between the .from()
    // and the .eq() chain. The mcp-visibility-guard.test.cjs is the
    // canonical regression test for this; this one is just a sanity
    // belt-and-braces.
    const profileItemsReads = indexSrc.match(/\.from\(['"]profile_items['"]\)/g) || [];
    expect(profileItemsReads.length).toBeGreaterThanOrEqual(4); // gift_ideas, likes, dislikes, boundaries
    const blocks = indexSrc.split("from('profile_items')").slice(1);
    let codeBlockCount = 0;
    for (const block of blocks) {
      const fragment = block.slice(0, 600);
      // Skip the comment block at the top of file (it mentions the
      // pattern but isn't an actual read).
      if (fragment.includes('visibility-ok:') || fragment.startsWith("` read")) {
        continue;
      }
      codeBlockCount++;
      expect(fragment).toContain("'public'");
    }
    expect(codeBlockCount).toBeGreaterThanOrEqual(4);
  });
});

describe('KAN-201: version bump for the tool change', () => {
  test('package.json bumped to 1.1.0', () => {
    expect(pkg.version).toBe('1.1.0');
  });

  test('McpServer constructor version matches package.json', () => {
    expect(indexSrc).toMatch(/name:\s*['"]lyra-mcp-server['"],\s*version:\s*['"]1\.1\.0['"]/);
  });
});
