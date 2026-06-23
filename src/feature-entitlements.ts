/**
 * KAN-317: per-user feature-entitlement enforcement for the MCP server.
 *
 * Mirrors lyra/src/lib/features/registry.ts defaults. The MCP server uses the
 * service-role client (getSupabase bypasses RLS — CLAUDE.md Gotcha #1), so these
 * checks MUST be explicit app-code; RLS does not protect this path. A positive
 * registry test (tests/mcp-entitlement-guard.test.cjs) asserts every write/
 * convene tool funnels through these checks.
 *
 * Defaults: mcp/convene/paid_* default OFF (an admin grant is required —
 * existing API-key holders were backfilled mcp=true); media_uploads/discovery
 * default ON.
 */
import { getSupabase } from './supabase.js';

const FEATURE_DEFAULTS: Record<string, boolean> = {
  mcp: false,
  convene: false,
  paid_gift_links: false,
  convene_paid_channels: false,
  media_uploads: true,
  discovery: true,
};

const DENY_MESSAGE: Record<string, string> = {
  mcp: 'MCP access is not enabled for your account. Ask the Lyra team to enable it.',
  convene: 'Convene is not enabled for your account yet.',
};

async function profileForUser(userId: string): Promise<{ id: string; age_status: string } | null> {
  const sb = getSupabase();
  const { data } = await sb
    .from('profiles')
    .select('id, age_status')
    .eq('user_id', userId)
    .single();
  if (!data) return null;
  const row = data as { id: string; age_status?: string };
  return { id: row.id, age_status: row.age_status ?? 'none' };
}

/** Pure: resolve a feature's effective state from rows + per-key default. */
export function isFeatureEnabled(
  rows: ReadonlyArray<{ feature_key: string; enabled: boolean }>,
  key: string,
): boolean {
  const row = rows.find((r) => r.feature_key === key);
  return row ? row.enabled : (FEATURE_DEFAULTS[key] ?? false);
}

/** Throw a friendly error if the user lacks any required feature entitlement. */
export async function requireFeatures(userId: string, keys: string[]): Promise<void> {
  const prof = await profileForUser(userId);
  if (!prof) throw new Error('No profile found for this user');
  const sb = getSupabase();
  const { data } = await sb
    .from('feature_entitlements')
    .select('feature_key, enabled')
    .eq('profile_id', prof.id);
  const rows = (data ?? []) as { feature_key: string; enabled: boolean }[];
  for (const k of keys) {
    if (!isFeatureEnabled(rows, k)) {
      throw new Error(DENY_MESSAGE[k] ?? `The "${k}" feature is not enabled for your account.`);
    }
  }
}

/**
 * Block publishing over MCP when the env-wide age gate is on and the user isn't
 * age-verified (mirrors the web publishProfile gate; KAN-282/KAN-319). Requires
 * AGE_VERIFICATION_REQUIRED on the MCP server's Railway env.
 */
export async function requireAgeVerifiedToPublish(userId: string): Promise<void> {
  if (process.env.AGE_VERIFICATION_REQUIRED !== 'true') return;
  const prof = await profileForUser(userId);
  if (!prof || prof.age_status !== 'passed') {
    throw new Error(
      'You need to verify your age before publishing your profile. Visit checklyra.com/verify-age.',
    );
  }
}
