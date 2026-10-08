/**
 * SEC-61 (F-15 completion) — no raw DB/PostgREST error leakage to MCP clients,
 * enforced across ALL Convene tool files (+ write-tools.ts), not just the two
 * files the original sec17-error-leak guard covered.
 *
 * A raw `errorResponse(<dbError>.message)` returns the database's own message to
 * the caller, which can leak column/constraint names, SQL fragments, Vault-RPC
 * internals and other schema detail. Every DB-error path must instead route
 * through `clientError()` (shared `src/convene-errors.ts`, or the test-pinned
 * local copies in write-tools.ts / convene-tools.ts), which logs the real error
 * server-side and returns a fixed, generic message.
 *
 * This is a static-source guard (this repo tests TS source by grep — see
 * sec17-proxy-ip.test.cjs / sec17-error-leak.test.cjs). It scans line-by-line
 * so it never trips on the intentional generic catch-block pattern
 * `errorResponse(e instanceof Error ? e.message : 'unknown error')` (the caught
 * variable is `e`, not a `*Err` DB-error object).
 */
const fs = require('fs');
const path = require('path');

const srcDir = path.join(__dirname, '..', 'src');

// Every Convene tool file + the write-tools module.
const GUARDED_FILES = fs
  .readdirSync(srcDir)
  .filter((f) => (f.startsWith('convene-') || f === 'write-tools.ts') && f.endsWith('.ts'))
  .sort();

// The 8 tool files that must import the shared helper (the two with a local
// test-pinned clientError — convene-tools.ts, write-tools.ts — are exempt, and
// files with no DB-error path don't need it either).
const SHARED_IMPORT_FILES = [
  'convene-availability-tool.ts',
  'convene-calendar-tools.ts',
  'convene-contact-tools.ts',
  'convene-gathering-tools.ts',
  'convene-invite-tools.ts',
  'convene-lifecycle-tools.ts',
  'convene-recommend-tools.ts',
  'convene-suggest-venues-tool.ts',
];

// A DB-error object (a Supabase/PostgREST `{ error }` — variables all end in
// `Err`/`Error`, e.g. connErr, insErr, updErr, rtErr) whose `.message` is being
// handed to `errorResponse(...)`.
const LEAK = /errorResponse\([^\n]*\b[A-Za-z_]\w*[Ee]rr\w*\??\.message/;

describe('SEC-61/F-15 — DB-error leakage guard (all Convene + write tool files)', () => {
  test('at least the known tool files are being scanned', () => {
    // Guards against a glob that silently matches nothing.
    expect(GUARDED_FILES).toEqual(expect.arrayContaining(SHARED_IMPORT_FILES));
    expect(GUARDED_FILES).toContain('convene-tools.ts');
    expect(GUARDED_FILES).toContain('write-tools.ts');
  });

  for (const rel of GUARDED_FILES) {
    test(`${rel}: no errorResponse(<dbError>.message) leak sites`, () => {
      const src = fs.readFileSync(path.join(srcDir, rel), 'utf8');
      const isComment = (l) =>
        l.startsWith('*') || l.startsWith('//') || l.startsWith('/*');
      const offenders = src
        .split('\n')
        .map((line, i) => ({ line: line.trim(), n: i + 1 }))
        .filter(({ line }) => !isComment(line) && LEAK.test(line));
      expect(offenders).toEqual([]);
    });
  }

  describe('shared helper module (src/convene-errors.ts)', () => {
    const src = fs.readFileSync(path.join(srcDir, 'convene-errors.ts'), 'utf8');

    test('exports clientError() that logs server-side and returns a generic message', () => {
      expect(src).toMatch(/export function clientError\(error: unknown, context: string\)/);
      expect(src).toMatch(/console\.error\(`\[mcp\]\[\$\{context\}\] database error:`, error\)/);
      expect(src).toMatch(/The request could not be completed\. Please check your input and try again\./);
    });

    test('exports errorResponse()', () => {
      expect(src).toMatch(/export function errorResponse\(msg: string\)/);
    });
  });

  for (const rel of SHARED_IMPORT_FILES) {
    test(`${rel}: routes DB errors through the shared clientError()`, () => {
      const src = fs.readFileSync(path.join(srcDir, rel), 'utf8');
      expect(src).toMatch(/import \{ clientError \} from '\.\/convene-errors\.js'/);
      expect(src).toMatch(/clientError\(\w+, '/);
    });
  }
});
