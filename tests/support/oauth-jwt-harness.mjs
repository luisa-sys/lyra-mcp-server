/**
 * SEC-46 — behavioural harness for `validateOAuthAccessToken`.
 *
 * WHY A SUBPROCESS HARNESS RATHER THAN A MOCK
 * -------------------------------------------
 * `jest.config.cjs` matches only `**\/tests\/**\/*.test.cjs`, and this package
 * is `"type": "module"` — so a `.cjs` test cannot `require()` the compiled ESM
 * in `dist/`. The header of `tests/oauth-jwt-validator.test.cjs` concluded from
 * that "importing the compiled dist/ from .test.cjs is not viable", and every
 * OAuth test in this repo is therefore a source-text grep.
 *
 * That is exactly the CTL-038 shape: `oauth-jwt-validator.test.cjs` asserts
 * `expect(src).toMatch(/OAUTH_REVOCATION_CHECK/)`, which stays green if the
 * whole revocation block is deleted so long as a comment mentions the name.
 * The fail-open this change fixes (`const { data } = await sb…`, error
 * discarded) lived under that green tick for months.
 *
 * Widening `testMatch` would fix it, but that is a jest-config change — it
 * needs sign-off and alters how all 44 existing suites execute. So this follows
 * the convention CLAUDE.md prescribes instead: an `.mjs` harness driven by
 * `execFileSync` from a `.cjs` test.
 *
 * WHY A REAL HTTP SERVER RATHER THAN A STUBBED CLIENT
 * ---------------------------------------------------
 * `getSupabase()` memoises a module-level client built from `SUPABASE_URL`, so
 * there is no injection seam. Pointing that URL at a local server is not a
 * workaround for the lack of one — it is strictly better evidence: the real
 * supabase-js client issues the real PostgREST request, so the assertion covers
 * the QUERY SHAPE (`select=revoked_at`, `jti=eq.…`) as well as the branch
 * logic. A hand-stubbed `.from().select().eq().maybeSingle()` chain would agree
 * with whatever the code did.
 *
 * Usage:  node oauth-jwt-harness.mjs '<json-scenario>'
 * Prints one line of JSON to stdout: the validator's return value plus what the
 * stub observed. Any other stdout would corrupt the contract, so keep it clean.
 */
import http from 'node:http';
import { SignJWT } from 'jose';

/**
 * ⚠️ WebSocket shim — required to run on Node 20, and it surfaced a real gap.
 *
 * `createClient()` builds a RealtimeClient eagerly, and `@supabase/realtime-js`
 * throws `Node.js detected but native WebSocket not found` unless a WebSocket
 * constructor is global — which Node only provides unflagged from **22**.
 * CI (`test.yml`) pins **node-version: '20'**, so this harness passed locally
 * on Node 22 and failed in CI. It is the first test in this repo to construct a
 * real Supabase client, which is why nothing had surfaced it before.
 *
 * That divergence is a finding in its own right and is NOT fixed here: nothing
 * declares `engines` and nothing pins Railway's runtime, so production runs on
 * whatever Railway defaults to — and if that is ever Node 20, `getSupabase()`
 * throws on the FIRST authenticated tool call. Raised separately; bumping CI to
 * 22 would change the environment all 45 suites execute in and needs sign-off.
 *
 * The stub is never connected to. Realtime is not used by this code path at
 * all — only PostgREST over HTTP — so a constructor that exists and is never
 * invoked is a faithful stand-in, not a behaviour change. Defined only when
 * absent, so on Node 22 the native implementation is still what runs.
 */
if (typeof globalThis.WebSocket === 'undefined') {
  globalThis.WebSocket = class NeverConnectedWebSocket {
    constructor() {
      throw new Error(
        'oauth-jwt-harness: realtime WebSocket was actually opened — this code path should only speak PostgREST over HTTP'
      );
    }
  };
}

const scenario = JSON.parse(process.argv[2] ?? '{}');

const SECRET = '0'.repeat(32);
const JTI = scenario.jti ?? 'jti-harness-1';

/** What the stub PostgREST saw — asserted by the caller. */
const observed = { tokenQueries: 0, lastPath: null };

const server = http.createServer((req, res) => {
  const url = req.url ?? '';

  // The RS256 path is tried first and must fail so the HS256 fallback runs.
  // An empty key set makes jose give up immediately rather than hang.
  if (url.includes('jwks')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ keys: [] }));
    return;
  }

  if (url.includes('oauth_access_tokens')) {
    observed.tokenQueries += 1;
    observed.lastPath = url;

    if (scenario.dbError) {
      // PostgREST error → supabase-js populates `error`. The pre-SEC-46 code
      // discarded this and read the null data as "not revoked".
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'simulated database failure', code: 'XX000' }));
      return;
    }

    // `.maybeSingle()` sends Accept: application/vnd.pgrst.object+json and
    // tolerates an empty result, so an empty array models "unknown jti".
    const rows = scenario.unknownJti
      ? []
      : [{ revoked_at: scenario.revoked ? '2026-08-14T00:00:00Z' : null }];
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}`,
    });
    res.end(JSON.stringify(scenario.unknownJti ? null : rows[0]));
    return;
  }

  res.writeHead(404).end('{}');
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;

process.env.SUPABASE_URL = base;
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-harness';
process.env.LYRA_SITE_URL = base;
process.env.OAUTH_JWT_SIGNING_SECRET = SECRET;
process.env.OAUTH_JWKS_URI = `${base}/.well-known/jwks.json`;
if (scenario.mcpResourceUrl) process.env.MCP_RESOURCE_URL = scenario.mcpResourceUrl;
if (scenario.revocationCheck !== undefined) {
  process.env.OAUTH_REVOCATION_CHECK = scenario.revocationCheck;
} else {
  delete process.env.OAUTH_REVOCATION_CHECK; // the DEFAULT is what we assert
}
if (scenario.audienceCheck !== undefined) {
  process.env.OAUTH_AUDIENCE_CHECK = scenario.audienceCheck;
} else {
  delete process.env.OAUTH_AUDIENCE_CHECK;
}

// Capture the observe-mode warning without letting it reach stdout.
const warnings = [];
console.warn = (...a) => warnings.push(a.join(' '));
const errors = [];
console.error = (...a) => errors.push(a.join(' '));

// Imported AFTER the env is set — the module reads it at call time, but the
// supabase client memoises on first use, so ordering is load-bearing.
const { validateOAuthAccessToken } = await import('../../dist/oauth-jwt.js');

const token = await new SignJWT({
  scope: scenario.scope ?? 'lyra:full',
  client_id: 'lyra_oauth_test',
})
  .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
  .setIssuer(base)
  .setSubject('user-uuid-harness')
  .setAudience(scenario.aud ?? 'lyra_oauth_test')
  .setJti(JTI)
  .setIssuedAt()
  .setExpirationTime('1h')
  .sign(new TextEncoder().encode(SECRET));

const result = await validateOAuthAccessToken(token);

process.stdout.write(JSON.stringify({ result, observed, warnings, errors }) + '\n');
server.close();
