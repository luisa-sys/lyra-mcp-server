/**
 * Input sanitisation for MCP write tools.
 * Mirrors the web app's sanitise.ts but standalone for the MCP server.
 */

/**
 * Strip all HTML tags from a string.
 *
 * SEC-59 / KAN-171 (CodeQL js/incomplete-multi-character-sanitization, high;
 * CWE-020 / CWE-080 / CWE-116): the previous single-pass
 * `input.replace(/<[^>]*>/g, '')` was vulnerable to nested-tag bypass — e.g.
 * `<scr<script>ipt>` still contains `<script>` after one pass. Looping the regex
 * until the string stabilises guarantees no `<…>` substring survives arbitrary
 * nesting / interleaving. Convergence is fast: each iteration strictly shrinks
 * the string (or terminates), and callers bound the input via `maxLength`.
 *
 * Mirrors the web app's `src/lib/sanitise.ts` `stripHtml` so both surfaces
 * sanitise free-text identically (SEC-59 convergence leg).
 */
export function stripHtml(input: string): string {
  let prev: string;
  let current = input;
  do {
    prev = current;
    current = current.replace(/<[^>]*>/g, '');
  } while (current !== prev);
  return current.trim();
}

/** Strip HTML tags, normalise whitespace, and limit length */
export function sanitiseText(input: string, maxLength: number): string {
  return stripHtml(input)
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, maxLength);
}

/**
 * Sanitise a free-text search term before interpolating it into a PostgREST
 * `.or()` / `.ilike()` filter string.
 *
 * SEC-09 (TDD 2026-06-21): the service-role client bypasses RLS, and the search
 * term is interpolated raw into `.or('display_name.ilike.%…%,…')`. PostgREST parses
 * `.or()` as a filter DSL, so `,` `(` `)` could alter the filter tree and `%` `_`
 * are ilike wildcards that could turn the query into a match-all. Strip them all.
 */
export function sanitiseSearchTerm(input: string, maxLength = 100): string {
  return input
    .replace(/[,()*%_\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, maxLength);
}

/** Validate and sanitise URLs — must be http/https */
export function sanitiseUrl(input: string): string | null {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
