/**
 * OAuth JWT validator on the MCP server — KAN-88 P5.
 *
 * Verifies HS256-signed access tokens issued by the lyra AS at
 * /oauth/token. The shared secret (OAUTH_JWT_SIGNING_SECRET) MUST
 * match between this server and the AS — otherwise every token
 * fails the signature check.
 *
 * Optional revocation check: if OAUTH_REVOCATION_CHECK=1 is set, we
 * look up the jti in oauth_access_tokens and reject if revoked_at
 * is non-null. Disabled by default for latency (the JWT exp claim
 * is the primary expiry signal).
 */

import { jwtVerify } from 'jose';
import { getSupabase } from './supabase.js';

function secretKey(): Uint8Array {
  const raw = process.env.OAUTH_JWT_SIGNING_SECRET;
  if (!raw || raw.length < 32) {
    throw new Error('OAUTH_JWT_SIGNING_SECRET must be set to at least 32 chars');
  }
  return new TextEncoder().encode(raw);
}

function expectedIssuer(): string {
  // Match the AS's runtime issuer (NEXT_PUBLIC_SITE_URL on Vercel).
  // On the MCP server we just store the same URL under LYRA_SITE_URL.
  const url = process.env.LYRA_SITE_URL || 'https://checklyra.com';
  return url.replace(/\/$/, '');
}

export interface OAuthValidationResult {
  ok: true;
  userId: string;
  clientId: string;
  scope: string;
  jti: string;
}
export interface OAuthValidationError {
  ok: false;
  error: 'invalid_token' | 'expired' | 'revoked' | 'signature' | 'malformed';
  detail?: string;
}

/**
 * Validate an OAuth access token presented as `Authorization: Bearer …`.
 * The middleware decides whether to call this based on token shape
 * (JWTs start with `eyJ…`).
 */
export async function validateOAuthAccessToken(
  rawToken: string
): Promise<OAuthValidationResult | OAuthValidationError> {
  let payload;
  try {
    const verified = await jwtVerify(rawToken, secretKey(), {
      issuer: expectedIssuer(),
      algorithms: ['HS256'],
    });
    payload = verified.payload;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    if (/expired/i.test(msg)) return { ok: false, error: 'expired', detail: msg };
    if (/signature/i.test(msg)) return { ok: false, error: 'signature', detail: msg };
    return { ok: false, error: 'invalid_token', detail: msg };
  }

  if (typeof payload.sub !== 'string') return { ok: false, error: 'malformed', detail: 'missing sub' };
  if (typeof payload.jti !== 'string') return { ok: false, error: 'malformed', detail: 'missing jti' };
  if (typeof payload.scope !== 'string') return { ok: false, error: 'malformed', detail: 'missing scope' };
  if (typeof payload.client_id !== 'string') return { ok: false, error: 'malformed', detail: 'missing client_id' };

  // Optional revocation check.
  if (process.env.OAUTH_REVOCATION_CHECK === '1') {
    const sb = getSupabase();
    const { data } = await sb
      .from('oauth_access_tokens')
      .select('revoked_at')
      .eq('jti', payload.jti)
      .maybeSingle();
    const row = data as { revoked_at: string | null } | null;
    if (row?.revoked_at) {
      return { ok: false, error: 'revoked', detail: 'token revoked' };
    }
  }

  return {
    ok: true,
    userId: payload.sub,
    clientId: payload.client_id,
    scope: payload.scope,
    jti: payload.jti,
  };
}

/**
 * Heuristic: does this token look like a JWT vs an opaque `lyra_…` key?
 * JWTs are three base64url-encoded segments separated by dots.
 */
export function looksLikeJwt(token: string): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  // First segment decodes to JSON starting with '{'.
  try {
    const head = Buffer.from(parts[0], 'base64url').toString('utf8');
    return head.trimStart().startsWith('{');
  } catch {
    return false;
  }
}
