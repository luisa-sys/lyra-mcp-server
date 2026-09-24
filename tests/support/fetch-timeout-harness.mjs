/**
 * KAN-354 — behavioural harness for the REAL `fetchWithTimeout`.
 *
 * Why a subprocess harness rather than a plain test: `jest.config.cjs` matches
 * only `*.test.cjs` while this package is `"type": "module"`, so a CommonJS
 * test cannot `require()` the compiled ESM in `dist/`. Widening `testMatch`
 * would be a jest-config change (sign-off, and it alters how every suite
 * executes), so the sanctioned route is an `.mjs` harness driven by
 * `execFileSync` — `tests/support/oauth-jwt-harness.mjs` is the precedent.
 *
 * This harness imports the compiled helper and drives it against a REAL local
 * HTTP server, so the assertions are about what the code DOES (does it abort
 * at the budget? does it clear its timer? does it preserve the caller's init?)
 * rather than about what its source text says. That distinction is the whole
 * point: the grep suite alongside this one stays green when the bound is
 * silently multiplied by 1000, because every token it matches on survives.
 *
 * Usage: node fetch-timeout-harness.mjs '<scenario json>'
 * Emits a single JSON line on stdout.
 */

import http from 'node:http';

const scenario = JSON.parse(process.argv[2] ?? '{}');

/**
 * Outer watchdog. If the helper fails to abort at its budget, we must report
 * that as data rather than hang until jest kills us — a harness that hangs is
 * indistinguishable from a broken harness.
 */
const WATCHDOG_MS = scenario.watchdogMs ?? 4000;

const { fetchWithTimeout, DEFAULT_FETCH_TIMEOUT_MS, DRAIN_FETCH_TIMEOUT_MS } =
  await import('../../dist/fetch-timeout.js');

/**
 * Write the result and exit IMMEDIATELY.
 *
 * Deliberately does NOT `await server.close()`: a scenario that hangs the
 * upstream is still holding that socket open, so `close()` never resolves and
 * the harness would hang instead of reporting. That is not hypothetical — an
 * earlier cut of this file awaited the close, and the ×1000 mutation below
 * produced a 30-second `spawnSync ETIMEDOUT` crash rather than a clean red.
 * A red for the wrong reason is a red you learn to distrust.
 */
function emit(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
  process.exit(0);
}

/** Records what the server actually received, so we can prove init survived. */
const received = [];

/**
 * `mode: 'hang'`  — accept the request and never respond.
 * `mode: 'reply'` — respond 200 immediately.
 */
const server = http.createServer((req, res) => {
  received.push({
    method: req.method,
    url: req.url,
    headers: { 'x-harness': req.headers['x-harness'] ?? null },
  });
  if (scenario.mode === 'reply') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  }
  // 'hang': deliberately never call res.end().
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/probe`;

/** Race one call against the watchdog; report which won and how long it took. */
async function timedCall(target, init, budgetMs) {
  const started = Date.now();
  let watchdogTimer;
  const watchdog = new Promise((resolve) => {
    watchdogTimer = setTimeout(() => resolve('__WATCHDOG__'), WATCHDOG_MS);
  });
  try {
    const outcome = await Promise.race([
      fetchWithTimeout(target, init, budgetMs).then(
        (res) => ({ kind: 'resolved', status: res.status }),
        (err) => ({ kind: 'rejected', message: String(err && err.message) })
      ),
      watchdog,
    ]);
    const elapsedMs = Date.now() - started;
    if (outcome === '__WATCHDOG__') {
      // The call did NOT settle within the watchdog. Under a mutated bound this
      // is the expected signal, and it must surface as a fact, not a hang.
      return { kind: 'watchdog-expired', elapsedMs, watchdogMs: WATCHDOG_MS };
    }
    return { ...outcome, elapsedMs };
  } finally {
    clearTimeout(watchdogTimer);
  }
}

const out = { scenario: scenario.name, constants: { DEFAULT_FETCH_TIMEOUT_MS, DRAIN_FETCH_TIMEOUT_MS } };

switch (scenario.name) {
  case 'aborts-a-hung-upstream-at-its-budget': {
    out.call = await timedCall(url, {}, scenario.budgetMs);
    out.budgetMs = scenario.budgetMs;
    break;
  }

  case 'success-path-resolves-and-leaks-no-timer': {
    // Count Timeout handles before and after so a missing clearTimeout is
    // observable. The watchdog's own timer is cleared before we measure.
    const before = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    out.call = await timedCall(url, { method: 'GET', headers: { 'x-harness': 'preserved' } }, 3000);
    // Yield once so any already-cleared timer is reaped before we count.
    await new Promise((r) => setImmediate(r));
    const after = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    out.timers = { before, after };
    out.received = received;
    break;
  }

  case 'non-timeout-failure-propagates-unchanged': {
    // A port with nothing listening → ECONNREFUSED. This must NOT be dressed
    // up as a timeout: "upstream said no" and "we gave up" have to stay
    // distinguishable, or a caller cannot tell a dead provider from a slow one.
    await new Promise((resolve) => server.close(resolve));
    out.call = await timedCall(`http://127.0.0.1:${port}/gone`, {}, 3000);
    emit(out);
    break;
  }

  case 'concurrent-calls-honour-their-own-budgets': {
    const [short, long] = await Promise.all([
      timedCall(url, {}, scenario.shortMs),
      timedCall(url, {}, scenario.longMs),
    ]);
    out.short = { ...short, budgetMs: scenario.shortMs };
    out.long = { ...long, budgetMs: scenario.longMs };
    break;
  }

  default:
    out.error = `unknown scenario: ${scenario.name}`;
}

emit(out);
