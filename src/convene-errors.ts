/**
 * Shared MCP tool error helpers — SEC-17 / SEC-61 (F-15).
 *
 * `clientError()` is the single, canonical way every Convene (and write) tool
 * must surface a database / PostgREST / RPC failure to an MCP client. A raw
 * `errorResponse(dbError.message)` returns the database's own message to the
 * caller, which can leak column names, constraint names, SQL fragments, Vault
 * RPC internals and other schema detail. `clientError()` logs the real error
 * server-side and returns a fixed, generic, safe message instead.
 *
 * SEC-61 lifted this helper out of the per-file copies (which had drifted — the
 * masking had only been applied in 2 of the ~13 Convene tool files) into this
 * shared module so every tool file routes DB errors through the same code path.
 * `tests/sec61-db-error-leak-guard.test.cjs` statically fails the build if any
 * `errorResponse(<dbError>.message)` leak site is re-introduced.
 *
 * NOTE: `write-tools.ts` and `convene-tools.ts` keep their own local
 * `clientError()` definitions (pinned by `tests/sec17-error-leak.test.cjs`);
 * they are byte-identical to this one. All other Convene tool files import from
 * here.
 */

export function errorResponse(msg: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }] };
}

/**
 * SEC-17 / F-15: never surface a raw DB/PostgREST error to the MCP client — the
 * message can leak column names, constraint names, SQL fragments and internal
 * schema. Log the real error server-side; return a generic, safe message.
 */
export function clientError(error: unknown, context: string) {
  console.error(`[mcp][${context}] database error:`, error);
  return errorResponse('The request could not be completed. Please check your input and try again.');
}
