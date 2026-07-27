#!/usr/bin/env node
/**
 * KAN-426 — Convene scoring drift detector (cross-repo parity check).
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS — AND WHEN TO DELETE IT
 * ────────────────────────────────────────────────────────────────────────
 * `src/convene-recommend-scoring.ts` and `src/convene-recommend-venue-scoring.ts`
 * are VERBATIM COPIES of the Convene scorers that live in the `luisa-sys/lyra`
 * repo under `src/lib/recommend/convene/`. The MCP server cannot import
 * TypeScript across repo boundaries, so the two copies are kept in manual
 * lockstep — which is to say, they were in sync by luck. Nothing detected
 * divergence.
 *
 * This checker is the INTERIM mitigation: it re-derives the scoring
 * constants and the scoring function bodies from BOTH copies and fails the
 * build when they disagree, so a one-sided edit is caught the same day.
 *
 * RETIREMENT CONDITION: this script is deleted, together with both duplicate
 * source files, when `@lyra/contracts` lands (KAN-415 E3, via KAN-418) and the
 * MCP server consumes the scorers as a published package instead of a copy.
 * It is not a permanent fixture. Do not build on it.
 *
 * ────────────────────────────────────────────────────────────────────────
 * HOW IT COMPARES
 * ────────────────────────────────────────────────────────────────────────
 * NOT a file checksum. A whitespace or comment change must NOT red the build;
 * a changed weight or threshold MUST. So each side is reduced to normalised
 * artefacts before comparison:
 *
 *   - `WEIGHTS`                  → parsed to {key: number}, compared per key
 *                                  (so `0.30` and `0.3` are the same value)
 *   - `TRIBE_KEYWORDS_BY_INTENT` → parsed to {key: string[]}
 *   - `TYPE_FIT_BY_INTENT`       → parsed to {key: string[]} (`new Set([...])`)
 *   - scoring function bodies    → reduced to an ordered fingerprint of their
 *                                  numeric literals and comparison/arithmetic
 *                                  operators. Blind to formatting, brace style,
 *                                  trailing commas, identifier names and
 *                                  comments; sensitive to an inline threshold
 *                                  edit (`daysSince < 7` → `< 10`), a flipped
 *                                  comparison (`>` → `>=`) and an added,
 *                                  removed or reordered scoring branch.
 *
 * Differences that are already known and documented live in KNOWN_DIVERGENCES
 * below. That register is a RATCHET: it pins the exact fingerprint of BOTH
 * sides, so a catalogued function is still fully guarded against any FURTHER
 * change. It is printed as a ::warning:: on every run.
 *
 * ────────────────────────────────────────────────────────────────────────
 * SECURITY (KAN-426 §4)
 * ────────────────────────────────────────────────────────────────────────
 * - The remote source is fetched as TEXT and parsed as TEXT. It is never
 *   `eval`d, `import`ed, `require`d or executed in any form.
 * - `luisa-sys/lyra` is a PUBLIC repository, so the fetch needs NO credential
 *   at all. That is deliberately the least-privilege answer: there is no token
 *   to scope, store, leak or rotate. If lyra is ever made private this script
 *   will start failing closed with an HTTP 404 and a token will have to be
 *   introduced then — read-only, `contents` scope, that repo only.
 * - The ref is pinned explicitly (LYRA_REF, default `develop` — the branch all
 *   lyra feature work lands on). It is never left to a server-side default.
 * - FAILS CLOSED. A fetch error, a non-200, an unparseable source or a missing
 *   artefact is a FAILURE, never a skip. A drift check that silently passes
 *   when it cannot compare gives false assurance that two scorers agree when
 *   nobody has actually checked — precisely the class of false-positive green
 *   the Workflow & Backup Integrity Policy forbids.
 *
 * Usage:
 *   node scripts/check-convene-scoring-drift.cjs
 *
 * Env:
 *   LYRA_REF        git ref in luisa-sys/lyra to compare against (default: develop)
 *   LYRA_RAW_BASE   override the raw base URL (tests / mirrors)
 */

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const LYRA_REF = process.env.LYRA_REF || 'develop';
const LYRA_RAW_BASE =
  process.env.LYRA_RAW_BASE || `https://raw.githubusercontent.com/luisa-sys/lyra/${LYRA_REF}`;

/**
 * The permanent fix, named in every failure message so a future reader knows
 * this check is a stopgap and what replaces it.
 */
const PERMANENT_FIX = 'KAN-415 E3 (@lyra/contracts shared package, via KAN-418)';

/**
 * What is duplicated, and where each side lives.
 *
 * `remotePaths` is a list because the lyra copy is split across modules
 * (`types.ts` holds the shared `clamp01` / `weightedAverage` helpers that the
 * MCP copy inlines into one file); the sources are concatenated before
 * extraction so an artefact is found wherever it lives on that side.
 */
const PAIRS = [
  {
    label: 'attendee',
    localPath: 'src/convene-recommend-scoring.ts',
    remotePaths: [
      'src/lib/recommend/convene/types.ts',
      'src/lib/recommend/convene/score-attendee.ts',
    ],
    constants: [
      { name: 'WEIGHTS', kind: 'numericMap' },
      { name: 'TRIBE_KEYWORDS_BY_INTENT', kind: 'listMap' },
    ],
    functions: [
      'clamp01',
      'weightedAverage',
      'scoreTribeFit',
      'scoreRecency',
      'scoreResponseHistory',
      'scoreTypeFit',
      'scoreDiversity',
      'scoreAttendee',
    ],
  },
  {
    label: 'venue',
    localPath: 'src/convene-recommend-venue-scoring.ts',
    remotePaths: ['src/lib/recommend/convene/score-venue.ts'],
    constants: [
      { name: 'WEIGHTS', kind: 'numericMap' },
      { name: 'TYPE_FIT_BY_INTENT', kind: 'listMap' },
    ],
    functions: [
      'haversineKm',
      'scoreTypeFit',
      'scoreDistance',
      'scoreDietary',
      'scoreCapacity',
      'scorePriceTier',
      'scorePriorVisits',
      'scoreDiversityPenalty',
      'scoreExternalRating',
      'scoreVenue',
    ],
  },
];

/**
 * KNOWN DIVERGENCES — a RATCHET, not a waiver.
 *
 * Each entry records the EXACT fingerprint of both sides at the moment the
 * divergence was catalogued. The check stays green only while both sides still
 * match those recorded values. Change either copy — even inside an
 * already-catalogued function — and the fingerprints stop matching and the
 * build FAILS. So an entry here suppresses one specific, documented,
 * already-known difference and nothing else; it does not blind the checker to
 * that function's future.
 *
 * This is the same shape as `supabase/migration-privileges-baseline.json` in
 * the lyra repo: the list may shrink, never grow silently. Adding an entry is a
 * deliberate, reviewed act that must cite a Jira key.
 *
 * Every entry is printed as a ::warning:: on every run — a known divergence is
 * never invisible just because it is known.
 */
const KNOWN_DIVERGENCES = {
  'attendee/scoreRecency': {
    ticket: 'KAN-426',
    severity: 'benign',
    reason:
      'Same constant written two ways: this repo writes the day-in-milliseconds ' +
      'divisor as the numeric literal 86400_000, lyra writes it as 1000 * 60 * 60 * 24. ' +
      '86400000 === 1000*60*60*24, so behaviour is identical (pinned by an assertion in ' +
      'tests/convene-scoring-drift.test.cjs). Resolved for free when KAN-415 E3 removes ' +
      'the duplication; not worth a runtime edit in a CI-only change.',
    local:
      '|| 0.5 - / 86400000 < 7 0.3 - < 14 0.5 < 30 0.85 - < 180 1 < 365 0.75 0.55 > 1',
    remote:
      '|| 0.5 - / 1000 * 60 * 60 * 24 < 7 0.3 - < 14 0.5 < 30 0.85 - < 180 1 < 365 0.75 0.55 > 1',
  },
  'venue/scoreVenue': {
    ticket: 'BUGS-78',
    severity: 'REAL DRIFT — venue rankings differ between the web app and MCP',
    reason:
      'Both copies declare the identical 10-key WEIGHTS map, but this repo\'s scoreVenue ' +
      'only ever populates 8 of them: it never calls an openingHours or accessibility ' +
      'factor, which lyra scores via scoreOpeningHours() and scoreAccessibilityFit(). ' +
      'weightedAverage() sums only the weights of keys present in `breakdown`, so MCP ' +
      'normalises over 0.90 of weight against lyra\'s 1.00 and drops the accessibility ' +
      'signal entirely — the same venue set can rank differently on mcp.checklyra.com ' +
      'than on checklyra.com. Porting the two factors is a behaviour change to a shipped ' +
      'MCP tool and is out of scope for this CI-only ticket: raised as BUGS-78.',
    local: '!= && < < ?? => > 0 ?? > 0 => === 0 0.6 === 0 ? 1 1 => => =>',
    remote: '!= && < 0 < ?? => > 0 0 ?? > 0 => === 0 0 => =>',
  },
};

// ─── parse errors are a distinct class: they must fail closed, loudly ────────

class DriftParseError extends Error {}

// ─── text normalisation ─────────────────────────────────────────────────────

/**
 * Remove `//` and block comments without corrupting string/template literals.
 * Character-by-character rather than regex, because a regex over `//` happily
 * eats the `//` inside a URL in a string and silently changes the artefact.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      // Preserve a separator so `a/*x*/b` does not become `ab`.
      out += ' ';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        if (src[i] === '\\') {
          out += src[i] + (src[i + 1] ?? '');
          i += 2;
          continue;
        }
        out += src[i];
        if (src[i] === quote) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Collapse every whitespace run to one space. Comments must be gone already. */
function normaliseWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Reduce a function body to an ordered stream of the tokens that can change
 * its OUTPUT: numeric literals and comparison/arithmetic operators.
 *
 * Comparing normalised body text was tried first and is too strict — the two
 * copies already differ in brace style around single-statement `if`s and in
 * trailing commas, which changes nothing a caller can observe. A checker that
 * fires on that gets waived, and a waived checker is worse than none.
 *
 * The fingerprint is deliberately blind to formatting, identifier names and
 * comments, and deliberately sensitive to:
 *   - a changed weight or threshold   0.85 → 0.9,  `> 5` → `> 8`
 *   - a flipped comparison            `>` → `>=`
 *   - a reordered / added / removed scoring branch
 *
 * Numeric literals are normalised through Number(), so `0.30` and `0.3` are
 * the same token and `86400_000` and `86400000` are the same token.
 */
function numericFingerprint(bodyText) {
  const tokens = [];
  const re = /(\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)|(===|!==|==|!=|<=|>=|=>|&&|\|\||\?\?|[<>+\-*/%?])/g;
  let m;
  while ((m = re.exec(bodyText)) !== null) {
    if (m[1] !== undefined) tokens.push(String(Number(m[1].replace(/_/g, ''))));
    else tokens.push(m[2]);
  }
  return tokens.join(' ');
}

/**
 * Return the balanced `{...}` (or `(...)`) block starting at `startIndex`,
 * inclusive of the delimiters. Skips over string literals so a brace inside a
 * string cannot unbalance the scan.
 */
function readBalanced(src, startIndex, open, close) {
  let depth = 0;
  let i = startIndex;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') {
          i += 2;
          continue;
        }
        if (src[i] === quote) break;
        i++;
      }
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return src.slice(startIndex, i + 1);
    }
  }
  throw new DriftParseError(
    `unbalanced '${open}' starting at offset ${startIndex} — source could not be parsed`
  );
}

// ─── artefact extraction ────────────────────────────────────────────────────

/** Extract the `{...}` initialiser of `const <name> = {...}` (comment-free source). */
function extractConstantBlock(cleanSrc, name) {
  const decl = new RegExp(`\\bconst\\s+${name}\\b[^=]*=\\s*`, 'g');
  const m = decl.exec(cleanSrc);
  if (!m) {
    throw new DriftParseError(`constant \`${name}\` not found`);
  }
  const braceAt = cleanSrc.indexOf('{', m.index + m[0].length - 1);
  if (braceAt === -1) {
    throw new DriftParseError(`constant \`${name}\` has no object initialiser`);
  }
  return readBalanced(cleanSrc, braceAt, '{', '}');
}

const TYPE_OPENERS = { '{': '}', '(': ')', '[': ']', '<': '>' };

/**
 * Skip a TypeScript return-type annotation, starting just after its `:`.
 * Returns the index of the first character past the annotation.
 *
 * This exists because the naive "first `{` after the parameter list is the
 * body" rule is WRONG for an object return type — it captures
 * `{ score: number; reason: string | null }` and reports every such function
 * as drifted the moment one copy writes a trailing `;` and the other does not.
 * That was observed on `scoreResponseHistory` while building this check: two
 * identical implementations, one spurious failure. A checker whose false
 * positives get waived is a checker nobody believes.
 */
function skipTypeAnnotation(src, start, stopAtArrow = false) {
  let i = start;
  const skipWs = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  for (;;) {
    skipWs();
    const close = TYPE_OPENERS[src[i]];
    if (close) {
      i += readBalanced(src, i, src[i], close).length;
    } else {
      const before = i;
      while (i < src.length && /[A-Za-z0-9_$.]/.test(src[i])) i++;
      if (i === before) break; // nothing consumable — stop and let the caller judge
    }
    skipWs();
    if (src[i] === '|' || src[i] === '&' || src[i] === ',') {
      i++;
      continue;
    }
    if (src.startsWith('=>', i)) {
      // For an arrow function (`const f = (a): T => {...}`) this `=>` is the
      // arrow itself, not a function-type arrow inside the return type — stop,
      // or we would swallow the body as if it were part of the annotation.
      if (stopAtArrow) break;
      i += 2;
      continue;
    }
    if (src[i] === '[' || src[i] === '<') continue; // array / generic suffix
    break;
  }
  return i;
}

/**
 * Extract the body of `function <name>(...)` / `const <name> = (...) =>`, as a
 * normalised token stream. Covers both the exported and module-private forms
 * used across the two copies, and both bare and annotated return types.
 */
function extractFunctionBody(cleanSrc, name) {
  const patterns = [
    { re: new RegExp(`\\bfunction\\s+${name}\\s*\\(`, 'g'), arrow: false },
    {
      re: new RegExp(`\\bconst\\s+${name}\\s*(?::[^=]*)?=\\s*(?:async\\s*)?\\(`, 'g'),
      arrow: true,
    },
  ];
  for (const { re, arrow } of patterns) {
    const m = re.exec(cleanSrc);
    if (!m) continue;

    // m[0] ends at the '(' that opens the parameter list.
    const parenAt = m.index + m[0].length - 1;
    let i = parenAt + readBalanced(cleanSrc, parenAt, '(', ')').length;

    while (i < cleanSrc.length && /\s/.test(cleanSrc[i])) i++;
    if (cleanSrc[i] === ':') i = skipTypeAnnotation(cleanSrc, i + 1, arrow);
    while (i < cleanSrc.length && /\s/.test(cleanSrc[i])) i++;
    if (cleanSrc.startsWith('=>', i)) i += 2;
    while (i < cleanSrc.length && /\s/.test(cleanSrc[i])) i++;

    if (cleanSrc[i] !== '{') {
      throw new DriftParseError(
        `function \`${name}\` found but its body could not be located`
      );
    }
    return numericFingerprint(readBalanced(cleanSrc, i, '{', '}'));
  }
  throw new DriftParseError(`function \`${name}\` not found`);
}

/** `{ tribeFit: 0.30, ... }` → `{ tribeFit: 0.3, ... }` (numbers, not text). */
function parseNumericMap(block, name) {
  const out = {};
  const re = /([A-Za-z_$][\w$]*)\s*:\s*(-?\d+(?:\.\d+)?)/g;
  let m;
  while ((m = re.exec(block)) !== null) out[m[1]] = Number(m[2]);
  if (Object.keys(out).length === 0) {
    throw new DriftParseError(`constant \`${name}\` parsed to zero numeric entries`);
  }
  return out;
}

/** `{ coffee: ['a','b'] }` and `{ coffee: new Set(['a','b']) }` → `{ coffee: ['a','b'] }`. */
function parseListMap(block, name) {
  const out = {};
  const re = /([A-Za-z_$][\w$]*)\s*:\s*(?:new\s+Set\s*\(\s*)?\[([\s\S]*?)\]/g;
  let m;
  while ((m = re.exec(block)) !== null) {
    const items = [];
    const itemRe = /['"`]([^'"`]*)['"`]/g;
    let im;
    while ((im = itemRe.exec(m[2])) !== null) items.push(im[1]);
    out[m[1]] = items;
  }
  if (Object.keys(out).length === 0) {
    throw new DriftParseError(`constant \`${name}\` parsed to zero list entries`);
  }
  return out;
}

/**
 * Reduce one side of a pair to its comparable artefacts.
 * Throws DriftParseError if anything the pair declares is missing — a source
 * we cannot parse is a failure, not a pass.
 */
function extractArtefacts(sourceText, pair) {
  const clean = stripComments(sourceText);
  const constants = {};
  for (const spec of pair.constants) {
    const block = extractConstantBlock(clean, spec.name);
    constants[spec.name] =
      spec.kind === 'numericMap'
        ? parseNumericMap(block, spec.name)
        : parseListMap(block, spec.name);
  }
  const functions = {};
  for (const fnName of pair.functions) {
    functions[fnName] = extractFunctionBody(clean, fnName);
  }
  return { constants, functions };
}

// ─── comparison ─────────────────────────────────────────────────────────────

/**
 * Compare two extracted sides. Returns a list of human-readable drift
 * descriptions — empty means in sync.
 */
function compareArtefacts(local, remote, label, known = KNOWN_DIVERGENCES) {
  const findings = [];
  const acknowledged = [];

  for (const constName of Object.keys(local.constants)) {
    const l = local.constants[constName];
    const r = remote.constants[constName];
    if (!r) {
      findings.push(`[${label}] \`${constName}\` is missing from the lyra copy`);
      continue;
    }
    for (const key of new Set([...Object.keys(l), ...Object.keys(r)])) {
      const lv = l[key];
      const rv = r[key];
      const same = Array.isArray(lv) && Array.isArray(rv)
        ? lv.length === rv.length && lv.every((v, i) => v === rv[i])
        : lv === rv;
      if (!same) {
        findings.push(
          `[${label}] ${constName}.${key} differs — ` +
            `lyra-mcp-server: ${JSON.stringify(lv ?? null)} · ` +
            `lyra: ${JSON.stringify(rv ?? null)}`
        );
      }
    }
  }

  for (const fnName of Object.keys(local.functions)) {
    const l = local.functions[fnName];
    const r = remote.functions[fnName];
    if (l === r) continue;

    const key = `${label}/${fnName}`;
    const entry = known[key];
    if (entry && entry.local === l && entry.remote === r) {
      // Exactly the catalogued difference, on both sides. Loud, but not fatal.
      acknowledged.push(`[${key}] known divergence (${entry.ticket}): ${entry.severity}`);
      continue;
    }
    if (entry) {
      findings.push(
        `[${key}] has a KNOWN divergence (${entry.ticket}) but the sources have ` +
          `changed since it was catalogued — re-review it, do not just update the ` +
          `recorded fingerprints\n` +
          `        recorded  mcp: ${entry.local}\n` +
          `        actual    mcp: ${l}\n` +
          `        recorded lyra: ${entry.remote}\n` +
          `        actual   lyra: ${r}`
      );
      continue;
    }
    findings.push(
      `[${label}] function \`${fnName}\` differs — its numeric/operator ` +
        `fingerprint has diverged, i.e. a weight, threshold, comparison or ` +
        `scoring branch is not the same in both copies\n` +
        `        lyra-mcp-server: ${l}\n` +
        `        lyra:            ${r}`
    );
  }

  return { findings, acknowledged };
}

// ─── I/O ────────────────────────────────────────────────────────────────────

function readLocal(relPath) {
  const abs = path.join(REPO_ROOT, relPath);
  if (!fs.existsSync(abs)) {
    throw new DriftParseError(`local source missing: ${relPath}`);
  }
  return fs.readFileSync(abs, 'utf8');
}

/** Fetch remote source as TEXT. Never executed. Non-200 is a hard failure. */
async function fetchRemote(relPath) {
  const url = `${LYRA_RAW_BASE}/${relPath}`;
  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'text/plain' } });
  } catch (err) {
    throw new DriftParseError(`fetch failed for ${url}: ${err.message}`);
  }
  if (!res.ok) {
    throw new DriftParseError(`fetch returned HTTP ${res.status} for ${url}`);
  }
  const text = await res.text();
  if (!text.trim()) {
    throw new DriftParseError(`fetch returned an empty body for ${url}`);
  }
  return text;
}

// ─── entry point ────────────────────────────────────────────────────────────

async function main() {
  console.log(
    `Convene scoring drift check (KAN-426) — comparing against luisa-sys/lyra@${LYRA_REF}`
  );

  const findings = [];
  for (const pair of PAIRS) {
    const localText = readLocal(pair.localPath);
    const remoteTexts = [];
    for (const rp of pair.remotePaths) remoteTexts.push(await fetchRemote(rp));

    const local = extractArtefacts(localText, pair);
    const remote = extractArtefacts(remoteTexts.join('\n'), pair);
    const result = compareArtefacts(local, remote, pair.label);
    findings.push(...result.findings);

    const nConst = pair.constants.length;
    const nFn = pair.functions.length;
    console.log(
      `  ${result.findings.length === 0 ? 'OK  ' : 'DRIFT'} ${pair.label}: ` +
        `${nConst} constant(s) + ${nFn} function(s) compared`
    );
    for (const a of result.acknowledged) console.log(`::warning::${a}`);
  }

  if (findings.length > 0) {
    for (const f of findings) console.error(`::error::${f}`);
    console.error('');
    console.error(
      `Convene scoring has DRIFTED between luisa-sys/lyra-mcp-server and ` +
        `luisa-sys/lyra@${LYRA_REF} (${findings.length} difference(s) above).`
    );
    console.error(
      'These two scorers are verbatim copies of each other; any change to ' +
        'weights, keywords or thresholds MUST land in both repos.'
    );
    console.error(`Permanent fix that removes the duplication: ${PERMANENT_FIX}.`);
    process.exitCode = 1;
    return;
  }

  const knownCount = Object.keys(KNOWN_DIVERGENCES).length;
  console.log(
    `No new drift. ${knownCount} known divergence(s) acknowledged above — ` +
      `see KNOWN_DIVERGENCES in ${path.relative(REPO_ROOT, __filename)}.`
  );
}

if (require.main === module) {
  main().catch((err) => {
    // Fail CLOSED: parse failure, fetch failure, anything unexpected.
    console.error(`::error::Convene scoring drift check could not complete: ${err.message}`);
    console.error(
      'Failing closed — a drift check that passes when it cannot compare is ' +
        'worse than no check at all.'
    );
    process.exitCode = 1;
  });
}

module.exports = {
  PAIRS,
  KNOWN_DIVERGENCES,
  PERMANENT_FIX,
  DriftParseError,
  stripComments,
  normaliseWhitespace,
  numericFingerprint,
  readBalanced,
  extractConstantBlock,
  extractFunctionBody,
  parseNumericMap,
  parseListMap,
  extractArtefacts,
  compareArtefacts,
  fetchRemote,
  main,
};
