/**
 * KAN-354 — `fetchWithTimeout` behaviour, asserted at RUNTIME.
 *
 * WHY THIS FILE EXISTS, given `tests/kan354-mcp-reliability.test.cjs` already
 * "covers" the helper:
 *
 * That suite is a source-text scan. Measured on this branch, mutating
 * `setTimeout(() => controller.abort(), timeoutMs)` to `timeoutMs * 1000` —
 * turning every 8-second bound into 8000 seconds, i.e. unbounded in any real
 * sense — leaves all 14 of its cases GREEN, and the whole 782-test estate
 * green with them. Every token it matches on (`new AbortController()`,
 * `setTimeout(() => controller.abort(`, `clearTimeout(`, `signal:
 * controller.signal`, `timed out after`) survives the mutation untouched.
 *
 * So the one property the ticket is actually about — that an outbound call is
 * BOUNDED — had nothing asserting it. KAN-354 §3 says so in as many words:
 * the anti-drift assertion "must be behavioural (inspect the `init` argument
 * the mock received), not a grep for the string `signal:`".
 *
 * The subject is reached through `tests/support/fetch-timeout-harness.mjs`,
 * an `.mjs` subprocess harness driven by `execFileSync` — the sanctioned route
 * in this repo, because `jest.config.cjs` matches only `*.test.cjs` while the
 * package is `"type": "module"`, so a CommonJS test cannot `require()` the
 * compiled ESM in `dist/`. Widening `testMatch` would need sign-off and would
 * change how all 46 suites execute.
 *
 * The grep suite is NOT replaced or weakened — it is left exactly as it is and
 * still guards the call sites. This file adds the behaviour it cannot see.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const HARNESS = path.join(__dirname, 'support', 'fetch-timeout-harness.mjs');
const DIST = path.join(__dirname, '..', 'dist', 'fetch-timeout.js');

/** Run one scenario through the REAL compiled helper. */
function run(scenario) {
  const out = execFileSync('node', [HARNESS, JSON.stringify(scenario)], {
    encoding: 'utf8',
    timeout: 30000,
  });
  const line = out.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(line);
}

describe('KAN-354 — harness preconditions', () => {
  // Assert the subject is genuinely reachable BEFORE relying on it. A harness
  // that silently failed to import would make every case below pass for the
  // wrong reason (catalogue failure mode 6).
  test('the compiled helper exists — run `npx tsc` first', () => {
    expect(fs.existsSync(DIST)).toBe(true);
  });

  test('the harness reaches the REAL helper and its real constants', () => {
    const r = run({ name: 'success-path-resolves-and-leaks-no-timer', mode: 'reply' });
    expect(r.error).toBeUndefined();
    // Imported from dist/, not restated here: if the module failed to load,
    // these would be undefined rather than numbers.
    expect(r.constants.DEFAULT_FETCH_TIMEOUT_MS).toBe(8000);
    expect(r.constants.DRAIN_FETCH_TIMEOUT_MS).toBe(10000);
  });
});

describe('KAN-354 — a hung upstream is aborted at the configured budget', () => {
  // THIS is the case the grep suite cannot express, and the one that goes red
  // under the ×1000 mutation.
  const r = run({
    name: 'aborts-a-hung-upstream-at-its-budget',
    mode: 'hang',
    budgetMs: 400,
    watchdogMs: 4000,
  });

  test('the call settles rather than hanging — the watchdog did not fire', () => {
    expect(r.call.kind).not.toBe('watchdog-expired');
  });

  test('it rejects (never resolves) when the upstream never responds', () => {
    expect(r.call.kind).toBe('rejected');
  });

  test('the rejection names the timeout, so logs distinguish it from a refusal', () => {
    expect(r.call.message).toMatch(/timed out after 400ms/);
  });

  test('it aborts CLOSE TO the budget, not merely eventually', () => {
    // The assertion that kills the ×1000 mutation: 400ms would become 400s.
    // A generous upper bound keeps this stable on a loaded CI runner while
    // still being four orders of magnitude below the mutated value.
    expect(r.call.elapsedMs).toBeGreaterThanOrEqual(300);
    expect(r.call.elapsedMs).toBeLessThan(3000);
  });
});

describe('KAN-354 — the success path resolves, preserves init, and leaks no timer', () => {
  const r = run({ name: 'success-path-resolves-and-leaks-no-timer', mode: 'reply' });

  test('a responsive upstream resolves normally', () => {
    expect(r.call.kind).toBe('resolved');
    expect(r.call.status).toBe(200);
  });

  test("the caller's init survives — method and headers reach the server", () => {
    // Behavioural version of "a signal is passed": we assert the request the
    // server ACTUALLY received, so spreading `init` incorrectly is visible.
    expect(r.received).toHaveLength(1);
    expect(r.received[0].method).toBe('GET');
    expect(r.received[0].headers['x-harness']).toBe('preserved');
  });

  test('the abort timer is cleared on success — no handle is left pending', () => {
    // Without `clearTimeout` in the finally block, a Timeout handle survives
    // the call and can keep a Railway dyno warm.
    expect(r.timers.after).toBeLessThanOrEqual(r.timers.before);
  });
});

describe('KAN-354 — a non-timeout failure stays distinguishable from a timeout', () => {
  const r = run({ name: 'non-timeout-failure-propagates-unchanged', mode: 'hang' });

  test('a refused connection rejects', () => {
    expect(r.call.kind).toBe('rejected');
  });

  test('it is NOT reported as a timeout', () => {
    // "upstream said no" must not be dressed up as "we gave up" — a caller
    // that cannot tell them apart cannot retry correctly.
    expect(r.call.message).not.toMatch(/timed out after/);
  });

  test('it fails fast rather than burning the budget', () => {
    expect(r.call.elapsedMs).toBeLessThan(3000);
  });
});

describe('KAN-354 — concurrent calls each honour their own budget', () => {
  const r = run({
    name: 'concurrent-calls-honour-their-own-budgets',
    mode: 'hang',
    shortMs: 400,
    longMs: 1500,
    watchdogMs: 5000,
  });

  test('both calls abort rather than hanging', () => {
    expect(r.short.kind).toBe('rejected');
    expect(r.long.kind).toBe('rejected');
  });

  test('the budget is per call, not shared or global', () => {
    // If one controller were reused across calls, both would abort together.
    expect(r.short.message).toMatch(/timed out after 400ms/);
    expect(r.long.message).toMatch(/timed out after 1500ms/);
    expect(r.long.elapsedMs).toBeGreaterThan(r.short.elapsedMs);
  });
});
