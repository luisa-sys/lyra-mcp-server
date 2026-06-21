/**
 * SEC-4 — MCP server error tracking (Sentry) wiring.
 *
 * Structural guards (this repo tests TS source by grep). Assert the
 * security/ops-relevant shape: Sentry is initialised ONLY when SENTRY_DSN is
 * present (inert by default), tracing is off (errors only), and index.ts wires
 * the Express error handler when enabled.
 */
const fs = require('fs');
const path = require('path');

const SRC_SENTRY = fs.readFileSync(path.join(__dirname, '..', 'src', 'sentry.ts'), 'utf8');
const SRC_INDEX = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');

describe('SEC-4 MCP Sentry error tracking', () => {
  test('sentry.ts initialises Sentry only when SENTRY_DSN is set', () => {
    expect(SRC_SENTRY).toMatch(/process\.env\.SENTRY_DSN/);
    expect(SRC_SENTRY).toMatch(/Sentry\.init\(/);
    expect(SRC_SENTRY).toMatch(/export const sentryEnabled = Boolean\(dsn\)/);
  });

  test('sentry.ts keeps tracing off (errors only, no hot-path overhead)', () => {
    expect(SRC_SENTRY).toMatch(/tracesSampleRate:\s*0/);
  });

  test('index.ts imports the gated init and wires the express error handler', () => {
    expect(SRC_INDEX).toMatch(/from '\.\/sentry\.js'/);
    expect(SRC_INDEX).toMatch(/sentryEnabled/);
    expect(SRC_INDEX).toMatch(/setupExpressErrorHandler\(app\)/);
  });
});
