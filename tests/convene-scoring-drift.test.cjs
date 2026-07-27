/**
 * KAN-426 — tests for the Convene scoring drift detector.
 *
 * The checker's whole value is that people believe it. So this suite pins both
 * halves of that belief:
 *
 *   - it FIRES on a real scoring change (weight, keyword, threshold, operator)
 *   - it does NOT fire on cosmetics (comments, whitespace, brace style,
 *     trailing commas, `0.30` vs `0.3`)
 *   - it FAILS CLOSED when it cannot compare at all (bad fetch, bad parse)
 *
 * A detector that cries wolf gets waived; a detector that silently passes when
 * it cannot compare is worse than no detector. Both failure modes are covered
 * below.
 */

const fs = require('fs');
const path = require('path');

const drift = require('../scripts/check-convene-scoring-drift.cjs');
const {
  PAIRS,
  KNOWN_DIVERGENCES,
  DriftParseError,
  stripComments,
  numericFingerprint,
  extractConstantBlock,
  extractFunctionBody,
  parseNumericMap,
  parseListMap,
  extractArtefacts,
  compareArtefacts,
  fetchRemote,
} = drift;

// ─── fixtures ───────────────────────────────────────────────────────────────

/** A miniature stand-in for the real scorer, in the same shape. */
const BASE_SOURCE = `
/** A comment mentioning https://example.com/not-a-comment */
const WEIGHTS = {
  tribeFit: 0.30,
  recency: 0.20,
};

const TRIBE_KEYWORDS_BY_INTENT = {
  coffee: ['friends', 'colleagues'],
  other: [],
};

function scoreRecency(signals, nowMs): { score: number; reason: string | null } {
  const daysSince = (nowMs - signals.at) / 86400_000;
  if (daysSince < 7) return { score: 0.3, reason: 'recent' };
  return { score: 1.0, reason: null };
}
`;

const FIXTURE_PAIR = {
  label: 'fixture',
  constants: [
    { name: 'WEIGHTS', kind: 'numericMap' },
    { name: 'TRIBE_KEYWORDS_BY_INTENT', kind: 'listMap' },
  ],
  functions: ['scoreRecency'],
};

const compare = (localSrc, remoteSrc, known = {}) =>
  compareArtefacts(
    extractArtefacts(localSrc, FIXTURE_PAIR),
    extractArtefacts(remoteSrc, FIXTURE_PAIR),
    'fixture',
    known
  );

// ─── the detector fires on real scoring changes ─────────────────────────────

describe('KAN-426 drift detector — fires on real scoring changes', () => {
  test('identical sources produce no findings', () => {
    const { findings } = compare(BASE_SOURCE, BASE_SOURCE);
    expect(findings).toEqual([]);
  });

  test('a changed WEIGHT fails, naming the constant and BOTH values', () => {
    const drifted = BASE_SOURCE.replace('tribeFit: 0.30', 'tribeFit: 0.45');
    const { findings } = compare(BASE_SOURCE, drifted);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('WEIGHTS.tribeFit');
    expect(findings[0]).toContain('0.3');
    expect(findings[0]).toContain('0.45');
  });

  test('a changed keyword list fails', () => {
    const drifted = BASE_SOURCE.replace("['friends', 'colleagues']", "['friends']");
    const { findings } = compare(BASE_SOURCE, drifted);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('TRIBE_KEYWORDS_BY_INTENT.coffee');
  });

  test('an inline THRESHOLD change inside a function body fails', () => {
    const drifted = BASE_SOURCE.replace('daysSince < 7', 'daysSince < 10');
    const { findings } = compare(BASE_SOURCE, drifted);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('scoreRecency');
  });

  test('a FLIPPED COMPARISON (`<` → `<=`) fails', () => {
    const drifted = BASE_SOURCE.replace('daysSince < 7', 'daysSince <= 7');
    const { findings } = compare(BASE_SOURCE, drifted);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('scoreRecency');
  });

  test('a changed score INSIDE a branch fails', () => {
    const drifted = BASE_SOURCE.replace('score: 0.3, reason:', 'score: 0.8, reason:');
    const { findings } = compare(BASE_SOURCE, drifted);

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('scoreRecency');
  });

  test('a constant missing entirely from the lyra copy is reported, not skipped', () => {
    const local = extractArtefacts(BASE_SOURCE, FIXTURE_PAIR);
    const remote = extractArtefacts(BASE_SOURCE, FIXTURE_PAIR);
    delete remote.constants.WEIGHTS;

    const { findings } = compareArtefacts(local, remote, 'fixture', {});
    expect(findings.join('\n')).toContain('`WEIGHTS` is missing from the lyra copy');
  });
});

// ─── the detector stays quiet on cosmetics ──────────────────────────────────

describe('KAN-426 drift detector — quiet on cosmetic changes', () => {
  test('a comment-only change does not fire', () => {
    const cosmetic = BASE_SOURCE.replace(
      '/** A comment mentioning https://example.com/not-a-comment */',
      '// totally different commentary\n// on two lines'
    );
    expect(compare(BASE_SOURCE, cosmetic).findings).toEqual([]);
  });

  test('a whitespace/indentation-only change does not fire', () => {
    const cosmetic = BASE_SOURCE.replace(/^ {2}/gm, '        ').replace(/\n\n/g, '\n\n\n');
    expect(compare(BASE_SOURCE, cosmetic).findings).toEqual([]);
  });

  test('`0.30` vs `0.3` is the same weight', () => {
    const cosmetic = BASE_SOURCE.replace('tribeFit: 0.30', 'tribeFit: 0.3');
    expect(compare(BASE_SOURCE, cosmetic).findings).toEqual([]);
  });

  test('brace style and trailing commas do not fire', () => {
    // This is the exact shape the two REAL copies already differ in: lyra wraps
    // single-statement `if` bodies in braces and leaves trailing commas, this
    // repo does not. Comparing normalised body TEXT reported all five attendee
    // scorers as drifted; comparing the numeric fingerprint reports none.
    const cosmetic = BASE_SOURCE.replace(
      "if (daysSince < 7) return { score: 0.3, reason: 'recent' };",
      "if (daysSince < 7) {\n    return {\n      score: 0.3,\n      reason: 'recent',\n    };\n  }"
    );
    expect(compare(BASE_SOURCE, cosmetic).findings).toEqual([]);
  });

  test('renaming a local identifier does not fire', () => {
    const cosmetic = BASE_SOURCE.replace(/daysSince/g, 'elapsedDays');
    expect(compare(BASE_SOURCE, cosmetic).findings).toEqual([]);
  });

  test('an OBJECT RETURN TYPE is not mistaken for the function body', () => {
    // Regression pin. The naive "first `{` after the parameter list" rule
    // captured `{ score: number; reason: string | null }` instead of the body,
    // so a trailing `;` in one copy's TYPE reported the function as drifted.
    // Two identical implementations, one spurious failure.
    const annotated = `function f(a): { score: number; reason: string | null } { return 0.5; }`;
    const withSemi = `function f(a): { score: number; reason: string | null; } { return 0.5; }`;
    const bare = `function f(a) { return 0.5; }`;

    const fp = (src) => extractFunctionBody(stripComments(src), 'f');
    expect(fp(annotated)).toBe(fp(withSemi));
    expect(fp(annotated)).toBe(fp(bare));
  });

  test('an arrow function with an annotated return type is handled', () => {
    const arrow = `const f = (a): number => { return a * 2; };`;
    expect(extractFunctionBody(stripComments(arrow), 'f')).toBe(
      extractFunctionBody(stripComments(`function f(a) { return a * 2; }`), 'f')
    );
  });
});

// ─── fail-closed behaviour ──────────────────────────────────────────────────

describe('KAN-426 drift detector — fails closed', () => {
  test('a missing constant is a parse ERROR, not a pass', () => {
    const truncated = BASE_SOURCE.replace(/const WEIGHTS = \{[^}]*\};/, '');
    expect(() => extractArtefacts(truncated, FIXTURE_PAIR)).toThrow(DriftParseError);
  });

  test('a missing function is a parse ERROR, not a pass', () => {
    const truncated = BASE_SOURCE.replace('function scoreRecency', 'function somethingElse');
    expect(() => extractArtefacts(truncated, FIXTURE_PAIR)).toThrow(DriftParseError);
  });

  test('an unbalanced brace is a parse ERROR, not a pass', () => {
    expect(() => extractConstantBlock('const WEIGHTS = { a: 1', 'WEIGHTS')).toThrow(
      DriftParseError
    );
  });

  test('a constant that parses to zero entries is a parse ERROR', () => {
    expect(() => parseNumericMap('{ }', 'WEIGHTS')).toThrow(DriftParseError);
    expect(() => parseListMap('{ }', 'KEYWORDS')).toThrow(DriftParseError);
  });

  test('an HTTP non-200 fetch is a hard failure', async () => {
    const spy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: false, status: 404, text: async () => '' });
    await expect(fetchRemote('some/path.ts')).rejects.toThrow(/HTTP 404/);
    spy.mockRestore();
  });

  test('a network error is a hard failure', async () => {
    const spy = jest.spyOn(global, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
    await expect(fetchRemote('some/path.ts')).rejects.toThrow(DriftParseError);
    spy.mockRestore();
  });

  test('an EMPTY body is a hard failure — not an empty, silently-equal source', async () => {
    const spy = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue({ ok: true, status: 200, text: async () => '   \n' });
    await expect(fetchRemote('some/path.ts')).rejects.toThrow(/empty body/);
    spy.mockRestore();
  });
});

// ─── the known-divergence register is a ratchet, not a waiver ───────────────

describe('KAN-426 known-divergence register', () => {
  const drifted = BASE_SOURCE.replace('score: 1.0, reason: null', 'score: 0.9, reason: null');

  const registerFor = (localSrc, remoteSrc) => ({
    'fixture/scoreRecency': {
      ticket: 'TEST-1',
      severity: 'catalogued',
      reason: 'fixture',
      local: extractFunctionBody(stripComments(localSrc), 'scoreRecency'),
      remote: extractFunctionBody(stripComments(remoteSrc), 'scoreRecency'),
    },
  });

  test('an exactly-catalogued divergence is acknowledged, not a finding', () => {
    const { findings, acknowledged } = compare(
      BASE_SOURCE,
      drifted,
      registerFor(BASE_SOURCE, drifted)
    );
    expect(findings).toEqual([]);
    expect(acknowledged.join('\n')).toContain('TEST-1');
  });

  test('a FURTHER change to a catalogued function still FAILS', () => {
    // The whole point of recording both fingerprints: cataloguing one known
    // difference must not blind the checker to the next one.
    const driftedMore = drifted.replace('daysSince < 7', 'daysSince < 21');
    const { findings } = compare(
      BASE_SOURCE,
      driftedMore,
      registerFor(BASE_SOURCE, drifted)
    );

    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('has a KNOWN divergence');
    expect(findings[0]).toContain('do not just update the recorded fingerprints');
  });

  test('every register entry cites a Jira key and explains itself', () => {
    for (const [key, entry] of Object.entries(KNOWN_DIVERGENCES)) {
      expect(entry.ticket).toMatch(/^(KAN|BUGS|SEC)-\d+$/);
      expect(String(entry.reason).length).toBeGreaterThan(60);
      expect(typeof entry.local).toBe('string');
      expect(typeof entry.remote).toBe('string');
      expect(entry.local).not.toBe(entry.remote); // a no-op entry is a lie
      expect(key).toMatch(/^[a-z]+\/\w+$/);
    }
  });

  test('the catalogued `scoreRecency` difference really is behaviour-preserving', () => {
    // Pins the claim made in the register: the two copies write the same
    // day-in-milliseconds constant two different ways. If this ever stops being
    // true, the entry is no longer benign and must be re-reviewed.
    expect(86400_000).toBe(1000 * 60 * 60 * 24);
  });
});

// ─── the checker must stay wired to the REAL sources ────────────────────────

describe('KAN-426 drift detector — wiring to the real sources', () => {
  test('every configured local source exists and parses', () => {
    for (const pair of PAIRS) {
      const abs = path.join(__dirname, '..', pair.localPath);
      expect(fs.existsSync(abs)).toBe(true);
      // Throws DriftParseError if a constant or function was renamed away.
      expect(() => extractArtefacts(fs.readFileSync(abs, 'utf8'), pair)).not.toThrow();
    }
  });

  test('the duplicated scorers still declare themselves duplicates', () => {
    // If someone de-duplicates these files the header changes and this test
    // says so — at which point the checker should be DELETED, not patched.
    for (const pair of PAIRS) {
      const src = fs.readFileSync(path.join(__dirname, '..', pair.localPath), 'utf8');
      expect(src).toMatch(/DUPLICATED from\s+\*?\s*lyra\/src\/lib\/recommend\/convene/);
    }
  });

  test('the file header cites the real ticket, not an unnumbered placeholder', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src/convene-recommend-scoring.ts'),
      'utf8'
    );
    expect(src).not.toContain('KAN-XXX');
    expect(src).toContain('KAN-426');
  });

  test('the fingerprint normalises numeric separators and decimal padding', () => {
    expect(numericFingerprint('86400_000')).toBe(numericFingerprint('86400000'));
    expect(numericFingerprint('0.30')).toBe(numericFingerprint('0.3'));
    expect(numericFingerprint('a > 5')).not.toBe(numericFingerprint('a >= 5'));
  });
});
