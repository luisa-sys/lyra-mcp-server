/**
 * KAN-354 — MCP reliability & consistency (findings mcp-quality-2, mcp-quality-5).
 *
 * Two legs are covered here:
 *
 *  1. fetchWithTimeout() (mcp-quality-2): every outbound provider/HTTP call must
 *     be bounded by an AbortController so an upstream hang can't block an MCP
 *     request indefinitely. A runtime block proves the helper aborts; static
 *     guards prove each known call site routes through it and that no bare
 *     `await fetch(` survives in the provider files.
 *
 *  2. lyra_get_onboarding_coaching (mcp-quality-5): the tool is classified
 *     PUBLIC (auth-registry + /.well-known/mcp.json) and returns only static
 *     guidance, so its handler must NOT hard-require an API key.
 *
 * (The mcp-quality-3 leg — collapsing the duplicated errorResponse/okResponse/
 * clientError helpers into one module — is intentionally deferred to avoid
 * colliding with the in-flight SEC-61 shared-error module; see the KAN-354
 * Jira comment and PR description.)
 *
 * Style matches the rest of the suite: file-content guards (the suite does not
 * boot the server, and the compiled output is ESM so it can't be require()'d
 * from these CommonJS tests). The helper's behaviour is locked structurally:
 * AbortController + timed abort + a clear, timeout-named rethrow.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

// ── Leg 1: the timeout helper is correctly shaped ──────────────────────────
describe('KAN-354: fetchWithTimeout bounds every request via AbortController', () => {
  const helper = read('src/fetch-timeout.ts');

  test('exports fetchWithTimeout and the timeout constants', () => {
    expect(helper).toMatch(/export async function fetchWithTimeout/);
    expect(helper).toMatch(/export const DEFAULT_FETCH_TIMEOUT_MS/);
    expect(helper).toMatch(/export const DRAIN_FETCH_TIMEOUT_MS/);
  });

  test('creates an AbortController and aborts it on a timer', () => {
    expect(helper).toMatch(/new AbortController\(\)/);
    expect(helper).toMatch(/setTimeout\(\(\) => controller\.abort\(\)/);
    // The timer must always be cleared so a fast success doesn't leak a handle.
    expect(helper).toMatch(/clearTimeout\(/);
  });

  test('passes the abort signal into fetch and rethrows a clear timeout error', () => {
    expect(helper).toMatch(/signal: controller\.signal/);
    expect(helper).toMatch(/controller\.signal\.aborted/);
    expect(helper).toMatch(/timed out after/);
  });
});

// ── Leg 1: static guards — every unbounded outbound call now routes here ────
describe('KAN-354: all unbounded outbound fetches route through fetchWithTimeout', () => {
  // index.ts:555 already had its own AbortController(5s) bound (pinned by the
  // KAN-201 test) and is deliberately left as-is; these are the four calls the
  // ticket flagged as unbounded.
  const providerFiles = [
    'src/convene-availability-tool.ts',
    'src/convene-places-adapter.ts',
    'src/convene-drain-tool.ts',
  ];

  test.each(providerFiles)('%s imports fetchWithTimeout', (file) => {
    expect(read(file)).toMatch(/from '\.\/fetch-timeout\.js'/);
  });

  test.each(providerFiles)('%s has no bare `await fetch(` left', (file) => {
    // The only legitimate raw fetch() in the codebase lives inside the helper.
    expect(read(file)).not.toMatch(/await fetch\(/);
  });

  test('availability tool bounds both the token refresh and freeBusy calls', () => {
    const src = read('src/convene-availability-tool.ts');
    expect(src).toMatch(/fetchWithTimeout\('https:\/\/oauth2\.googleapis\.com\/token'/);
    expect(src).toMatch(/fetchWithTimeout\('https:\/\/www\.googleapis\.com\/calendar\/v3\/freeBusy'/);
  });

  test('drain tool uses the larger drain timeout constant', () => {
    expect(read('src/convene-drain-tool.ts')).toMatch(/DRAIN_FETCH_TIMEOUT_MS/);
  });
});

// ── Leg 2: onboarding-coaching is genuinely public ─────────────────────────
describe('KAN-354: lyra_get_onboarding_coaching responds without auth', () => {
  const writeSrc = read('src/write-tools.ts');
  const registry = read('src/auth-registry.ts');
  const indexSrc = read('src/index.ts');

  test('classification stays PUBLIC in the registry and well-known listing', () => {
    expect(registry).toMatch(/'lyra_get_onboarding_coaching'/);
    expect(indexSrc).toMatch(/'lyra_get_onboarding_coaching'/);
  });

  test('handler no longer gates on authAndProfile', () => {
    // Isolate the onboarding tool registration block and assert it does not
    // authenticate. The block runs from its registerTool line to the end of
    // registerWriteTools.
    const start = writeSrc.indexOf("'lyra_get_onboarding_coaching'");
    expect(start).toBeGreaterThan(-1);
    const block = writeSrc.slice(start, start + 3600);
    expect(block).not.toMatch(/authAndProfile/);
  });

  test('handler still returns the static coaching guidance', () => {
    const start = writeSrc.indexOf("'lyra_get_onboarding_coaching'");
    const block = writeSrc.slice(start, start + 3600);
    expect(block).toMatch(/const coaching = \{/);
    expect(block).toMatch(/okResponse\(coaching\)/);
  });
});
