/**
 * SEC-17 (F-08, F-16) — trusted proxy + non-spoofable audit IP.
 *
 * Structural guards (this repo tests TS source by grep — see
 * tool-call-log.test.cjs). These assert the security-relevant shape:
 *   - index.ts sets `trust proxy` to a single hop so Express derives req.ip
 *     from the real client (functional per-client rate limiting) rather than
 *     the shared Railway proxy IP.
 *   - The audit-log IP and the request-logger IP both come from req.ip, not a
 *     client-spoofable raw X-Forwarded-For header.
 */
const fs = require('fs');
const path = require('path');

const SRC_INDEX = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
const SRC_LOG = fs.readFileSync(path.join(__dirname, '..', 'src', 'tool-call-log.ts'), 'utf8');

describe('SEC-17 trusted proxy + audit IP', () => {
  test('index.ts trusts exactly one proxy hop (F-08)', () => {
    expect(SRC_INDEX).toMatch(/app\.set\(\s*['"]trust proxy['"]\s*,\s*1\s*\)/);
  });

  test('extractIp() uses req.ip and no longer parses raw X-Forwarded-For (F-16)', () => {
    const fn = SRC_LOG.match(/function extractIp\([\s\S]*?\n\}/);
    expect(fn).not.toBeNull();
    expect(fn[0]).toMatch(/req\.ip/);
    // Must not read request headers at all anymore (req.ip is the trusted source).
    expect(fn[0]).not.toMatch(/req\.headers/);
  });

  test('request logger derives ip from req.ip (F-16)', () => {
    expect(SRC_INDEX).toMatch(/const ip = req\.ip/);
  });
});
