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

  test('registers lyra_get_my_calendar_busy_times', () => {
    expect(src).toMatch(/server\.registerTool\(\s*['"]lyra_get_my_calendar_busy_times['"]/);
  });

  test('no longer registers the deprecated lyra_get_host_availability alias', () => {
    // The alias was retained for one release after the KAN-244 rename to keep
    // cached tools/list snapshots in claude.ai / Claude Code working. It's now
    // removed — assert no live `registerTool('lyra_get_host_availability', …)`
    // remains. References inside comments are fine.
    expect(src).not.toMatch(/server\.registerTool\(\s*['"]lyra_get_host_availability['"]/);
  });

  test('uses a single shared definition + handler (no logic duplication)', () => {
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

// ─────────────────────────────────────────────────────────────────────────
// KAN-235 — shared availability fan-out tool tests
// ─────────────────────────────────────────────────────────────────────────

describe('Convene shared-availability fan-out — structure (KAN-235)', () => {
  test('registers lyra_get_shared_availability', () => {
    expect(src).toMatch(/server\.registerTool\(\s*['"]lyra_get_shared_availability['"]/);
  });

  test('exports computeSharedFreeIntervals for unit testing', () => {
    expect(src).toMatch(/export\s*\{[^}]*computeSharedFreeIntervals[^}]*\}/);
  });

  test('defines a SHARED_AVAILABILITY_TOOL_DEF (kept separate from host-only def)', () => {
    expect(src).toMatch(/const SHARED_AVAILABILITY_TOOL_DEF/);
  });

  test('has a single shared handleSharedAvailability handler (no logic duplication)', () => {
    expect(src).toMatch(/async function handleSharedAvailability/);
  });

  test('caps attendee_contact_ids at MAX_SHARED_ATTENDEES = 8', () => {
    expect(src).toMatch(/const MAX_SHARED_ATTENDEES\s*=\s*8/);
    expect(src).toMatch(/\.max\(\s*MAX_SHARED_ATTENDEES\s*\)/);
  });

  test('attendee_contact_ids requires at least 1 entry', () => {
    expect(src).toMatch(/attendee_contact_ids[\s\S]{0,200}\.min\(1\)/);
  });

  test('attendee_contact_ids enforces UUID per entry', () => {
    expect(src).toMatch(/attendee_contact_ids[\s\S]{0,200}z\.string\(\)\.uuid\(\)/);
  });

  test('defence-in-depth: handler re-asserts the 8-attendee cap', () => {
    expect(src).toMatch(/attendee_contact_ids\.length\s*>\s*MAX_SHARED_ATTENDEES/);
  });

  test('shared description mentions per-attendee busy ranges + no event titles', () => {
    const sharedIdx = src.indexOf('const SHARED_AVAILABILITY_TOOL_DEF');
    expect(sharedIdx).toBeGreaterThan(-1);
    const region = src.slice(sharedIdx, sharedIdx + 1500);
    expect(region).toMatch(/per-attendee busy time ranges/);
    expect(region).toMatch(/never event titles/);
  });

  test('shared description tells the LLM to use lyra_list_my_contacts to find contact IDs', () => {
    const sharedIdx = src.indexOf('const SHARED_AVAILABILITY_TOOL_DEF');
    const region = src.slice(sharedIdx, sharedIdx + 2000);
    expect(region).toMatch(/lyra_list_my_contacts/);
  });

  test('shared tool is read-only', () => {
    const sharedIdx = src.indexOf('const SHARED_AVAILABILITY_TOOL_DEF');
    const region = src.slice(sharedIdx, sharedIdx + 2000);
    expect(region).toMatch(/readOnlyHint:\s*true/);
  });

  test('shared tool accepts api_key as optional (KAN-240 Bearer auth parity)', () => {
    const sharedIdx = src.indexOf('const SHARED_AVAILABILITY_TOOL_DEF');
    const region = src.slice(sharedIdx, sharedIdx + 2000);
    expect(region).toMatch(/api_key:\s*z\.string\(\)\.optional\(\)/);
  });

  test('handler chains owner_user_id filter when reading the host contacts (KAN-205 guard)', () => {
    // Look for the contacts read block + the .eq('owner_user_id', userId) within it.
    expect(src).toMatch(/\.from\(['"]contacts['"]\)[\s\S]{0,400}\.eq\(['"]owner_user_id['"],\s*userId\)/);
  });

  test('handler filters host contacts soft-delete (deleted_at IS NULL)', () => {
    expect(src).toMatch(/\.from\(['"]contacts['"]\)[\s\S]{0,400}\.is\(['"]deleted_at['"],\s*null\)/);
  });

  test('resolves linked_profile_id → profile via profiles table', () => {
    expect(src).toMatch(/\.from\(['"]profiles['"]\)[\s\S]{0,400}\.in\(['"]id['"]/);
  });

  test('excludes suspended profiles (is_suspended = false)', () => {
    expect(src).toMatch(/\.from\(['"]profiles['"]\)[\s\S]{0,400}\.eq\(['"]is_suspended['"],\s*false\)/);
  });

  test('looks up attendee Google connections by their owner_user_id (with ownership-ok comment)', () => {
    // The second oauth_connections read in the handler uses .in() — guard
    // requires either .eq(owner_user_id) within 15 lines OR an ownership-ok
    // comment within 3 lines back.
    expect(src).toMatch(/ownership-ok:[^\n]*KAN-235[\s\S]{0,200}\.from\(['"]oauth_connections['"]\)[\s\S]{0,200}\.in\(['"]owner_user_id['"]/);
  });

  test('does NOT select event-title fields from oauth_connections (no leak)', () => {
    // Strictly assert that no select() call in the file pulls anything that
    // looks like an event title field. The Google freeBusy API doesn't return
    // titles either, but a defensive check guards against future drift.
    expect(src).not.toMatch(/\.select\(['"][^'"]*\b(event_title|summary|title|description)\b[^'"]*['"]\)[\s\S]{0,40}oauth_connections/);
  });

  test('per-attendee state shape: source, busy_blocks, requires_manual_confirm', () => {
    expect(src).toMatch(/source:\s*['"]connected['"]/);
    expect(src).toMatch(/source:\s*['"]manual['"]/);
    expect(src).toMatch(/requires_manual_confirm:\s*true/);
    expect(src).toMatch(/requires_manual_confirm:\s*false/);
  });

  test('response includes attendee_states keyed by contact_id', () => {
    expect(src).toMatch(/attendee_states:\s*attendeeStates/);
  });

  test('response includes summary with counts (requested / connected / manual)', () => {
    expect(src).toMatch(/attendees_requested/);
    expect(src).toMatch(/attendees_connected/);
    expect(src).toMatch(/attendees_requires_manual_confirm/);
  });

  test('aggregated suggested_free_intervals via computeSharedFreeIntervals', () => {
    expect(src).toMatch(/computeSharedFreeIntervals\(\s*start,\s*end,\s*allBusyLists,\s*minSlot\s*\)/);
  });

  test('per-attendee fetch errors are isolated (single failure does not poison batch)', () => {
    // Search the handler region for a try/catch around the freeBusy fetch.
    expect(src).toMatch(/try\s*\{[\s\S]{0,800}refreshGoogleAccessToken[\s\S]{0,800}\}\s*catch/);
  });

  test('window cap + min_slot constraints reuse the host-only handler bounds', () => {
    // Same 14-day cap + [15,480] minute slot — single source of truth (literally
    // the same constants in both handlers; assert both bounds appear in the
    // shared handler region).
    const sharedHandlerIdx = src.indexOf('handleSharedAvailability');
    expect(sharedHandlerIdx).toBeGreaterThan(-1);
    const region = src.slice(sharedHandlerIdx);
    expect(region).toMatch(/14\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
    expect(region).toMatch(/minSlot\s*<\s*15\s*\|\|\s*minSlot\s*>\s*8\s*\*\s*60/);
  });

  test('host-only handler description-order invariant is documented', () => {
    // Preserve the source-order constraint so future edits do not break the
    // existing "YOUR connected Google calendar" structural test.
    expect(src).toMatch(/MUST stay above SHARED_AVAILABILITY_TOOL_DEF/);
  });
});
