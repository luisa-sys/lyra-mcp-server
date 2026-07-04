/**
 * KAN-404 — tests for the two bundled MCP write-tool changes:
 *
 *   #12  lyra_update_item  — edit an existing profile item's text.
 *   #1   lyra_add_school   — affiliation_type param + school-postcode rule.
 *
 * The repo compiles to ESM and the Jest suite runs as CommonJS, so — like
 * every other guard here (moderation-write-tools, mcp-ownership-guard, …) —
 * these tests analyse the TypeScript source statically rather than importing
 * the compiled module. The postcode ACCEPT/REJECT cases additionally run
 * against a faithful re-implementation of the source's validity rule so the
 * exact 'SW1A' / 'M1' / 'SW1A 1AA' vs '' / 'London' / '12345' boundary is
 * behaviourally covered.
 */

const fs = require('fs');
const path = require('path');

const WRITE_TOOLS_PATH = path.join(__dirname, '..', 'src', 'write-tools.ts');
const src = fs.readFileSync(WRITE_TOOLS_PATH, 'utf8');
const INDEX_PATH = path.join(__dirname, '..', 'src', 'index.ts');
const indexSrc = fs.readFileSync(INDEX_PATH, 'utf8');

function extractToolBlock(toolName) {
  const marker = `'${toolName}'`;
  const idx = src.indexOf(marker);
  if (idx === -1) return null;
  const openIdx = src.lastIndexOf('registerTool(', idx);
  if (openIdx === -1) return null;
  let depth = 0;
  let i = openIdx + 'registerTool'.length;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(openIdx, i);
}

// ── #1: school-postcode validity rule ─────────────────────────────────────
// Faithful mirror of isValidSchoolPostcode in write-tools.ts. Kept in the
// test so the accept/reject boundary is asserted behaviourally, not only by
// grepping the source. If the source rule changes, the static test below
// (which greps for this exact predicate) will fail and force a review here.
function isValidSchoolPostcode(value) {
  const trimmed = (value ?? '').trim();
  if (trimmed.length < 2 || trimmed.length > 12) return false;
  return /[A-Za-z]/.test(trimmed) && /[0-9]/.test(trimmed);
}

describe('KAN-404 #1 — school postcode rule', () => {
  test.each(['SW1A', 'M1', 'SW1A 1AA', 'ec1a 1bb'])('accepts valid partial/full postcode %s', (pc) => {
    expect(isValidSchoolPostcode(pc)).toBe(true);
  });

  test.each(['', ' ', 'London', 'Manchester', '12345', 'A', '1'])('rejects invalid location %s', (pc) => {
    expect(isValidSchoolPostcode(pc)).toBe(false);
  });

  test('rejects null / undefined', () => {
    expect(isValidSchoolPostcode(null)).toBe(false);
    expect(isValidSchoolPostcode(undefined)).toBe(false);
  });

  test('rejects overly long strings (>12 chars) even if letter+digit present', () => {
    expect(isValidSchoolPostcode('SW1A 1AA EXTRA')).toBe(false);
  });

  test('source uses exactly this predicate (letter AND digit, trimmed 2–12)', () => {
    expect(src).toMatch(/function\s+isValidSchoolPostcode/);
    expect(src).toMatch(/trimmed\.length\s*<\s*2\s*\|\|\s*trimmed\.length\s*>\s*12/);
    expect(src).toMatch(/\/\[A-Za-z\]\/\.test\(\s*trimmed\s*\)\s*&&\s*\/\[0-9\]\/\.test\(\s*trimmed\s*\)/);
  });
});

// ── #1: lyra_add_school affiliation_type + gate wiring ────────────────────
describe('KAN-404 #1 — lyra_add_school affiliation_type + postcode gate', () => {
  const block = extractToolBlock('lyra_add_school');

  test('tool block found', () => {
    expect(block).not.toBeNull();
  });

  test('accepts an affiliation_type enum param defaulting to school', () => {
    expect(block).toMatch(/affiliation_type:\s*z\.enum\(\s*\[\s*['"]school['"]\s*,\s*['"]organisation['"]\s*,\s*['"]community['"]\s*\]\s*\)\s*\.optional\(\)\.default\(\s*['"]school['"]\s*\)/);
  });

  test('enforces the school postcode rule and returns the postcode error', () => {
    expect(block).toMatch(/type\s*===\s*['"]school['"]\s*&&\s*!\s*isValidSchoolPostcode\(\s*school_location\s*\)/);
    expect(block).toMatch(/errorResponse\(\s*['"]Schools need a postcode \(full or partial\)/);
  });

  test('postcode gate runs BEFORE the insert (invalid never lands a row)', () => {
    const gateIdx = block.indexOf('isValidSchoolPostcode');
    const insertIdx = block.indexOf(".from('school_affiliations')");
    expect(gateIdx).toBeGreaterThan(0);
    expect(insertIdx).toBeGreaterThan(gateIdx);
  });

  test('inserts affiliation_type into the row', () => {
    expect(block).toMatch(/affiliation_type:\s*type/);
  });

  test('org/community keep location optional (gate is scoped to type === school)', () => {
    // The guard must be conditional on the school type, not unconditional.
    expect(block).not.toMatch(/if\s*\(\s*!\s*isValidSchoolPostcode\(\s*school_location\s*\)\s*\)/);
  });
});

// ── #12: lyra_update_item wiring ──────────────────────────────────────────
describe('KAN-404 #12 — lyra_update_item', () => {
  const block = extractToolBlock('lyra_update_item');

  test('tool block found', () => {
    expect(block).not.toBeNull();
  });

  test('is enumerated in the well-known tool list in index.ts', () => {
    expect(indexSrc).toMatch(/'lyra_update_item'/);
  });

  test('inputSchema accepts item_id + optional title/description/url', () => {
    expect(block).toMatch(/item_id:\s*z\.string\(\)/);
    expect(block).toMatch(/title:\s*z\.string\(\)\.optional\(\)/);
    expect(block).toMatch(/description:\s*z\.string\(\)\.optional\(\)/);
    expect(block).toMatch(/url:\s*z\.string\(\)\.optional\(\)/);
  });

  test('non-destructive + idempotent annotations', () => {
    expect(block).toMatch(/destructiveHint:\s*false/);
    expect(block).toMatch(/idempotentHint:\s*true/);
  });

  test('authenticates via authAndProfile (own-profile-only, mcp entitlement)', () => {
    expect(block).toMatch(/authAndProfile\(\s*api_key/);
  });

  test('sanitises + moderates title before write', () => {
    expect(block).toMatch(/sanitiseText\(\s*title\s*,\s*200\s*\)/);
    expect(block).toMatch(/moderateAndAudit\(\s*\{[\s\S]*?text:\s*sanitisedTitle/);
    expect(block).toMatch(/if\s*\(\s*!\s*titleMod\.ok\s*\)\s*return\s+errorResponse/);
  });

  test('sanitises + moderates description before write, clears empty to null', () => {
    expect(block).toMatch(/sanitiseText\(\s*description\s*,\s*1000\s*\)/);
    expect(block).toMatch(/if\s*\(\s*!\s*descMod\.ok\s*\)\s*return\s+errorResponse/);
    expect(block).toMatch(/updates\.description\s*=\s*sanitisedDesc\.length\s*>\s*0\s*\?\s*sanitisedDesc\s*:\s*null/);
  });

  test('url validated via sanitiseUrl; invalid → errorResponse; empty → null', () => {
    expect(block).toMatch(/sanitiseUrl\(\s*url\s*\)/);
    expect(block).toMatch(/errorResponse\(\s*['"]Invalid URL[^'"]*['"]\s*\)/);
    expect(block).toMatch(/updates\.url\s*=\s*null/);
  });

  test('empty-patch guard returns before any write', () => {
    expect(block).toMatch(/Object\.keys\(\s*updates\s*\)\.length\s*===\s*0[\s\S]*?errorResponse\(\s*['"]No fields to update['"]/);
  });

  test('moderation runs BEFORE the profile_items update', () => {
    const modIdx = block.search(/moderateAndAudit/);
    const updateIdx = block.indexOf(".from('profile_items')");
    expect(modIdx).toBeGreaterThan(0);
    expect(updateIdx).toBeGreaterThan(modIdx);
  });

  test('owner-scoped write: .eq id AND .eq profile_id (KAN-260)', () => {
    expect(block).toMatch(/\.eq\(\s*'id'\s*,\s*item_id\s*\)/);
    expect(block).toMatch(/\.eq\(\s*'profile_id'\s*,\s*auth\.profileId\s*\)/);
  });

  test('masks raw DB errors via clientError', () => {
    expect(block).toMatch(/clientError\(\s*error\s*,\s*'write-tools'\s*\)/);
  });
});
