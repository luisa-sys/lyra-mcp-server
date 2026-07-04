/**
 * SEC-55 — structural guard for the MCP Sentry PII/secret scrubbing layer.
 *
 * The MCP server is a Node ESM project (`"type": "module"`) and the test runner
 * is plain Jest-on-CJS, so we follow the same static-grep style as the other
 * port guards in this directory (e.g. `moderation-policy.test.cjs`,
 * `mcp-visibility-guard.test.cjs`). The *behavioural* coverage for the scrub
 * logic lives in the web repo at `tests/unit/sentry-scrub.test.ts` — the file
 * here is a behaviour-equivalent port of `lyra/src/lib/sentry-scrub.ts`, so
 * this guard verifies the port is present, complete, and wired into init.
 */

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'src');
const SCRUB_PATH = path.join(SRC_DIR, 'sentry-scrub.ts');
const SENTRY_PATH = path.join(SRC_DIR, 'sentry.ts');

const scrubSrc = fs.readFileSync(SCRUB_PATH, 'utf8');
const sentrySrc = fs.readFileSync(SENTRY_PATH, 'utf8');

// Every OAuth secret / PII field the SEC-55 fix must strip.
const SENSITIVE_KEYS = [
  'code',
  'code_verifier',
  'state',
  'refresh_token',
  'access_token',
  'client_secret',
  'token',
];

describe('SEC-55 — sentry-scrub module', () => {
  test('exists and is ESM-correct (no CommonJS require/module.exports)', () => {
    expect(fs.existsSync(SCRUB_PATH)).toBe(true);
    expect(scrubSrc).not.toMatch(/\bmodule\.exports\b/);
    expect(scrubSrc).not.toMatch(/\brequire\(/);
  });

  test('exports the two Sentry hooks + the URL helper', () => {
    expect(scrubSrc).toMatch(/export function scrubSentryEvent\b/);
    expect(scrubSrc).toMatch(/export function scrubSentryBreadcrumb\b/);
    expect(scrubSrc).toMatch(/export function scrubUrl\b/);
  });

  test('the sensitive-key set covers every enumerated OAuth secret / PII field', () => {
    // Isolate the SENSITIVE_KEYS Set literal so we do not accidentally match
    // the same words appearing in comments elsewhere in the file.
    const match = scrubSrc.match(/const SENSITIVE_KEYS[^=]*=\s*new Set\(\[([\s\S]*?)\]\)/);
    expect(match).not.toBeNull();
    const setBody = match[1];
    for (const key of SENSITIVE_KEYS) {
      expect(setBody).toContain(`'${key}'`);
    }
  });

  test('redacts both oauth path families in full', () => {
    // The path regex must cover /oauth/* and /api/convene/oauth/*.
    expect(scrubSrc).toMatch(/oauth\|api\\\/convene\\\/oauth/);
  });

  test('drops credential-bearing headers wholesale', () => {
    for (const header of ['authorization', 'cookie', 'set-cookie', 'x-api-key']) {
      expect(scrubSrc).toContain(`'${header}'`);
    }
  });

  test('key matching is case-insensitive (guards against Header-Case bypass)', () => {
    expect(scrubSrc).toMatch(/\.toLowerCase\(\)/);
  });
});

describe('SEC-55 — sentry.ts init wiring', () => {
  test('imports the scrub hooks from the port module', () => {
    expect(sentrySrc).toMatch(
      /import\s*\{[^}]*scrubSentryEvent[^}]*scrubSentryBreadcrumb[^}]*\}\s*from\s*'\.\/sentry-scrub\.js'/,
    );
  });

  test('wires beforeSend + beforeBreadcrumb into Sentry.init', () => {
    expect(sentrySrc).toMatch(/beforeSend:\s*\(event\)\s*=>\s*scrubSentryEvent\(event\)/);
    expect(sentrySrc).toMatch(
      /beforeBreadcrumb:\s*\(breadcrumb\)\s*=>\s*scrubSentryBreadcrumb\(breadcrumb\)/,
    );
  });

  test('does not weaken the existing errors-only config', () => {
    // tracesSampleRate:0 and the DSN gate must survive the edit.
    expect(sentrySrc).toMatch(/tracesSampleRate:\s*0/);
    expect(sentrySrc).toMatch(/if \(sentryEnabled\)/);
  });
});
