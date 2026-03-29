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
