/**
 * KAN-208 P4 — gathering lifecycle MCP tools structural tests.
 *
 * Verifies all three lifecycle tools are registered, gated on API-key auth,
 * filter by host_user_id, append events_log entries, and respect the state
 * machine (only finalise from 'draft', only edit from editable states).
 */

const fs = require('fs');
const path = require('path');

const srcPath = path.join(__dirname, '..', 'src', 'convene-gathering-tools.ts');
const src = fs.readFileSync(srcPath, 'utf8');

describe('Convene gathering lifecycle tools — structure (KAN-208)', () => {
  describe('file', () => {
    test('exists', () => {
      expect(fs.existsSync(srcPath)).toBe(true);
    });

    test('exports registerConveneGatheringTools', () => {
      expect(src).toMatch(/export function registerConveneGatheringTools\(/);
    });

    test('wired into index.ts', () => {
      const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
      expect(idx).toMatch(/import\s*\{\s*registerConveneGatheringTools\s*\}\s*from\s*['"]\.\/convene-gathering-tools\.js['"]/);
      expect(idx).toMatch(/registerConveneGatheringTools\(server\)/);
    });
  });

  describe('lyra_create_gathering', () => {
    // Block spans the create-gathering body — start a few chars BEFORE the
    // first occurrence of the tool name so we include the registerTool prefix.
    const startIdx = Math.max(0, src.indexOf("'lyra_create_gathering'") - 40);
    const block = src.slice(startIdx, src.indexOf("'lyra_update_gathering'"));

    test('is registered', () => {
      expect(block).toMatch(/server\.registerTool\(\s*['"]lyra_create_gathering['"]/);
    });
    test('requires api_key', () => {
      expect(block).toMatch(/api_key:\s*z\.string/);
    });
    test('validates gathering_type against the enum', () => {
      // Schema uses z.enum(GATHERING_TYPES) — the enum constant is defined at module scope.
      expect(src).toMatch(/const GATHERING_TYPES = \[/);
      // The two pieces appear in source: a gathering_type field and a z.enum(GATHERING_TYPES) usage.
      expect(src).toMatch(/gathering_type:/);
      expect(src).toMatch(/z[\s\S]{0,20}\.enum\(GATHERING_TYPES\)/);
    });
    test('caps proposed_slots at 10', () => {
      expect(block).toMatch(/\.max\(10\)/);
    });
    test('caps invitee_contact_ids at 30', () => {
      expect(block).toMatch(/\.max\(30\)/);
    });
    test('inserts with host_user_id = authed user', () => {
      expect(block).toMatch(/host_user_id:\s*userId/);
    });
    test('initial status is draft', () => {
      expect(block).toMatch(/status:\s*['"]draft['"]/);
    });
    test('appends gathering_created event log entry', () => {
      expect(block).toMatch(/gathering_created/);
    });
  });

  describe('lyra_update_gathering', () => {
    const startIdx = Math.max(0, src.indexOf("'lyra_update_gathering'") - 40);
    const block = src.slice(startIdx, src.indexOf("'lyra_finalise_gathering'"));

    test('is registered', () => {
      expect(block).toMatch(/server\.registerTool\(\s*['"]lyra_update_gathering['"]/);
    });
    test('filters lookup by host_user_id', () => {
      expect(block).toMatch(/\.eq\(['"]host_user_id['"],\s*userId\)/);
    });
    test('rejects updates from non-editable states', () => {
      expect(block).toMatch(/EDITABLE_STATES\.has/);
      expect(block).toMatch(/Cannot edit a gathering/);
    });
    test('appends gathering_updated event log entry', () => {
      expect(block).toMatch(/gathering_updated/);
    });
    test('rejects empty update', () => {
      expect(block).toMatch(/No fields provided to update/);
    });
  });

  describe('lyra_finalise_gathering', () => {
    const startIdx = Math.max(0, src.indexOf("'lyra_finalise_gathering'") - 40);
    const block = src.slice(startIdx);

    test('is registered', () => {
      expect(block).toMatch(/server\.registerTool\(\s*['"]lyra_finalise_gathering['"]/);
    });
    test('filters by host_user_id', () => {
      expect(block).toMatch(/\.eq\(['"]host_user_id['"],\s*userId\)/);
    });
    test('rejects finalise from non-draft state', () => {
      expect(block).toMatch(/FINALISABLE_FROM\.has/);
      expect(block).toMatch(/Cannot finalise from state/);
    });
    test('validates slot end > start', () => {
      expect(block).toMatch(/finalised_slot_end_iso must be after/);
    });
    test('verifies venue exists when supplied', () => {
      expect(block).toMatch(/venue_id does not exist/);
    });
    test('transitions status to live', () => {
      expect(block).toMatch(/status:\s*['"]live['"]/);
    });
    test('appends gathering_finalised event log entry', () => {
      expect(block).toMatch(/gathering_finalised/);
    });
  });

  describe('audit log helper', () => {
    test('appendEvent inserts into gathering_events_log', () => {
      expect(src).toMatch(/\.from\(['"]gathering_events_log['"]\)/);
    });
    test('event_type, actor_user_id, gathering_id, metadata all set', () => {
      const helperBlock = src.slice(src.indexOf('async function appendEvent'), src.indexOf('export function'));
      expect(helperBlock).toMatch(/gathering_id:/);
      expect(helperBlock).toMatch(/actor_user_id:/);
      expect(helperBlock).toMatch(/event_type:/);
      expect(helperBlock).toMatch(/metadata:/);
    });
  });

  describe('prompt-injection notice', () => {
    test('all three tools include _data_notice', () => {
      const notices = (src.match(/_data_notice/g) || []).length;
      expect(notices).toBeGreaterThanOrEqual(3);
    });
  });
});
