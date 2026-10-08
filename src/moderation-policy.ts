/**
 * KAN-242 (part of KAN-63 Tier 2): policy wrapper around `content-moderation`.
 *
 * Ported from the web-app's `src/modules/contracts/moderation-policy.ts` (KAN-241).
 * Same semantics, same error-string discipline (category-only — no
 * wordlist enumeration) so MCP and web-app users see consistent rejection
 * messages.
 *
 * The web-app version returns `{ ok, error }` for use by server actions.
 * MCP write tools return a different shape (`errorResponse(msg)`), so
 * this module returns the same generic `{ ok, error, flags }` and the
 * caller adapts. Single source of truth for the policy logic.
 */

import { moderateContent, type FieldType } from './content-moderation.js';

export type CheckResult =
  | { ok: true }
  | { ok: false; error: string; flags: string[] };

/**
 * Run text through the moderation library, apply the policy decision.
 *
 * @param text       The text to check. NULL/undefined/empty → pass.
 * @param fieldType  'public' (default) for fields that appear on the
 *                   public profile. 'private' for owner-only fields.
 * @param fieldName  Optional — included in the warn-log so admin sees
 *                   which field triggered. Not surfaced in the error
 *                   string (keeps category-only error policy).
 */
export function checkModeration(
  text: string | null | undefined,
  fieldType: FieldType = 'public',
  fieldName?: string,
): CheckResult {
  if (!text) return { ok: true };

  const result = moderateContent(text, fieldType);

  if (result.severity === 'block') {
    return {
      ok: false,
      error: buildErrorMessage(result.flags),
      flags: result.flags,
    };
  }

  if (result.severity === 'warn') {
    console.warn('[moderation] warn-level flag', {
      field: fieldName ?? '(unspecified)',
      flags: result.flags,
      preview: text.slice(0, 80),
    });
  }

  return { ok: true };
}

/**
 * Category-only error message. Never includes the exact match — that
 * would expose the wordlist by trial and error.
 */
function buildErrorMessage(flags: string[]): string {
  const categories = Array.from(
    new Set(flags.map((f) => f.split(':')[0]).filter(Boolean)),
  );
  const friendly = categories
    .map((c) =>
      c === 'profanity'
        ? 'inappropriate language'
        : c === 'pii'
          ? 'personal information that should not be in public fields (e.g. phone, email)'
          : c === 'spam'
            ? 'spam-like patterns'
            : c,
    )
    .join(', ');
  return `Content rejected: ${friendly}. Please edit and try again.`;
}
