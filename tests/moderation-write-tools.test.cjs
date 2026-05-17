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

describe('KAN-242 write-tools moderation wiring', () => {
  test('imports checkModeration from the policy wrapper', () => {
    expect(src).toMatch(
      /import\s*\{\s*checkModeration\s*\}\s*from\s*['"]\.\/moderation-policy\.js['"]/,
    );
  });

  describe('lyra_update_profile', () => {
    const block = extractToolBlock('lyra_update_profile');

    test('tool block found', () => {
      expect(block).not.toBeNull();
    });

    test('iterates sanitised updates through checkModeration', () => {
      // The update tool accepts ≥5 free-text fields. We check ALL of
      // them via a loop over `updates`, after sanitiseText.
      expect(block).toMatch(/for\s*\(\s*const\s*\[[^\]]+\]\s*of\s*Object\.entries\s*\(\s*updates\s*\)/);
      expect(block).toMatch(/checkModeration\s*\(/);
    });

    test('moderation runs BEFORE the database update', () => {
      const modIdx = block.indexOf('checkModeration');
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
      expect(block).toMatch(/checkModeration\s*\(\s*sanitisedTitle/);
    });

    test('moderates description when present (optional field)', () => {
      // Optional fields must be guarded inside an `if (sanitisedDesc)`
      // — otherwise null descriptions throw. The guard's body must
      // contain the checkModeration call.
      expect(block).toMatch(/if\s*\(\s*sanitisedDesc\s*\)\s*\{[\s\S]*?checkModeration\s*\(\s*sanitisedDesc/);
    });

    test('rejections bail with errorResponse before the insert', () => {
      const titleRejectIdx = block.indexOf('titleMod.ok');
      const insertIdx = block.indexOf(".from('profile_items')");
      expect(titleRejectIdx).toBeGreaterThan(0);
      expect(insertIdx).toBeGreaterThan(titleRejectIdx);
      expect(block).toMatch(/if\s*\(\s*!\s*titleMod\.ok\s*\)\s*return\s+errorResponse/);
    });
  });

  describe('lyra_add_school', () => {
    const block = extractToolBlock('lyra_add_school');

    test('tool block found', () => {
      expect(block).not.toBeNull();
    });

    test('moderates school_name (required)', () => {
      expect(block).toMatch(/checkModeration\s*\(\s*sanitisedName/);
    });

    test('moderates school_location when present (optional)', () => {
      expect(block).toMatch(/if\s*\(\s*sanitisedLoc\s*\)\s*\{[\s\S]*?checkModeration\s*\(\s*sanitisedLoc/);
    });

    test('rejections bail before the insert', () => {
      const nameRejectIdx = block.indexOf('nameMod.ok');
      const insertIdx = block.indexOf(".from('school_affiliations')");
      expect(nameRejectIdx).toBeGreaterThan(0);
      expect(insertIdx).toBeGreaterThan(nameRejectIdx);
    });
  });

  describe('lyra_add_link', () => {
    const block = extractToolBlock('lyra_add_link');

    test('tool block found', () => {
      expect(block).not.toBeNull();
    });

    test('moderates link title (user-controlled free text)', () => {
      // The URL itself is restricted by sanitiseUrl. Only the title
      // needs moderation — but it MUST be moderated, otherwise an
      // attacker can put profanity in a publicly-rendered link label.
      expect(block).toMatch(/checkModeration\s*\(\s*sanitisedLinkTitle/);
    });

    test('rejections bail before the insert', () => {
      const rejectIdx = block.indexOf('titleMod.ok');
      const insertIdx = block.indexOf(".from('external_links')");
      expect(rejectIdx).toBeGreaterThan(0);
      expect(insertIdx).toBeGreaterThan(rejectIdx);
    });
  });

  describe('public-field classification', () => {
    test('every checkModeration call in write-tools passes "public" fieldType', () => {
      // The profile-content write tools all populate fields rendered on
      // the public profile page ([slug]/page.tsx). If a future caller
      // passes 'private' here, PII like phone numbers would silently
      // slip into a public surface — guard against that.
      const calls = src.match(/checkModeration\s*\([^)]*\)/g) || [];
      expect(calls.length).toBeGreaterThanOrEqual(5);
      for (const call of calls) {
        expect(call).toMatch(/['"]public['"]/);
      }
    });
  });
});
