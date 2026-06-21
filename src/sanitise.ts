/**
 * Input sanitisation for MCP write tools.
 * Mirrors the web app's sanitise.ts but standalone for the MCP server.
 */

/** Strip HTML tags and limit length */
export function sanitiseText(input: string, maxLength: number): string {
  return input
    .replace(/<[^>]*>/g, '')
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
