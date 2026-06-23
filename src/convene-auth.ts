/**
 * KAN-317: shared auth wrapper for every Convene MCP tool.
 *
 * Replaces the per-file `authedUser` wrappers so the mcp + convene entitlement
 * checks live in ONE place that all Convene tools funnel through (and that the
 * registry test can assert). Returns the authed user id or throws a friendly
 * error.
 */
import { authenticateApiKey } from './auth.js';
import { requireFeatures } from './feature-entitlements.js';

export async function conveneAuthedUser(apiKey: string | undefined): Promise<string> {
  if (!apiKey) {
    throw new Error('API key required. Generate one at checklyra.com/dashboard/settings');
  }
  const auth = await authenticateApiKey(apiKey);
  if (!auth.authenticated || !auth.userId) {
    throw new Error(auth.error || 'Authentication failed');
  }
  // Convene tools require BOTH the base MCP entitlement and the Convene feature.
  await requireFeatures(auth.userId, ['mcp', 'convene']);
  return auth.userId;
}
