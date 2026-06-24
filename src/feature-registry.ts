/**
 * KAN-328 — feature registry for the MCP server.
 *
 * Mirror of the web app's `lyra/src/lib/features/registry.ts`, EXTENDED with the
 * access-model-v2 feature TIER so the MCP server and the GUI resolve "is feature
 * X enabled for user Y" identically (one source of truth — no MCP-only access
 * path). Pure module: constants + pure helpers, NO I/O, so the gate logic is
 * directly reasoned about and grep-guarded in tests/kan-328-access-model-gate.
 *
 * Tiers (KAN-326/KAN-327 redesign; resolution per option 3 — KAN-330 /
 * KAN-328 comment #11300). The tier is a LABEL/grouping, NOT a silent grant:
 *   - GA   : on for everyone, admin-revocable           → media_uploads, discovery
 *   - test : opt-in. Default OFF; granted only by an
 *            explicit feature_entitlements row (web      → mcp, convene,
 *            admin bulk action, KAN-330). access_tier       paid_gift_links,
 *            does NOT grant test features.                  convene_paid_channels
 *
 * Effective per-user state = explicit feature_entitlements row (wins), else the
 * tier-default (GA on / test off) — independent of access_tier, matching the web
 * app's resolveEntitlements so MCP == GUI (no MCP-only access path). The per-env
 * master switch (CONVENE_ENABLED, SOVRN_API_KEY, …) is ANDed at the call sites
 * that own it and is unchanged by this module.
 *
 * ⚠️ Keep FEATURE_TIER in lockstep with the web app's registry when the GUI
 * adopts the tier model (parent epic KAN-326). A divergence here is a
 * GUI/MCP parity bug.
 */

export const FEATURE_KEYS = [
  'mcp',
  'convene',
  'paid_gift_links',
  'convene_paid_channels',
  'media_uploads',
  'discovery',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** GA = on-for-everyone (revocable); test = opt-in (beta-default-on, prod-default-off). */
export type FeatureTier = 'GA' | 'test';

/** Which site/tier the user belongs to (profiles.access_tier). */
export type AccessTier = 'beta' | 'prod';

export const FEATURE_TIER: Record<FeatureKey, FeatureTier> = {
  mcp: 'test',
  convene: 'test',
  paid_gift_links: 'test',
  convene_paid_channels: 'test',
  media_uploads: 'GA',
  discovery: 'GA',
};

export function isFeatureKey(value: string): value is FeatureKey {
  return (FEATURE_KEYS as readonly string[]).includes(value);
}

/**
 * Pure tier-default for a feature (option 3 — KAN-330 / KAN-328 comment #11300).
 * The tier is a LABEL only; it does NOT silently grant test features by
 * access_tier:
 *   - GA   → always true (revocable only by an explicit disabling row)
 *   - test → always false (opt-in: requires an explicit feature_entitlements row,
 *            granted via the web admin bulk action — KAN-330)
 * This matches the web app's resolveEntitlements, whose static per-feature
 * default is GA-on / test-off and never consults access_tier — keeping MCP == GUI
 * so there is no MCP-only access path.
 */
export function tierDefault(key: FeatureKey): boolean {
  return FEATURE_TIER[key] === 'GA';
}

/**
 * Pure: resolve a single feature's effective state — an explicit entitlement row
 * always wins over the tier-default (GA on / test off). Mirrors the web app's
 * resolveEntitlements precedence (row beats default), independent of access_tier.
 */
export function resolveFeature(
  rows: ReadonlyArray<{ feature_key: string; enabled: boolean }>,
  key: FeatureKey,
): boolean {
  const row = rows.find((r) => r.feature_key === key);
  return row ? row.enabled : tierDefault(key);
}

/**
 * Pure: the GUI-parity SERVICE gate. Only a user whose account is LIVE and not
 * suspended may use gated MCP tools — mirroring the web app, where
 * waitlist/not_applied users never reach the app and suspended users are blocked
 * at login (KAN-319). This is enforced BEFORE any per-feature entitlement check.
 */
export function hasLiveAccess(p: { user_status: string; is_suspended: boolean }): boolean {
  return p.user_status === 'live' && p.is_suspended === false;
}
