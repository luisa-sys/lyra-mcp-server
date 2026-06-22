/**
 * SEC-17 (F-08) — the /mcp rate limiter is keyed per API key, not just per IP.
 *
 * Structural guard (this repo tests TS source by grep). Keying only on IP means
 * many users behind one NAT share the 60/min cap, while a single API key can
 * spread load across many source IPs to evade it. The limiter now keys on the
 * caller's API key (x-api-key / Bearer) when present, falling back to the
 * IPv6-safe trusted req.ip for unauthenticated public reads.
 */
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');

describe('SEC-17/F-08 per-API-key MCP rate limiting', () => {
  test('imports the IPv6-safe ipKeyGenerator helper', () => {
    expect(SRC).toMatch(/import \{ ipKeyGenerator \} from 'express-rate-limit'/);
  });

  test('the /mcp limiter defines a keyGenerator keyed on the API key with an ip fallback', () => {
    const block = SRC.match(/app\.use\('\/mcp',\s*rateLimit\(\{[\s\S]*?\}\)\);/);
    expect(block).not.toBeNull();
    expect(block[0]).toMatch(/keyGenerator:\s*\(req\)\s*=>/);
    expect(block[0]).toMatch(/x-api-key/);
    expect(block[0]).toMatch(/ipKeyGenerator\(req\.ip/);
    expect(block[0]).toMatch(/max:\s*60/);
  });
});
