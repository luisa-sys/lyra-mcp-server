/**
 * BUGS-21 (KAN-141 closeout) — MCP server suspension-filter regression guard.
 *
 * The MCP server uses SUPABASE_SERVICE_ROLE_KEY which bypasses RLS, so the
 * `is_suspended` filter the web app relies on (via cookie-session RLS
 * policies) provides NO protection here. The MCP server itself must filter
 * every read of `profiles` to `.eq('is_suspended', false)` — otherwise an
 * admin-suspended profile will still appear in `lyra_search_profiles`,
 * `lyra_get_profile`, `lyra_get_insights`, etc.
 *
 * Static-grep regression test, mirror of `mcp-visibility-guard.test.cjs`.
 * If a future refactor adds a `profiles` read without the suspension
 * filter, this test fails — preventing the regression from reaching
 * production.
 *
 * If you intentionally need a `profiles` read WITHOUT the suspension
 * filter (e.g. an authenticated admin tool that wants to see suspended
 * profiles), add an explicit allow-list comment of the form:
 *
 *   // suspension-ok: <reason> (must include a Jira ticket key)
 *
 * directly above the `.from('profiles')` call. The test will skip
 * that occurrence.
 */

const fs = require('fs');
const path = require('path');

const indexPath = path.join(__dirname, '..', 'src', 'index.ts');
const source = fs.readFileSync(indexPath, 'utf8');
const lines = source.split('\n');

function findProfilesReads() {
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes(".from('profiles')")) continue;
    // Skip line comments and backtick-quoted prose
    const matchIndex = line.indexOf(".from('profiles')");
    const commentIndex = line.indexOf('//');
    if (commentIndex !== -1 && commentIndex < matchIndex) continue;
    const beforeMatch = line.slice(0, matchIndex);
    const backticks = (beforeMatch.match(/`/g) || []).length;
    if (backticks % 2 === 1) continue;
    hits.push({ lineNumber: i + 1, lineIndex: i });
  }
  return hits;
}

function findInnerJoinReads() {
  // Catch `profiles!inner(...)` joins from OTHER tables (e.g.
  // `school_affiliations.profiles!inner(...)`) — these also need
  // `.eq('profiles.is_suspended', false)` so a suspended profile's
  // school affiliation doesn't leak.
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/profiles!inner\s*\(/.test(line)) continue;
    const commentIndex = line.indexOf('//');
    const matchIndex = line.search(/profiles!inner/);
    if (commentIndex !== -1 && commentIndex < matchIndex) continue;
    hits.push({ lineNumber: i + 1, lineIndex: i, isInnerJoin: true });
  }
  return hits;
}

function isAllowListed(lineIndex) {
  for (let j = Math.max(0, lineIndex - 3); j < lineIndex; j++) {
    if (/suspension-ok:/i.test(lines[j])) return true;
  }
  return false;
}

function nextSevenLines(lineIndex) {
  return lines.slice(lineIndex, Math.min(lines.length, lineIndex + 8)).join('\n');
}

describe('BUGS-21 MCP suspension-filter regression guard', () => {
  const directReads = findProfilesReads();
  const innerJoinReads = findInnerJoinReads();

  test('source file is readable and contains profiles reads', () => {
    expect(source.length).toBeGreaterThan(100);
    expect(directReads.length).toBeGreaterThanOrEqual(5);
  });

  test('every direct `from("profiles")` read includes .eq("is_suspended", false)', () => {
    const unsafe = [];
    for (const hit of directReads) {
      if (isAllowListed(hit.lineIndex)) continue;
      const block = nextSevenLines(hit.lineIndex);
      const hasFilter = /\.eq\(\s*['"]is_suspended['"]\s*,\s*false\s*\)/.test(block);
      if (!hasFilter) {
        unsafe.push({
          line: hit.lineNumber,
          snippet: block.slice(0, 240).replace(/\n/g, ' '),
        });
      }
    }
    if (unsafe.length > 0) {
      const msg =
        'profiles reads WITHOUT is_suspended filter (BUGS-21):\n' +
        unsafe.map((u) => `  line ${u.line}: ${u.snippet}…`).join('\n') +
        '\nAdd `.eq("is_suspended", false)` to each, OR add a `// suspension-ok: <reason>` comment if intentional.';
      throw new Error(msg);
    }
    expect(unsafe.length).toBe(0);
  });

  test('every `profiles!inner(...)` join includes .eq("profiles.is_suspended", false)', () => {
    const unsafe = [];
    for (const hit of innerJoinReads) {
      if (isAllowListed(hit.lineIndex)) continue;
      const block = nextSevenLines(hit.lineIndex);
      const hasFilter = /\.eq\(\s*['"]profiles\.is_suspended['"]\s*,\s*false\s*\)/.test(block);
      if (!hasFilter) {
        unsafe.push({
          line: hit.lineNumber,
          snippet: block.slice(0, 240).replace(/\n/g, ' '),
        });
      }
    }
    if (unsafe.length > 0) {
      const msg =
        'profiles!inner(...) joins WITHOUT suspension filter (BUGS-21):\n' +
        unsafe.map((u) => `  line ${u.line}: ${u.snippet}…`).join('\n') +
        '\nAdd `.eq("profiles.is_suspended", false)` to each, OR add a `// suspension-ok: <reason>` comment if intentional.';
      throw new Error(msg);
    }
    expect(unsafe.length).toBe(0);
  });

  test('forbidden values are not used (catches `.eq("is_suspended", true)` typos)', () => {
    // We DO want only non-suspended profiles. A filter using `true` would
    // invert the meaning and only return suspended ones — almost certainly
    // a bug.
    const offenders = [];
    const re = /\.eq\(\s*['"](?:profiles\.)?is_suspended['"]\s*,\s*true\s*\)/;
    lines.forEach((line, idx) => {
      if (re.test(line)) {
        offenders.push({ line: idx + 1, snippet: line.trim() });
      }
    });
    if (offenders.length > 0) {
      const msg =
        'is_suspended filter uses TRUE value (should be false):\n' +
        offenders.map((o) => `  line ${o.line}: ${o.snippet}`).join('\n');
      throw new Error(msg);
    }
    expect(offenders.length).toBe(0);
  });
});
