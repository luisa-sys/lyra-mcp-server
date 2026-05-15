/**
 * KAN-143 (lyra repo) — MCP server visibility-filter regression guard.
 *
 * The MCP server uses SUPABASE_SERVICE_ROLE_KEY, which BYPASSES RLS.
 * That means the database's row-level security policies on `profile_items`
 * (the public/members_only/draft/private filter set up in the lyra-repo
 * migration `20260514054350_profile_items_visibility.sql`) provide NO
 * protection here. The MCP server itself must filter every read of
 * `profile_items` to `.eq('visibility', 'public')` — otherwise draft
 * (owner-only), private (legacy synonym for draft), and members_only
 * items will leak to anonymous MCP callers.
 *
 * This is a static-grep regression test. If a future refactor removes
 * the `.eq('visibility', 'public')` filter from any `profile_items`
 * read in `src/index.ts`, this test fails — preventing the regression
 * from reaching production.
 *
 * If you intentionally need a `profile_items` read WITHOUT the public
 * filter (e.g. a future authenticated tool that wants members_only items),
 * add an explicit allow-list comment of the form:
 *
 *   // visibility-ok: <reason> (must include a Jira ticket key)
 *
 * directly above the `.from('profile_items')` call. The test will skip
 * that occurrence.
 */

const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, '..', 'src', 'index.ts');
const source = fs.readFileSync(indexPath, 'utf8');
const lines = source.split('\n');

function findProfileItemReads() {
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes(".from('profile_items')")) continue;
    // Skip occurrences inside line comments — they're commentary, not code.
    const matchIndex = line.indexOf(".from('profile_items')");
    const commentIndex = line.indexOf('//');
    if (commentIndex !== -1 && commentIndex < matchIndex) continue;
    // Skip occurrences inside backtick-quoted prose (e.g. in docstrings).
    // Heuristic: if there's an odd number of backticks BEFORE the match
    // on this line, we're inside a backtick span.
    const beforeMatch = line.slice(0, matchIndex);
    const backticks = (beforeMatch.match(/`/g) || []).length;
    if (backticks % 2 === 1) continue;
    hits.push({ lineNumber: i + 1, lineIndex: i });
  }
  return hits;
}

function isAllowListed(lineIndex) {
  // Walk back up to 3 lines looking for a `visibility-ok:` comment.
  for (let j = Math.max(0, lineIndex - 3); j < lineIndex; j++) {
    if (/visibility-ok:/i.test(lines[j])) return true;
  }
  return false;
}

function nextFiveLines(lineIndex) {
  return lines.slice(lineIndex, Math.min(lines.length, lineIndex + 6)).join('\n');
}

describe('KAN-143 MCP visibility filter regression guard', () => {
  const reads = findProfileItemReads();

  test('source file is readable and contains profile_items reads', () => {
    expect(source.length).toBeGreaterThan(100);
    expect(reads.length).toBeGreaterThanOrEqual(5); // 5 read tools as of 2026-05-14
  });

  test('every profile_items read includes .eq("visibility", "public") or is explicitly allow-listed', () => {
    const unsafe = [];
    for (const hit of reads) {
      if (isAllowListed(hit.lineIndex)) continue;
      const block = nextFiveLines(hit.lineIndex);
      // Match `.eq('visibility', 'public')` with either single or double quotes
      // and any whitespace.
      const hasFilter = /\.eq\(\s*['"]visibility['"]\s*,\s*['"]public['"]\s*\)/.test(block);
      if (!hasFilter) {
        unsafe.push({
          line: hit.lineNumber,
          snippet: block.slice(0, 200),
        });
      }
    }
    if (unsafe.length > 0) {
      const msg =
        'profile_items reads WITHOUT visibility filter (KAN-143):\n' +
        unsafe.map((u) => `  line ${u.line}: ${u.snippet.replace(/\n/g, ' ').slice(0, 120)}…`).join('\n') +
        '\nAdd `.eq("visibility", "public")` to each, OR add a `// visibility-ok: <reason>` comment if intentional.';
      throw new Error(msg);
    }
    expect(unsafe.length).toBe(0);
  });

  test('forbidden enum values are not used in filters (catches `private`, `draft`, `members_only` filter typos)', () => {
    // We DO want only `public` items. Filters using any other visibility
    // value would expose hidden items. Catch typos / refactor accidents.
    const forbiddenValues = ['private', 'draft', 'members_only'];
    const offenders = [];
    for (const val of forbiddenValues) {
      const re = new RegExp(`\\.eq\\(\\s*['"]visibility['"]\\s*,\\s*['"]${val}['"]\\s*\\)`);
      lines.forEach((line, idx) => {
        if (re.test(line)) {
          offenders.push({ line: idx + 1, value: val, snippet: line.trim() });
        }
      });
    }
    if (offenders.length > 0) {
      const msg =
        'profile_items visibility filter uses NON-public value(s):\n' +
        offenders.map((o) => `  line ${o.line} [${o.value}]: ${o.snippet}`).join('\n');
      throw new Error(msg);
    }
    expect(offenders.length).toBe(0);
  });

  test('selected columns from profile_items never include unsafe data without a filter', () => {
    // Sanity: the `.select(...)` immediately preceding each `.from('profile_items')`
    // should not be `*`. We name columns so an additive schema change (e.g.
    // future `internal_note` column) doesn't silently leak.
    const offenders = [];
    for (const hit of reads) {
      const block = nextFiveLines(hit.lineIndex);
      if (/\.select\(\s*['"]\*['"]\s*\)/.test(block)) {
        offenders.push(`line ${hit.lineNumber}: uses SELECT *`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
