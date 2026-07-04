/**
 * KAN-242 — write-tools.ts moderation wiring regression guard.
 *
 * Static-grep guard ensuring every write tool that accepts user-supplied
 * text routes that text through `checkModeration` BEFORE the database
 * insert/update. If a future refactor adds a new write tool or removes
 * the moderation call from an existing one, this test fails.
 *
 * Mirrors the philosophy of `mcp-suspension-guard.test.cjs` and
 * `mcp-visibility-guard.test.cjs`: cheap, fast, no DB — the actual
 * library behaviour is regression-covered by the web app's
 * `tests/unit/moderation-policy.test.ts` (KAN-241).
 *
 * Scope is the *profile-content* write tools in write-tools.ts. Convene
 * tools (gathering titles, RSVP notes, etc.) are an intentional
 * follow-up — see KAN-242 ticket comment.
 */

const fs = require('fs');
const path = require('path');

const WRITE_TOOLS_PATH = path.join(__dirname, '..', 'src', 'write-tools.ts');
const src = fs.readFileSync(WRITE_TOOLS_PATH, 'utf8');

/**
 * Extract the body of `server.registerTool('<name>', ...)` so we can
 * grep within a single tool's scope. Returns null if not found.
 */
function extractToolBlock(toolName) {
  const marker = `'${toolName}'`;
  const idx = src.indexOf(marker);
  if (idx === -1) return null;
  // Walk forward to the matching closing `);` of registerTool by
  // counting paren depth from the opening `(` of `registerTool(`.
  const openIdx = src.lastIndexOf('registerTool(', idx);
  if (openIdx === -1) return null;
  let depth = 0;
  let i = openIdx + 'registerTool'.length;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return src.slice(openIdx, i);
}

// KAN-244: callers were migrated from the sync `checkModeration` to the
// async `moderateAndAudit` wrapper, which calls `checkModeration`
// internally and additionally writes a `content_moderation_flags`
// audit row. These guards accept either entry point — the original
// intent ("moderation is wired") is preserved while the audit-trail
// migration is allowed.
const MODERATION_FN = /(?:checkModeration|moderateAndAudit)/;

describe('KAN-242 write-tools moderation wiring', () => {
  test('imports moderation entry point from policy or audit wrapper', () => {
    expect(src).toMatch(
      /import\s*\{\s*(?:checkModeration|moderateAndAudit)\s*\}\s*from\s*['"]\.\/moderation-(?:policy|audit)\.js['"]/,
    );
  });

  describe('lyra_update_profile', () => {
    const block = extractToolBlock('lyra_update_profile');

    test('tool block found', () => {
      expect(block).not.toBeNull();
    });

    test('iterates sanitised updates through moderation', () => {
      expect(block).toMatch(/for\s*\(\s*const\s*\[[^\]]+\]\s*of\s*Object\.entries\s*\(\s*updates\s*\)/);
      expect(block).toMatch(MODERATION_FN);
    });

    test('moderation runs BEFORE the database update', () => {
      const modIdx = block.search(MODERATION_FN);
      const updateIdx = block.indexOf(".from('profiles')");
      expect(modIdx).toBeGreaterThan(0);
      expect(updateIdx).toBeGreaterThan(modIdx);
    });

    test('fails closed: rejection returns errorResponse, does not fall through', () => {
      expect(block).toMatch(/if\s*\(\s*!\s*mod\.ok\s*\)\s*return\s+errorResponse\(/);
    });
  });

  describe('lyra_add_item', () => {
    const block = extractToolBlock('lyra_add_item');

    test('tool block found', () => {
      expect(block).not.toBeNull();
    });

    test('moderates title (required field)', () => {
      // Old: checkModeration(sanitisedTitle, ...). New: moderateAndAudit({ text: sanitisedTitle, ... }).
      expect(block).toMatch(/(?:checkModeration\s*\(\s*sanitisedTitle|moderateAndAudit\s*\(\s*\{[\s\S]*?text:\s*sanitisedTitle)/);
    });

    test('moderates description when present (optional field)', () => {
      // Guarded by `if (sanitisedDesc)`; either entry point allowed.
      expect(block).toMatch(/if\s*\(\s*sanitisedDesc\s*\)\s*\{[\s\S]*?(?:checkModeration\s*\(\s*sanitisedDesc|moderateAndAudit\s*\(\s*\{[\s\S]*?text:\s*sanitisedDesc)/);
    });

    test('rejections bail with errorResponse before the insert', () => {
      const titleRejectIdx = block.indexOf('titleMod.ok');
      const insertIdx = block.indexOf(".from('profile_items')");
      expect(titleRejectIdx).toBeGreaterThan(0);
      expect(insertIdx).toBeGreaterThan(titleRejectIdx);
      expect(block).toMatch(/if\s*\(\s*!\s*titleMod\.ok\s*\)\s*return\s+errorResponse/);
    });
  });

  // KAN-404 #12 — lyra_update_item edits an existing item's title /
  // description / url. Same moderation-before-write policy as lyra_add_item.
  describe('lyra_update_item', () => {
    const block = extractToolBlock('lyra_update_item');

    test('tool block found', () => {
      expect(block).not.toBeNull();
    });

    test('moderation entry point is wired', () => {
      expect(block).toMatch(MODERATION_FN);
    });

    test('moderates title when provided', () => {
      expect(block).toMatch(/moderateAndAudit\s*\(\s*\{[\s\S]*?text:\s*sanitisedTitle/);
    });

    test('moderates description when non-empty', () => {
      expect(block).toMatch(/if\s*\(\s*sanitisedDesc\.length\s*>\s*0\s*\)\s*\{[\s\S]*?moderateAndAudit\s*\(\s*\{[\s\S]*?text:\s*sanitisedDesc/);
    });

    test('moderation runs BEFORE the profile_items update', () => {
      const modIdx = block.search(MODERATION_FN);
      const updateIdx = block.indexOf(".from('profile_items')");
      expect(modIdx).toBeGreaterThan(0);
      expect(updateIdx).toBeGreaterThan(modIdx);
    });

    test('rejections bail with errorResponse before the write', () => {
      expect(block).toMatch(/if\s*\(\s*!\s*titleMod\.ok\s*\)\s*return\s+errorResponse/);
      expect(block).toMatch(/if\s*\(\s*!\s*descMod\.ok\s*\)\s*return\s+errorResponse/);
    });

    test('owner-scoped write: eq id AND profile_id', () => {
      expect(block).toMatch(/\.eq\(\s*'id'\s*,\s*item_id\s*\)/);
      expect(block).toMatch(/\.eq\(\s*'profile_id'\s*,\s*auth\.profileId\s*\)/);
    });
  });

  describe('lyra_add_school', () => {
    const block = extractToolBlock('lyra_add_school');

    test('tool block found', () => {
      expect(block).not.toBeNull();
    });

    test('moderates school_name (required)', () => {
      expect(block).toMatch(/(?:checkModeration\s*\(\s*sanitisedName|moderateAndAudit\s*\(\s*\{[\s\S]*?text:\s*sanitisedName)/);
    });

    test('moderates school_location when present (optional)', () => {
      expect(block).toMatch(/if\s*\(\s*sanitisedLoc\s*\)\s*\{[\s\S]*?(?:checkModeration\s*\(\s*sanitisedLoc|moderateAndAudit\s*\(\s*\{[\s\S]*?text:\s*sanitisedLoc)/);
    });

    test('rejections bail before the insert', () => {
      const nameRejectIdx = block.indexOf('nameMod.ok');
      const insertIdx = block.indexOf(".from('school_affiliations')");
      expect(nameRejectIdx).toBeGreaterThan(0);
      expect(insertIdx).toBeGreaterThan(nameRejectIdx);
    });

    // KAN-404 #1 — school-postcode gate must run BEFORE any DB insert so an
    // invalid/absent postcode never lands a row for a school affiliation.
    test('school postcode gate runs before the insert', () => {
      const gateIdx = block.indexOf('isValidSchoolPostcode');
      const insertIdx = block.indexOf(".from('school_affiliations')");
      expect(gateIdx).toBeGreaterThan(0);
      expect(insertIdx).toBeGreaterThan(gateIdx);
    });
  });

  describe('lyra_add_link', () => {
    const block = extractToolBlock('lyra_add_link');

    test('tool block found', () => {
      expect(block).not.toBeNull();
    });

    test('moderates link title (user-controlled free text)', () => {
      expect(block).toMatch(/(?:checkModeration\s*\(\s*sanitisedLinkTitle|moderateAndAudit\s*\(\s*\{[\s\S]*?text:\s*sanitisedLinkTitle)/);
    });

    test('rejections bail before the insert', () => {
      const rejectIdx = block.indexOf('titleMod.ok');
      const insertIdx = block.indexOf(".from('external_links')");
      expect(rejectIdx).toBeGreaterThan(0);
      expect(insertIdx).toBeGreaterThan(rejectIdx);
    });
  });

  describe('public-field classification', () => {
    test('every moderation call in write-tools passes "public" fieldType', () => {
      // The profile-content write tools all populate fields rendered on
      // the public profile page. Allow either entry-point form.
      // - Old: `checkModeration(text, 'public', '...')` — 3 positional args
      // - New: `moderateAndAudit({ text, fieldType: 'public', field, profileId })` — object arg
      // Both must mention 'public' for these surfaces.
      const oldCalls = src.match(/checkModeration\s*\([^)]*\)/g) || [];
      const newCalls = src.match(/moderateAndAudit\s*\(\s*\{[\s\S]*?\}\s*\)/g) || [];
      expect(oldCalls.length + newCalls.length).toBeGreaterThanOrEqual(5);
      for (const call of [...oldCalls, ...newCalls]) {
        expect(call).toMatch(/['"]public['"]/);
      }
    });
  });
});
