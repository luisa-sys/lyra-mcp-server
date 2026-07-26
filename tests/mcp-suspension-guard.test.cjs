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
 * SEC-85 — the scan was widened from `src/index.ts` only to also cover every
 * `src/convene-*.ts` tool file. Convene profile reads (e.g. the availability
 * fan-out and the link_contact validation) were previously outside guard
 * scope, so a future convene refactor dropping the suspension filter would not
 * have failed CI. Adding new convene files is auto-covered by the glob below.
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

const srcDir = path.join(__dirname, '..', 'src');
const indexPath = path.join(srcDir, 'index.ts');

// SEC-85: index.ts + every convene-*.ts tool file. NOTE: write-tools.ts is
// deliberately NOT scanned here — its `profiles` operations are the caller's
// own authenticated self-writes (`.eq('id', auth.profileId)`), a distinct
// concern from read-leakage and governed by the SEC-83 suspended-actor guard.
function scanFiles() {
  const files = [indexPath];
  for (const name of fs.readdirSync(srcDir).sort()) {
    if (name.startsWith('convene-') && name.endsWith('.ts')) {
      files.push(path.join(srcDir, name));
    }
  }
  return files;
}

function loadFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  return { file, relPath: path.relative(path.join(__dirname, '..'), file), text, lines: text.split('\n') };
}

function findProfilesReads(lines) {
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

function findInnerJoinReads(lines) {
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

function isAllowListed(lines, lineIndex) {
  for (let j = Math.max(0, lineIndex - 3); j < lineIndex; j++) {
    if (/suspension-ok:/i.test(lines[j])) return true;
  }
  return false;
}

function nextSevenLines(lines, lineIndex) {
  return lines.slice(lineIndex, Math.min(lines.length, lineIndex + 8)).join('\n');
}

const scanned = scanFiles().filter((f) => fs.existsSync(f)).map(loadFile);

describe('BUGS-21 MCP suspension-filter regression guard', () => {
  const indexFile = scanned.find((s) => s.file === indexPath);

  test('src/index.ts is readable and contains at least 5 profiles reads', () => {
    expect(indexFile).toBeDefined();
    expect(indexFile.text.length).toBeGreaterThan(100);
    expect(findProfilesReads(indexFile.lines).length).toBeGreaterThanOrEqual(5);
  });

  test('convene tool files are included in the scan (SEC-85)', () => {
    const conveneScanned = scanned.filter((s) => /convene-.*\.ts$/.test(s.file));
    expect(conveneScanned.length).toBeGreaterThanOrEqual(5);
  });

  test('every direct `from("profiles")` read includes .eq("is_suspended", false)', () => {
    const unsafe = [];
    for (const src of scanned) {
      for (const hit of findProfilesReads(src.lines)) {
        if (isAllowListed(src.lines, hit.lineIndex)) continue;
        const block = nextSevenLines(src.lines, hit.lineIndex);
        const hasFilter = /\.eq\(\s*['"]is_suspended['"]\s*,\s*false\s*\)/.test(block);
        if (!hasFilter) {
          unsafe.push({
            where: `${src.relPath}:${hit.lineNumber}`,
            snippet: block.slice(0, 240).replace(/\n/g, ' '),
          });
        }
      }
    }
    if (unsafe.length > 0) {
      const msg =
        'profiles reads WITHOUT is_suspended filter (BUGS-21 / SEC-85):\n' +
        unsafe.map((u) => `  ${u.where}: ${u.snippet}…`).join('\n') +
        '\nAdd `.eq("is_suspended", false)` to each, OR add a `// suspension-ok: <reason>` comment if intentional.';
      throw new Error(msg);
    }
    expect(unsafe.length).toBe(0);
  });

  test('every `profiles!inner(...)` join includes .eq("profiles.is_suspended", false)', () => {
    const unsafe = [];
    for (const src of scanned) {
      for (const hit of findInnerJoinReads(src.lines)) {
        if (isAllowListed(src.lines, hit.lineIndex)) continue;
        const block = nextSevenLines(src.lines, hit.lineIndex);
        const hasFilter = /\.eq\(\s*['"]profiles\.is_suspended['"]\s*,\s*false\s*\)/.test(block);
        if (!hasFilter) {
          unsafe.push({
            where: `${src.relPath}:${hit.lineNumber}`,
            snippet: block.slice(0, 240).replace(/\n/g, ' '),
          });
        }
      }
    }
    if (unsafe.length > 0) {
      const msg =
        'profiles!inner(...) joins WITHOUT suspension filter (BUGS-21 / SEC-85):\n' +
        unsafe.map((u) => `  ${u.where}: ${u.snippet}…`).join('\n') +
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
    for (const src of scanned) {
      src.lines.forEach((line, idx) => {
        if (re.test(line)) {
          offenders.push({ where: `${src.relPath}:${idx + 1}`, snippet: line.trim() });
        }
      });
    }
    if (offenders.length > 0) {
      const msg =
        'is_suspended filter uses TRUE value (should be false):\n' +
        offenders.map((o) => `  ${o.where}: ${o.snippet}`).join('\n');
      throw new Error(msg);
    }
    expect(offenders.length).toBe(0);
  });

  // SEC-85 — negative meta-test. Proves the scan logic actually flags a
  // `profiles` read that has had its suspension filter removed, so a real
  // regression in any newly-scanned convene file would fail CI.
  describe('guard actually flags a removed suspension filter (regression proof)', () => {
    const badLines = [
      "const { data } = await sb",
      "  .from('profiles')",
      "  .select('id, user_id')",
      "  .in('id', linkedProfileIds);", // is_suspended filter removed
    ];
    const goodLines = [
      "const { data } = await sb",
      "  .from('profiles')",
      "  .select('id, user_id')",
      "  .in('id', linkedProfileIds)",
      "  .eq('is_suspended', false);",
    ];

    test('an unfiltered profiles read is detected and NOT allow-listed', () => {
      const hits = findProfilesReads(badLines);
      expect(hits.length).toBe(1);
      expect(isAllowListed(badLines, hits[0].lineIndex)).toBe(false);
      const block = nextSevenLines(badLines, hits[0].lineIndex);
      expect(/\.eq\(\s*['"]is_suspended['"]\s*,\s*false\s*\)/.test(block)).toBe(false);
    });

    test('the same read with the suspension filter restored passes', () => {
      const hits = findProfilesReads(goodLines);
      expect(hits.length).toBe(1);
      const block = nextSevenLines(goodLines, hits[0].lineIndex);
      expect(/\.eq\(\s*['"]is_suspended['"]\s*,\s*false\s*\)/.test(block)).toBe(true);
    });

    test('a suspension-ok comment exempts an intentional unfiltered read', () => {
      const exempt = ['// suspension-ok: admin tool needs suspended rows (SEC-85)', ...badLines];
      const hits = findProfilesReads(exempt);
      expect(hits.length).toBe(1);
      expect(isAllowListed(exempt, hits[0].lineIndex)).toBe(true);
    });
  });
});
