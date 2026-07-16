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
 * read, this test fails — preventing the regression from reaching
 * production.
 *
 * SEC-85 — the scan was widened from `src/index.ts` only to also cover every
 * `src/convene-*.ts` tool file, so a future convene tool that reads
 * `profile_items` is enforced by this guard rather than sitting in a blind
 * spot. (No convene file reads `profile_items` today; this is forward cover.)
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

const srcDir = path.join(__dirname, '..', 'src');
const indexPath = path.join(srcDir, 'index.ts');

// SEC-85: index.ts + every convene-*.ts tool file.
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

function findProfileItemReads(lines) {
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

function isAllowListed(lines, lineIndex) {
  // Walk back up to 3 lines looking for a `visibility-ok:` comment.
  for (let j = Math.max(0, lineIndex - 3); j < lineIndex; j++) {
    if (/visibility-ok:/i.test(lines[j])) return true;
  }
  return false;
}

function nextFiveLines(lines, lineIndex) {
  return lines.slice(lineIndex, Math.min(lines.length, lineIndex + 6)).join('\n');
}

const scanned = scanFiles().filter((f) => fs.existsSync(f)).map(loadFile);

describe('KAN-143 MCP visibility filter regression guard', () => {
  const indexFile = scanned.find((s) => s.file === indexPath);

  test('src/index.ts is readable and contains at least 5 profile_items reads', () => {
    expect(indexFile).toBeDefined();
    expect(indexFile.text.length).toBeGreaterThan(100);
    expect(findProfileItemReads(indexFile.lines).length).toBeGreaterThanOrEqual(5); // 5 read tools as of 2026-05-14
  });

  test('convene tool files are included in the scan (SEC-85)', () => {
    const conveneScanned = scanned.filter((s) => /convene-.*\.ts$/.test(s.file));
    expect(conveneScanned.length).toBeGreaterThanOrEqual(5);
  });

  test('every profile_items read includes .eq("visibility", "public") or is explicitly allow-listed', () => {
    const unsafe = [];
    for (const src of scanned) {
      for (const hit of findProfileItemReads(src.lines)) {
        if (isAllowListed(src.lines, hit.lineIndex)) continue;
        const block = nextFiveLines(src.lines, hit.lineIndex);
        // Match `.eq('visibility', 'public')` with either single or double quotes
        // and any whitespace.
        const hasFilter = /\.eq\(\s*['"]visibility['"]\s*,\s*['"]public['"]\s*\)/.test(block);
        if (!hasFilter) {
          unsafe.push({ where: `${src.relPath}:${hit.lineNumber}`, snippet: block.slice(0, 200) });
        }
      }
    }
    if (unsafe.length > 0) {
      const msg =
        'profile_items reads WITHOUT visibility filter (KAN-143 / SEC-85):\n' +
        unsafe.map((u) => `  ${u.where}: ${u.snippet.replace(/\n/g, ' ').slice(0, 120)}…`).join('\n') +
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
    for (const src of scanned) {
      for (const val of forbiddenValues) {
        const re = new RegExp(`\\.eq\\(\\s*['"]visibility['"]\\s*,\\s*['"]${val}['"]\\s*\\)`);
        src.lines.forEach((line, idx) => {
          if (re.test(line)) {
            offenders.push({ where: `${src.relPath}:${idx + 1}`, value: val, snippet: line.trim() });
          }
        });
      }
    }
    if (offenders.length > 0) {
      const msg =
        'profile_items visibility filter uses NON-public value(s):\n' +
        offenders.map((o) => `  ${o.where} [${o.value}]: ${o.snippet}`).join('\n');
      throw new Error(msg);
    }
    expect(offenders.length).toBe(0);
  });

  test('selected columns from profile_items never include unsafe data without a filter', () => {
    // Sanity: the `.select(...)` immediately preceding each `.from('profile_items')`
    // should not be `*`. We name columns so an additive schema change (e.g.
    // future `internal_note` column) doesn't silently leak.
    const offenders = [];
    for (const src of scanned) {
      for (const hit of findProfileItemReads(src.lines)) {
        const block = nextFiveLines(src.lines, hit.lineIndex);
        if (/\.select\(\s*['"]\*['"]\s*\)/.test(block)) {
          offenders.push(`${src.relPath}:${hit.lineNumber}: uses SELECT *`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // SEC-85 — negative meta-test. Proves the scan logic actually flags a
  // `profile_items` read that has had its visibility filter removed.
  describe('guard actually flags a removed visibility filter (regression proof)', () => {
    const badLines = [
      "const { data } = await sb",
      "  .from('profile_items')",
      "  .select('id, category, value')",
      "  .eq('profile_id', profileId);", // visibility filter removed
    ];
    const goodLines = [
      "const { data } = await sb",
      "  .from('profile_items')",
      "  .select('id, category, value')",
      "  .eq('profile_id', profileId)",
      "  .eq('visibility', 'public');",
    ];

    test('an unfiltered profile_items read is detected and NOT allow-listed', () => {
      const hits = findProfileItemReads(badLines);
      expect(hits.length).toBe(1);
      expect(isAllowListed(badLines, hits[0].lineIndex)).toBe(false);
      const block = nextFiveLines(badLines, hits[0].lineIndex);
      expect(/\.eq\(\s*['"]visibility['"]\s*,\s*['"]public['"]\s*\)/.test(block)).toBe(false);
    });

    test('the same read with the visibility filter restored passes', () => {
      const hits = findProfileItemReads(goodLines);
      expect(hits.length).toBe(1);
      const block = nextFiveLines(goodLines, hits[0].lineIndex);
      expect(/\.eq\(\s*['"]visibility['"]\s*,\s*['"]public['"]\s*\)/.test(block)).toBe(true);
    });
  });
});
