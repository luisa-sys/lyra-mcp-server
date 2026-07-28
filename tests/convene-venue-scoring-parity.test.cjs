/**
 * BUGS-78 — venue scoring parity between this repo and
 * lyra/src/lib/recommend/convene/score-venue.ts.
 *
 * Behavioural tests import the COMPILED module (`npx tsc` must have run — the
 * same precondition as tests/mcp-server.test.cjs). Structural tests read the
 * source so they stay meaningful even before a build.
 *
 * What this file pins, and why it is worded the way it is:
 *
 * BUGS-78 as filed claimed this repo's `scoreVenue` populated only 8 of the 10
 * weighted keys, normalised over 0.90 of weight, and therefore RANKED venues
 * differently from the web app. That diagnosis was wrong. The old code did
 * populate all ten keys — `openingHours` and `accessibility` were inline
 * object literals (`{ score: 0.6 }` and `{ score: ... ? 1.0 : 1.0 }`) rather
 * than calls to named factor functions. Both produced exactly the scores the
 * ported functions produce, so the fix changes NO score and NO ranking; a
 * 900-case differential run over the pre-fix and post-fix modules found zero
 * score and zero breakdown differences.
 *
 * The real defect was narrower and is what these tests guard:
 *   1. the `Accessibility: <flags> ✓` reason was never emitted by MCP, so an
 *      agent's explanation of a venue omitted the accessibility rationale the
 *      app shows;
 *   2. the inline literals meant `scoreOpeningHours` and `scoreAccessibilityFit`
 *      did not exist here at all, so the KAN-426 drift check could not compare
 *      them — the divergence was structurally invisible rather than benign.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const scoringSrc = fs.readFileSync(path.join(root, 'src/convene-recommend-venue-scoring.ts'), 'utf8');
const driftSrc = fs.readFileSync(path.join(root, 'scripts/check-convene-scoring-drift.cjs'), 'utf8');

// The weights both copies declare. Duplicated here deliberately: a test that
// imported WEIGHTS from the module under test would pass even if every weight
// were wrong.
const WEIGHTS = {
  typeFit: 0.20,
  distance: 0.20,
  dietaryFit: 0.10,
  capacity: 0.05,
  openingHours: 0.05,
  priceTier: 0.05,
  accessibility: 0.05,
  priorVisits: 0.10,
  diversityPenalty: 0.10,
  externalRating: 0.10,
};

const NOW = Date.parse('2026-07-28T00:00:00Z');

function candidate(overrides = {}) {
  return {
    venueId: 'v1',
    name: 'The Test Rooms',
    venueType: 'restaurant',
    city: null,
    postcode: null,
    lat: null,
    lng: null,
    priceTier: null,
    capacityEstimate: 10,
    accessibilityFlags: [],
    dietaryFlags: [],
    externalRating: null,
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    intent: 'dinner',
    anchor: null,
    capacityRequired: 4,
    required: {},
    preferred: {},
    ...overrides,
  };
}

let scoreVenue;

beforeAll(async () => {
  ({ scoreVenue } = await import('../dist/convene-recommend-venue-scoring.js'));
});

describe('BUGS-78 — all ten weighted factors are populated', () => {
  test('breakdown carries exactly the ten keys WEIGHTS declares', () => {
    const result = scoreVenue(candidate(), context(), NOW);
    expect(Object.keys(result.breakdown).sort()).toEqual(Object.keys(WEIGHTS).sort());
  });

  test('weight actually used by weightedAverage is 1.00, not 0.90', () => {
    const result = scoreVenue(candidate(), context(), NOW);
    const totalWeight = Object.keys(result.breakdown).reduce((sum, k) => sum + (WEIGHTS[k] ?? 0), 0);
    expect(totalWeight).toBeCloseTo(1.0, 10);
  });

  test('score equals the independently computed weighted average of the breakdown', () => {
    const result = scoreVenue(
      candidate({ capacityEstimate: 12, externalRating: 4.6, priceTier: 2 }),
      context({ preferred: { priceTier: 2 } }),
      NOW
    );
    let totalWeight = 0;
    let totalScore = 0;
    for (const [key, value] of Object.entries(result.breakdown)) {
      totalWeight += WEIGHTS[key];
      totalScore += value * WEIGHTS[key];
    }
    expect(result.score).toBeCloseTo(totalScore / totalWeight, 10);
  });

  test('openingHours is the neutral 0.6 placeholder lyra uses', () => {
    expect(scoreVenue(candidate(), context(), NOW).breakdown.openingHours).toBe(0.6);
  });
});

describe('BUGS-78 — accessibility factor matches the lyra copy', () => {
  test('no accessibility required: score 1.0 and no accessibility reason', () => {
    const result = scoreVenue(candidate(), context(), NOW);
    expect(result.breakdown.accessibility).toBe(1.0);
    expect(result.reasons.some((r) => r.startsWith('Accessibility:'))).toBe(false);
  });

  test('required accessibility satisfied: emits the "Accessibility: ... ✓" reason', () => {
    const result = scoreVenue(
      candidate({ accessibilityFlags: ['step_free', 'hearing_loop'] }),
      context({ required: { accessibility: ['step_free', 'hearing_loop'] } }),
      NOW
    );
    expect(result.breakdown.accessibility).toBe(1.0);
    expect(result.reasons).toContain('Accessibility: step_free, hearing_loop ✓');
  });

  test('required accessibility missing is still a HARD filter, not a soft penalty', () => {
    const result = scoreVenue(
      candidate({ accessibilityFlags: [] }),
      context({ required: { accessibility: ['step_free'] } }),
      NOW
    );
    expect(result.hardFilterFailed).toBe('accessibility');
    expect(result.score).toBe(0);
    expect(result.reasons).toEqual(['Missing accessibility: step_free']);
  });
});

describe('BUGS-78 — hard-filter early returns use the ten-key zero breakdown', () => {
  const cases = [
    [
      'capacity',
      candidate({ capacityEstimate: 2 }),
      context({ capacityRequired: 10 }),
      'Capacity 2 < required 10',
    ],
    [
      'accessibility',
      candidate({ accessibilityFlags: [] }),
      context({ required: { accessibility: ['step_free'] } }),
      'Missing accessibility: step_free',
    ],
    [
      'dietary',
      candidate({ dietaryFlags: ['halal'] }),
      context({ required: { dietary: ['vegan'] } }),
      'No dietary match for vegan',
    ],
  ];

  test.each(cases)('%s failure returns score 0 and an all-zero ten-key breakdown', (kind, c, ctx, reason) => {
    const result = scoreVenue(c, ctx, NOW);
    expect(result.hardFilterFailed).toBe(kind);
    expect(result.score).toBe(0);
    expect(result.reasons).toEqual([reason]);
    expect(Object.keys(result.breakdown).sort()).toEqual(Object.keys(WEIGHTS).sort());
    expect(Object.values(result.breakdown).every((v) => v === 0)).toBe(true);
  });
});

describe('BUGS-78 — the fix changed no score (regression guard on the ranking claim)', () => {
  // The pre-fix inline literals were `{ score: 0.6 }` for openingHours and
  // `{ score: requiredAcc.length === 0 ? 1.0 : 1.0 }` for accessibility — i.e.
  // 0.6 and 1.0 unconditionally. Since the accessibility hard filter has
  // already excluded every candidate that fails a required flag, the ported
  // scoreAccessibilityFit can only ever return 1.0 from within scoreVenue.
  // These assertions fail if a future edit makes either factor conditional,
  // which WOULD move rankings and would need its own ticket.
  test('accessibility scores 1.0 for every candidate that survives the hard filter', () => {
    const variants = [
      [[], {}],
      [['step_free'], {}],
      [['step_free'], { accessibility: ['step_free'] }],
      [['step_free', 'hearing_loop'], { accessibility: ['step_free'] }],
      [['step_free', 'hearing_loop'], { accessibility: ['step_free', 'hearing_loop'] }],
    ];
    for (const [flags, required] of variants) {
      const result = scoreVenue(candidate({ accessibilityFlags: flags }), context({ required }), NOW);
      expect(result.hardFilterFailed).toBeUndefined();
      expect(result.breakdown.accessibility).toBe(1.0);
    }
  });

  test('openingHours is unconditional, so it cannot reorder candidates', () => {
    const variants = [
      candidate(),
      candidate({ venueType: 'cafe', priceTier: 4 }),
      candidate({ postcode: 'SW1A 1AA', externalRating: 4.9 }),
    ];
    for (const c of variants) {
      expect(scoreVenue(c, context(), NOW).breakdown.openingHours).toBe(0.6);
    }
  });
});

describe('BUGS-78 — structural parity with the lyra copy', () => {
  test('scoreOpeningHours and scoreAccessibilityFit exist as named functions', () => {
    expect(scoringSrc).toMatch(/function scoreOpeningHours\(\)/);
    expect(scoringSrc).toMatch(/function scoreAccessibilityFit\(/);
  });

  test('scoreVenue calls them rather than inlining a literal factor', () => {
    expect(scoringSrc).toMatch(/openingHours: scoreOpeningHours\(\)/);
    expect(scoringSrc).toMatch(/accessibility: scoreAccessibilityFit\(candidate, context\)/);
  });

  test('the local makeFailed helper is gone, replaced by lyra\'s zeroBreakdown', () => {
    expect(scoringSrc).not.toMatch(/makeFailed/);
    expect(scoringSrc).toMatch(/function zeroBreakdown\(\)/);
  });
});

describe('BUGS-78 — the KAN-426 drift register no longer waives scoreVenue', () => {
  test("KNOWN_DIVERGENCES has no 'venue/scoreVenue' entry", () => {
    expect(driftSrc).not.toMatch(/'venue\/scoreVenue':/);
  });

  test('the drift check now compares both newly-ported factor functions', () => {
    expect(driftSrc).toMatch(/'scoreOpeningHours',/);
    expect(driftSrc).toMatch(/'scoreAccessibilityFit',/);
  });
});
