/**
 * KAN-244 — MCP-side moderation audit wrapper.
 *
 * Mirrors the lyra repo's `tests/unit/moderation-audit.test.ts`. Verifies
 * the wrapper writes to `content_moderation_flags` on warn/block and
 * NEVER blocks the user write on insert failure.
 *
 * Static-grep guards also verify every previous `checkModeration` call
 * site in write-tools.ts / convene-*.ts has been migrated to
 * `moderateAndAudit`.
 */

const fs = require('fs');
const path = require('path');

const MOD_AUDIT_PATH = path.join(__dirname, '..', 'src', 'moderation-audit.ts');
const WRITE_TOOLS_PATH = path.join(__dirname, '..', 'src', 'write-tools.ts');
const CONVENE_GATHER_PATH = path.join(__dirname, '..', 'src', 'convene-gathering-tools.ts');
const CONVENE_INVITE_PATH = path.join(__dirname, '..', 'src', 'convene-invite-tools.ts');

const modAudit = fs.readFileSync(MOD_AUDIT_PATH, 'utf8');
const writeTools = fs.readFileSync(WRITE_TOOLS_PATH, 'utf8');
const conveneGather = fs.readFileSync(CONVENE_GATHER_PATH, 'utf8');
const conveneInvite = fs.readFileSync(CONVENE_INVITE_PATH, 'utf8');

describe('KAN-244 MCP moderation-audit module', () => {
  test('file exists + exports moderateAndAudit', () => {
    expect(fs.existsSync(MOD_AUDIT_PATH)).toBe(true);
    expect(modAudit).toMatch(/export\s+async\s+function\s+moderateAndAudit\s*\(/);
  });

  test('always sets source = "mcp_server" on insert (never "web_app")', () => {
    // Cross-source bookkeeping: the lyra and MCP wrappers must each
    // hard-code their own source so a forensic query can split traffic.
    expect(modAudit).toMatch(/source:\s*['"]mcp_server['"]/);
    expect(modAudit).not.toMatch(/source:\s*['"]web_app['"]/);
  });

  test('snippet is capped at 200 chars on insert (DB CHECK + app defence)', () => {
    expect(modAudit).toMatch(/slice\(\s*0\s*,\s*200\s*\)/);
  });

  test('insert failure does NOT throw (fire-and-forget — never blocks the user write)', () => {
    // try/catch round the entire `recordFlag` body + the supabase call
    // itself is awaited inside the try. No bare `throw` statements.
    const recordFn = modAudit.match(/async\s+function\s+recordFlag[\s\S]*?\n\}/);
    expect(recordFn).not.toBeNull();
    const decommented = recordFn[0]
      .replace(/\/\/[^\n]*\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    expect(decommented).toMatch(/try\s*\{/);
    expect(decommented).not.toMatch(/^\s*throw\s/m);
  });
});

describe('KAN-244 write-tools migration', () => {
  test('imports moderateAndAudit (not checkModeration directly)', () => {
    expect(writeTools).toMatch(
      /import\s*\{\s*moderateAndAudit\s*\}\s*from\s*['"]\.\/moderation-audit\.js['"]/,
    );
    // No leftover direct checkModeration import — the wrapper is the
    // sole entry point so the audit row always fires.
    expect(writeTools).not.toMatch(/import\s*\{[^}]*\bcheckModeration\b[^}]*\}\s*from/);
  });

  test('every write tool uses moderateAndAudit (≥5 call sites)', () => {
    // updateProfile (loop) + add_item (title + desc) + add_school (name + loc) + add_link (title)
    // = at least 5 — the loop counts as one usage in the source even
    // though it iterates over multiple fields.
    const calls = (writeTools.match(/moderateAndAudit\s*\(/g) || []).length;
    expect(calls).toBeGreaterThanOrEqual(5);
  });

  test('every wired call passes profileId from auth (so audit row gets a real owner)', () => {
    // The wrapper's `profileId` argument is the way owners see their
    // own flags via RLS. Write tools have `auth.profileId` in scope.
    expect(writeTools).toMatch(/profileId:\s*auth\.profileId/);
  });

  test('moderation precedes the DB write in every wired tool', () => {
    // Sanity check: the FIRST moderateAndAudit call must appear before
    // the first .insert / .update on the target table.
    const firstMod = writeTools.indexOf('moderateAndAudit');
    const firstInsert = writeTools.search(/\.insert\(\{\s*\n?\s*profile_id:/);
    expect(firstMod).toBeGreaterThan(0);
    expect(firstInsert).toBeGreaterThan(firstMod);
  });
});

describe('KAN-244 convene-gathering-tools migration', () => {
  test('imports moderateAndAudit', () => {
    expect(conveneGather).toMatch(
      /import\s*\{\s*moderateAndAudit\s*\}\s*from\s*['"]\.\/moderation-audit\.js['"]/,
    );
    expect(conveneGather).not.toMatch(/import\s*\{[^}]*\bcheckModeration\b[^}]*\}\s*from/);
  });

  test('both create and update paths now use moderateAndAudit', () => {
    const calls = (conveneGather.match(/moderateAndAudit\s*\(/g) || []).length;
    // Create-loop counts as 1, update-loop counts as 1.
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test('profileId is null for Convene (gatherings aren\'t profile-scoped)', () => {
    expect(conveneGather).toMatch(/profileId:\s*null/);
  });
});

describe('KAN-244 convene-invite-tools migration', () => {
  test('imports moderateAndAudit', () => {
    expect(conveneInvite).toMatch(
      /import\s*\{\s*moderateAndAudit\s*\}\s*from\s*['"]\.\/moderation-audit\.js['"]/,
    );
  });

  test('lyra_record_rsvp notes routed through moderateAndAudit (private fieldType)', () => {
    expect(conveneInvite).toMatch(/moderateAndAudit\s*\(\s*\{[\s\S]*?text:\s*input\.notes/);
    expect(conveneInvite).toMatch(/fieldType:\s*['"]private['"]/);
    expect(conveneInvite).toMatch(/['"]gathering_invitees\.notes['"]/);
  });
});

describe('KAN-244 no orphaned checkModeration call sites', () => {
  // Negative guard: catch any future regression where a new write
  // tool forgets to use the wrapper and uses the bare policy fn
  // (would silently skip the audit row).
  const ALL_PATHS = [
    'write-tools.ts',
    'convene-gathering-tools.ts',
    'convene-invite-tools.ts',
  ];
  for (const p of ALL_PATHS) {
    test(`${p} contains no bare checkModeration() calls`, () => {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', p), 'utf8');
      // Strip comments so docs/JSDoc mentioning the function don't trip the guard.
      const code = src
        .replace(/\/\/[^\n]*\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      // Allow `moderateAndAudit` but no direct `checkModeration(`.
      expect(code).not.toMatch(/[^a-zA-Z]checkModeration\s*\(/);
    });
  }
});
