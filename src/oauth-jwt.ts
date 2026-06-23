/**
 * OAuth JWT validator on the MCP server — dual-accept HS256→RS256 (KAN-88 / SEC-33).
 *
 * Verifies access tokens issued by the lyra authorization server.
 *   Path 1 (primary): RS256 verified against the AS's published JWKS — this
 *     server holds NO signing material (the security win over HS256).
 *   Path 2 (legacy bridge): HS256 shared secret, gated by
 *     OAUTH_ALLOW_HS256_FALLBACK (default on). Torn down after the RS256 cutover.
 *
 * Algorithm-confusion safe: each jwtVerify pins a SINGLE-element algorithms
 * allow-list against its own key — never a combined list.
 *
 * Optional revocation check: if OAUTH_REVOCATION_CHECK=1, look up the jti in
 * oauth_access_tokens and reject if revoked_at is non-null.
 */
import { jwtVerify, createRemoteJWKSet } from 'jose';
import { getSupabase } from './supabase.js';

function expectedIssuer(): string {
  // Match the AS's runtime issuer; on the MCP server it's stored as LYRA_SITE_URL.
  const url = process.env.LYRA_SITE_URL || 'https://checklyra.com';
  return url.replace(/\/$/, '');
}

/**
 * RS256 verification key set = the AS's published JWKS. Built ONCE per process;
 * jose caches keys, refreshes in the background, and auto-refetches on an
 * unknown `kid` — so initial rollout and later key rotation need no redeploy.
 * Defaults to `${issuer}/.well-known/jwks.json`; override with OAUTH_JWKS_URI.
 */
let _jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
function jwks(): ReturnType<typeof createRemoteJWKSet> {
  if (!_jwks) {
    const uri = process.env.OAUTH_JWKS_URI || `${expectedIssuer()}/.well-known/jwks.json`;
    _jwks = createRemoteJWKSet(new URL(uri));
  }
  return _jwks;
}

/**
 * Legacy HS256 shared secret — returns null when absent/short (NEVER throws),
 * so a JWKS-only deploy verifies RS256 cleanly and a missing secret can't be
 * mistaken for "oauth not configured" / mask a valid RS256 token.
 */
function hsSecret(): Uint8Array | null {
  const raw = process.env.OAUTH_JWT_SIGNING_SECRET;
  if (!raw || raw.length < 32) return null;
  return new TextEncoder().encode(raw);
}

/** HS256 fallback kill-switch — default ON; set OAUTH_ALLOW_HS256_FALLBACK='0'
 *  per env once its in-flight HS256 tokens have expired post-cutover. */
function hs256FallbackEnabled(): boolean {
  return process.env.OAUTH_ALLOW_HS256_FALLBACK !== '0';
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

function classifyError(e: unknown): OAuthValidationError {
  const msg = e instanceof Error ? e.message : 'unknown';
  if (/expired/i.test(msg)) return { ok: false, error: 'expired', detail: msg };
  if (/signature/i.test(msg)) return { ok: false, error: 'signature', detail: msg };
  return { ok: false, error: 'invalid_token', detail: msg };
}

/**
 * Validate an OAuth access token presented as `Authorization: Bearer …`.
 * RS256-via-JWKS first, HS256 shared-secret fallback during the overlap.
 */
export async function validateOAuthAccessToken(
  rawToken: string
): Promise<OAuthValidationResult | OAuthValidationError> {
  let payload: Record<string, unknown>;

  // ── Path 1: RS256 via the AS JWKS (primary). ──
  try {
    const verified = await jwtVerify(rawToken, jwks(), { issuer: expectedIssuer(), algorithms: ['RS256'] });
    payload = verified.payload as Record<string, unknown>;
  } catch (rsErr) {
    // ── Path 2: legacy HS256 shared secret (migration bridge). ──
    const secret = hsSecret();
    if (hs256FallbackEnabled() && secret) {
      try {
        const verified = await jwtVerify(rawToken, secret, { issuer: expectedIssuer(), algorithms: ['HS256'] });
        payload = verified.payload as Record<string, unknown>;
      } catch (hsErr) {
        return classifyError(hsErr);
      }
    } else {
      // No HS256 fallback available → the RS256 outcome is authoritative.
      return classifyError(rsErr);
    }
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
      .eq('jti', payload.jti as string)
      .maybeSingle();
    const row = data as { revoked_at: string | null } | null;
    if (row?.revoked_at) {
      return { ok: false, error: 'revoked', detail: 'token revoked' };
    }
  }

  return {
    ok: true,
    userId: payload.sub as string,
    clientId: payload.client_id as string,
    scope: payload.scope as string,
    jti: payload.jti as string,
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
  try {
    const head = Buffer.from(parts[0], 'base64url').toString('utf8');
    return head.trimStart().startsWith('{');
  } catch {
    return false;
  }
}
