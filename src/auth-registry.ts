/**
 * Auth registry — KAN-88.
 *
 * Which tools require authentication, and which are public reads.
 * Used by the /mcp middleware to decide whether an unauthenticated
 * tool call should return a JSON-RPC error (200) or a 401 +
 * WWW-Authenticate (which triggers claude.ai's OAuth discovery).
 *
 * Keep this list in sync with /.well-known/mcp.json's tools listing
 * and with each tool's own auth check inside its handler.
 */

/**
 * Tools that respond without authentication. Everything else requires
 * either a JWT Bearer (OAuth) or a per-call api_key arg.
 */
export const PUBLIC_TOOLS = new Set<string>([
  // Profile reads — public profile data.
  'lyra_search_profiles',
  'lyra_get_profile',
  'lyra_get_section',
  'lyra_get_insights',
  'lyra_recommend_gifts',
  'lyra_list_schools',
  'lyra_get_onboarding_coaching',
]);

export function requiresAuth(toolName: string): boolean {
  return !PUBLIC_TOOLS.has(toolName);
}
