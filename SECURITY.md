# Security Policy

CheckLyra Ltd takes the security of Lyra (checklyra.com), the Lyra MCP server
(mcp.checklyra.com), and the personal data it processes seriously.

## Reporting a vulnerability

**Please do not report security issues in public GitHub issues or pull requests.**

Use one of these private channels:

1. **GitHub private vulnerability reporting (preferred)** — open the **Security** tab
   of this repository and click **Report a vulnerability**. This is enabled and routes
   privately to the maintainers.
2. **Email** — `security@checklyra.com` with a description, impact, and steps to
   reproduce.

We aim to acknowledge a report within **3 working days** and to agree a remediation
timeline after triage. Please allow us a reasonable period to fix the issue before any
public disclosure (coordinated disclosure).

## Scope

In scope: this repository and the production services it powers — `mcp.checklyra.com`
and `checklyra.com`. Out of scope: third-party services we rely on (report those to the
relevant provider), volumetric/denial-of-service testing, and social engineering.

## Supported versions

The MCP server is continuously deployed from `main`; only the currently-deployed
version is supported.

## Recognition

We're a small team without a paid bounty programme, but we're glad to credit
researchers who disclose responsibly.
