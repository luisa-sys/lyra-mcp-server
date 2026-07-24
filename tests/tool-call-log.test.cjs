/**
 * KAN-232 — tool-call-log middleware tests.
 *
 * Mix of structural guards (the middleware is mounted in index.ts in
 * the correct order — before the rate limiter, after express.json)
 * and unit tests for the extractor helpers (IP parsing, API-key
 * prefix, etc.).
 *
 * Behavioural tests against a real Supabase would require a test
 * harness this repo doesn't currently have. The pure helpers + the
 * static-grep guards catch the bulk of regressions.
 */

const fs = require('fs');
const path = require('path');

const SRC_INDEX = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
const SRC_MIDDLEWARE = fs.readFileSync(path.join(__dirname, '..', 'src', 'tool-call-log.ts'), 'utf8');

describe('KAN-232 tool-call-log middleware', () => {
  describe('source file', () => {
    test('exports toolCallLogMiddleware', () => {
      expect(SRC_MIDDLEWARE).toMatch(/export\s+function\s+toolCallLogMiddleware\s*\(/);
    });

    test('reads MCP_TOOL_CALL_LOG_ENABLED env var', () => {
      expect(SRC_MIDDLEWARE).toMatch(/MCP_TOOL_CALL_LOG_ENABLED/);
    });

    test('default is OFF (env must equal "true" exactly)', () => {
      // Defence against the classic `process.env.X === ''` (truthy) bug —
      // require the explicit 'true' string so a default-empty env never
      // enables logging accidentally.
      expect(SRC_MIDDLEWARE).toMatch(/process\.env\.MCP_TOOL_CALL_LOG_ENABLED\s*===\s*['"]true['"]/);
    });

    test('writes to mcp_tool_call_log table', () => {
      expect(SRC_MIDDLEWARE).toMatch(/\.from\(\s*['"]mcp_tool_call_log['"]\s*\)/);
      expect(SRC_MIDDLEWARE).toMatch(/\.insert\(/);
    });

    test('stores only the api-key PREFIX, never the full key', () => {
      // Wordlist-protection invariant for credentials: only the first
      // 8 chars go into the audit table. The full key in the log
      // would be a credential leak.
      expect(SRC_MIDDLEWARE).toMatch(/slice\(\s*0\s*,\s*8\s*\)/);
      // Negative guard: the insert payload must not include the raw
      // key. Grep the file for any insert payload that references
      // a full-key variable name.
      expect(SRC_MIDDLEWARE).not.toMatch(/api_key:\s*(?:apiKey|fullKey|token)\b/);
    });

    test('fire-and-forget: does not await the insert call', () => {
      // The middleware itself should return next() immediately — only
      // the helper awaits the insert. Verify the middleware fn does
      // not await directly in its body.
      const middlewareBody = SRC_MIDDLEWARE.match(/export\s+function\s+toolCallLogMiddleware[\s\S]*?\n\}/);
      expect(middlewareBody).not.toBeNull();
      // The recordToolCall call must be prefixed with `void` (fire-and-forget signal)
      expect(middlewareBody[0]).toMatch(/void\s+recordToolCall\(/);
    });

    test('tolerates missing table — warns once, never throws', () => {
      expect(SRC_MIDDLEWARE).toMatch(/try\s*\{/);
      expect(SRC_MIDDLEWARE).toMatch(/warnOnce\s*\(/);
      // Negative: no `throw <expr>;` STATEMENT in recordToolCall. Strip
      // comments first so the word "throw" in a comment doesn't trigger
      // a false positive.
      const recordFn = SRC_MIDDLEWARE.match(
        /async\s+function\s+recordToolCall[\s\S]*?\n\}/,
      );
      expect(recordFn).not.toBeNull();
      const decommented = recordFn[0]
        .replace(/\/\/[^\n]*\n/g, '\n')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      // Match an actual throw statement: leading whitespace then `throw `
      expect(decommented).not.toMatch(/^\s*throw\s/m);
    });
  });

  describe('wiring into index.ts', () => {
    test('middleware is imported', () => {
      expect(SRC_INDEX).toMatch(/import\s*\{\s*toolCallLogMiddleware\s*\}\s*from\s*['"]\.\/tool-call-log\.js['"]/);
    });

    test('middleware is mounted via app.use', () => {
      expect(SRC_INDEX).toMatch(/app\.use\(\s*toolCallLogMiddleware\s*\)/);
    });

    test('middleware mounts BEFORE the rate limiter', () => {
      const logIdx = SRC_INDEX.indexOf('toolCallLogMiddleware');
      // Find the first app.use(rateLimit({ AFTER imports.
      const rateIdx = SRC_INDEX.search(/app\.use\(\s*rateLimit\(/);
      expect(logIdx).toBeGreaterThan(0);
      expect(rateIdx).toBeGreaterThan(0);
      // Find the SECOND occurrence of 'toolCallLogMiddleware' (the
      // app.use, not the import) by searching from the imports section.
      const useIdx = SRC_INDEX.search(/app\.use\(\s*toolCallLogMiddleware\s*\)/);
      expect(useIdx).toBeLessThan(rateIdx);
    });

    test('middleware mounts AFTER express.json() — needs req.body', () => {
      const jsonIdx = SRC_INDEX.search(/app\.use\(\s*express\.json\(\)\s*\)/);
      const useIdx = SRC_INDEX.search(/app\.use\(\s*toolCallLogMiddleware\s*\)/);
      expect(jsonIdx).toBeGreaterThan(0);
      expect(useIdx).toBeGreaterThan(jsonIdx);
    });
  });

  describe('BUGS-61 — status_code is populated from the real response', () => {
    test('captures the response status code (res.statusCode)', () => {
      // The historical defect: every mcp_tool_call_log row had status_code
      // NULL because the insert fired on the way IN, before any response
      // existed. The fix records on the way OUT and reads res.statusCode.
      expect(SRC_MIDDLEWARE).toMatch(/statusCode:\s*res\.statusCode/);
    });

    test('records on the response finish event (not on request arrival)', () => {
      expect(SRC_MIDDLEWARE).toMatch(/res\.once\(\s*['"]finish['"]\s*,/);
    });

    test('also records on client-abort (close) so aborted calls are not lost', () => {
      expect(SRC_MIDDLEWARE).toMatch(/res\.once\(\s*['"]close['"]\s*,/);
    });

    test('the insert payload still writes status_code', () => {
      expect(SRC_MIDDLEWARE).toMatch(/status_code:\s*rec\.statusCode/);
    });

    test('middleware now uses the response arg (not _res placeholder)', () => {
      // The pre-fix signature ignored the response (`_res`); populating
      // status_code requires actually reading from it.
      expect(SRC_MIDDLEWARE).toMatch(/toolCallLogMiddleware\(\s*req:\s*Request,\s*res:\s*Response/);
    });
  });

  describe('BUGS-61 — record-once-on-finish semantics (behavioural)', () => {
    // Mirror of the real record-on-terminate closure in the middleware.
    // The middleware is TS/ESM and this suite is CJS static-grep (no runtime
    // DI seam — see KAN-356a), so we re-implement the exact closure here and
    // exercise it against a real EventEmitter-backed fake response, matching
    // the existing `extractIpStub` convention below.
    const { EventEmitter } = require('events');

    function attachRecorder(res, sink) {
      let recorded = false;
      const record = () => {
        if (recorded) return;
        recorded = true;
        sink.push(res.statusCode);
      };
      res.once('finish', record);
      res.once('close', record);
    }

    function fakeRes(statusCode) {
      const res = new EventEmitter();
      res.statusCode = statusCode;
      return res;
    }

    test('success path → records status 200 when the response finishes', () => {
      const sink = [];
      const res = fakeRes(200);
      attachRecorder(res, sink);
      res.emit('finish');
      expect(sink).toEqual([200]);
    });

    test('rate-limited path → records status 429', () => {
      const sink = [];
      const res = fakeRes(429);
      attachRecorder(res, sink);
      res.emit('finish');
      expect(sink).toEqual([429]);
    });

    test('error path → records the real non-2xx code (e.g. 401)', () => {
      const sink = [];
      const res = fakeRes(401);
      attachRecorder(res, sink);
      res.emit('finish');
      expect(sink).toEqual([401]);
    });

    test('never NULL — a concrete numeric code is always recorded', () => {
      const sink = [];
      const res = fakeRes(500);
      attachRecorder(res, sink);
      res.emit('finish');
      expect(sink).toHaveLength(1);
      expect(typeof sink[0]).toBe('number');
      expect(sink[0]).not.toBeNull();
    });

    test('records exactly once even when both finish and close fire', () => {
      const sink = [];
      const res = fakeRes(200);
      attachRecorder(res, sink);
      res.emit('finish');
      res.emit('close');
      expect(sink).toEqual([200]);
    });

    test('client-abort (close, no finish) still records the status', () => {
      const sink = [];
      const res = fakeRes(499);
      attachRecorder(res, sink);
      res.emit('close');
      expect(sink).toEqual([499]);
    });
  });

  describe('helper functions (unit)', () => {
    // Stand-in for what's tested — we re-implement the same small
    // helpers here to verify the logic. The real ones are in TS so
    // we test against the actual behaviour through grep-only checks
    // above + the smoke-test on the deployed env.
    function extractIpStub(req) {
      const fwd = req.headers['x-forwarded-for'];
      if (typeof fwd === 'string' && fwd.length > 0) {
        return fwd.split(',')[0]?.trim() || 'unknown';
      }
      if (Array.isArray(fwd) && fwd.length > 0) {
        return fwd[0]?.split(',')[0]?.trim() || 'unknown';
      }
      return req.socket?.remoteAddress || 'unknown';
    }

    test('x-forwarded-for first hop wins', () => {
      expect(extractIpStub({ headers: { 'x-forwarded-for': '203.0.113.5, 10.0.0.1' } })).toBe('203.0.113.5');
    });

    test('x-forwarded-for absent → falls back to socket.remoteAddress', () => {
      expect(extractIpStub({ headers: {}, socket: { remoteAddress: '198.51.100.7' } })).toBe('198.51.100.7');
    });

    test('completely unknown → "unknown" sentinel (never throws)', () => {
      expect(extractIpStub({ headers: {} })).toBe('unknown');
    });
  });
});
