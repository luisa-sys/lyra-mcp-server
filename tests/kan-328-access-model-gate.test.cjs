/**
 * KAN-328 — MCP access-model alignment guard.
 *
 * The MCP server uses the service-role key (bypasses RLS), so the GUI's access
 * model (user_status / access_tier / per-user feature entitlements + tiers) must
 * be re-enforced in explicit app-code. These are static-grep guards (the .cjs
 * suite cannot import the ESM src — repo gotcha), so they assert the WIRING is
 * present and prod-safe. Behavioural correctness (block vs allow for each
 * cohort) is verified live against the dev MCP per the ticket's test plan.
 *
 * What this guards:
 *   - feature-registry.ts encodes the GA/test tier model + pure resolution.
 *   - feature-entitlements.ts gates new behaviour behind ACCESS_MODEL_V2, reads
 *     the NEW columns (and ONLY under the flag — prod-safe), enforces the
 *     live/non-suspended service gate, and resolves features by tier.
 *   - NO legacy column (access_stage / beta_access_status / is_beta_eligible /
 *     early_access) is read anywhere in src (KAN-326 Phase C drops them).
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const registry = read('feature-registry.ts');
const entitlements = read('feature-entitlements.ts');

describe('KAN-328: feature-registry tier model', () => {
  test('GA tier = media_uploads + discovery', () => {
    expect(registry).toMatch(/media_uploads:\s*['"]GA['"]/);
    expect(registry).toMatch(/discovery:\s*['"]GA['"]/);
  });

  test('test tier = mcp + convene + paid_gift_links + convene_paid_channels', () => {
    expect(registry).toMatch(/\bmcp:\s*['"]test['"]/);
    expect(registry).toMatch(/\bconvene:\s*['"]test['"]/);
    expect(registry).toMatch(/paid_gift_links:\s*['"]test['"]/);
    expect(registry).toMatch(/convene_paid_channels:\s*['"]test['"]/);
  });

  test('tierDefault (option 3): GA always on; test features default OFF (no access_tier grant)', () => {
    // Option 3 (KAN-330 / KAN-328 comment #11300): the tier is a label only.
    // GA → true; test → false (an explicit feature_entitlements row is required).
    // access_tier is NOT consulted, so tierDefault takes only the key.
    expect(registry).toMatch(/return\s+FEATURE_TIER\[key\]\s*===\s*['"]GA['"]/);
    expect(registry).toMatch(/function tierDefault\(key:\s*FeatureKey\)/);
    // The old beta tier-default must be gone — otherwise MCP would grant test
    // features the GUI shows as off (the MCP-only access path KAN-328 forbids).
    expect(registry).not.toMatch(/accessTier\s*===\s*['"]beta['"]/);
  });

  test('resolveFeature: an explicit entitlement row wins over the tier default', () => {
    expect(registry).toMatch(/rows\.find\(\([^)]*\)\s*=>\s*[^)]*\.feature_key\s*===\s*key\)/);
    expect(registry).toMatch(/row\s*\?\s*row\.enabled\s*:\s*tierDefault\(key\)/);
  });

  test('hasLiveAccess: user_status==="live" AND not suspended', () => {
    expect(registry).toMatch(
      /user_status\s*===\s*['"]live['"]\s*&&\s*p\.is_suspended\s*===\s*false/,
    );
  });
});

describe('KAN-328: feature-entitlements access gate', () => {
  test('new behaviour is gated behind the ACCESS_MODEL_V2 env flag', () => {
    expect(entitlements).toMatch(/ACCESS_MODEL_V2\s*===\s*['"]true['"]/);
    expect(entitlements).toMatch(/function accessModelV2Enabled/);
  });

  test('profileForUser reads the NEW columns only under the flag (prod-safe conditional select)', () => {
    // Both column lists must be present: the v2 list (new columns) AND the
    // legacy list, so an un-migrated env (prod today) never selects a missing
    // column.
    expect(entitlements).toMatch(
      /['"]id,\s*age_status,\s*user_status,\s*access_tier,\s*is_suspended['"]/,
    );
    expect(entitlements).toMatch(/['"]id,\s*age_status['"]/);
    // The new-column select must be on the TRUE branch of the flag check, so an
    // un-migrated env only ever runs the legacy `id, age_status` select.
    expect(entitlements).toMatch(
      /accessModelV2Enabled\(\)[\s\S]{0,120}?\.select\(\s*['"]id, age_status, user_status, access_tier, is_suspended['"]/,
    );
  });

  test('requireFeatures enforces the live/non-suspended service gate before feature checks', () => {
    expect(entitlements).toMatch(/hasLiveAccess/);
    // The service gate is v2-conditional AND its body must THROW — a no-op body
    // would silently let waitlist/suspended callers through. Pin the throw to the
    // gate so a gutted body fails this test.
    expect(entitlements).toMatch(
      /if\s*\(\s*v2\s*&&\s*!hasLiveAccess\(prof\)\s*\)\s*\{\s*throw new Error\(accessDenyMessage\(prof\)\)\s*;?\s*\}/,
    );
    // accessDenyMessage must actually distinguish suspended / waitlist reasons.
    expect(entitlements).toMatch(/accessDenyMessage\s*\(/);
    expect(entitlements).toMatch(/is_suspended[\s\S]{0,80}suspended/i);
    // The gate must appear BEFORE the feature_entitlements read in the function.
    const gateIdx = entitlements.indexOf('!hasLiveAccess(prof)');
    const featureReadIdx = entitlements.indexOf("from('feature_entitlements')");
    expect(gateIdx).toBeGreaterThan(-1);
    expect(featureReadIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeLessThan(featureReadIdx);
  });

  test('requireFeatures resolves features by explicit entitlement only under v2 (no access_tier tier-default)', () => {
    // Option 3: resolveFeature is called WITHOUT access_tier — test features need
    // an explicit entitlement row; the tier no longer grants them (GUI parity).
    expect(entitlements).toMatch(/resolveFeature\(rows,\s*k\s+as\s+FeatureKey\)/);
    expect(entitlements).not.toMatch(/resolveFeature\([^)]*prof\.access_tier/);
  });

  test('the legacy v1 path (flat defaults) is retained for ACCESS_MODEL_V2=OFF', () => {
    expect(entitlements).toMatch(/isFeatureEnabled\(rows,\s*k\)/);
    expect(entitlements).toMatch(/FEATURE_DEFAULTS/);
  });
});

describe('KAN-328: no legacy access columns are read anywhere in src', () => {
  // Phase C of KAN-326 DROPS these columns; the MCP server must stop reading
  // them. Prose mentions (in comments) are fine — we strip comments first and
  // only flag QUOTED, single-line usages, which is how a column appears inside
  // .select()/.eq()/filters.
  const LEGACY = ['access_stage', 'beta_access_status', 'is_beta_eligible', 'early_access'];
  const tsFiles = fs.readdirSync(SRC).filter((f) => f.endsWith('.ts'));

  // Strip block and line comments so prose mentions can't trip the column scan.
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

  test.each(LEGACY)('no quoted "%s" column usage in any src file (.select/.eq)', (col) => {
    const offenders = [];
    // Same-line quoted usage only (the negated class excludes newlines).
    const re = new RegExp(`['"\`][^'"\`\\n]*\\b${col}\\b[^'"\`\\n]*['"\`]`);
    for (const f of tsFiles) {
      if (re.test(stripComments(read(f)))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });

  test.each(LEGACY)('no unquoted member access of "%s" in any src file (row.col)', (col) => {
    const offenders = [];
    // e.g. `row.access_stage`, `data.beta_access_status` — reading a column you
    // (correctly) never selected would still be a regression to flag.
    const re = new RegExp(`\\.${col}\\b`);
    for (const f of tsFiles) {
      if (re.test(stripComments(read(f)))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
  });
});
