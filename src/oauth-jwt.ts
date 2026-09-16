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
 * Revocation check (SEC-46 Phase A): DEFAULT ON. The jti is looked up in
 * oauth_access_tokens and the token rejected if revoked_at is non-null, if the
 * row is absent, or if the lookup itself fails. `OAUTH_REVOCATION_CHECK='0'` is
 * a deliberate kill-switch, not a configuration knob.
 *
 * Audience check (SEC-46 Phase B): OBSERVE-ONLY until `OAUTH_AUDIENCE_CHECK='1'`.
 * Ships inert on purpose — see the note above `audienceEnforced()`.
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
  error: 'invalid_token' | 'expired' | 'revoked' | 'signature' | 'malformed' | 'invalid_audience';
  detail?: string;
}

/**
 * SEC-46 Phase A — revocation is ON unless explicitly switched off.
 *
 * This was `=== '1'`, i.e. opt-in, and the variable was set on NONE of the
 * three Railway services. So `revoked_at` was written by /oauth/revoke and by
 * refresh-replay `revokeFamily()` and read by NOBODY: revocation bit only at
 * token expiry, up to an hour later. "Revoke access" was inert.
 *
 * Inverted to opt-out. `'0'` remains as a kill-switch because this check puts a
 * database read on every authenticated tool call and fails closed (below), so
 * there must be a way to shed that dependency in an incident without a deploy.
 * Set it explicitly per service rather than relying on this default, so the two
 * environments can be reasoned about independently.
 */
function revocationCheckEnabled(): boolean {
  return process.env.OAUTH_REVOCATION_CHECK !== '0';
}

/**
 * SEC-46 Phase B — the canonical resource URI(s) this server will accept in
 * `aud`, tolerating a trailing slash and the bare-origin form.
 *
 * Reuses MCP_RESOURCE_URL, which already exists for the RFC 9728 protected
 * resource metadata document — deliberately NOT a second name for the same
 * fact. Note this promotes that variable from a metadata string into an
 * authorization decision, so it must be correct per service.
 */
function acceptedAudiences(): string[] {
  const res = (process.env.MCP_RESOURCE_URL || 'https://mcp.checklyra.com/mcp').replace(/\/$/, '');
  return [res, res.replace(/\/mcp$/, '')];
}

/**
 * SEC-46 Phase B — audience enforcement is OFF until `OAUTH_AUDIENCE_CHECK='1'`.
 *
 * ⚠️ This asymmetry with revocation (default ON) is deliberate, and it is the
 * point of the phase split. The authorization server currently mints
 * `aud = client_id`, not `aud = <resource>`. Enforcing today would 401 every
 * existing MCP connector — so this ships as an OBSERVATION that logs mismatches,
 * and is flipped only once the AS is issuing resource-bound tokens and the logs
 * have been quiet for at least one access-token TTL.
 *
 * That is also why the check is hand-rolled rather than passed to `jwtVerify`
 * as its `audience` option: jose THROWS on mismatch, which gives no way to
 * measure the blast radius before committing to it. The measurement is the
 * de-risking.
 */
function audienceEnforced(): boolean {
  return process.env.OAUTH_AUDIENCE_CHECK === '1';
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

  // SEC-46 Phase B — audience. Observe-only until OAUTH_AUDIENCE_CHECK='1'.
  // `aud` may legally be a string or an array (RFC 7519 §4.1.3), so normalise
  // both. Compared by EXACT match after a trailing-slash strip — never by
  // prefix or substring, or `https://mcp.checklyra.com/mcp.evil.test` would
  // satisfy it.
  const auds = Array.isArray(payload.aud)
    ? (payload.aud as unknown[]).filter((a): a is string => typeof a === 'string')
    : typeof payload.aud === 'string'
      ? [payload.aud]
      : [];
  if (!auds.some((a) => acceptedAudiences().includes(a.replace(/\/$/, '')))) {
    if (audienceEnforced()) {
      return { ok: false, error: 'invalid_audience', detail: 'aud not for this resource' };
    }
    console.warn(
      `[oauth][SEC-46] audience mismatch (observe-only) aud=${auds.join(',') || '(none)'} expected=${acceptedAudiences()[0]}`
    );
  }

  // SEC-46 Phase A — revocation. Default ON; '0' is a deliberate kill-switch.
  if (revocationCheckEnabled()) {
    const sb = getSupabase();
    // PK lookup: oauth_access_tokens_pkey is on (jti). No new index needed.
    const { data, error } = await sb
      .from('oauth_access_tokens')
      .select('revoked_at')
      .eq('jti', payload.jti as string)
      .maybeSingle();

    // FAIL CLOSED. Previously this destructured `{ data }` alone and threw the
    // error away, so a Supabase blip returned data=null and was read as "not
    // revoked" — a silent fail-open on the ONLY containment control we have,
    // with nothing logged. A revocation check that degrades to "allow" is inert
    // exactly when it matters most.
    if (error) {
      console.error('[oauth][SEC-46] revocation lookup failed — failing closed:', error.message);
      return { ok: false, error: 'revoked', detail: 'revocation status unavailable' };
    }

    // Unknown jti is a REFUSAL, not a pass. Issuance writes the registry row in
    // the same request that signs the token (the AS throws before returning the
    // JWT if that insert fails) and nothing purges the table, so a missing row
    // means the token was not minted by this system.
    if (!data) {
      return { ok: false, error: 'revoked', detail: 'token not in registry' };
    }

    if ((data as { revoked_at: string | null }).revoked_at) {
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
