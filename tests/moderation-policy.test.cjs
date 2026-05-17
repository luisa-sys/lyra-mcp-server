/**
 * KAN-242 — Structural guards for the ported moderation modules.
 *
 * The MCP server is a Node ESM project (`"type": "module"`) and the test
 * runner is plain Jest-on-CJS. Loading the TS source for behavioural unit
 * tests would require ts-jest wiring that the rest of this suite doesn't
 * use, so we follow the same static-grep style as the other guards in
 * this directory (e.g. `mcp-suspension-guard.test.cjs`,
 * `mcp-ownership-guard.test.cjs`).
 *
 * The corresponding *behavioural* tests live in the web app under
 * `tests/unit/moderation-policy.test.ts` and `tests/unit/moderation-actions.test.ts`
 * (KAN-241, PR #261). The MCP files are byte-equivalent ports of the
 * library + policy wrapper, so the library behaviour is already
 * regression-covered upstream — these tests verify the *port* (presence
 * of exports, no semantic drift, ESM-correct imports, no wordlist leak
 * in the error path).
 */

const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'src');
const MOD_LIB_PATH = path.join(SRC_DIR, 'content-moderation.ts');
const MOD_POLICY_PATH = path.join(SRC_DIR, 'moderation-policy.ts');

describe('KAN-242 moderation port — content-moderation.ts', () => {
  test('file exists', () => {
    expect(fs.existsSync(MOD_LIB_PATH)).toBe(true);
  });

  const src = fs.readFileSync(MOD_LIB_PATH, 'utf8');

  test('exports moderateContent', () => {
    expect(src).toMatch(/export\s+function\s+moderateContent\s*\(/);
  });

  test('exports the public API used by the policy wrapper', () => {
    expect(src).toMatch(/export\s+(?:type|function)\s+.*FieldType/);
    expect(src).toMatch(/export\s+(?:type|interface)\s+ModerationResult/);
  });

  test('uses public/private field-type distinction', () => {
    // The PII check only blocks on public fields. If the type narrows,
    // private bios would start being rejected for phone numbers.
    expect(src).toMatch(/['"]public['"]/);
    expect(src).toMatch(/['"]private['"]/);
  });

  test('block-severity branch exists (otherwise no rejections fire)', () => {
    expect(src).toMatch(/['"]block['"]/);
    expect(src).toMatch(/severity/);
  });
});

describe('KAN-242 moderation port — moderation-policy.ts', () => {
  test('file exists', () => {
    expect(fs.existsSync(MOD_POLICY_PATH)).toBe(true);
  });

  const src = fs.readFileSync(MOD_POLICY_PATH, 'utf8');

  test('exports checkModeration', () => {
    expect(src).toMatch(/export\s+function\s+checkModeration\s*\(/);
  });

  test('imports moderateContent from the local library', () => {
    // ESM-correct import: must use the `.js` extension (Node ESM resolver
    // does not auto-append). Without this the runtime import fails.
    expect(src).toMatch(
      /import\s*\{[^}]*moderateContent[^}]*\}\s*from\s*['"]\.\/content-moderation\.js['"]/,
    );
  });

  test('default fieldType is "public"', () => {
    // Web-app contract: callers in write-tools.ts pass 'public' explicitly
    // but the default is the safer one (more PII rules apply).
    expect(src).toMatch(/fieldType:\s*FieldType\s*=\s*['"]public['"]/);
  });

  test('null/empty text passes (no spurious rejections on optional fields)', () => {
    // The guard `if (!text) return { ok: true }` is load-bearing — without
    // it every optional field that arrives as null/'' would 500.
    expect(src).toMatch(/if\s*\(\s*!\s*text\s*\)\s*return\s*\{\s*ok:\s*true\s*\}/);
  });

  test('warn severity logs but does not block', () => {
    expect(src).toMatch(/severity\s*===\s*['"]warn['"]/);
    expect(src).toMatch(/console\.warn\s*\(/);
  });

  test('error message is category-only — no raw flag enumeration', () => {
    // Wordlist-protection invariant: the error string must never include
    // the matched word/phrase (would let an attacker probe the dictionary
    // via trial-and-error). Friendly category names only.
    expect(src).toMatch(/inappropriate language/);
    expect(src).toMatch(/spam-like patterns/);
    // The flag format is `category:detail` — make sure we split on ':'
    // and discard the right-hand side.
    expect(src).toMatch(/split\(['"]:['"]\)/);
  });

  test('result shape is the documented union', () => {
    expect(src).toMatch(/ok:\s*true/);
    expect(src).toMatch(/ok:\s*false/);
    expect(src).toMatch(/error:\s*string/);
    expect(src).toMatch(/flags:\s*string\[\]/);
  });
});
