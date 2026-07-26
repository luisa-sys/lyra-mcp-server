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
 *   2. FEATURE RESOLUTION — option 3 (KAN-330 / comment #11300): the tier is a
 *      LABEL only. GA features default on (revocable); TEST features default OFF
 *      and require an explicit feature_entitlements row (granted via the web
 *      admin bulk action). access_tier does NOT grant test features. An explicit
 *      row always wins. One source of truth shared with the GUI (resolveEntitlements).
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
 * SEC-83 — best-effort suspension lookup, used ONLY on the v1 (ACCESS_MODEL_V2
 * off) path where profileForUser's prod-safe legacy select deliberately omits
 * `is_suspended` (the KAN-328 guard pins that select to `id, age_status` so an
 * un-migrated env never references a missing column). We read the single column
 * on its own so the flag-independent suspension gate can still fire on v1.
 *
 * DEGRADE-SAFE: if the column is absent (env predates the KAN-327 migration —
 * e.g. production today), Postgres returns 42703 undefined_column. We cannot
 * enforce suspension where there is no suspension data, so we return false
 * (matching the pre-SEC-83 prod behaviour — no regression) and warn, rather than
 * erroring every gated call. Any other lookup error also degrades to
 * not-suspended: denying all callers on a transient DB blip would be a worse
 * outage than the narrow suspended-actor gap this closes. Once the KAN-327
 * column lands in an env, the gate becomes fully active there automatically.
 */
async function callerIsSuspended(profileId: string): Promise<boolean> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('profiles')
    .select('is_suspended')
    .eq('id', profileId)
    .single();
  if (error || !data) {
    if (error?.code === '42703') {
      console.warn(
        '[mcp][feature-entitlements] is_suspended column absent on this env ' +
          '(pre-KAN-327 schema) — flag-independent suspension gate INACTIVE here ' +
          'until the column lands.',
      );
    } else if (error && error.code !== 'PGRST116') {
      console.error(
        '[mcp][feature-entitlements] suspension lookup failed:',
        error.code,
        error.message,
      );
    }
    return false;
  }
  return (data as { is_suspended?: boolean }).is_suspended === true;
}

/**
 * Enforce access for a gated tool: the flag-independent suspension refusal
 * (SEC-83), then (v2 only) the live/waitlist service gate, then the per-feature
 * entitlement check. Throws a friendly error on deny.
 */
export async function requireFeatures(userId: string, keys: string[]): Promise<void> {
  const prof = await profileForUser(userId);
  if (!prof) throw new Error('No profile found for this user');

  const v2 = accessModelV2Enabled();

  // SEC-83 — the suspension refusal is FLAG-INDEPENDENT. A suspended (formerly
  // live) caller keeps their existing feature_entitlements rows, so under v1
  // (ACCESS_MODEL_V2 off — the documented prod config) the v2 service gate below
  // is skipped and a suspended abuser could still call every write/convene tool:
  // edit a published profile, send Convene invites, drain the queue. Refuse a
  // suspended caller regardless of the flag, BEFORE the v2 gate and the feature
  // read. Under v2 prof.is_suspended is authoritative (selected in profileForUser);
  // under v1 the legacy select omits the column (prod-safe — prod's profiles
  // table predates KAN-327), so we do a best-effort standalone lookup that
  // degrades to not-suspended on an un-migrated schema (see callerIsSuspended)
  // rather than erroring every gated call.
  const suspended = v2 ? prof.is_suspended : await callerIsSuspended(prof.id);
  if (suspended) {
    throw new Error(
      'Your Lyra account is suspended. Contact the Lyra team if you think this is a mistake.',
    );
  }

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
    // v2 (option 3): GA features default on; TEST features default OFF and need
    // an explicit entitlement row — no access_tier tier-default (GUI parity).
    // v1: flat FEATURE_DEFAULTS. An explicit entitlement row wins either way.
    const enabled =
      v2 && isFeatureKey(k)
        ? resolveFeature(rows, k as FeatureKey)
        : isFeatureEnabled(rows, k);
    if (!enabled) {
      throw new Error(DENY_MESSAGE[k] ?? `The "${k}" feature is not enabled for your account.`);
    }
  }
}

/*
 * requireAgeVerifiedToPublish (KAN-282/KAN-319) was REMOVED 2026-07-20, along
 * with the web publishProfile gate it mirrored. Lyra no longer runs a provider
 * age check: age is an 18+ self-declaration made at sign-up and recorded by the
 * web app, so there is nothing for MCP to re-check at publish time and
 * lyra_publish_profile no longer consults age at all.
 *
 * `AGE_VERIFICATION_REQUIRED` is now read by nothing in this server — unset it
 * on both Railway services. Leaving it set is inert but misleading.
 *
 * `age_status` remains on ProfileGate because the v1 select list is pinned to
 * columns guaranteed to exist on every environment (see profileForUser); it is
 * no longer consulted by any gate.
 */
