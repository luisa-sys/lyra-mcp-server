/**
 * SEC-83 — the MCP suspension refusal must be FLAG-INDEPENDENT.
 *
 * `authenticateApiKey` never checks `is_suspended`, and before this fix the only
 * suspended/live service gate in `requireFeatures` lived behind `if (v2 && …)`.
 * Production runs with ACCESS_MODEL_V2 OFF (v1) until the KAN-327 migration is
 * promoted there, so under v1 a suspended (formerly-live) caller — whose
 * feature_entitlements rows survive suspension — could still call every
 * write/convene tool (lyra_update_profile, lyra_add_item, lyra_send_invite,
 * lyra_record_rsvp, lyra_drain_invite_queue). SEC-81/SEC-80 class: a standing
 * control skipped on a live path.
 *
 * The .cjs suite cannot import the ESM src (repo gotcha — see
 * kan-328-access-model-gate.test.cjs), so this is a static-grep guard that pins
 * the WIRING: requireFeatures refuses suspended callers regardless of the flag,
 * before the v2 gate and the feature read; the v1 path resolves suspension via a
 * best-effort, degrade-safe standalone lookup. It must FAIL if a future refactor
 * re-gates the suspension check behind ACCESS_MODEL_V2.
 *
 * NOTE: this ADDS coverage. It never weakens the existing KAN-328 / BUGS-21
 * suspension guards.
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const entitlements = fs.readFileSync(path.join(SRC, 'feature-entitlements.ts'), 'utf8');

// Strip block + line comments so prose in the (heavily-commented) source can't
// satisfy or trip the code-shape assertions below.
function stripComments(src) {
  const out = [];
  let inBlock = false;
  for (const raw of src.split('\n')) {
    let line = raw;
    if (inBlock) {
      const end = line.indexOf('*/');
      if (end === -1) continue;
      line = line.slice(end + 2);
      inBlock = false;
    }
    let bs;
    while ((bs = line.indexOf('/*')) !== -1) {
      const be = line.indexOf('*/', bs + 2);
      if (be === -1) {
        line = line.slice(0, bs);
        inBlock = true;
        break;
      }
      line = line.slice(0, bs) + ' ' + line.slice(be + 2);
    }
    const lc = line.indexOf('//');
    if (lc !== -1) line = line.slice(0, lc);
    out.push(line);
  }
  return out.join('\n');
}

const code = stripComments(entitlements);

describe('SEC-83: flag-independent MCP suspension refusal', () => {
  test('requireFeatures resolves suspension on BOTH flag states (v1 via a standalone lookup)', () => {
    // The v1 branch of the ternary must reach a real suspension value — proving
    // the refusal is not skipped when ACCESS_MODEL_V2 is off.
    expect(code).toMatch(
      /const\s+suspended\s*=\s*v2\s*\?\s*prof\.is_suspended\s*:\s*await\s+callerIsSuspended\(\s*prof\.id\s*\)/,
    );
  });

  test('a suspended caller is thrown out (not a no-op body)', () => {
    expect(code).toMatch(/if\s*\(\s*suspended\s*\)\s*\{[\s\S]{0,200}?throw new Error\(/);
  });

  test('the suspension refusal runs BEFORE the v2 service gate and the feature read', () => {
    const suspIdx = code.indexOf('const suspended =');
    const v2GateIdx = code.indexOf('!hasLiveAccess(prof)');
    const featureReadIdx = code.indexOf("from('feature_entitlements')");
    expect(suspIdx).toBeGreaterThan(-1);
    expect(v2GateIdx).toBeGreaterThan(-1);
    expect(featureReadIdx).toBeGreaterThan(-1);
    // Flag-independent: the suspension check precedes the v2-conditional gate…
    expect(suspIdx).toBeLessThan(v2GateIdx);
    // …and precedes the per-feature entitlement read.
    expect(suspIdx).toBeLessThan(featureReadIdx);
  });

  test('the suspension refusal is NOT nested inside the `if (v2 && …)` gate', () => {
    // Regression pin: re-folding suspension behind the flag (the SEC-83 bug)
    // would move `callerIsSuspended` / the `suspended` throw after the v2 gate.
    const v2GateIdx = code.indexOf('if (v2 && !hasLiveAccess(prof))');
    const suspThrowIdx = code.search(/if\s*\(\s*suspended\s*\)/);
    expect(v2GateIdx).toBeGreaterThan(-1);
    expect(suspThrowIdx).toBeGreaterThan(-1);
    expect(suspThrowIdx).toBeLessThan(v2GateIdx);
  });

  test('callerIsSuspended reads only is_suspended and degrades safe on a pre-KAN-327 schema', () => {
    expect(code).toMatch(/async function callerIsSuspended\s*\(/);
    expect(code).toMatch(/\.from\('profiles'\)[\s\S]{0,80}\.select\('is_suspended'\)/);
    // Degrade-safe: handle 42703 undefined_column and never throw out of the
    // helper (deny-all on a missing column / DB blip would be a worse outage).
    const start = code.indexOf('async function callerIsSuspended');
    const end = code.indexOf('export async function requireFeatures', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = code.slice(start, end);
    expect(body).toMatch(/42703/);
    expect(body).toMatch(/return false/);
    expect(body).not.toMatch(/\bthrow\b/);
  });

  test('the v1 legacy profile select is unchanged (still prod-safe: no is_suspended column)', () => {
    // Belt-and-braces with the KAN-328 guard: the fix must NOT fold is_suspended
    // into the v1 select (that would 42703 every gated call on un-migrated prod).
    expect(code).toMatch(/\.select\('id, age_status'\)/);
  });
});
