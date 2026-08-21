/**
 * KAN-356 leg A (finding mcp-quality-4) — RUNTIME cross-user isolation for the
 * Convene MCP tools.
 *
 * ── What this closes ────────────────────────────────────────────────────────
 * This server runs on `SUPABASE_SERVICE_ROLE_KEY` and BYPASSES RLS, so the
 * `.eq()` chained in application code IS the tenancy boundary — there is no
 * database-level backstop behind it. Until now the only control on that
 * boundary was `tests/mcp-ownership-guard.test.cjs`, a source-text scan.
 *
 * A source scan proves a filter STRING is present near a `.from()`. It cannot
 * prove the VALUE bound to it belongs to the caller, and its own header says
 * so: "Static verification of derivation is infeasible" for every child table
 * (`gathering_invitees`, `gathering_proposed_slots`, `gathering_events_log`,
 * …), which are waved through on an `// ownership-ok:` comment — on a human's
 * word rather than on an observation.
 *
 * `lyra_get_gathering` is that blind spot in one function. Its three child
 * reads are keyed on the caller-supplied `gathering_id` and nothing else; what
 * protects them is the early `return` taken when the owner-scoped parent read
 * finds no row. Delete that ONE `return` and every `.eq()` string in the file
 * is still there — the static guard stays green — while user B receives user
 * A's invitee list, proposed slots and event log. That is KAN-356 acceptance
 * criterion 3, and it is demonstrated in the PR that adds this file.
 *
 * ── Why a subprocess harness ────────────────────────────────────────────────
 * `jest.config.cjs` matches only `*.test.cjs` while the package is
 * `"type": "module"`, so a `.cjs` test cannot `require()` the compiled ESM.
 * Widening `testMatch` is a jest-config change needing sign-off that would
 * alter how every existing suite executes, so this uses the convention
 * CLAUDE.md prescribes: an `.mjs` subprocess (`tests/support/cross-user-harness.mjs`)
 * driven by `execFileSync`. The harness imports the REAL `dist/` modules and
 * points the REAL supabase-js client at a local PostgREST stub that genuinely
 * filters, so a dropped `.eq()` changes which rows come back exactly as it
 * would in production. KAN-356 §2 step 1 asks for precisely this over a mocked
 * builder — a mocked builder is what concealed KAN-447/448.
 *
 * `tests/mcp-ownership-guard.test.cjs` is deliberately left untouched. It is
 * cheap and catches a different class (a filter deleted outright). This suite
 * is additive, per §2 step 5.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HARNESS = path.join(__dirname, 'support', 'cross-user-harness.mjs');
const DIST_CONVENE = path.join(__dirname, '..', 'dist', 'convene-tools.js');
const DIST_AVAIL = path.join(__dirname, '..', 'dist', 'convene-availability-tool.js');

/** Ids are duplicated from the harness seed so the test can address rows. */
const GATHERING_A = 'a0000000-1111-4111-8111-a00000000001';
const GATHERING_B = 'b0000000-2222-4222-8222-b00000000001';
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';

const WINDOW = {
  window_start_iso: '2026-09-01T08:00:00Z',
  window_end_iso: '2026-09-02T08:00:00Z',
};

/** Invoke one real tool handler as one real user, through the real client. */
function callTool(tool, caller, args) {
  const out = execFileSync('node', [HARNESS, JSON.stringify({ tool, caller, args })], {
    encoding: 'utf8',
    timeout: 60000,
  });
  const line = out.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(line);
}

/** Table names, in order, of the PostgREST reads the handler actually issued. */
function tablesRead(run) {
  return run.observed.requests.map((u) => u.split('?')[0].split('/').pop());
}

describe('KAN-356 leg A — harness preconditions', () => {
  // Assert the subject exists and is genuinely reached BEFORE relying on any
  // isolation result. A harness that silently failed to import its subject
  // would make every "B sees nothing" case below pass for the wrong reason
  // (catalogue failure mode 6) — "B saw nothing" is also what a broken harness
  // returns.
  test('the compiled tool modules exist — run `npx tsc` first', () => {
    expect(fs.existsSync(DIST_CONVENE)).toBe(true);
    expect(fs.existsSync(DIST_AVAIL)).toBe(true);
  });

  test('the harness reaches the REAL handler and the REAL PostgREST query', () => {
    const run = callTool('lyra_list_my_contacts', 'A', {});
    // Pins the query shape the whole boundary depends on: the ownership filter
    // is present in the request the client actually sent, not merely in source.
    const contactsRead = run.observed.requests.find((u) => u.includes('/contacts?'));
    expect(contactsRead).toBeDefined();
    expect(contactsRead).toContain(`owner_user_id=eq.${USER_A}`);
    // And the auth + entitlement gates really ran on the way in.
    expect(tablesRead(run)).toEqual(
      expect.arrayContaining(['api_keys', 'profiles', 'feature_entitlements'])
    );
  });

  test('the two seeded users are genuinely distinct', () => {
    // A fixture where A and B share a seed makes every assertion below
    // unfalsifiable (catalogue failure mode 5).
    const a = callTool('lyra_list_my_contacts', 'A', {});
    const b = callTool('lyra_list_my_contacts', 'B', {});
    expect(USER_A).not.toBe(USER_B);
    expect(a.payload.count).toBeGreaterThan(0);
    expect(b.payload.count).toBeGreaterThan(0);
    expect(a.responseText).not.toBe(b.responseText);
  });

  test('the leak corpus is non-empty', () => {
    // Every "no A-owned string appears" assertion below iterates this list.
    // An empty list would make each of them vacuously true (failure mode 4).
    const run = callTool('lyra_list_my_contacts', 'A', {});
    expect(run.ids.A_ONLY_STRINGS.length).toBeGreaterThanOrEqual(8);
  });
});

describe('KAN-356 criterion 1+2 — lyra_list_my_contacts', () => {
  test('A sees exactly A’s contacts', () => {
    // Positive control: assert the exact seeded count, not merely ">= 0".
    const run = callTool('lyra_list_my_contacts', 'A', {});
    expect(run.payload.count).toBe(2);
    const names = run.payload.contacts.map((c) => c.display_name).sort();
    expect(names).toEqual(['A-CONTACT-ALICE', 'A-CONTACT-AMIR']);
  });

  test('B sees exactly B’s contacts and none of A’s', () => {
    const run = callTool('lyra_list_my_contacts', 'B', {});
    expect(run.payload.count).toBe(1);
    expect(run.payload.contacts.map((c) => c.display_name)).toEqual(['B-CONTACT-BEA']);
    // Assert there IS a response before asserting what is absent from it: an
    // empty string contains nothing, so a broken harness would satisfy every
    // `not.toContain` below (failure mode 3's cousin).
    expect(run.responseText.length).toBeGreaterThan(0);
    for (const secret of run.ids.A_ONLY_STRINGS) {
      expect(run.responseText).not.toContain(secret);
    }
  });

  test('B cannot reach A’s contacts through the search parameter', () => {
    // The realistic attack is a well-formed value belonging to someone else,
    // not a malformed one (§4). Searching for A's contact by name must still
    // return nothing, because the owner filter is applied alongside the search.
    const run = callTool('lyra_list_my_contacts', 'B', { search: 'A-CONTACT' });
    expect(run.payload.count).toBe(0);
    expect(run.payload.contacts).toEqual([]);
  });
});

describe('KAN-356 criterion 1+2 — lyra_get_gathering (parent row)', () => {
  test('A can read A’s own gathering', () => {
    const run = callTool('lyra_get_gathering', 'A', { gathering_id: GATHERING_A });
    expect(run.payload.error).toBeUndefined();
    expect(run.payload.gathering.id).toBe(GATHERING_A);
    expect(run.payload.gathering.title).toBe('A-GATHERING-TITLE');
  });

  test('B is refused A’s gathering by id', () => {
    const run = callTool('lyra_get_gathering', 'B', { gathering_id: GATHERING_A });
    expect(run.payload.error).toBe('Gathering not found or you are not the host');
    expect(run.payload.gathering).toBeUndefined();
  });

  test('the parent read is owner-scoped in the request B actually sent', () => {
    const run = callTool('lyra_get_gathering', 'B', { gathering_id: GATHERING_A });
    const gatheringsRead = run.observed.requests.find((u) => u.includes('/gatherings?'));
    expect(gatheringsRead).toContain(`host_user_id=eq.${USER_B}`);
    expect(gatheringsRead).toContain(`id=eq.${GATHERING_A}`);
  });

  test('B can still read B’s own gathering (the refusal is not blanket)', () => {
    // Without this, "B is refused" would also pass if the tool were simply
    // broken for B — a refusal that proves nothing about isolation.
    const run = callTool('lyra_get_gathering', 'B', { gathering_id: GATHERING_B });
    expect(run.payload.error).toBeUndefined();
    expect(run.payload.gathering.id).toBe(GATHERING_B);
  });
});

describe('KAN-356 criterion 1 — the child tables the static guard cannot verify', () => {
  // gathering_invitees / gathering_proposed_slots / gathering_events_log are
  // all `// ownership-ok:` exemptions in mcp-ownership-guard.test.cjs. This is
  // the single highest-value assertion in the ticket (§2 step 4).

  test('A’s own read returns the seeded child rows — the corpus is real', () => {
    const run = callTool('lyra_get_gathering', 'A', { gathering_id: GATHERING_A });
    expect(run.payload.invitees).toHaveLength(2);
    expect(run.payload.proposed_slots).toHaveLength(1);
    expect(run.payload.events_log).toHaveLength(1);
    expect(tablesRead(run)).toEqual(
      expect.arrayContaining([
        'gathering_invitees',
        'gathering_proposed_slots',
        'gathering_events_log',
      ])
    );
  });

  test('B receives NO child row of A’s gathering', () => {
    const run = callTool('lyra_get_gathering', 'B', { gathering_id: GATHERING_A });
    // Assert there IS a response before asserting what is absent from it: an
    // empty string contains nothing, so a broken harness would satisfy every
    // `not.toContain` below (failure mode 3's cousin).
    expect(run.responseText.length).toBeGreaterThan(0);
    for (const secret of run.ids.A_ONLY_STRINGS) {
      expect(run.responseText).not.toContain(secret);
    }
  });

  test('B’s request never even queries A’s child tables', () => {
    // Stronger than "the response was empty": the owner-scoped parent read
    // must SHORT-CIRCUIT, so no child query is issued at all. This is the
    // assertion that goes red when the early return is removed while every
    // `.eq()` string stays textually intact.
    const run = callTool('lyra_get_gathering', 'B', { gathering_id: GATHERING_A });
    const tables = tablesRead(run);
    expect(tables).not.toContain('gathering_invitees');
    expect(tables).not.toContain('gathering_proposed_slots');
    expect(tables).not.toContain('gathering_events_log');
  });
});

describe('KAN-356 criterion 1+2 — lyra_get_my_calendar_busy_times', () => {
  test('A’s own connection is found (positive control)', () => {
    // The harness vault RPC returns null, so the handler stops here rather than
    // calling Google — offline, but it has provably resolved A's connection.
    const run = callTool('lyra_get_my_calendar_busy_times', 'A', WINDOW);
    expect(run.payload.error).toBe('No refresh token in vault for this connection');
    expect(run.observed.rpcCalls).toContain('convene_vault_read_secret');
  });

  test('B does not inherit A’s calendar connection', () => {
    const run = callTool('lyra_get_my_calendar_busy_times', 'B', WINDOW);
    expect(run.payload.error).toContain('No active Google calendar connection');
    // The decisive half: B must never reach the vault, because B resolved no
    // connection at all. If the owner filter were dropped, B would find A's
    // row and this call would appear.
    expect(run.observed.rpcCalls).toEqual([]);
    // Assert there IS a response before asserting what is absent from it: an
    // empty string contains nothing, so a broken harness would satisfy every
    // `not.toContain` below (failure mode 3's cousin).
    expect(run.responseText.length).toBeGreaterThan(0);
    for (const secret of run.ids.A_ONLY_STRINGS) {
      expect(run.responseText).not.toContain(secret);
    }
  });

  test('the connection lookup is owner-scoped in the request B actually sent', () => {
    const run = callTool('lyra_get_my_calendar_busy_times', 'B', WINDOW);
    const connRead = run.observed.requests.find((u) => u.includes('/oauth_connections?'));
    expect(connRead).toContain(`owner_user_id=eq.${USER_B}`);
  });
});
