/**
 * WWW-Authenticate header builder — KAN-88.
 *
 * Built to match claude.ai's documented OAuth-discovery trigger:
 * a 401 with `WWW-Authenticate: Bearer resource_metadata="<PRM URL>"`.
 * Claude.ai's MCP connector follows the `resource_metadata` link to
 * /.well-known/oauth-protected-resource, then follows that document's
 * `authorization_servers` to the AS metadata, then runs DCR + the
 * authorization code flow.
 *
 *   resource_metadata=<PRM URL>            (the documented claude.ai trigger)
 *   realm=<MCP resource URL>               (RFC 6750 §3 — informational)
 *   error=<error code>                     (RFC 6750 §3.1 — when applicable)
 *   error_description=<human reason>       (RFC 6750 §3.1 — when applicable)
 *
 * For the "no auth presented" case (the most common trigger), omit
 * error/error_description — those fields per RFC 6750 §3.1 should only
 * appear when the client presented something the server then rejected.
 */

export interface AuthenticateHeaderOpts {
  /** When set, included as error="…" per RFC 6750 §3.1. Omit for "no auth presented". */
  error?: string;
  /** When set, included as error_description="…" per RFC 6750 §3.1. */
  errorDescription?: string;
}

export function wwwAuthenticateBearer(opts: AuthenticateHeaderOpts = {}): string {
  const siteUrl = (process.env.LYRA_SITE_URL || 'https://checklyra.com').replace(/\/$/, '');
  const resource = process.env.MCP_RESOURCE_URL || 'https://mcp.checklyra.com/mcp';
  // The Protected Resource Metadata URL — claude.ai follows this. It lives
  // on the resource server (us), not the authorization server.
  const prmUrl = `${resource.replace(/\/mcp\/?$/, '')}/.well-known/oauth-protected-resource`;

  const parts = [
    `Bearer realm="${resource}"`,
    `resource_metadata="${prmUrl}"`,
  ];
  if (opts.error) {
    parts.push(`error="${opts.error}"`);
  }
  if (opts.errorDescription) {
    const safeDesc = opts.errorDescription.replace(/"/g, '\\"');
    parts.push(`error_description="${safeDesc}"`);
  }
  // For completeness we ALSO advertise the AS metadata URL via the
  // `as_uri` parameter — some non-claude.ai clients (MCP Inspector,
  // Cursor) read that instead. Belt and braces.
  parts.push(`as_uri="${siteUrl}/.well-known/oauth-authorization-server"`);
  return parts.join(', ');
}
