/**
 * fetchWithTimeout — KAN-354 (finding mcp-quality-2).
 *
 * A thin `fetch()` wrapper that aborts the request after `timeoutMs` via an
 * AbortController. Without a bound, an upstream hang (Google token refresh,
 * freeBusy, Places, the lyra drain-queue endpoint) blocks the MCP request
 * indefinitely — and Convene availability fans out per-attendee, so a single
 * slow token refresh would otherwise stall an entire gathering.
 *
 * Every outbound provider/HTTP call in this server MUST route through this
 * helper (guarded by tests/kan354-mcp-reliability.test.cjs) so no future call
 * site can silently reintroduce an unbounded fetch.
 *
 * On timeout the underlying fetch rejects with an AbortError; we rethrow a
 * clearer Error that names the target and the timeout so logs are unambiguous.
 * Non-timeout errors (DNS, connection reset, etc.) propagate unchanged.
 */

/** Default bound for outbound provider calls (Google token/freeBusy/Places). */
export const DEFAULT_FETCH_TIMEOUT_MS = 8000;

/** Larger bound for the lyra drain-queue call, which does batch work server-side. */
export const DRAIN_FETCH_TIMEOUT_MS = 10000;

export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // controller.signal is set last so the timeout always owns cancellation.
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      const target = typeof input === 'string' ? input : input.toString();
      throw new Error(`Request to ${target} timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
