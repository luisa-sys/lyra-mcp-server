/**
 * SEC-46 Phase A/B — revocation is default-ON and fails CLOSED; audience is
 * observed before it is enforced.
 *
 * ⚠️ THIS IS THE FIRST BEHAVIOURAL TEST OF `validateOAuthAccessToken` IN THIS
 * REPO, and that gap is the finding, not an aside.
 *
 * Every other OAuth suite here is a source-text grep, because `jest.config.cjs`
 * matches only `*.test.cjs` while the package is `"type": "module"`, so a `.cjs`
 * test cannot `require()` the compiled ESM. `oauth-jwt-validator.test.cjs`
 * accordingly asserts `expect(src).toMatch(/OAUTH_REVOCATION_CHECK/)` — which
 * stays green if the entire revocation block is deleted, provided a comment
 * still mentions the name. That is CTL-038/CTL-039 exactly, and it is the tick
 * under which a real fail-open lived: the old code destructured
 * `const { data } = await sb…`, threw the error away, and read a failed lookup
 * as "not revoked".
 *
 * The subject is reached through `tests/support/oauth-jwt-harness.mjs` — an
 * `.mjs` subprocess that imports the real `dist/oauth-jwt.js` and points the
 * real supabase-js client at a local HTTP stub. So these assertions cover the
 * actual PostgREST request, not a hand-rolled `.from().select().eq()` chain
 * that would agree with whatever the code happened to do.
 *
 * The existing grep in `oauth-jwt-validator.test.cjs` is deliberately left
 * alone (Test Integrity Policy — it is an existing assertion). It is now
 * redundant rather than load-bearing.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HARNESS = path.join(__dirname, 'support', 'oauth-jwt-harness.mjs');
const DIST = path.join(__dirname, '..', 'dist', 'oauth-jwt.js');

/** Run one scenario through the real validator. */
function validate(scenario) {
  const out = execFileSync('node', [HARNESS, JSON.stringify(scenario)], {
    encoding: 'utf8',
    timeout: 30000,
  });
  const line = out.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(line);
}

describe('SEC-46 — harness preconditions', () => {
  // Assert the corpus/subject exists BEFORE relying on it. A harness that
  // silently fails to import its subject would make every case below pass for
  // the wrong reason (catalogue failure mode 6).
  test('the compiled validator exists — run `npx tsc` first', () => {
    expect(fs.existsSync(DIST)).toBe(true);
  });

  test('the harness reaches the REAL validator and the REAL PostgREST query', () => {
    const { result, observed } = validate({});
    expect(result.ok).toBe(true);
    // Proves the lookup went through supabase-js to a real HTTP request, and
    // pins the query shape the fix depends on.
    expect(observed.lastPath).toContain('oauth_access_tokens');
    expect(observed.lastPath).toContain('select=revoked_at');
    expect(observed.lastPath).toContain('jti=eq.jti-harness-1');
  });
});

describe('SEC-46 Phase A — revocation is ON by default', () => {
  test('with OAUTH_REVOCATION_CHECK UNSET, the lookup still runs', () => {
    // The whole defect: the flag was `=== '1'` and set on no service, so this
    // query never happened anywhere and `revoked_at` was write-only.
    const { observed } = validate({});
    expect(observed.tokenQueries).toBe(1);
  });

  test('a revoked token is rejected with UNSET flag', () => {
    const { result } = validate({ revoked: true });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('revoked');
  });

  test('an active token still validates', () => {
    const { result } = validate({ revoked: false });
    expect(result.ok).toBe(true);
    expect(result.userId).toBe('user-uuid-harness');
  });

  test("OAUTH_REVOCATION_CHECK='0' is a kill-switch — no lookup is issued", () => {
    // Must remain available: this check adds a database read to the hot path
    // and fails closed, so an incident needs a way to shed that dependency
    // without a deploy.
    const { result, observed } = validate({ revoked: true, revocationCheck: '0' });
    expect(observed.tokenQueries).toBe(0);
    expect(result.ok).toBe(true);
  });
});

describe('SEC-46 Phase A — the lookup FAILS CLOSED', () => {
  test('a database error rejects the token rather than allowing it', () => {
    // The regression that matters. Before the fix the error was discarded, so
    // a Supabase blip returned data=null and was read as "not revoked" — the
    // containment control silently inverting exactly when it was needed.
    const { result } = validate({ dbError: true });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('revoked');
    expect(result.detail).toMatch(/unavailable/i);
  });

  test('a database error is LOGGED, not swallowed', () => {
    const { errors } = validate({ dbError: true });
    expect(errors.join(' ')).toMatch(/revocation lookup failed/i);
  });

  test('an unknown jti is refused, not treated as valid', () => {
    // Issuance writes the registry row in the same request that signs the
    // token, and nothing purges the table, so a missing row means the token
    // was not minted by this system.
    const { result } = validate({ unknownJti: true });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('revoked');
    expect(result.detail).toMatch(/registry/i);
  });
});

describe('SEC-46 Phase B — audience is observed, then enforced', () => {
  test('OBSERVE mode: a legacy aud=client_id token still passes, but warns', () => {
    // Non-negotiable for rollout: the AS currently mints aud=client_id, so
    // enforcing today would 401 every existing connector.
    const { result, warnings } = validate({});
    expect(result.ok).toBe(true);
    expect(warnings.join(' ')).toMatch(/audience mismatch/i);
    expect(warnings.join(' ')).toMatch(/observe-only/i);
  });

  test('ENFORCE mode: a legacy aud=client_id token is rejected', () => {
    const { result } = validate({ audienceCheck: '1' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_audience');
  });

  test('ENFORCE mode: the canonical resource URI is accepted', () => {
    const { result } = validate({
      audienceCheck: '1',
      aud: 'https://mcp.checklyra.com/mcp',
    });
    expect(result.ok).toBe(true);
  });

  test('ENFORCE mode: the bare-origin and trailing-slash variants are accepted', () => {
    expect(validate({ audienceCheck: '1', aud: 'https://mcp.checklyra.com' }).result.ok).toBe(true);
    expect(validate({ audienceCheck: '1', aud: 'https://mcp.checklyra.com/mcp/' }).result.ok).toBe(
      true
    );
  });

  test('ENFORCE mode: a token for the ADMIN resource is rejected by the user MCP', () => {
    // This is the SEC-46/SEC-48 headline. Both resource servers verify against
    // the same JWKS with issuer only, so today one token is accepted by both
    // and `is_admin` plus the Cloudflare Access edge are the only things
    // between a consumer token and the admin tool surface.
    const { result } = validate({
      audienceCheck: '1',
      aud: 'https://admin-mcp.checklyra.com/mcp',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_audience');
  });

  test('ENFORCE mode: audience is matched EXACTLY, not by prefix', () => {
    // `https://mcp.checklyra.com/mcp.evil.test` must not satisfy a prefix test.
    const { result } = validate({
      audienceCheck: '1',
      aud: 'https://mcp.checklyra.com/mcp.evil.test',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid_audience');
  });

  test('audience is checked BEFORE the revocation round trip', () => {
    // Ordering is a real property, not cosmetics: an unbound token should be
    // refused without spending a database read, so a flood of wrong-audience
    // tokens cannot amplify into Supabase load.
    const { observed } = validate({ audienceCheck: '1' });
    expect(observed.tokenQueries).toBe(0);
  });
});
