/**
 * KAN-205 — MCP server ownership-filter regression guard for Convene tables.
 *
 * The MCP server uses SUPABASE_SERVICE_ROLE_KEY which BYPASSES RLS. Convene
 * tables therefore depend on the MCP code chaining an explicit ownership
 * filter on every read — otherwise contacts, tribes, gatherings, and OAuth
 * connections leak across users.
 *
 * Required filter per table (direct owner column):
 *
 *   contacts          .eq('owner_user_id', <userId>)
 *   tribes            .eq('owner_user_id', <userId>)
 *   oauth_connections .eq('owner_user_id', <userId>)
 *   gatherings        .eq('host_user_id',  <userId>)
 *   venue_ratings     .eq('user_id',       <userId>)
 *
 * Child tables (contact_methods, tribe_members, gathering_invitees,
 * gathering_proposed_slots, gathering_invite_messages, gathering_events_log,
 * venue_visits) are joined via a parent. Reads against them MUST include
 * `.eq('<parent>_id', <value-derived-from-owner-scoped-parent>)`. Static
 * verification of derivation is infeasible — those reads require an
 * `// ownership-ok: <reason + Jira key>` comment immediately above the
 * `.from(...)` line.
 *
 * If a future refactor removes the required filter from any covered read,
 * this test fails — preventing the regression from reaching production.
 *
 * To intentionally bypass for a specific call site, add:
 *
 *   // ownership-ok: <reason> (must include a Jira ticket key)
 *
 * directly above the `.from(...)` line. The test will then skip it.
 */

const fs = require('fs');
const path = require('path');

const REQUIRED_DIRECT_OWNER_FILTERS = {
  contacts:          'owner_user_id',
  tribes:            'owner_user_id',
  oauth_connections: 'owner_user_id',
  gatherings:        'host_user_id',
  venue_ratings:     'user_id',
};

const CHILD_TABLES = [
  'contact_methods',
  'tribe_members',
  'gathering_invitees',
  'gathering_proposed_slots',
  'gathering_invite_messages',
  'gathering_events_log',
  'venue_visits',
];

// Source files to scan.
const sourceFiles = [
  path.join(__dirname, '..', 'src', 'index.ts'),
  path.join(__dirname, '..', 'src', 'write-tools.ts'),
  path.join(__dirname, '..', 'src', 'convene-tools.ts'),
  // KAN-235 — added so the multi-attendee fan-out reads (contacts +
  // oauth_connections via .in()) are statically checked. The contacts read
  // has the direct .eq('owner_user_id', userId); the second oauth_connections
  // read uses .in() and is guarded by an `ownership-ok:` comment.
  path.join(__dirname, '..', 'src', 'convene-availability-tool.ts'),
  // KAN-307 — contact/tribe write tools touch contacts, tribes, tribe_members,
  // contact_methods. Statically enforce their ownership scoping too.
  path.join(__dirname, '..', 'src', 'convene-contact-tools.ts'),
  // SEC-85 — the remaining Convene write-tool files contained owner-table
  // reads (gatherings → host_user_id, venue_ratings → user_id) and child-table
  // reads that were previously UNSCANNED by this guard. A future refactor that
  // dropped an ownership filter in any of them would not have failed CI. All
  // current reads were hand-verified correctly scoped when added here.
  path.join(__dirname, '..', 'src', 'convene-gathering-tools.ts'),
  path.join(__dirname, '..', 'src', 'convene-invite-tools.ts'),
  path.join(__dirname, '..', 'src', 'convene-lifecycle-tools.ts'),
  path.join(__dirname, '..', 'src', 'convene-recommend-tools.ts'),
  path.join(__dirname, '..', 'src', 'convene-suggest-venues-tool.ts'),
];

function loadSource(file) {
  const text = fs.readFileSync(file, 'utf8');
  return { file, text, lines: text.split('\n') };
}

function findFromOccurrences(src, table) {
  const needle = `.from('${table}')`;
  const hits = [];
  for (let i = 0; i < src.lines.length; i++) {
    const line = src.lines[i];
    const idx = line.indexOf(needle);
    if (idx === -1) continue;
    // Skip in-line comments.
    const commentIdx = line.indexOf('//');
    if (commentIdx !== -1 && commentIdx < idx) continue;
    // Skip inside backtick strings.
    const before = line.slice(0, idx);
    const backticks = (before.match(/`/g) || []).length;
    if (backticks % 2 === 1) continue;
    hits.push({ lineIndex: i, lineNumber: i + 1 });
  }
  return hits;
}

function hasAllowList(src, lineIndex) {
  // Walk back up to 3 lines for `ownership-ok:` comment.
  for (let j = Math.max(0, lineIndex - 3); j < lineIndex; j++) {
    if (/ownership-ok:/i.test(src.lines[j])) return true;
  }
  return false;
}

function hasOwnershipFilter(src, startLine, requiredColumn) {
  // Look forward up to 15 lines for `.eq('<column>', ...)`.
  const needle = `.eq('${requiredColumn}'`;
  for (let j = startLine; j < Math.min(src.lines.length, startLine + 15); j++) {
    if (src.lines[j].includes(needle)) return true;
  }
  return false;
}

describe('MCP ownership-filter regression guard (KAN-205)', () => {
  for (const [table, requiredColumn] of Object.entries(REQUIRED_DIRECT_OWNER_FILTERS)) {
    describe(`reads of public.${table}`, () => {
      for (const file of sourceFiles) {
        if (!fs.existsSync(file)) continue;
        const src = loadSource(file);
        const hits = findFromOccurrences(src, table);
        if (hits.length === 0) continue;

        for (const hit of hits) {
          const relPath = path.relative(path.join(__dirname, '..'), file);
          test(`${relPath}:${hit.lineNumber} chains .eq('${requiredColumn}', …) or is allow-listed`, () => {
            if (hasAllowList(src, hit.lineIndex)) return; // explicit exemption
            const ok = hasOwnershipFilter(src, hit.lineIndex, requiredColumn);
            if (!ok) {
              const ctx = src.lines.slice(hit.lineIndex, Math.min(src.lines.length, hit.lineIndex + 8)).join('\n');
              throw new Error(
                `${relPath}:${hit.lineNumber} reads ${table} without .eq('${requiredColumn}', …) ` +
                  `and without an ownership-ok: allow-list comment.\n\nContext:\n${ctx}\n`
              );
            }
          });
        }
      }
    });
  }

  describe(`reads of child tables (parent-scoped)`, () => {
    for (const table of CHILD_TABLES) {
      for (const file of sourceFiles) {
        if (!fs.existsSync(file)) continue;
        const src = loadSource(file);
        const hits = findFromOccurrences(src, table);
        if (hits.length === 0) continue;

        for (const hit of hits) {
          const relPath = path.relative(path.join(__dirname, '..'), file);
          test(`${relPath}:${hit.lineNumber} reads ${table} with ownership-ok comment`, () => {
            if (!hasAllowList(src, hit.lineIndex)) {
              const ctx = src.lines.slice(hit.lineIndex, Math.min(src.lines.length, hit.lineIndex + 6)).join('\n');
              throw new Error(
                `${relPath}:${hit.lineNumber} reads child table ${table} without an ` +
                  `ownership-ok: comment. Child tables must be scoped via their parent's ` +
                  `owner; static verification needs the explicit comment.\n\nContext:\n${ctx}\n`
              );
            }
          });
        }
      }
    }
  });

  // SEC-85 — negative meta-test. Drives the SAME helper functions the guard
  // uses against synthetic in-memory source, proving that a `gatherings` read
  // with the ownership filter REMOVED is actually detected as unsafe (and that
  // the guard would fail CI on such a regression in any newly-scanned file).
  describe('guard actually flags a removed ownership filter (regression proof)', () => {
    function fakeSrc(code) {
      return { file: '<synthetic>', text: code, lines: code.split('\n') };
    }

    test('a gatherings read WITHOUT .eq(host_user_id) and WITHOUT allow-list is flagged unsafe', () => {
      const bad = fakeSrc(
        [
          "const { data } = await sb",
          "  .from('gatherings')",
          "  .select('id, status')",
          "  .eq('id', input.gathering_id)", // note: no host_user_id filter
          "  .maybeSingle();",
        ].join('\n')
      );
      const hits = findFromOccurrences(bad, 'gatherings');
      expect(hits.length).toBe(1);
      expect(hasAllowList(bad, hits[0].lineIndex)).toBe(false);
      expect(hasOwnershipFilter(bad, hits[0].lineIndex, 'host_user_id')).toBe(false);
    });

    test('the same read WITH .eq(host_user_id) is accepted', () => {
      const good = fakeSrc(
        [
          "const { data } = await sb",
          "  .from('gatherings')",
          "  .select('id, status')",
          "  .eq('id', input.gathering_id)",
          "  .eq('host_user_id', userId)",
          "  .maybeSingle();",
        ].join('\n')
      );
      const hits = findFromOccurrences(good, 'gatherings');
      expect(hits.length).toBe(1);
      expect(hasOwnershipFilter(good, hits[0].lineIndex, 'host_user_id')).toBe(true);
    });

    test('a child-table read is accepted only with an ownership-ok comment', () => {
      const withoutComment = fakeSrc(
        ["const { data } = await sb", "  .from('gathering_invitees')", "  .eq('gathering_id', gid);"].join('\n')
      );
      const withComment = fakeSrc(
        [
          '// ownership-ok: scoped via gid (SEC-85)',
          "const { data } = await sb",
          "  .from('gathering_invitees')",
          "  .eq('gathering_id', gid);",
        ].join('\n')
      );
      const h1 = findFromOccurrences(withoutComment, 'gathering_invitees');
      const h2 = findFromOccurrences(withComment, 'gathering_invitees');
      expect(hasAllowList(withoutComment, h1[0].lineIndex)).toBe(false);
      expect(hasAllowList(withComment, h2[0].lineIndex)).toBe(true);
    });
  });
});
