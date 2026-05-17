/**
 * KAN-239: the MCP `lyra_recommend_gifts` tool must surface the upstream
 * `meta.fellBackToEvergreen` flag so AI assistants can soften their
 * narration when the engine substituted safe-default ("evergreen")
 * concepts because the recipient profile was too sparse.
 *
 * The flag wire format:
 *   - Upstream `/api/recommendations/v2/[slug]` returns
 *     `meta.fellBackToEvergreen: boolean` (lyra repo, KAN-201 follow-up
 *     PR #242).
 *   - The MCP tool projects that into a top-level
 *     `fell_back_to_evergreen` field on the tool response.
 *   - When V2 fails (no upstream response), the field is omitted — we
 *     genuinely don't know which path the legacy fallback would have
 *     taken.
 *
 * These are file-content tests in the existing pattern (same as
 * kan-201-recommend-gifts.test.cjs). They lock the contract on the source
 * without booting the server.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const indexSrc = fs.readFileSync(path.join(root, 'src/index.ts'), 'utf8');

describe('KAN-239: V2EndpointResponse type admits meta.fellBackToEvergreen', () => {
  test('the meta object on V2EndpointResponse declares fellBackToEvergreen', () => {
    // We don't run tsc as part of this test (the build step already does
    // that and would fail loud), but we do lock the source shape so a
    // future refactor that drops the field gets caught.
    expect(indexSrc).toMatch(
      /meta\?:\s*\{[\s\S]{0,400}fellBackToEvergreen\?:\s*boolean/,
    );
  });
});

describe('KAN-239: tool response surfaces fell_back_to_evergreen', () => {
  test('top-level fell_back_to_evergreen field is present on the response', () => {
    expect(indexSrc).toContain('fell_back_to_evergreen');
  });

  test('the field reads from v2.meta.fellBackToEvergreen', () => {
    // The exact identifier we use in the assignment — coupled tightly to
    // the implementation so a rename catches both ends.
    expect(indexSrc).toMatch(
      /fellBackToEvergreen\s*=\s*v2\s*\?\s*Boolean\(v2\.meta\?\.fellBackToEvergreen\)\s*:\s*undefined/,
    );
  });

  test('the field is omitted (undefined) when V2 was unreachable', () => {
    // When `v2 === null` we set the value to `undefined` so JSON.stringify
    // drops it — we honestly don't know, so we don't claim either way.
    expect(indexSrc).toMatch(/v2\s*\?\s*Boolean\(v2\.meta\?\.fellBackToEvergreen\)\s*:\s*undefined/);
  });
});

describe('KAN-239: tool description signals the flag to AI assistants', () => {
  // AI assistants read the tool description to decide how to narrate. If
  // we add the flag to the payload without telling them what it means,
  // they'll either ignore it or hallucinate a meaning. The description
  // must explicitly mention it + what to do.
  test('description mentions fell_back_to_evergreen', () => {
    expect(indexSrc).toContain('fell_back_to_evergreen');
    // And it appears inside the recommendation tool's description block,
    // not just the response. We do a coarse-grained check: the substring
    // "soften" or "tailored" appears near "fell_back_to_evergreen" in the
    // description. Both phrasings would be acceptable; we require at
    // least one.
    expect(indexSrc).toMatch(
      /fell_back_to_evergreen[\s\S]{0,400}(soften|tailored|sparse|default)/i,
    );
  });
});

describe('KAN-239: backwards-compatible — does not break the KAN-201 schema', () => {
  // Existing assertions on the KAN-201 payload shape must continue to
  // pass — the evergreen flag is purely additive.
  test('disclosure_global, buyer_context, recommendations, version still present', () => {
    for (const field of [
      'disclosure_global',
      'buyer_context',
      'recommendations:',
      'version:',
    ]) {
      expect(indexSrc).toContain(field);
    }
  });

  test('legacy fields gift_ideas/likes/dislikes/boundaries still present', () => {
    for (const field of ['gift_ideas:', 'likes:', 'dislikes:', 'boundaries:']) {
      expect(indexSrc).toContain(field);
    }
  });
});
