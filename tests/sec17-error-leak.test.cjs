/**
 * SEC-17 (F-15) — no raw DB/PostgREST error leakage to MCP clients.
 *
 * Structural guards (this repo tests TS source by grep — see
 * sec17-proxy-ip.test.cjs). A raw `errorResponse(error.message)` returns the
 * database's own message to the caller, which can leak column/constraint names,
 * SQL fragments and internal schema. Every DB-error path in the write + convene
 * tool modules must instead route through `clientError()`, which logs the real
 * error server-side and returns a fixed, generic message.
 *
 * Static-validation `errorResponse('...')` calls (e.g. 'No fields to update')
 * are intentionally NOT touched — they carry no internal detail.
 */
const fs = require('fs');
const path = require('path');

const FILES = ['write-tools.ts', 'convene-tools.ts'];

describe('SEC-17/F-15 DB-error leakage guard', () => {
  for (const rel of FILES) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', rel), 'utf8');

    test(`${rel}: no raw errorResponse(error.message) sites remain`, () => {
      expect(src).not.toMatch(/errorResponse\(error\.message\)/);
    });

    test(`${rel}: defines clientError() that logs server-side + returns a generic message`, () => {
      expect(src).toMatch(/function clientError\(error: unknown, context: string\)/);
      expect(src).toMatch(/console\.error\(`\[mcp\]\[\$\{context\}\] database error:`, error\)/);
      expect(src).toMatch(/The request could not be completed\. Please check your input and try again\./);
    });

    test(`${rel}: routes DB errors through clientError(error, ...)`, () => {
      expect(src).toMatch(/clientError\(error, '/);
    });
  }
});
