/**
 * WWW-Authenticate header builder — KAN-88 P6.
 *
 * RFC 6750 + the MCP authorization spec require resource servers to
 * advertise the authorization server URL on 401 responses, so clients
 * can discover where to start the OAuth flow.
 *
 * Format:
 *   Bearer realm="<resource>", error="invalid_token",
 *     error_description="<reason>",
 *     as_uri="<AS metadata URL>"
 */

export function wwwAuthenticateBearer(error: string, errorDescription: string): string {
  const asUri =
    (process.env.LYRA_SITE_URL || 'https://checklyra.com').replace(/\/$/, '') +
    '/.well-known/oauth-authorization-server';
  const resource = process.env.MCP_RESOURCE_URL || 'https://mcp.checklyra.com/mcp';
  // RFC 7235 — params are token-encoded; double-quoted strings escape via backslash.
  const safeDesc = errorDescription.replace(/"/g, '\\"');
  return [
    `Bearer realm="${resource}"`,
    `error="${error}"`,
    `error_description="${safeDesc}"`,
    `as_uri="${asUri}"`,
  ].join(', ');
}
