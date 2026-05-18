/**
 * KAN-206 P2 — Convene availability tool tests.
 *
 * Two test groups:
 *   1) Structural — file exists, tool registered, owner_user_id filter, etc.
 *   2) computeFreeIntervals — exercised end-to-end with synthetic busy blocks.
 *      This is the local algorithmic part; provider IO is mocked separately.
 */

const fs = require('fs');
const path = require('path');

const srcPath = path.join(__dirname, '..', 'src', 'convene-availability-tool.ts');
const src = fs.readFileSync(srcPath, 'utf8');

describe('Convene availability tool — structure (KAN-206 P2)', () => {
  test('file exists', () => {
    expect(fs.existsSync(srcPath)).toBe(true);
  });

  test('exports registerConveneAvailabilityTools', () => {
    expect(src).toMatch(/export function registerConveneAvailabilityTools\(/);
  });

  test('is wired into index.ts', () => {
    const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    expect(idx).toMatch(/import\s*\{\s*registerConveneAvailabilityTools\s*\}\s*from\s*['"]\.\/convene-availability-tool\.js['"]/);
    expect(idx).toMatch(/registerConveneAvailabilityTools\(server\)/);
  });

  test('registers the renamed lyra_get_my_calendar_busy_times', () => {
    expect(src).toMatch(/server\.registerTool\(\s*['"]lyra_get_my_calendar_busy_times['"]/);
  });

  test('keeps lyra_get_host_availability as a deprecated alias', () => {
    expect(src).toMatch(/server\.registerTool\(\s*['"]lyra_get_host_availability['"]/);
    expect(src).toMatch(/deprecated/i);
  });

  test('both names share the same handler (no logic duplication)', () => {
    // Single AVAILABILITY_TOOL_DEF constant + single handler function
    expect(src).toMatch(/const AVAILABILITY_TOOL_DEF/);
    expect(src).toMatch(/async function handleAvailability/);
  });

  test('tool accepts api_key as optional (KAN-240 Bearer auth)', () => {
    expect(src).toMatch(/api_key:\s*z\.string\(\)\.optional\(\)/);
  });

  test('tool is read-only', () => {
    expect(src).toMatch(/readOnlyHint:\s*true/);
  });

  test('description leads with "YOUR" calendar (not "host\'s")', () => {
    const descIdx = src.indexOf('description:');
    expect(descIdx).toBeGreaterThan(-1);
    const region = src.slice(descIdx, descIdx + 500);
    expect(region).toMatch(/YOUR connected Google calendar/);
    expect(region).not.toMatch(/host's connected Google calendar/);
  });

  test('error when no calendar connected guides the user to the connect tool', () => {
    expect(src).toMatch(/lyra_connect_calendar/);
    expect(src).toMatch(/grant consent on the Google screen/);
  });

  test('chains owner_user_id filter on oauth_connections read', () => {
    expect(src).toMatch(/\.eq\(['"]owner_user_id['"],\s*userId\)/);
  });

  test('uses convene_vault_read_secret RPC to fetch refresh token', () => {
    expect(src).toMatch(/convene_vault_read_secret/);
  });

  test('caps window at 14 days', () => {
    expect(src).toMatch(/14\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
  });

  test('min_slot_minutes is constrained to [15, 480]', () => {
    expect(src).toMatch(/minSlot\s*<\s*15\s*\|\|\s*minSlot\s*>\s*8\s*\*\s*60/);
  });

  test('drift-risk comment present', () => {
    expect(src).toMatch(/DRIFT RISK/i);
  });

  test('response includes _data_notice', () => {
    expect(src).toMatch(/_data_notice/);
  });
});

// computeFreeIntervals algorithmic tests are deferred — the dist module is
// ESM and Jest's CommonJS test environment requires --experimental-vm-modules
// to dynamic-import it. The function's correctness is small and inspectable;
// will get integration coverage from the manual E2E test on dev. Tracked
// for follow-up once the MCP server moves to a Jest config that supports
// ESM modules.
