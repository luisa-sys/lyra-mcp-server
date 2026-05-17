/**
 * KAN-243 — Convene write-tools moderation regression guard.
 *
 * Mirrors `moderation-write-tools.test.cjs` (KAN-242) for the Convene
 * surface: every Convene write tool that accepts user-supplied free text
 * must route that text through `checkModeration` before the database
 * insert/update. If a future refactor adds a new Convene write tool, or
 * drops the moderation call from an existing one, this test fails.
 *
 * Behavioural coverage for the moderation library itself already exists
 * upstream (web-app `tests/unit/moderation-policy.test.ts`, KAN-241). We
 * don't repeat it here — these guards verify the *wiring*.
 */

const fs = require('fs');
const path = require('path');

const GATHERING_PATH = path.join(__dirname, '..', 'src', 'convene-gathering-tools.ts');
const INVITE_PATH = path.join(__dirname, '..', 'src', 'convene-invite-tools.ts');

const gatheringSrc = fs.readFileSync(GATHERING_PATH, 'utf8');
const inviteSrc = fs.readFileSync(INVITE_PATH, 'utf8');

function extractToolBlock(src, toolName) {
  const marker = `'${toolName}'`;
  const idx = src.indexOf(marker);
  if (idx === -1) return null;
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

describe('KAN-243 Convene write tools moderation wiring', () => {
  describe('convene-gathering-tools.ts imports + wiring', () => {
    test('imports checkModeration from the policy wrapper', () => {
      expect(gatheringSrc).toMatch(
        /import\s*\{\s*checkModeration\s*\}\s*from\s*['"]\.\/moderation-policy\.js['"]/,
      );
    });

    test('lyra_create_gathering: tool block found', () => {
      expect(extractToolBlock(gatheringSrc, 'lyra_create_gathering')).not.toBeNull();
    });

    test('lyra_create_gathering: moderates title (public)', () => {
      const block = extractToolBlock(gatheringSrc, 'lyra_create_gathering');
      // The "public" field-type matters — gathering titles render in invite
      // emails to all attendees and on the public RSVP page.
      expect(block).toMatch(/\[\s*input\.title\s*,\s*['"]public['"]\s*,\s*['"]gatherings\.title['"]/);
    });

    test('lyra_create_gathering: moderates description, dietary_summary, notes', () => {
      const block = extractToolBlock(gatheringSrc, 'lyra_create_gathering');
      expect(block).toMatch(/gatherings\.description/);
      expect(block).toMatch(/gatherings\.dietary_summary/);
      expect(block).toMatch(/gatherings\.notes/);
    });

    test('lyra_create_gathering: notes uses "private" (host-only)', () => {
      // private = PII warns instead of blocks — a host writing their own
      // phone number in private notes shouldn't be rejected.
      const block = extractToolBlock(gatheringSrc, 'lyra_create_gathering');
      expect(block).toMatch(/\[\s*input\.notes\s*,\s*['"]private['"]\s*,\s*['"]gatherings\.notes['"]/);
    });

    test('lyra_create_gathering: moderation runs BEFORE the DB insert', () => {
      const block = extractToolBlock(gatheringSrc, 'lyra_create_gathering');
      const modIdx = block.indexOf('checkModeration');
      const insertIdx = block.indexOf(".from('gatherings')");
      expect(modIdx).toBeGreaterThan(0);
      expect(insertIdx).toBeGreaterThan(modIdx);
    });

    test('lyra_create_gathering: fails closed (returns errorResponse on !ok)', () => {
      const block = extractToolBlock(gatheringSrc, 'lyra_create_gathering');
      expect(block).toMatch(/if\s*\(\s*!\s*mod\.ok\s*\)\s*return\s+errorResponse\s*\(\s*mod\.error/);
    });

    test('lyra_update_gathering: tool block found', () => {
      expect(extractToolBlock(gatheringSrc, 'lyra_update_gathering')).not.toBeNull();
    });

    test('lyra_update_gathering: moderates the same 4 fields with same field-types', () => {
      const block = extractToolBlock(gatheringSrc, 'lyra_update_gathering');
      expect(block).toMatch(/gatherings\.title/);
      expect(block).toMatch(/gatherings\.description/);
      expect(block).toMatch(/gatherings\.dietary_summary/);
      expect(block).toMatch(/gatherings\.notes/);
      // public/private split must match create — otherwise a field that was
      // public on create gets quietly relaxed on edit.
      expect(block).toMatch(/['"]public['"]\s*,\s*['"]gatherings\.title['"]/);
      expect(block).toMatch(/['"]private['"]\s*,\s*['"]gatherings\.notes['"]/);
    });

    test('lyra_update_gathering: skips undefined fields (does not moderate empty updates)', () => {
      // The update tool accepts every text field as optional. A guard that
      // ran moderation on `undefined` would either crash or rubber-stamp —
      // verify the skip is in place.
      const block = extractToolBlock(gatheringSrc, 'lyra_update_gathering');
      expect(block).toMatch(/if\s*\(\s*val\s*===\s*undefined\s*\)\s*continue/);
    });

    test('lyra_update_gathering: moderation runs BEFORE the DB update', () => {
      const block = extractToolBlock(gatheringSrc, 'lyra_update_gathering');
      const modIdx = block.indexOf('checkModeration');
      const updateIdx = block.indexOf('.update(update)');
      expect(modIdx).toBeGreaterThan(0);
      expect(updateIdx).toBeGreaterThan(modIdx);
    });
  });

  describe('convene-invite-tools.ts imports + wiring', () => {
    test('imports checkModeration from the policy wrapper', () => {
      expect(inviteSrc).toMatch(
        /import\s*\{\s*checkModeration\s*\}\s*from\s*['"]\.\/moderation-policy\.js['"]/,
      );
    });

    test('lyra_record_rsvp: tool block found', () => {
      expect(extractToolBlock(inviteSrc, 'lyra_record_rsvp')).not.toBeNull();
    });

    test('lyra_record_rsvp: moderates host notes (private)', () => {
      const block = extractToolBlock(inviteSrc, 'lyra_record_rsvp');
      expect(block).toMatch(
        /checkModeration\s*\(\s*input\.notes\s*,\s*['"]private['"]\s*,\s*['"]gathering_invitees\.notes['"]/,
      );
    });

    test('lyra_record_rsvp: moderation runs BEFORE the DB update', () => {
      const block = extractToolBlock(inviteSrc, 'lyra_record_rsvp');
      const modIdx = block.indexOf('checkModeration');
      const updateIdx = block.indexOf(".from('gathering_invitees')\n          .update(");
      expect(modIdx).toBeGreaterThan(0);
      // The update block exists; require modIdx precedes it textually
      const firstUpdateIdx = block.search(/\.from\('gathering_invitees'\)\s*\n?\s*\.update\(/);
      expect(firstUpdateIdx).toBeGreaterThan(modIdx);
    });

    test('lyra_record_rsvp: fails closed on rejection', () => {
      const block = extractToolBlock(inviteSrc, 'lyra_record_rsvp');
      expect(block).toMatch(/if\s*\(\s*!\s*notesMod\.ok\s*\)\s*return\s+errorResponse/);
    });
  });

  describe('coverage sweep', () => {
    test('at least one checkModeration call in each convene write-tool file', () => {
      expect((gatheringSrc.match(/checkModeration\s*\(/g) || []).length).toBeGreaterThanOrEqual(2);
      expect((inviteSrc.match(/checkModeration\s*\(/g) || []).length).toBeGreaterThanOrEqual(1);
    });
  });
});
