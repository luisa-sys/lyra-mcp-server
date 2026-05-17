/**
 * KAN-232 (KAN-63 Tier 2-C) — MCP tool-call audit log middleware.
 *
 * Logs every MCP request to `public.mcp_tool_call_log` so we can spot
 * abuse patterns (>100 requests/hour from a single IP — alert threshold
 * lives in the `mcp_per_ip_recent_count` view, consumed by KAN-233).
 *
 * Design:
 *   - **Fire-and-forget.** The insert is `await`ed only for error logging
 *     in dev; failures NEVER block the request. Logging is a side-effect,
 *     not a quality gate.
 *   - **Gated by `MCP_TOOL_CALL_LOG_ENABLED=true`.** Default off so a
 *     deploy can land before the migration is promoted to stage/prod
 *     (KAN-245). Enable on dev MCP first; flip stage/prod later.
 *   - **API key prefix only** — never store the full credential. First
 *     8 chars are enough to correlate "same client, multiple calls"
 *     without being a credential leak.
 *   - **Tolerates a missing table.** If the migration hasn't been applied
 *     yet, the insert fails silently (one console.warn). The MCP server
 *     keeps serving requests.
 */

import type { Request, Response, NextFunction } from 'express';
import { getSupabase } from './supabase.js';

function isEnabled(): boolean {
  return process.env.MCP_TOOL_CALL_LOG_ENABLED === 'true';
}

function extractIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0]?.trim() || 'unknown';
  }
  if (Array.isArray(fwd) && fwd.length > 0) {
    return fwd[0]?.split(',')[0]?.trim() || 'unknown';
  }
  return req.socket?.remoteAddress || 'unknown';
}

function extractApiKeyPrefix(req: Request): string | null {
  // Header form (legacy)
  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string' && headerKey.length >= 8) {
    return headerKey.slice(0, 8);
  }
  // Bearer form (post-KAN-240)
  const auth = req.headers['authorization'];
  if (typeof auth === 'string') {
    const m = auth.match(/^Bearer\s+(\S+)$/);
    if (m && m[1] && m[1].length >= 8) {
      return m[1].slice(0, 8);
    }
  }
  // Per-call arg form (some clients pass it in body.params.arguments.api_key)
  const argKey = req.body?.params?.arguments?.api_key;
  if (typeof argKey === 'string' && argKey.length >= 8) {
    return argKey.slice(0, 8);
  }
  return null;
}

function extractMethod(req: Request): { method: string; tool: string } {
  const m = req.body?.method;
  const tool = req.body?.params?.name;
  return {
    method: typeof m === 'string' ? m : 'unknown',
    tool: typeof tool === 'string' ? tool : '(no-tool)',
  };
}

/**
 * Express middleware: writes one row per POST /mcp request.
 * Mount AFTER `express.json()` (needs req.body) and BEFORE the rate
 * limiter, so even rate-limited requests appear in the log.
 */
export function toolCallLogMiddleware(req: Request, _res: Response, next: NextFunction): void {
  // Skip non-MCP routes and non-POST traffic — those are health checks,
  // discovery probes, etc. and don't represent agent activity.
  if (req.method !== 'POST' || req.path !== '/mcp') {
    return next();
  }
  if (!isEnabled()) {
    return next();
  }

  const ip = extractIp(req);
  const { method, tool } = extractMethod(req);
  const apiKeyPrefix = extractApiKeyPrefix(req);

  // Fire-and-forget. We don't await the insert — the request shouldn't
  // wait for an audit-log row to land before being processed.
  void recordToolCall({ ip, tool, method, apiKeyPrefix });

  next();
}

interface ToolCallRecord {
  ip: string;
  tool: string;
  method: string;
  apiKeyPrefix: string | null;
  statusCode?: number | null;
}

async function recordToolCall(rec: ToolCallRecord): Promise<void> {
  try {
    const sb = getSupabase();
    const { error } = await sb.from('mcp_tool_call_log').insert({
      ip: rec.ip,
      tool: rec.tool,
      method: rec.method,
      api_key_prefix: rec.apiKeyPrefix,
      status_code: rec.statusCode ?? null,
    });
    if (error) {
      // Common case: migration not applied yet. Warn once per process to
      // avoid log spam — but never throw, never block the request.
      warnOnce(error.message);
    }
  } catch (e) {
    warnOnce(e instanceof Error ? e.message : String(e));
  }
}

const warnedMessages = new Set<string>();
function warnOnce(msg: string): void {
  if (warnedMessages.has(msg)) return;
  warnedMessages.add(msg);
  console.warn(`[tool-call-log] insert failed (will not retry-warn this msg): ${msg}`);
}

// Exposed for tests.
export const __testing = {
  extractIp,
  extractApiKeyPrefix,
  extractMethod,
  isEnabled,
  warnedMessages,
};
