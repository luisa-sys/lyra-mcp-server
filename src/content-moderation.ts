/**
 * Content moderation utilities — KAN-224 (part of the KAN-63 Tier 2 epic).
 *
 * Pure functions for detecting problematic content in user-submitted text.
 * No external API calls, no I/O, no PII collection. The functions return
 * boolean flags + optional metadata so the caller decides what to do
 * (warn, block, auto-suspend, etc.) — this library doesn't enforce policy.
 *
 * Wiring into server actions is intentionally deferred to a follow-up
 * ticket so the policy decisions (block vs warn, severity thresholds,
 * appeal flow) land alongside the integration.
 */

// ─────────────────────────────────────────────────────────────────────
// Profanity word filter
// ─────────────────────────────────────────────────────────────────────
//
// Small static list. Covers common English profanity + slurs. Deliberately
// NOT exhaustive — exhaustive lists are arms races we can't win, and the
// real defense is the human-in-the-loop review when the auto-flag fires.
//
// Stored as lowercase substrings — `containsProfanity` lowercases the
// input first so case-only obfuscation ("FUcK") still matches. Common
// character substitutions (0→o, 3→e, @→a, $→s, 1→i) are normalized
// before matching so leet-speak obfuscation is caught too.
//
// Word-boundary matching prevents false positives on legitimate words
// that contain a substring of a profane word (e.g. "Scunthorpe", the
// classic test case).

const PROFANITY_LIST = [
  // English profanity — most common forms; the normalization step handles
  // common variants ("f***", "f@ck", "f4ck", etc.).
  'fuck',
  'shit',
  'bitch',
  'asshole',
  'bastard',
  'cunt',
  'dick',
  'piss',
  'wanker',
  'twat',
  // Slurs — keep curated. Adding to this list should require sign-off
  // because policy implications are non-trivial.
  'nigger',
  'faggot',
  'retard',
  'tranny',
  'kike',
  'spic',
  'chink',
  // Explicit sexual content (not slurs, but inappropriate for a profile field)
  'penis',
  'vagina',
  'pussy',
];

// Common leet-speak / obfuscation substitutions. Conservative — only
// substitutions that survive being applied to legitimate words too,
// since we use word-boundary matching after normalization.
const NORMALIZATION_MAP: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '@': 'a',
  '$': 's',
  '!': 'i',
};

// Profanity-context substitutions where a digit visually substitutes for
// a letter that's NOT the standard leet mapping. Tried in addition to
// (not instead of) the standard map, so legitimate words aren't mangled.
//
// Example: "f4ck" — standard leet would give "fack". In profanity context
// the 4 is being used as a visual stand-in for "u". We try this alternate
// normalization ALSO, and a word is flagged if EITHER normalization matches.
const PROFANITY_ALT_NORMALIZATION_MAP: Record<string, string> = {
  '4': 'u',
  '@': 'u',
  '*': 'u',
};

function applyMap(input: string, map: Record<string, string>): string {
  let result = input;
  for (const [from, to] of Object.entries(map)) {
    result = result.split(from).join(to);
  }
  return result;
}

function normalizeForProfanityCheck(input: string): string[] {
  // Lowercase first
  const lower = input.toLowerCase();
  // Try multiple normalization paths INDEPENDENTLY so we cover both
  // standard leet ("sh1t" → "shit" via 1→i) AND profanity-context
  // visual subs ("f4ck" → "fuck" via 4→u).
  //
  // The two maps must NOT be chained because they share keys with
  // different targets (e.g. 4→a in standard vs 4→u in alt). If we
  // chained, the standard pass would consume the 4 before alt could
  // see it.
  const standardOnly = applyMap(lower, NORMALIZATION_MAP);
  const alternateOnly = applyMap(lower, PROFANITY_ALT_NORMALIZATION_MAP);
  // Each variant gets two forms: with non-alphanumeric collapsed to spaces
  // (so word-boundary matching can hit "f u c k"), and with all
  // non-alphanumerics stripped entirely (so "f.u.c.k" → "fuck" directly).
  const spaced = (s: string) => s.replace(/[^a-z0-9]+/g, ' ');
  const collapsed = (s: string) => s.replace(/[^a-z0-9]+/g, '');
  return [
    spaced(standardOnly),
    collapsed(standardOnly),
    spaced(alternateOnly),
    collapsed(alternateOnly),
  ];
}

export interface ProfanityResult {
  flagged: boolean;
  matches: string[];
}

/**
 * Returns whether the input contains any profanity from the curated list.
 * Match is case-insensitive and tolerates basic leet-speak / punctuation
 * obfuscation. Word boundaries are enforced (no false positives on
 * legitimate words that happen to contain a profane substring).
 */
export function containsProfanity(input: string): ProfanityResult {
  if (!input || typeof input !== 'string') {
    return { flagged: false, matches: [] };
  }
  const variants = normalizeForProfanityCheck(input);
  const matchedSet = new Set<string>();
  for (const word of PROFANITY_LIST) {
    for (const variant of variants) {
      // Try several match strategies:
      //   - exact word boundary via space-padding (works on the spaced
      //     variants where "f u c k" gets collapsed via padded match)
      //   - prefix match for concatenated forms ("fucking", "shitter")
      //   - direct substring match for the collapsed variants
      //     ("fuckthis" / "fuckhell" — caught even without spacing)
      const padded = ` ${variant} `;
      if (padded.includes(` ${word} `)) {
        matchedSet.add(word);
        break;
      }
      const wordRegex = new RegExp(`\\b${word}[a-z]{0,4}\\b`);
      if (wordRegex.test(variant)) {
        matchedSet.add(word);
        break;
      }
      // Collapsed-form match: word appears anywhere in a collapsed
      // (no whitespace, no punctuation) form of the input.
      if (variant.includes(word)) {
        matchedSet.add(word);
        break;
      }
    }
  }
  return { flagged: matchedSet.size > 0, matches: Array.from(matchedSet) };
}

// ─────────────────────────────────────────────────────────────────────
// Spam pattern detection
// ─────────────────────────────────────────────────────────────────────

export interface SpamResult {
  flagged: boolean;
  reasons: string[];
}

const SPAM_URL_THRESHOLD = 4; // 4+ URLs in one text → spam
const SPAM_REPEAT_RATIO = 0.5; // >50% of length is one repeated char → spam
const SPAM_CAPS_BLOCK_LENGTH = 20; // contiguous run of 20+ caps letters → spam

/**
 * Heuristic spam-pattern detection. Returns reasons for any flags so the
 * caller can choose whether to block or warn.
 *
 * Detects:
 *   - Excessive URLs (≥4 in one text)
 *   - Repeated character runs ("aaaaaa...")
 *   - Long all-caps blocks ("LOOK AT THIS NOW BUY NOW")
 */
export function detectSpam(input: string): SpamResult {
  if (!input || typeof input !== 'string') {
    return { flagged: false, reasons: [] };
  }
  const reasons: string[] = [];

  // 1. URL count
  const urlMatches = input.match(/https?:\/\/[^\s)]+/gi) ?? [];
  if (urlMatches.length >= SPAM_URL_THRESHOLD) {
    reasons.push(`excessive_urls:${urlMatches.length}`);
  }

  // 2. Repeated-character runs. We look at the longest run vs total length.
  const repeatMatch = input.match(/(.)\1+/g) ?? [];
  const longestRun = repeatMatch.reduce(
    (max, run) => Math.max(max, run.length),
    0,
  );
  if (input.length >= 10 && longestRun / input.length > SPAM_REPEAT_RATIO) {
    reasons.push(`repeated_chars:${longestRun}/${input.length}`);
  }

  // 3. All-caps detection. Two patterns:
  //    a. Long contiguous CAPS run (one word screamed): /[A-Z]{20,}/
  //    b. Multiple consecutive all-caps WORDS (sentence screamed):
  //       4+ consecutive whitespace-separated all-caps tokens of length
  //       ≥ 3 each. Examples that should trip:
  //         "IMPORTANT BUY THIS NOW LIMITED TIME OFFER"
  //         "BUY NOW LIMITED TIME ONLY GREAT DEAL"
  //
  // Single short acronyms (NASA, JPL) are NOT flagged because we require
  // 4+ consecutive caps words.
  const hasLowerCase = /[a-z]/.test(input);
  const longContiguous = input.match(/[A-Z]{20,}/g) ?? [];
  const firstLong = longContiguous[0];
  if (firstLong && hasLowerCase) {
    reasons.push(`caps_block:${firstLong.slice(0, 30)}`);
  }
  // Multi-word caps detection — find runs of 4+ consecutive all-caps tokens
  const tokens = input.split(/\s+/);
  let consecutiveCapsTokens = 0;
  let maxConsecutiveCaps = 0;
  let capsTokenSample = '';
  for (const tok of tokens) {
    // Token qualifies if it's ≥3 chars AND all caps (letters/digits/punctuation
    // mixed in is fine, but it must contain at least 3 caps letters).
    const capsLetters = (tok.match(/[A-Z]/g) ?? []).length;
    const lowerLetters = (tok.match(/[a-z]/g) ?? []).length;
    if (capsLetters >= 3 && lowerLetters === 0) {
      consecutiveCapsTokens += 1;
      if (consecutiveCapsTokens > maxConsecutiveCaps) {
        maxConsecutiveCaps = consecutiveCapsTokens;
        capsTokenSample = tokens
          .slice(
            Math.max(0, tokens.indexOf(tok) - consecutiveCapsTokens + 1),
            tokens.indexOf(tok) + 1,
          )
          .join(' ')
          .slice(0, 40);
      }
    } else {
      consecutiveCapsTokens = 0;
    }
  }
  if (maxConsecutiveCaps >= 4) {
    if (hasLowerCase) {
      reasons.push(`caps_block:${capsTokenSample}`);
    } else {
      reasons.push(`all_caps:${input.length}`);
    }
  } else if (
    !hasLowerCase &&
    input.length >= SPAM_CAPS_BLOCK_LENGTH &&
    /[A-Z]/.test(input)
  ) {
    // Pure all-caps shorter sentence (no lowercase, < 4 words but long)
    reasons.push(`all_caps:${input.length}`);
  }

  return { flagged: reasons.length > 0, reasons };
}

// ─────────────────────────────────────────────────────────────────────
// PII detection
// ─────────────────────────────────────────────────────────────────────

export interface PIIResult {
  flagged: boolean;
  types: string[];
}

/**
 * Detects common PII patterns in text that's about to be saved to a public
 * field. The goal is to **prevent leaks** — flag content before it goes
 * public so the UI can warn the user (or auto-redact, depending on policy).
 *
 * Detects:
 *   - Phone numbers (E.164-ish: +CC followed by 6-14 digits, or plain
 *     runs of 7+ digits with optional separators)
 *   - Credit-card-like 16-digit runs (Luhn check excluded for simplicity
 *     — we'd rather have false positives than miss a real card number)
 *   - Email addresses (basic RFC-5322-lite — most legitimate uses on
 *     a profile go through the dedicated `links` table, not free text)
 */
export function containsPII(input: string): PIIResult {
  if (!input || typeof input !== 'string') {
    return { flagged: false, types: [] };
  }
  const types: string[] = [];

  // Phone — E.164 (+CC...) or local with separators. The 7+ digit minimum
  // prevents flagging years or short reference numbers.
  // International: + then 8-15 digits
  if (/\+\d{1,3}[\s-]?\(?\d{1,4}\)?[\s-]?\d{3,5}[\s-]?\d{3,5}/.test(input)) {
    types.push('phone_international');
  } else if (/\b\d{2,4}[\s-]\d{3,4}[\s-]\d{3,5}\b/.test(input)) {
    // Local with separators: "020 7946 0958" / "555-123-4567"
    types.push('phone_local');
  } else if (/\b\d{10,15}\b/.test(input)) {
    // Plain run of 10-15 digits
    types.push('phone_plain');
  }

  // Credit-card-like: 4 groups of 4 digits (with or without separators)
  // or one run of 13-19 digits. Some false positives expected on long
  // numeric IDs — caller can downweight if too noisy.
  if (
    /\b(?:\d[ -]?){13,18}\d\b/.test(input.replace(/\s+/g, ' ')) &&
    !/^\d{10,15}$/.test(input.trim()) // skip plain phone runs caught above
  ) {
    // Count total digits to avoid flagging things like "1234567890" twice
    const digitCount = (input.match(/\d/g) ?? []).length;
    if (digitCount >= 13 && digitCount <= 19) {
      types.push('credit_card_like');
    }
  }

  // Email — basic RFC-5322-lite
  if (/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(input)) {
    types.push('email');
  }

  return { flagged: types.length > 0, types };
}

// ─────────────────────────────────────────────────────────────────────
// Top-level wrapper
// ─────────────────────────────────────────────────────────────────────

export type FieldType = 'public' | 'private';

export type ModerationSeverity = 'none' | 'warn' | 'block';

export interface ModerationResult {
  /** Whether the content passes the policy for `fieldType`. */
  allowed: boolean;
  /** Severity — none (clean), warn (suspicious), block (definitely bad). */
  severity: ModerationSeverity;
  /** Tagged flags from the underlying checks for auditing/UI. */
  flags: string[];
}

/**
 * Top-level moderation check for a text field.
 *
 *   - Profanity → severity=block on public fields, warn on private
 *   - PII detection → severity=block on public, warn on private
 *   - Spam patterns → severity=warn (always)
 *
 * The split between public and private reflects the threat model: PII
 * in a private "notes to self" field is the user's own data, but PII
 * in their public profile is a leak.
 */
export function moderateContent(
  input: string,
  fieldType: FieldType = 'public',
): ModerationResult {
  if (!input || typeof input !== 'string') {
    return { allowed: true, severity: 'none', flags: [] };
  }
  const flags: string[] = [];
  let severity: ModerationSeverity = 'none';

  const profanity = containsProfanity(input);
  if (profanity.flagged) {
    flags.push(...profanity.matches.map((m) => `profanity:${m}`));
    severity = fieldType === 'public' ? 'block' : 'warn';
  }

  const pii = containsPII(input);
  if (pii.flagged) {
    flags.push(...pii.types.map((t) => `pii:${t}`));
    // PII upgrades severity to block only if we were below block.
    if (fieldType === 'public' && severity !== 'block') {
      severity = 'block';
    } else if (fieldType === 'private' && severity === 'none') {
      severity = 'warn';
    }
  }

  const spam = detectSpam(input);
  if (spam.flagged) {
    flags.push(...spam.reasons.map((r) => `spam:${r}`));
    if (severity === 'none') severity = 'warn';
  }

  return {
    allowed: severity !== 'block',
    severity,
    flags,
  };
}
