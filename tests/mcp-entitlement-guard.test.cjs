/**
 * KAN-317 — MCP entitlement-enforcement registry guard.
 *
 * The MCP server uses the service-role key (bypasses RLS), so per-user feature
 * entitlements (`mcp`, `convene`) and the age publish-gate MUST be enforced in
 * explicit app-code at every authenticated tool boundary. A grep-for-a-string
 * guard can't detect a MISSING check, so this is a POSITIVE registry: it
 * enumerates every Convene tool file and asserts each routes through the shared
 * gate, and that the core write/publish gates are present. A new tool file that
 * forgets the gate fails this test.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');

describe('KAN-317: MCP entitlement enforcement', () => {
  test('convene-auth requires BOTH mcp and convene', () => {
    const s = read('convene-auth.ts');
    expect(s).toMatch(/requireFeatures\([^)]*\[\s*['"]mcp['"]\s*,\s*['"]convene['"]\s*\]/);
  });

  test('write-tools authAndProfile requires the mcp entitlement', () => {
    const s = read('write-tools.ts');
    expect(s).toMatch(/requireFeatures\(\s*auth\.userId\s*,\s*\[\s*['"]mcp['"]\s*\]\s*\)/);
  });

  test('lyra_publish_profile enforces the age gate', () => {
    const s = read('write-tools.ts');
    expect(s).toMatch(/requireAgeVerifiedToPublish/);
  });

  // Enumerate every Convene tool file (except the shared helper) and assert it
  // does NOT define a local auth bypass and DOES route through an entitlement gate.
  const conveneFiles = fs
    .readdirSync(SRC)
    .filter((f) => /^convene-.*\.ts$/.test(f) && f !== 'convene-auth.ts');

  test('there are Convene tool files to check', () => {
    expect(conveneFiles.length).toBeGreaterThanOrEqual(8);
  });

  test.each(conveneFiles)('%s routes through the entitlement gate (no ungated auth)', (f) => {
    const s = read(f);
    // No local authedUser wrapper — those bypassed the entitlement check.
    expect(s).not.toMatch(/async function authedUser/);
    // If the file authenticates at all, it must go via the shared gate
    // (conveneAuthedUser) or call requireFeatures itself (e.g. the drain tool).
    const touchesAuth = /authenticateApiKey|authedUser/.test(s);
    if (touchesAuth) {
      expect(/conveneAuthedUser|requireFeatures/.test(s)).toBe(true);
    }
  });
});
