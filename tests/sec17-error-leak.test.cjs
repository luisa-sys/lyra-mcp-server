/**
 * SEC-17 (F-15) — no raw DB/PostgREST error leakage to MCP clients.
 *
 * Structural guards (this repo tests TS source by grep — see
 * sec17-proxy-ip.test.cjs). A raw `errorResponse(<dbError>.message)` returns the
 * database's own message to the caller, which can leak column/constraint names,
 * SQL fragments and internal schema. Every DB-error path in the write + convene
 * tool modules must instead route through `clientError()`, which logs the real
 * error server-side and returns a fixed, generic message.
 *
 * Static-validation `errorResponse('...')` calls (e.g. 'No fields to update')
 * are intentionally NOT touched — they carry no internal detail.
 *
 * ---------------------------------------------------------------------------
 * WIDENED 2026-08-14 (KAN-354, founder-signed-off under the Test Integrity
 * Policy). This is a COVERAGE EXPANSION, not a relaxation. What changed and
 * why, so the next reader does not have to re-derive it:
 *
 * 1. The corpus was a hard-coded `FILES = ['write-tools.ts','convene-tools.ts']`
 *    — 2 of 11 tool modules. The other 9 import `clientError` from
 *    `convene-errors.ts` (SEC-61) and were covered by NOTHING. Consolidating a
 *    module's helpers silently REMOVED it from this guard, which is how the
 *    coverage shrank without anything going red. The corpus is now DERIVED from
 *    the tree, so a new tool module is covered the day it lands.
 *
 * 2. The "defines clientError()" assertion was applied per-consumer, which is
 *    what made consolidation look like a test failure. It now applies to every
 *    file that actually DEFINES the function, wherever that is — today
 *    `convene-errors.ts` plus the two remaining local copies. When KAN-354
 *    leg B deletes those copies, this keeps asserting the surviving definition
 *    with no edit required.
 *
 * 3. Both surviving assertions pinned the literal variable name `error`. The
 *    real code names DB errors `insErr`, `updErr`, `connErr`, `slotsErr`,
 *    `lookupErr`, `profErr`, `rtErr`, `resetErr`, `invErr`, `upsertErr`,
 *    `msgErr`, `hostRtErr`, `hostConnErr` … so the old pattern would not have
 *    caught a leak in any of them. Matched on shape now, not on spelling.
 *
 * ⚠️ The leak pattern deliberately does NOT ban every `errorResponse(x.message)`.
 * `write-tools.ts` has 12 legitimate `errorResponse(e.message)` sites in
 * `authAndProfile` catch blocks — those surface controlled auth messages
 * ('API key required…'), not database internals. Banning them outright would
 * turn this suite red on a non-defect, which is how a guard gets switched off.
 * The pattern keys on the DB-error naming convention (`error` / `*Err`), which
 * covers every DB error variable currently in the tree.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

/**
 * Strip line and block comments before matching.
 *
 * CTL-039 / gotcha #29: a source-text assertion satisfied by the comment
 * EXPLAINING the fix passes even after the fix is deleted — and the better the
 * fix is documented, the weaker the scan becomes. `convene-errors.ts` discusses
 * the leak pattern by name in its own header, which is exactly the shape that
 * would otherwise poison both directions here.
 *
 * Deliberately simple: this does not model strings containing comment markers.
 * That is acceptable for TypeScript source of this shape, and a false strip
 * would make a POSITIVE assertion fail (loud), not pass (silent).
 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const read = (rel) => stripComments(fs.readFileSync(path.join(SRC, rel), 'utf8'));

/** Every tool module in the tree, not a hand-maintained list. */
const TOOL_MODULES = fs
  .readdirSync(SRC)
  .filter((f) => /-tools?\.ts$/.test(f))
  .sort();

/** Whoever defines clientError must define it correctly — wherever it lives. */
const DEFINERS = fs
  .readdirSync(SRC)
  .filter((f) => f.endsWith('.ts'))
  .filter((f) => /function\s+clientError\s*\(/.test(read(f)))
  .sort();

/** A module with no database access has no DB error to route. */
const DB_MODULES = TOOL_MODULES.filter((f) => /\.from\(/.test(read(f)));

/** DB error variables are named `error` or `<something>Err` throughout. */
const LEAKED_DB_MESSAGE = /errorResponse\(\s*(?:error|\w*Err)\s*\.message\s*\)/;

describe('SEC-17/F-15 DB-error leakage guard', () => {
  // Assert the corpus BEFORE iterating it. An empty derived list registers zero
  // tests and reports green — catalogue failure mode 4.
  test('the derived corpus is non-empty and covers every tool module', () => {
    expect(TOOL_MODULES.length).toBeGreaterThanOrEqual(11);
    expect(DB_MODULES.length).toBeGreaterThanOrEqual(10);
    expect(DEFINERS.length).toBeGreaterThanOrEqual(1);
  });

  for (const rel of DEFINERS) {
    test(`${rel}: defines clientError() that logs server-side + returns a generic message`, () => {
      const src = read(rel);
      expect(src).toMatch(/function clientError\(error: unknown, context: string\)/);
      expect(src).toMatch(/console\.error\(`\[mcp\]\[\$\{context\}\] database error:`, error\)/);
      expect(src).toMatch(/The request could not be completed\. Please check your input and try again\./);
    });
  }

  for (const rel of TOOL_MODULES) {
    test(`${rel}: no raw DB error message is returned to the caller`, () => {
      expect(read(rel)).not.toMatch(LEAKED_DB_MESSAGE);
    });
  }

  for (const rel of DB_MODULES) {
    test(`${rel}: routes DB errors through clientError(<err>, '<context>')`, () => {
      expect(read(rel)).toMatch(/clientError\(\s*\w+\s*,\s*'/);
    });
  }
});
