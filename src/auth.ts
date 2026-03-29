import { createHash } from 'crypto';
import { getSupabase } from './supabase.js';

interface AuthResult {
  authenticated: boolean;
  userId?: string;
  error?: string;
}

/**
 * Validate an API key and return the associated user ID.
 * Keys are stored as SHA-256 hashes — the raw key is never persisted.
 */
export async function authenticateApiKey(apiKey: string): Promise<AuthResult> {
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
