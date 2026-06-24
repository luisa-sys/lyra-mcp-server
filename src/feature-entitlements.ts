/**
 * KAN-317 + KAN-328: per-user access + feature-entitlement enforcement for the
 * MCP server.
 *
 * The MCP server uses the service-role client (getSupabase bypasses RLS —
 * CLAUDE.md Gotcha #1), so these checks MUST be explicit app-code; RLS does not
 * protect this path. A positive registry test
 * (tests/mcp-entitlement-guard.test.cjs) asserts every write/convene tool
 * funnels through requireFeatures, so folding the new gate in HERE covers all
 * three gated paths (authAndProfile, conveneAuthedUser, and the bespoke
 * convene-drain-tool) with no risk of a missed call site.
 *
 * ── Access model v2 (KAN-326/KAN-327), env-gated on ACCESS_MODEL_V2 ──────────
 * When ACCESS_MODEL_V2 !== 'true' (default), behaviour is EXACTLY the legacy
 * KAN-317 model: select only `id, age_status`, flat per-key FEATURE_DEFAULTS, no
 * user_status/suspension gate. This keeps the server safe on environments whose
 * `profiles` table does NOT yet have the new columns (e.g. production until the
 * KAN-327 schema migration is promoted there). Both Railway services deploy from
 * `main`, so the SAME code runs on dev and prod — the flag, not the branch, is
 * what activates v2. Flip it ON only where user_status/access_tier are live.
 *
 * When ACCESS_MODEL_V2 === 'true':
 *   1. SERVICE GATE — the caller must have user_status='live' AND is_suspended=
 *      false, mirroring the GUI (waitlist/not_applied users never reach the app;
 *      suspended users are blocked at login, KAN-319). Enforced before any
 *      feature check.
 *   2. FEATURE RESOLUTION — per-feature defaults follow the tier model
 *      (registry FEATURE_TIER): GA features default on; test features default on
 *      for access_tier='beta', off for 'prod'. An explicit entitlement row always
 *      wins. One source of truth shared with the GUI (feature-registry.ts).
 *
 * Legacy columns (access_stage, beta_access_status, is_beta_eligible,
 * early_access) are NEVER read here — they are being dropped in Phase C of
 * KAN-326.
 */
import { getSupabase } from './supabase.js';
import {
  type AccessTier,
  type FeatureKey,
  hasLiveAccess,
  isFeatureKey,
  resolveFeature,
} from './feature-registry.js';

/** Legacy (v1) per-key defaults — used only when ACCESS_MODEL_V2 is OFF. */
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

/** True when the new access model (user_status/access_tier gating) is active. */
export function accessModelV2Enabled(): boolean {
  return process.env.ACCESS_MODEL_V2 === 'true';
}

interface ProfileGate {
  id: string;
  age_status: string;
  /** profiles.user_status ('not_applied'|'waitlist'|'live'). Only meaningful under v2. */
  user_status: string;
  /** profiles.access_tier ('beta'|'prod'). Only meaningful under v2. */
  access_tier: AccessTier;
  is_suspended: boolean;
}

/**
 * Resolve the caller's profile + access fields. Under v2 we additionally select
 * user_status/access_tier/is_suspended; under v1 we select ONLY the columns that
 * are guaranteed to exist everywhere (`id, age_status`) so the query never
 * references a not-yet-migrated column. The non-selected fields are filled with
 * permissive sentinels (live / beta / not-suspended) that the v1 code path never
 * consults — only the v2 path gates on them.
 */
async function profileForUser(userId: string): Promise<ProfileGate | null> {
  const sb = getSupabase();
  // Use a LITERAL select string per branch: supabase-js parses the select at the
  // type level, so a non-literal/union string degrades to a ParserError type.
  // The v1 branch selects ONLY columns guaranteed to exist everywhere, so an
  // un-migrated `profiles` table (prod pre-KAN-327) never references a missing
  // column.
  const { data, error } = accessModelV2Enabled()
    ? await sb
        .from('profiles')
        .select('id, age_status, user_status, access_tier, is_suspended')
        .eq('user_id', userId)
        .single()
    : await sb.from('profiles').select('id, age_status').eq('user_id', userId).single();
  if (error || !data) {
    // PGRST116 = .single() found no row — the normal "no profile" case. Any
    // OTHER error is unexpected and worth surfacing server-side: in particular a
    // 42703 undefined_column means ACCESS_MODEL_V2 was flipped on before the
    // KAN-327 columns landed in this env. Never leak it to the client; deny.
    if (error && error.code !== 'PGRST116') {
      console.error('[mcp][feature-entitlements] profile lookup failed:', error.code, error.message);
    }
    return null;
  }
  const row = data as {
    id: string;
    age_status?: string;
    user_status?: string;
    access_tier?: string;
    is_suspended?: boolean;
  };
  // Fail-SAFE sentinels: only relevant if a column is somehow absent under v2
  // (it never is under the NOT-NULL KAN-327 schema). Default to the most
  // RESTRICTIVE values so an anomaly denies access rather than admitting it
  // (not_applied → blocked by the service gate; prod → test features off).
  return {
    id: row.id,
    age_status: row.age_status ?? 'none',
    user_status: row.user_status ?? 'not_applied',
    access_tier: (row.access_tier as AccessTier) ?? 'prod',
    is_suspended: row.is_suspended === true,
  };
}

/** Friendly, reason-specific block message for a caller who fails the service gate. */
function accessDenyMessage(p: ProfileGate): string {
  if (p.is_suspended) {
    return 'Your Lyra account is suspended. Contact the Lyra team if you think this is a mistake.';
  }
  if (p.user_status === 'waitlist') {
    return "You're on the Lyra waitlist — MCP access unlocks when your account goes live.";
  }
  return 'Your Lyra account does not have access yet. Get started at checklyra.com.';
}

/**
 * Pure (v1): resolve a feature's effective state from rows + flat per-key
 * default. Retained for the ACCESS_MODEL_V2=OFF path and its existing tests.
 */
export function isFeatureEnabled(
  rows: ReadonlyArray<{ feature_key: string; enabled: boolean }>,
  key: string,
): boolean {
  const row = rows.find((r) => r.feature_key === key);
  return row ? row.enabled : (FEATURE_DEFAULTS[key] ?? false);
}

/**
 * Enforce access for a gated tool: (v2 only) the live/non-suspended service
 * gate, then the per-feature entitlement check. Throws a friendly error on deny.
 */
export async function requireFeatures(userId: string, keys: string[]): Promise<void> {
  const prof = await profileForUser(userId);
  if (!prof) throw new Error('No profile found for this user');

  const v2 = accessModelV2Enabled();

  // KAN-328 service gate — GUI parity: only live, non-suspended accounts may use
  // gated MCP tools. Enforced before any feature check so waitlist/not_applied/
  // suspended callers are blocked outright.
  if (v2 && !hasLiveAccess(prof)) {
    throw new Error(accessDenyMessage(prof));
  }

  const sb = getSupabase();
  const { data } = await sb
    .from('feature_entitlements')
    .select('feature_key, enabled')
    .eq('profile_id', prof.id);
  const rows = (data ?? []) as { feature_key: string; enabled: boolean }[];
  for (const k of keys) {
    // v2: tier-aware default (beta-on/prod-off for test features, GA always on);
    // v1: flat FEATURE_DEFAULTS. An explicit entitlement row wins either way.
    const enabled =
      v2 && isFeatureKey(k)
        ? resolveFeature(rows, k as FeatureKey, prof.access_tier)
        : isFeatureEnabled(rows, k);
    if (!enabled) {
      throw new Error(DENY_MESSAGE[k] ?? `The "${k}" feature is not enabled for your account.`);
    }
  }
}

/**
 * Block publishing over MCP when the env-wide age gate is on and the user isn't
 * age-verified (mirrors the web publishProfile gate; KAN-282/KAN-319). Requires
 * AGE_VERIFICATION_REQUIRED on the MCP server's Railway env. Independent of
 * ACCESS_MODEL_V2.
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
