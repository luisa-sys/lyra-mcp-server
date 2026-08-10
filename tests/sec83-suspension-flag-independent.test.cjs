/**
 * SEC-83 — a suspended caller must be refused by every MCP path.
 *
 * ORIGINAL DEFECT: `authenticateApiKey` never checks `is_suspended`, and the
 * only suspended/live service gate in `requireFeatures` lived behind
 * `if (v2 && …)`. Production ran with ACCESS_MODEL_V2 OFF, so a suspended
 * (formerly-live) caller — whose feature_entitlements rows survive suspension —
 * could still call every write/convene tool: lyra_update_profile, lyra_add_item,
 * lyra_send_invite, lyra_record_rsvp, lyra_drain_invite_queue. SEC-81/SEC-80
 * class: a standing control skipped on a live path.
 *
 * FIRST FIX (superseded): a flag-INDEPENDENT refusal, which under v1 resolved
 * suspension with a second, standalone lookup that DEGRADED TO NOT-SUSPENDED on
 * error. Correct in direction, but it left a fail-open on the default path.
 *
 * NOW (KAN-415 D5, 2026-08-10): the v1 path is RETIRED. Its whole justification
 * was a prod `profiles` table predating KAN-327 — verified against all three
 * Supabase projects that dev, staging and prod each have user_status,
 * access_tier, is_suspended and age_status, all NOT NULL. So the profile read
 * always selects is_suspended, the refusal is unconditional, and the second
 * lookup with its fail-open is gone.
 *
 * WHAT THESE ASSERTIONS NOW PIN, and why they changed shape: the old ones
 * matched the IMPLEMENTATION (`const suspended = v2 ? … : await callerIsSuspended(…)`).
 * That shape no longer exists, and pinning it would have meant keeping a branch
 * whose only purpose was to satisfy a test. The INVARIANT is unchanged and is
 * now structural rather than conditional — there is one path, and it refuses.
 * These assert that, plus the absence of any way to reintroduce the flag.
 *
 * The .cjs suite cannot import the ESM src (repo gotcha — see
 * kan-328-access-model-gate.test.cjs), so this remains a static guard. Comments
 * are stripped first, so the prose above cannot satisfy any assertion below.
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

describe('SEC-83: a suspended caller is refused, unconditionally', () => {
  test('requireFeatures refuses on prof.is_suspended with no flag in sight', () => {
    // The invariant. Not "there is a branch that handles v1" — there is no
    // branch, which is strictly stronger.
    expect(code).toMatch(/if\s*\(\s*prof\.is_suspended\s*\)\s*\{[\s\S]{0,240}?throw new Error\(/);
  });

  test('the refusal runs BEFORE the service gate and the feature read', () => {
    const refusal = code.indexOf('prof.is_suspended');
    const gate = code.indexOf('hasLiveAccess(prof)');
    const featureRead = code.indexOf("from('feature_entitlements')");
    expect(refusal).toBeGreaterThan(-1);
    expect(gate).toBeGreaterThan(-1);
    expect(featureRead).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(gate);
    expect(refusal).toBeLessThan(featureRead);
  });

  test('the profile read always selects is_suspended — no conditional select', () => {
    // The fail-open this closes: under v1 the select omitted the column, so
    // is_suspended arrived undefined and the caller read as not-suspended.
    expect(code).toMatch(/\.select\(\s*'id, age_status, user_status, access_tier, is_suspended'\s*\)/);
    // Exactly one select against profiles — the second, degrade-safe lookup is gone.
    const profileSelects = (code.match(/from\('profiles'\)/g) || []).length;
    expect(profileSelects).toBe(1);
  });

  test('ACCESS_MODEL_V2 cannot come back — no flag, no dual path', () => {
    // The reintroduction guard. A future "just re-add the flag for safety" is
    // what this file exists to stop, and it is the shape the original defect
    // took: a control that was present but conditionally skipped.
    expect(code).not.toMatch(/ACCESS_MODEL_V2/);
    expect(code).not.toMatch(/accessModelV2Enabled/);
    expect(code).not.toMatch(/callerIsSuspended/);
    expect(code).not.toMatch(/\bconst\s+v2\b/);
  });

  test('the service gate is unconditional too', () => {
    // Previously `if (v2 && !hasLiveAccess(prof))`. The && was the skip.
    expect(code).toMatch(/if\s*\(\s*!hasLiveAccess\(prof\)\s*\)/);
    expect(code).not.toMatch(/v2\s*&&\s*!hasLiveAccess/);
  });
});
