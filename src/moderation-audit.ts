/**
 * KAN-244 (KAN-63 Tier 2-A audit trail) — MCP-side moderation audit recorder.
 *
 * Mirror of the web-app `src/lib/moderation-audit.ts`. Wraps
 * `checkModeration` so callers keep their existing `if (!mod.ok) return
 * errorResponse(mod.error)` flow AND get a row written to
 * `public.content_moderation_flags` whenever the moderator flags a
 * field — warn or block.
 *
 * Failure mode: the audit insert is fire-and-forget. If the write fails
 * (table missing on this Supabase project, RLS misconfig, network blip),
 * we `console.warn` once but the tool keeps going. Audit is a
 * side-effect; it must never block a user write.
 */

import { checkModeration, type CheckResult } from './moderation-policy.js';
import { moderateContent, type FieldType } from './content-moderation.js';
import { getSupabase } from './supabase.js';

interface ModerateAndAuditArgs {
  text: string | null | undefined;
  fieldType?: FieldType;
  field: string;
  /** Profile owner (NULL for write tools where the action isn't profile-scoped, e.g. Convene). */
  profileId: string | null;
}

/**
 * Moderate the text + record a `content_moderation_flags` row when
 * severity is warn or block. Returns the same `CheckResult` shape as
 * `checkModeration` so callers don't have to change their branching.
 */
export async function moderateAndAudit(args: ModerateAndAuditArgs): Promise<CheckResult> {
  const { text, fieldType = 'public', field, profileId } = args;
  const mod = checkModeration(text, fieldType, field);

  if (mod.ok) {
    if (text && typeof text === 'string') {
      const detail = moderateContent(text, fieldType);
      if (detail.severity === 'warn') {
        await recordFlag({
          profileId,
          field,
          severity: 'warn',
          flags: detail.flags,
          snippet: text,
        });
      }
    }
    return mod;
  }

  await recordFlag({
    profileId,
    field,
    severity: 'block',
    flags: mod.flags,
    snippet: text ?? '',
  });
  return mod;
}

interface RecordArgs {
  profileId: string | null;
  field: string;
  severity: 'warn' | 'block';
  flags: string[];
  snippet: string;
}

async function recordFlag(args: RecordArgs): Promise<void> {
  try {
    const sb = getSupabase();
    const { error } = await sb.from('content_moderation_flags').insert({
      profile_id: args.profileId,
      field: args.field,
      severity: args.severity,
      flags: args.flags,
      content_snippet: args.snippet.slice(0, 200),
      source: 'mcp_server',
    });
    if (error) {
      console.warn('[moderation-audit] insert failed (will not block write)', {
        field: args.field,
        severity: args.severity,
        error: error.message,
      });
    }
  } catch (e) {
    console.warn('[moderation-audit] insert threw', {
      field: args.field,
      severity: args.severity,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}
