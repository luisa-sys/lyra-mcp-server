/**
 * KAN-210 P6 — lifecycle tools structural tests.
 *
 * Covers: lyra_reschedule_gathering, lyra_cancel_gathering, lyra_suggest_substitute.
 */
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'convene-lifecycle-tools.ts'),
  'utf8'
);
const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');

describe('Convene lifecycle tools — structure (KAN-210 P6)', () => {
  test('file exists + wired into index', () => {
    expect(src).toBeTruthy();
    expect(idx).toMatch(/import\s*\{\s*registerConveneLifecycleTools\s*\}/);
    expect(idx).toMatch(/registerConveneLifecycleTools\(server\)/);
  });

  describe('lyra_reschedule_gathering', () => {
    test('is registered', () => {
      expect(src).toMatch(/server\.registerTool\(\s*['"]lyra_reschedule_gathering['"]/);
    });
    test('requires gathering_id, new_slot_start_iso, new_slot_end_iso', () => {
      expect(src).toMatch(/gathering_id:\s*z\.string\(\)\.uuid/);
      expect(src).toMatch(/new_slot_start_iso:\s*z\.string/);
      expect(src).toMatch(/new_slot_end_iso:\s*z\.string/);
    });
    test('rejects if end <= start', () => {
      expect(src).toMatch(/new_slot_end_iso must be after new_slot_start_iso|<=\s*new Date\(input\.new_slot_start_iso\)/);
    });
    test('only allows reschedule from live state', () => {
      expect(src).toMatch(/g\.status !== ['"]live['"]/);
      expect(src).toMatch(/Can only reschedule live gatherings/);
    });
    test('resets accepted/tentative invitees to invited', () => {
      expect(src).toMatch(/\.in\(\s*['"]status['"]\s*,\s*\[\s*['"]accepted['"]\s*,\s*['"]tentative['"]/);
      expect(src).toMatch(/status:\s*['"]invited['"]/);
    });
    test('writes gathering_rescheduled audit with old + new slots', () => {
      expect(src).toMatch(/gathering_rescheduled/);
      expect(src).toMatch(/from_slot_start:\s*g\.finalised_slot_start/);
      expect(src).toMatch(/to_slot_start:\s*input\.new_slot_start_iso/);
    });
    test('host_user_id filter on read + update', () => {
      const count = (src.match(/\.eq\(\s*['"]host_user_id['"]\s*,\s*userId\s*\)/g) || []).length;
      expect(count).toBeGreaterThanOrEqual(2);
    });
  });

  describe('lyra_cancel_gathering', () => {
    test('is registered', () => {
      expect(src).toMatch(/server\.registerTool\(\s*['"]lyra_cancel_gathering['"]/);
    });
    test('destructiveHint: true', () => {
      const region = src.slice(src.indexOf("'lyra_cancel_gathering'"), src.indexOf("'lyra_cancel_gathering'") + 2000);
      expect(region).toMatch(/destructiveHint:\s*true/);
    });
    test('rejects already-terminal states', () => {
      expect(src).toMatch(/g\.status === ['"]cancelled['"][\s\S]{0,80}g\.status === ['"]completed['"]/);
      expect(src).toMatch(/already \$\{g\.status\}/);
    });
    test('writes gathering_cancelled audit with reason', () => {
      expect(src).toMatch(/gathering_cancelled/);
      expect(src).toMatch(/reason:\s*input\.reason/);
    });
  });

  describe('lyra_suggest_substitute', () => {
    test('is registered', () => {
      expect(src).toMatch(/server\.registerTool\(\s*['"]lyra_suggest_substitute['"]/);
    });
    test('readOnlyHint: true', () => {
      const region = src.slice(src.indexOf("'lyra_suggest_substitute'"), src.indexOf("'lyra_suggest_substitute'") + 2000);
      expect(region).toMatch(/readOnlyHint:\s*true/);
    });
    test('excludes contacts already on the gathering', () => {
      expect(src).toMatch(/excludeContactIds/);
      expect(src).toMatch(/!excludeContactIds\.has/);
    });
    test('boosts same-tribe candidates', () => {
      expect(src).toMatch(/declinedTribeIds/);
      expect(src).toMatch(/shared tribe with declined invitee/);
    });
    test('boosts same-city candidates', () => {
      expect(src).toMatch(/c\.city\.toLowerCase\(\) === declinedContact\.city\.toLowerCase\(\)/);
      expect(src).toMatch(/also in \$\{c\.city\}/);
    });
    test('returns at most max_results suggestions (default 5)', () => {
      expect(src).toMatch(/max_results:\s*z[\s\S]{0,80}\.number\(\)/);
      expect(src).toMatch(/scored\.slice\(0,\s*input\.max_results\s*\?\?\s*5\)/);
    });
    test('host_user_id filter applied on contacts pool', () => {
      expect(src).toMatch(/owner_user_id['"],\s*userId/);
    });
  });

  describe('prompt-injection guard', () => {
    test('all three tools emit _data_notice', () => {
      const notices = (src.match(/_data_notice/g) || []).length;
      expect(notices).toBeGreaterThanOrEqual(3);
    });
  });
});
