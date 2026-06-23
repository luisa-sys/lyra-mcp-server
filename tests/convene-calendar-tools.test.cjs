/**
 * KAN-206 — Convene calendar-tools structural tests.
 *
 * Verifies lyra_connect_calendar + lyra_disconnect_provider are present,
 * registered, gated on API-key auth, and carry the prompt-injection notice.
 */

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'convene-calendar-tools.ts'),
  'utf8'
);

describe('Convene calendar tools — structure (KAN-206)', () => {
  describe('file', () => {
    test('exists', () => {
      expect(fs.existsSync(path.join(__dirname, '..', 'src', 'convene-calendar-tools.ts'))).toBe(true);
    });

    test('exports registerConveneCalendarTools', () => {
      expect(src).toMatch(/export function registerConveneCalendarTools\(/);
    });

    test('is wired into index.ts', () => {
      const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
      expect(idx).toMatch(/import\s*\{\s*registerConveneCalendarTools\s*\}\s*from\s*['"]\.\/convene-calendar-tools\.js['"]/);
      expect(idx).toMatch(/registerConveneCalendarTools\(server\)/);
    });
  });

  describe('lyra_connect_calendar', () => {
    test('is registered', () => {
      expect(src).toMatch(/server\.registerTool\(\s*['"]lyra_connect_calendar['"]/);
    });

    test('requires api_key', () => {
      const start = src.indexOf("'lyra_connect_calendar'");
      const end = src.indexOf("'lyra_disconnect_provider'");
      const block = src.slice(start, end);
      expect(block).toMatch(/api_key:\s*z\.string/);
    });

    test('uses readOnlyHint=true (returns URL, no state mutation other than authedUser side effects)', () => {
      const start = src.indexOf("'lyra_connect_calendar'");
      const end = src.indexOf("'lyra_disconnect_provider'");
      const block = src.slice(start, end);
      expect(block).toMatch(/readOnlyHint:\s*true/);
    });

    test('returns a URL pointing at checklyra.com initiate route', () => {
      const start = src.indexOf("'lyra_connect_calendar'");
      const end = src.indexOf("'lyra_disconnect_provider'");
      const block = src.slice(start, end);
      expect(block).toMatch(/\/api\/convene\/oauth\/google\/initiate/);
    });

    test('marks the URL with via=mcp for analytics', () => {
      const start = src.indexOf("'lyra_connect_calendar'");
      const end = src.indexOf("'lyra_disconnect_provider'");
      const block = src.slice(start, end);
      expect(block).toMatch(/via=mcp/);
    });
  });

  describe('lyra_disconnect_provider', () => {
    test('is registered', () => {
      expect(src).toMatch(/server\.registerTool\(\s*['"]lyra_disconnect_provider['"]/);
    });

    test('uses destructiveHint=true and readOnlyHint=false', () => {
      const start = src.indexOf("'lyra_disconnect_provider'");
      const block = src.slice(start);
      expect(block).toMatch(/readOnlyHint:\s*false/);
      expect(block).toMatch(/destructiveHint:\s*true/);
    });

    test('filters lookup by owner_user_id', () => {
      const start = src.indexOf("'lyra_disconnect_provider'");
      const block = src.slice(start);
      expect(block).toMatch(/\.eq\('owner_user_id',\s*userId\)/);
    });

    test('soft-deletes (sets deleted_at + status=revoked)', () => {
      const start = src.indexOf("'lyra_disconnect_provider'");
      const block = src.slice(start);
      expect(block).toMatch(/deleted_at:/);
      expect(block).toMatch(/status:\s*['"]revoked['"]/);
    });

    test('writes consent_log audit entry', () => {
      const start = src.indexOf("'lyra_disconnect_provider'");
      const block = src.slice(start);
      expect(block).toMatch(/consent_log/);
      expect(block).toMatch(/oauth_revoked/);
    });

    test('calls convene_vault_revoke_secret RPC', () => {
      const start = src.indexOf("'lyra_disconnect_provider'");
      const block = src.slice(start);
      expect(block).toMatch(/convene_vault_revoke_secret/);
    });
  });

  describe('auth pattern (KAN-317: shared entitlement gate)', () => {
    // authedUser consolidated into convene-auth.ts (+ mcp/convene entitlement
    // enforcement). Rejection behaviour preserved, asserted in its shared home.
    const authSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'convene-auth.ts'), 'utf8');
    test('routes auth through the shared convene gate', () => {
      expect(src).toMatch(/conveneAuthedUser/);
    });
    test('shared gate rejects missing/invalid key + enforces entitlements', () => {
      expect(authSrc).toMatch(/API key required/);
      expect(authSrc).toMatch(/Authentication failed/);
      expect(authSrc).toMatch(/requireFeatures/);
    });
  });

  describe('prompt-injection guard', () => {
    test('every tool response includes _data_notice', () => {
      const notices = (src.match(/_data_notice/g) || []).length;
      expect(notices).toBeGreaterThanOrEqual(2);
    });
  });
});
