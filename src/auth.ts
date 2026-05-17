import { createHash } from 'crypto';
import { getSupabase } from './supabase.js';
import { requestContext, OAUTH_AUTHED_SENTINEL } from './request-context.js';

interface AuthResult {
  authenticated: boolean;
  userId?: string;
  error?: string;
}

/**
 * Validate an API key and return the associated user ID.
 *
 * Two auth paths (KAN-88 P5):
 *   1. OAuth-authed callers — the middleware has already validated the
 *      JWT Bearer header and put the resolved user_id in
 *      AsyncLocalStorage, then overwrote args.api_key with the
 *      OAUTH_AUTHED_SENTINEL string. We read the user_id from context.
 *   2. `lyra_…` opaque API keys — sha256 lookup against api_keys table
 *      (the original flow; unchanged).
 */
export async function authenticateApiKey(apiKey: string | undefined): Promise<AuthResult> {
  // OAuth path — middleware already verified the JWT.
  if (apiKey === OAUTH_AUTHED_SENTINEL) {
    const ctx = requestContext.getStore();
    if (ctx?.oauthUserId) {
      return { authenticated: true, userId: ctx.oauthUserId };
    }
    return { authenticated: false, error: 'OAuth context missing — sentinel without storage' };
  }

  if (!apiKey || !apiKey.startsWith('lyra_')) {
    return { authenticated: false, error: 'Invalid API key format' };
  }

  const keyHash = createHash('sha256').update(apiKey).digest('hex');
  const sb = getSupabase();

  const { data, error } = await sb
    .from('api_keys')
    .select('id, user_id, revoked_at')
    .eq('key_hash', keyHash)
    .single();

  if (error || !data) {
    return { authenticated: false, error: 'Invalid API key' };
  }

  if (data.revoked_at) {
    return { authenticated: false, error: 'API key has been revoked' };
  }

  // Update last_used_at (fire and forget — don't block the request)
  sb.from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('id', data.id)
    .then(() => {});

  return { authenticated: true, userId: data.user_id };
}

/**
 * Get the user's profile ID from their user_id.
 */
export async function getProfileForUser(userId: string): Promise<{ profileId?: string; slug?: string; error?: string }> {
  const sb = getSupabase();
  const { data, error } = await sb
    .from('profiles')
    .select('id, slug')
    .eq('user_id', userId)
    .single();

  if (error || !data) {
    return { error: 'No profile found for this user' };
  }

  return { profileId: data.id, slug: data.slug };
}
