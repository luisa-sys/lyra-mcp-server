/**
 * KAN-307 — Convene contacts & tribes write tools structural tests.
 *
 * Verifies all four parity tools are registered, gated on API-key auth, scope
 * every write to the authenticated user (insert-stamp / verify-parent / filter),
 * carry the ownership-ok allow-list comments the static guard requires, validate
 * input, and emit the prompt-injection _data_notice. Mirrors the source-assertion
 * style of convene-gathering-tools.test.cjs (no live handler execution).
 */

const fs = require('fs');
const path = require('path');

const srcPath = path.join(__dirname, '..', 'src', 'convene-contact-tools.ts');
const src = fs.readFileSync(srcPath, 'utf8');

describe('Convene contacts & tribes write tools — structure (KAN-307)', () => {
  describe('file', () => {
    test('exists', () => {
      expect(fs.existsSync(srcPath)).toBe(true);
    });

    test('exports registerConveneContactTools', () => {
      expect(src).toMatch(/export function registerConveneContactTools\(/);
    });

    test('wired into index.ts (import + call)', () => {
      const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
      expect(idx).toMatch(
        /import\s*\{\s*registerConveneContactTools\s*\}\s*from\s*['"]\.\/convene-contact-tools\.js['"]/
      );
      expect(idx).toMatch(/registerConveneContactTools\(server\)/);
    });

    test('added to the ownership-guard source list', () => {
      const guard = fs.readFileSync(path.join(__dirname, 'mcp-ownership-guard.test.cjs'), 'utf8');
      expect(guard).toMatch(/convene-contact-tools\.ts/);
    });

    test('imports moderation audit + supabase + the shared convene auth gate', () => {
      expect(src).toMatch(/from '\.\/moderation-audit\.js'/);
      expect(src).toMatch(/from '\.\/supabase\.js'/);
      // KAN-317: auth now routes through the shared convene-auth gate (mcp + convene).
      expect(src).toMatch(/from '\.\/convene-auth\.js'/);
    });
  });

  describe('lyra_add_contact', () => {
    const startIdx = Math.max(0, src.indexOf("'lyra_add_contact'") - 40);
    const block = src.slice(startIdx, src.indexOf("'lyra_create_tribe'"));

    test('is registered', () => {
      expect(block).toMatch(/server\.registerTool\(\s*['"]lyra_add_contact['"]/);
    });
    test('requires api_key', () => {
      expect(block).toMatch(/api_key:\s*z\.string/);
    });
    test('requires a non-empty display_name', () => {
      expect(block).toMatch(/display_name:\s*z\.string\(\)\.min\(1\)/);
    });
    test('validates email + optional linked_profile_id uuid', () => {
      expect(block).toMatch(/email:\s*z\.string\(\)\.email\(\)/);
      expect(block).toMatch(/linked_profile_id:\s*z[\s\S]{0,40}\.uuid\(\)/);
    });
    test('inserts contact with owner_user_id = authed user', () => {
      expect(block).toMatch(/\.from\(['"]contacts['"]\)/);
      expect(block).toMatch(/owner_user_id:\s*userId/);
    });
    test('inserts optional email/phone as contact_methods', () => {
      expect(block).toMatch(/\.from\(['"]contact_methods['"]\)/);
      expect(block).toMatch(/kind:\s*['"]email['"]/);
      expect(block).toMatch(/kind:\s*['"]phone['"]/);
    });
    test('carries ownership-ok comments for the writes', () => {
      const owOk = (block.match(/ownership-ok:/g) || []).length;
      expect(owOk).toBeGreaterThanOrEqual(2);
    });
    test('moderates display_name (public) and notes (private)', () => {
      expect(block).toMatch(/'contacts\.display_name'/);
      expect(block).toMatch(/'contacts\.notes'/);
    });
  });

  describe('lyra_create_tribe', () => {
    const startIdx = Math.max(0, src.indexOf("'lyra_create_tribe'") - 40);
    const block = src.slice(startIdx, src.indexOf("'lyra_add_contact_to_tribe'"));

    test('is registered', () => {
      expect(block).toMatch(/server\.registerTool\(\s*['"]lyra_create_tribe['"]/);
    });
    test('requires api_key + non-empty name', () => {
      expect(block).toMatch(/api_key:\s*z\.string/);
      expect(block).toMatch(/name:\s*z\.string\(\)\.min\(1\)/);
    });
    test('validates color_hex against the hex regex', () => {
      expect(block).toMatch(/color_hex:\s*z[\s\S]{0,40}\.regex\(/);
    });
    test('inserts tribe with owner_user_id = authed user', () => {
      expect(block).toMatch(/\.from\(['"]tribes['"]\)/);
      expect(block).toMatch(/owner_user_id:\s*userId/);
    });
    test('gives a friendly duplicate-name message (unique conflict)', () => {
      expect(block).toMatch(/23505/);
      expect(block).toMatch(/already have a tribe named/);
    });
  });

  describe('lyra_add_contact_to_tribe', () => {
    const startIdx = Math.max(0, src.indexOf("'lyra_add_contact_to_tribe'") - 40);
    const block = src.slice(startIdx, src.indexOf("'lyra_link_contact_profile'"));

    test('is registered', () => {
      expect(block).toMatch(/server\.registerTool\(\s*['"]lyra_add_contact_to_tribe['"]/);
    });
    test('verifies BOTH tribe and contact are owned by the user', () => {
      expect(block).toMatch(/\.from\(['"]tribes['"]\)[\s\S]{0,200}\.eq\(['"]owner_user_id['"],\s*userId\)/);
      expect(block).toMatch(/\.from\(['"]contacts['"]\)[\s\S]{0,200}\.eq\(['"]owner_user_id['"],\s*userId\)/);
    });
    test('inserts tribe_members under an ownership-ok comment', () => {
      // Proximity is enforced precisely by mcp-ownership-guard.test.cjs; here we
      // assert both the guard comment and the child-table insert are present.
      expect(block).toMatch(/ownership-ok:/);
      expect(block).toMatch(/\.from\(['"]tribe_members['"]\)\s*\n\s*\.insert\(/);
    });
    test('rejects a duplicate membership', () => {
      expect(block).toMatch(/already a member of this tribe/);
    });
  });

  describe('lyra_link_contact_profile', () => {
    const startIdx = Math.max(0, src.indexOf("'lyra_link_contact_profile'") - 40);
    const block = src.slice(startIdx);

    test('is registered', () => {
      expect(block).toMatch(/server\.registerTool\(\s*['"]lyra_link_contact_profile['"]/);
    });
    test('verifies the target profile exists and is published before linking', () => {
      expect(block).toMatch(/\.from\(['"]profiles['"]\)/);
      expect(block).toMatch(/is not published and cannot be linked/);
    });
    test('SEC-85: link validation also filters out suspended profiles', () => {
      // The profiles read in lyra_link_contact_profile must reject a
      // suspended-but-published profile (parity with the profiles RLS
      // suspension rule + the availability fan-out re-filter). `block` runs
      // from the tool registration to EOF (link_contact is the last tool).
      expect(block).toMatch(/\.from\(['"]profiles['"]\)[\s\S]*?\.eq\(['"]is_suspended['"],\s*false\)/);
    });
    test('updates contacts filtered by owner_user_id (and supports unlink)', () => {
      expect(block).toMatch(/\.from\(['"]contacts['"]\)/);
      expect(block).toMatch(/\.update\(\{\s*linked_profile_id:/);
      expect(block).toMatch(/\.eq\(['"]owner_user_id['"],\s*userId\)/);
    });
  });

  describe('prompt-injection notice + auth', () => {
    test('all four tools include _data_notice', () => {
      const notices = (src.match(/_data_notice/g) || []).length;
      expect(notices).toBeGreaterThanOrEqual(4);
    });
    test('every tool authenticates via authedUser(input.api_key)', () => {
      const calls = (src.match(/await authedUser\(input\.api_key\)/g) || []).length;
      expect(calls).toBeGreaterThanOrEqual(4);
    });
    test('all writes are guarded (>= 4 ownership-ok comments across the file)', () => {
      const owOk = (src.match(/ownership-ok:/g) || []).length;
      expect(owOk).toBeGreaterThanOrEqual(4);
    });
  });
});
