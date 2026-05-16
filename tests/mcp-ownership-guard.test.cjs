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
});
