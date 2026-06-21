/**
 * SEC-4: optional Sentry error tracking for the MCP server.
 *
 * Inert unless `SENTRY_DSN` is set — mirrors the web app's DSN-presence gate
 * (lyra docs/SENTRY_SETUP.md). No DSN → zero network calls, zero overhead.
 * The DSN is public-by-design (ingest only, no data access). Errors only:
 * `tracesSampleRate: 0` keeps the MCP request hot-path free of tracing cost.
 *
 * Set `SENTRY_DSN` on the Railway services (prod + dev) to activate; the
 * existing project DSN is in lyra's docs/SENTRY_SETUP.md (EU region).
 */
import * as Sentry from '@sentry/node';

const dsn = process.env.SENTRY_DSN;

export const sentryEnabled = Boolean(dsn);

if (sentryEnabled) {
  Sentry.init({
    dsn,
    environment:
      process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'production',
    tracesSampleRate: 0,
    release: process.env.RAILWAY_GIT_COMMIT_SHA || undefined,
  });
}

export { Sentry };
