/**
 * Request-scoped context — KAN-88 P5.
 *
 * AsyncLocalStorage carrier for per-request data that tool handlers
 * need but the MCP SDK doesn't surface in tool arguments. Currently
 * just OAuth identity (resolved by middleware from the Bearer JWT).
 *
 * The middleware calls `requestContext.run(ctx, () => next())`; tool
 * handlers (via authenticateApiKey) read with `.getStore()`.
 */
import { AsyncLocalStorage } from 'async_hooks';

export interface RequestContext {
  oauthUserId?: string;
  oauthClientId?: string;
  oauthJti?: string;
  oauthScope?: string;
}

export const requestContext = new AsyncLocalStorage<RequestContext>();

/** Sentinel value the middleware writes into args.api_key when an OAuth
 *  JWT was validated. authenticateApiKey() recognises this and returns
 *  the OAuth-resolved user from request context. */
export const OAUTH_AUTHED_SENTINEL = '__oauth_authed__';
