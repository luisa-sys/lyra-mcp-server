/**
 * KAN-356 leg A — runtime cross-user isolation harness for the Convene MCP tools.
 *
 * WHY THIS EXISTS
 * ---------------
 * The MCP server runs on `SUPABASE_SERVICE_ROLE_KEY`, which BYPASSES RLS. The
 * `.eq()` chained in application code therefore *is* the whole tenancy
 * boundary — there is no database-level backstop behind it.
 *
 * The only control on that boundary today is `tests/mcp-ownership-guard.test.cjs`,
 * a source-text scan. It proves a filter STRING is present near a `.from()`.
 * It cannot prove the VALUE bound to that string belongs to the caller, and its
 * own header concedes as much: every child-table read (`gathering_invitees`,
 * `gathering_proposed_slots`, `gathering_events_log`, …) is waved through on an
 * `// ownership-ok:` comment — i.e. on a human's word.
 *
 * `lyra_get_gathering` is the worked example of that blind spot. Its child
 * reads are keyed on the caller-supplied `gathering_id` and nothing else; what
 * actually protects them is the early `return` when the owner-scoped parent
 * read finds no row. Delete that one `return` and every `.eq()` string in the
 * file is still there — the static guard stays green — while user B receives
 * user A's invitee list. This harness turns that attestation into an
 * observation.
 *
 * WHY A SUBPROCESS HARNESS
 * ------------------------
 * `jest.config.cjs` matches only `**\/tests\/**\/*.test.cjs` and this package is
 * `"type": "module"`, so a `.cjs` test cannot `require()` the compiled ESM in
 * `dist/`. Widening `testMatch` is a jest-config change: it needs sign-off and
 * alters how every existing suite executes. So this follows the convention
 * CLAUDE.md prescribes and `tests/support/oauth-jwt-harness.mjs` established —
 * an `.mjs` subprocess driven by `execFileSync` from a `.cjs` test.
 *
 * WHY A REAL HTTP STUB RATHER THAN A MOCKED SUPABASE BUILDER
 * ----------------------------------------------------------
 * KAN-356 §2 step 1 is explicit: "prefer a seeded harness over hand-written
 * mocks — a mock of the Supabase builder is exactly what concealed KAN-447/448",
 * where owner-scoping assertions were satisfied by an unrelated pre-read and
 * deleting either filter left the suite 27/27 green.
 *
 * So the stub below speaks real PostgREST over HTTP and FILTERS FOR REAL: it
 * parses `col=eq.v`, `col=is.null`, `col=ilike.*x*`, `col=in.(…)` off the query
 * string and applies them to seeded rows. `getSupabase()` memoises a client
 * built from `SUPABASE_URL`, so pointing that at this server is not a
 * workaround for a missing injection seam — it is strictly better evidence.
 * The real supabase-js client issues the real request, so a dropped `.eq()`
 * genuinely changes which rows come back, exactly as it would in production.
 * A hand-stubbed `.from().select().eq()` chain would agree with whatever the
 * code happened to do.
 *
 * Usage:  node cross-user-harness.mjs '<json-scenario>'
 *   { "tool": "lyra_get_gathering", "caller": "B", "args": { … } }
 * Prints ONE line of JSON to stdout — the tool's parsed payload plus what the
 * stub observed. Any other stdout corrupts that contract, so console.* is
 * captured below rather than left to print.
 */
import http from 'node:http';
import { createHash } from 'node:crypto';

/**
 * ⚠️ WebSocket shim — see the same note in `oauth-jwt-harness.mjs`.
 * `createClient()` builds a RealtimeClient eagerly and `@supabase/realtime-js`
 * throws on Node 20 (CI pins node 20) unless a WebSocket constructor is global.
 * Realtime is never used on these code paths — only PostgREST over HTTP — so a
 * constructor that exists and is never invoked is a faithful stand-in. Defined
 * only when absent, so Node 22 still runs the native implementation.
 */
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = class NeverConnectedWebSocket {
    constructor() {
      throw new Error(
        'cross-user-harness: a realtime WebSocket was actually opened — these code paths should only speak PostgREST over HTTP'
      );
    }
  };
}

const scenario = JSON.parse(process.argv[2] ?? '{}');

// ── Seed ────────────────────────────────────────────────────────────────────
// Two users with GENUINELY DISTINCT ids and rows. A fixture where A and B share
// a seed makes every isolation assertion unfalsifiable (catalogue failure mode
// 5), so nothing below is shared between them except the venue, which is not
// user-owned.
const USER_A = '11111111-1111-4111-8111-111111111111';
const USER_B = '22222222-2222-4222-8222-222222222222';
const PROFILE_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const PROFILE_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const GATHERING_A = 'a0000000-1111-4111-8111-a00000000001';
const GATHERING_B = 'b0000000-2222-4222-8222-b00000000001';
const CONTACT_A1 = 'a0000000-1111-4111-8111-c00000000001';
const CONTACT_A2 = 'a0000000-1111-4111-8111-c00000000002';
const CONTACT_B1 = 'b0000000-2222-4222-8222-c00000000001';
const VENUE = 'e0000000-0000-4000-8000-000000000001';

const KEY_A = 'lyra_key_for_user_a';
const KEY_B = 'lyra_key_for_user_b';
const sha = (s) => createHash('sha256').update(s).digest('hex');

/**
 * Every string that belongs to A and must never be seen by B. The test asserts
 * against this list rather than against a hand-picked field, so a leak through
 * any column of any covered table shows up.
 */
const A_ONLY_STRINGS = [
  'A-CONTACT-ALICE',
  'A-CONTACT-AMIR',
  'A-GATHERING-TITLE',
  'A-INVITEE-NOTE-ONE',
  'A-INVITEE-NOTE-TWO',
  'A-SLOT-BREAKDOWN',
  'A-EVENT-METADATA',
  'A-CALENDAR-CONNECTION',
];

const seed = {
  api_keys: [
    { id: 'k-a', user_id: USER_A, key_hash: sha(KEY_A), revoked_at: null },
    { id: 'k-b', user_id: USER_B, key_hash: sha(KEY_B), revoked_at: null },
  ],
  profiles: [
    {
      id: PROFILE_A,
      user_id: USER_A,
      slug: 'user-a',
      age_status: 'self_declared_18_plus',
      user_status: 'live',
      access_tier: 'beta',
      is_suspended: false,
    },
    {
      id: PROFILE_B,
      user_id: USER_B,
      slug: 'user-b',
      age_status: 'self_declared_18_plus',
      user_status: 'live',
      access_tier: 'beta',
      is_suspended: false,
    },
  ],
  // `mcp` and `convene` are TEST features (feature-registry.ts), so they default
  // OFF and need an explicit row. Both users get both — otherwise B would be
  // refused by the entitlement gate and the isolation assertion would pass for
  // the wrong reason (failure mode 6).
  feature_entitlements: [
    { profile_id: PROFILE_A, feature_key: 'mcp', enabled: true },
    { profile_id: PROFILE_A, feature_key: 'convene', enabled: true },
    { profile_id: PROFILE_B, feature_key: 'mcp', enabled: true },
    { profile_id: PROFILE_B, feature_key: 'convene', enabled: true },
  ],
  contacts: [
    {
      id: CONTACT_A1,
      owner_user_id: USER_A,
      display_name: 'A-CONTACT-ALICE',
      city: 'Bath',
      country: 'GB',
      linked_profile_id: null,
      source: 'manual',
      created_at: '2026-01-01T00:00:00Z',
      deleted_at: null,
    },
    {
      id: CONTACT_A2,
      owner_user_id: USER_A,
      display_name: 'A-CONTACT-AMIR',
      city: 'Leeds',
      country: 'GB',
      linked_profile_id: null,
      source: 'manual',
      created_at: '2026-01-02T00:00:00Z',
      deleted_at: null,
    },
    {
      id: CONTACT_B1,
      owner_user_id: USER_B,
      display_name: 'B-CONTACT-BEA',
      city: 'Hull',
      country: 'GB',
      linked_profile_id: null,
      source: 'manual',
      created_at: '2026-01-03T00:00:00Z',
      deleted_at: null,
    },
  ],
  gatherings: [
    {
      id: GATHERING_A,
      host_user_id: USER_A,
      title: 'A-GATHERING-TITLE',
      gathering_type: 'dinner',
      status: 'live',
      venue_id: VENUE,
      finalised_slot_start: null,
      finalised_slot_end: null,
      capacity_min: 2,
      capacity_max: 6,
      created_at: '2026-02-01T00:00:00Z',
      deleted_at: null,
    },
    {
      id: GATHERING_B,
      host_user_id: USER_B,
      title: 'B-GATHERING-TITLE',
      gathering_type: 'walk',
      status: 'draft',
      venue_id: null,
      finalised_slot_start: null,
      finalised_slot_end: null,
      capacity_min: 2,
      capacity_max: 4,
      created_at: '2026-02-02T00:00:00Z',
      deleted_at: null,
    },
  ],
  // ── The child tables the static guard explicitly cannot verify. Every row
  // here belongs to A's gathering; B owns none of them.
  gathering_invitees: [
    {
      id: 'i-a-1',
      gathering_id: GATHERING_A,
      contact_id: CONTACT_A1,
      status: 'accepted',
      dietary_overrides: null,
      plus_ones: 0,
      notes: 'A-INVITEE-NOTE-ONE',
      invited_at: '2026-02-03T00:00:00Z',
      responded_at: null,
    },
    {
      id: 'i-a-2',
      gathering_id: GATHERING_A,
      contact_id: CONTACT_A2,
      status: 'pending',
      dietary_overrides: null,
      plus_ones: 1,
      notes: 'A-INVITEE-NOTE-TWO',
      invited_at: '2026-02-03T00:00:00Z',
      responded_at: null,
    },
  ],
  gathering_proposed_slots: [
    {
      id: 's-a-1',
      gathering_id: GATHERING_A,
      slot_start: '2026-03-01T18:00:00Z',
      slot_end: '2026-03-01T21:00:00Z',
      score: 9,
      availability_breakdown: 'A-SLOT-BREAKDOWN',
    },
  ],
  gathering_events_log: [
    {
      id: 'e-a-1',
      gathering_id: GATHERING_A,
      event_type: 'gathering_created',
      subject_kind: 'gathering',
      subject_id: GATHERING_A,
      metadata: 'A-EVENT-METADATA',
      created_at: '2026-02-01T00:00:01Z',
      actor_user_id: USER_A,
    },
  ],
  venues: [
    {
      id: VENUE,
      name: 'The Shared Venue',
      venue_type: 'restaurant',
      city: 'Bath',
      postcode: 'BA1 1AA',
      country: 'GB',
      lat: 51.38,
      lng: -2.36,
      price_tier: 2,
    },
  ],
  // A has a connected Google calendar; B has none. That asymmetry is what makes
  // the availability assertion falsifiable.
  oauth_connections: [
    {
      id: 'conn-a-1',
      owner_user_id: USER_A,
      provider: 'google',
      status: 'active',
      refresh_token_secret_id: 'secret-a-1',
      display_name: 'A-CALENDAR-CONNECTION',
      created_at: '2026-01-10T00:00:00Z',
      deleted_at: null,
      last_used_at: null,
    },
  ],
};

// ── Stub PostgREST ──────────────────────────────────────────────────────────
/** Every request the code actually issued, so the test can assert on shape. */
const observed = { requests: [], rpcCalls: [], writes: [] };

/** PostgREST reserved query params that are not row filters. */
const NON_FILTER = new Set(['select', 'order', 'limit', 'offset', 'on_conflict', 'columns']);

/** Decode one `col=<op>.<value>` filter and test it against a row. */
function rowMatches(row, col, spec) {
  const dot = spec.indexOf('.');
  const op = dot === -1 ? 'eq' : spec.slice(0, dot);
  const raw = dot === -1 ? spec : spec.slice(dot + 1);
  const actual = row[col];
  switch (op) {
    case 'eq':
      return String(actual) === raw;
    case 'neq':
      return String(actual) !== raw;
    case 'is':
      if (raw === 'null') return actual === null || actual === undefined;
      if (raw === 'true') return actual === true;
      if (raw === 'false') return actual === false;
      return false;
    case 'in': {
      const list = raw
        .replace(/^\(/, '')
        .replace(/\)$/, '')
        .split(',')
        .map((s) => s.replace(/^"|"$/g, ''));
      return list.includes(String(actual));
    }
    case 'ilike': {
      const pattern = raw.replace(/^\*|\*$/g, '').replace(/%/g, '');
      return typeof actual === 'string' && actual.toLowerCase().includes(pattern.toLowerCase());
    }
    case 'gte':
      return String(actual) >= raw;
    case 'lte':
      return String(actual) <= raw;
    default:
      // An unimplemented operator must NOT silently widen the result set —
      // that would make an isolation assertion pass because the filter was
      // ignored rather than because the code applied it.
      throw new Error(`cross-user-harness: unimplemented PostgREST operator "${op}" on ${col}`);
  }
}

const server = http.createServer((req, res) => {
  const url = req.url ?? '';
  const [pathPart, queryPart] = url.split('?');
  const table = decodeURIComponent(pathPart.replace(/^\/rest\/v1\//, '').replace(/^\//, ''));
  const params = new URLSearchParams(queryPart ?? '');
  const method = req.method ?? 'GET';

  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  if (table.startsWith('rpc/')) {
    const fn = table.slice(4);
    observed.rpcCalls.push(fn);
    // Deliberately returns null: the availability tool then stops with "no
    // refresh token in vault" BEFORE any outbound Google call. That keeps the
    // suite offline while still proving the connection lookup succeeded.
    send(200, null);
    return;
  }

  if (method !== 'GET') {
    // Fire-and-forget writes (api_keys.last_used_at, oauth_connections.last_used_at).
    observed.writes.push(`${method} ${table}`);
    send(200, []);
    return;
  }

  observed.requests.push(url);

  let rows = (seed[table] ?? []).slice();
  for (const [col, spec] of params.entries()) {
    if (NON_FILTER.has(col)) continue;
    rows = rows.filter((r) => rowMatches(r, col, spec));
  }

  const order = params.get('order');
  if (order) {
    const [col, dir] = order.split('.');
    rows.sort((x, y) => (String(x[col]) < String(y[col]) ? -1 : 1));
    if (dir === 'desc') rows.reverse();
  }
  const limit = params.get('limit');
  if (limit) rows = rows.slice(0, Number(limit));

  // `.single()` / `.maybeSingle()` send this Accept header; PostgREST answers a
  // non-singleton result with 406 + PGRST116, which supabase-js turns into an
  // error for single() and into a null row for maybeSingle().
  const wantsObject = (req.headers.accept ?? '').includes('vnd.pgrst.object+json');
  if (wantsObject) {
    if (rows.length === 1) return send(200, rows[0]);
    return send(406, {
      code: 'PGRST116',
      details: `The result contains ${rows.length} rows`,
      hint: null,
      message: 'JSON object requested, multiple (or no) rows returned',
    });
  }
  res.writeHead(200, {
    'content-type': 'application/json',
    'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}`,
  });
  res.end(JSON.stringify(rows));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

process.env.SUPABASE_URL = base;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-harness';
process.env.LYRA_SITE_URL = base;

// console.* must not reach stdout — the caller parses stdout as one JSON line.
const logs = [];
console.error = (...a) => logs.push(a.join(' '));
console.warn = (...a) => logs.push(a.join(' '));
console.log = (...a) => logs.push(a.join(' '));

// Imported AFTER the env is set: the supabase client memoises on first use, so
// ordering is load-bearing.
const { registerConveneTools } = await import('../../dist/convene-tools.js');
const { registerConveneAvailabilityTools } = await import('../../dist/convene-availability-tool.js');

/** Minimal stand-in for McpServer that captures the REAL handlers. */
const handlers = new Map();
const captureServer = {
  registerTool(name, _def, handler) {
    handlers.set(name, handler);
  },
};
registerConveneTools(captureServer);
registerConveneAvailabilityTools(captureServer);

const apiKey = scenario.caller === 'A' ? KEY_A : KEY_B;
const handler = handlers.get(scenario.tool);
if (!handler) {
  process.stdout.write(
    JSON.stringify({
      error: `cross-user-harness: tool "${scenario.tool}" was never registered`,
      registered: [...handlers.keys()],
    }) + '\n'
  );
  server.close();
  process.exit(1);
}

const raw = await handler({ api_key: apiKey, ...(scenario.args ?? {}) });
const text = raw?.content?.[0]?.text ?? '';
let payload;
try {
  payload = JSON.parse(text);
} catch {
  payload = { _unparsed: text };
}

process.stdout.write(
  JSON.stringify({
    payload,
    // The raw response text, so the test can assert no A-owned string appears
    // ANYWHERE in what B received — not just in the field it thought to check.
    responseText: text,
    observed,
    logs,
    ids: {
      USER_A,
      USER_B,
      GATHERING_A,
      GATHERING_B,
      CONTACT_A1,
      A_ONLY_STRINGS,
    },
  }) + '\n'
);
server.close();
