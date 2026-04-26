# [CLAUDE.md](http://CLAUDE.md) — Project Instructions for Claude

This file contains instructions and policies that Claude must follow when working on this repository.

## Pre-Work Checklist

Before starting any task, Claude must:

1. **Check Jira** — confirm a ticket exists for the work, or create one. Never start work without a tracked ticket.
2. **Check the lyra repo's docs/** — architecture docs live in the main lyra repo at `docs/`. Read relevant docs before acting on architecture, ops, or infrastructure questions.
3. **Check for existing work** — search the codebase and recent PRs to avoid duplicating effort.
4. **Run tests before and after** — every change must leave tests green.

## Jira Ticket Standard

All work must be tracked in Jira. KAN project for design/deployment, BUGS project for bug tracking.

Every KAN Task/Story description MUST include all six sections:

1. **What & Why**
2. **Implementation steps**
3. **Tests Required** — unit, functional, E2E: what to test, mocks, edge cases
4. **Security Review** — threats introduced, RLS/auth impact, input validation
5. **Architecture Impact** — docs/env vars/dependencies to update
6. **Acceptance Criteria**

## Deployment

- This repo deploys to Railway at [mcp.checklyra.com](http://mcp.checklyra.com)
- Railway auto-deploys from `main` branch
- Push to main only after tests pass
- Production MCP server points to production Supabase
- Current test floor: **64 tests** (2 suites)

## Testing Requirements

- All changes must have tests in the same commit — never defer to a separate ticket
- Claude must actively look for missing coverage and flag it
- MCP tool tests must cover: valid input, invalid input, auth failures, rate limiting edge cases

## Test Integrity Policy

Tests are the safety net. Claude must NEVER modify, weaken, skip, or delete any existing unit, smoke, or E2E test to make it pass. Tests exist to catch real problems — a failing test means the code is wrong, not the test.

### When a test fails, Claude must:

1. **STOP** — do not modify the test
2. **Investigate the root cause** — is it a code bug, a missing dependency, an environment issue, or a genuine content change?
3. **Report the failure** to the user with:
   - Which test(s) failed
   - The exact error message
   - Claude's assessment of the root cause
   - Whether Claude believes the test or the code is wrong, and why
4. **Wait for explicit sign-off** before making any changes

### What requires manual sign-off:

- Changing any assertion (expected values, matchers, thresholds)
- Deleting or skipping a test (`test.skip`, `.only`, commenting out)
- Changing test selectors or locators
- Weakening a test (e.g. changing `toBe` to `toContain`, exact match to regex)
- Removing a test file
- Changing the test environment or configuration in ways that affect test behaviour

### What Claude CAN do without sign-off:

- Fix the application code so the existing test passes as-is
- Add new tests (net new coverage is always welcome)
- Fix test infrastructure that doesn't change assertions (e.g. installing a missing dependency, adding a mock for a new import)

### Process for intentional content changes:

When Claude is deliberately changing tool responses, error messages, or API behaviour, it must:

1. Make the code change
2. Run the tests — they will fail because the output changed
3. List every failing test with the old expected value and the new value
4. Ask for sign-off: "These N tests need updating because the output intentionally changed. May I update them?"
5. Only update the tests after receiving explicit approval

This policy applies to all test types: unit (Jest/Vitest), integration, and any future test suites.

## Workflow & Backup Integrity Policy

**FALSE POSITIVES ARE WORSE THAN FAILURES.** This policy mirrors the lyra repo. Even though this repo has fewer workflows, the same rules apply.

### Forbidden patterns

Claude must NEVER introduce, and must actively REMOVE on sight:

1. **Silent-skip on missing secrets** — `if: env.X != ''` patterns that skip a critical step without failing.
2. **Error-swallowing fallbacks for critical data** — any pattern that overwrites a target file with a placeholder string when the real operation fails. Use `set -euo pipefail` and let the error propagate.
3. **Lossy** `|| echo "?"` **fallbacks** that mask fetch failures as data placeholders. Distinguish "0" from "fetch failed".
4. `continue-on-error: true` on critical steps. Acceptable only on advisory steps with a code comment explaining why.
5. **Multi-line** `run:` **blocks without** `set -euo pipefail`.

### Required patterns

Every multi-line shell block must:

1. Start with `set -euo pipefail`.
2. Validate critical outputs before declaring success.
3. Use GitHub `::error::` and `::warning::` annotations on failure.

### Pre-merge grep checks

```bash
grep -rn -E "(test|it|describe)\.(skip|todo|only)" tests/ src/
grep -rn -E "if:.*env\..*!=\s*''" .github/workflows/
grep -rn -E '\|\|\s*echo\s*"' .github/workflows/
grep -rn -E "continue-on-error:\s*true" .github/workflows/
```

If any match, justify in a code comment or remove. Tracked under KAN-167 in the lyra project.

## Known Technical Gotchas

1. **Supabase service role key**: The MCP server uses `SUPABASE_SERVICE_ROLE_KEY` which bypasses RLS. Every database query must be carefully scoped — never return data the requesting user shouldn't see.

2. **Rate limiting is in-memory**: The rate limiter resets on redeploy. This is acceptable at current scale but won't survive horizontal scaling.

3. **Prompt injection via profile data**: Users can put arbitrary text in bio/preferences fields. The MCP server must never execute or evaluate profile data — it's always treated as untrusted strings.

4. **Tool annotations**: All tools have `readOnlyHint` and `destructiveHint` annotations. Write tools require API key auth. Read tools are public. Don't change these classifications without sign-off.

5. **Streamable HTTP transport**: The server uses HTTP transport (not stdio) for cloud accessibility. CORS, rate limiting, and request logging are all configured in the transport layer.

## Security Rules

- Read tools (get_profile, search, etc.) are public — no auth required
- Write tools (add_item, update_profile, etc.) require a valid API key in the `x-api-key` header
- API keys are looked up in the `api_keys` table with RLS
- All user input is sanitised before database operations
- The server must never return service role key, connection strings, or internal errors to clients
