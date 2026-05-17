# [CLAUDE.md](http://CLAUDE.md) — Project Instructions for Claude

This file contains instructions and policies that Claude must follow when working on this repository.

## Pre-Work Checklist

Before starting any task, Claude must:

1. **Check Jira** — confirm a ticket exists for the work, or create one. Never start work without a tracked ticket.
2. **Check the lyra repo's docs/** — architecture docs live in the main lyra repo at `docs/`. Read relevant docs before acting on architecture, ops, or infrastructure questions.
3. **Check for existing work** — search the codebase and recent PRs to avoid duplicating effort.
4. **Run tests before and after** — every change must leave tests green.
5. **Confirm working tree isolation** — if any other Claude Code instance might be running against this repo, this session MUST run inside its own git worktree (see "Parallel Claude sessions" below). Verify with `git branch --show-current` at the start of work AND right before every commit; if HEAD has changed unexpectedly, stop and recover (BUGS-17).

## Parallel Claude sessions — use git worktrees

Luisa runs multiple Claude Code instances in parallel to work on independent features. **All instances after the first MUST operate in a git worktree** rather than the shared main checkout. Without isolation, parallel processes switch HEAD mid-flow and contaminate each other's commits — see BUGS-17 for the canonical incident (KAN-69a work landed on top of KAN-191 commits because two Claude sessions were sharing one checkout).

The lyra repo's `CLAUDE.md` is the source of truth for this policy. Briefly:

- Use `EnterWorktree` (Claude Code built-in) to isolate the current session.
- For sub-agents, pass `isolation: "worktree"` on the Agent tool call.
- For manually-launched sessions, `git worktree add ../<repo>-<branch> origin/main` (or `origin/develop` in the lyra repo) before invoking `claude`.
- Pre-commit safety check: `git branch --show-current` must equal the branch you intended. If it doesn't, do not commit — recover per BUGS-17's recovery section.

**Cleanup is mandatory at end of session:** every worktree Claude created must be either removed (work merged or abandoned) or explicitly noted as "kept for next session" in the session summary. Use `git worktree remove ../<worktree-name>` (or `ExitWorktree action="remove"` if EnterWorktree was used). Run `git worktree prune` afterwards to clear stale registry entries. Never `rm -rf` a worktree directory — that leaves zombie metadata in `.git/worktrees/`. Full cleanup decision tree is in `lyra/CLAUDE.md`.

When in doubt, prefer a worktree. Disk is cheap; mixed-feature PRs that ship contaminated code are not.

## Jira Ticket Standard

All work must be tracked in Jira. KAN project for design/deployment, BUGS project for bug tracking.

Every KAN Task/Story description MUST include all six sections:

1. **What & Why**
2. **Implementation steps**
3. **Tests Required** — unit, functional, E2E: what to test, mocks, edge cases
4. **Security Review** — threats introduced, RLS/auth impact, input validation
5. **Architecture Impact** — docs/env vars/dependencies to update
6. **Acceptance Criteria**

## MCP-main lockstep policy (KAN-222 — mirror)

This repo and `luisa-sys/lyra` are two surfaces of the same product. **Every user-facing feature in the main repo must ship MCP tool coverage in the same epic, or carry an explicit deferral annotation.** Canonical policy in `lyra/CLAUDE.md` → "MCP-main lockstep policy"; this section is the mirror.

Applied to this repo, it means:

- **A KAN ticket landing in `luisa-sys/lyra` against user data should produce a paired PR here.** When you pick up an MCP-related KAN ticket, check whether a paired main-app PR is already open.
- **Read tools (`lyra_list_*`, `lyra_get_*`, `lyra_search_*`)** are public — no API key needed. New entities exposed in the main app must have a read tool here within the same epic.
- **Write tools** require the existing API-key auth (post-KAN-88: bearer JWT). User-action parity: if the main app lets a user create/edit/delete an entity, MCP gets a `lyra_<verb>_*` write tool.
- **Static-grep guards** enforce data scoping. `mcp-visibility-guard.test.cjs` and (post-Convene-P1) `mcp-ownership-guard.test.cjs` fail CI if a `from(...)` read is missing its visibility or ownership filter. Add new guards alongside new tables.
- **Deferral annotation** — if MCP coverage is intentionally not in scope for an epic, the parent KAN ticket must contain the literal line `MCP coverage: deferred — <reason> (follow-up: KAN-XYZ)`. The follow-up ticket must exist before merge.

### Deploy order

When shipping a feature with both main-app and MCP changes:

1. Merge the MCP PR to `main` first — Railway auto-deploys.
2. Wait for `mcp-dev.checklyra.com/health` (or `mcp.checklyra.com/health` for production) to report the new build.
3. Then merge the main-app PR — Vercel auto-deploys.
4. End-to-end test exercises the new tool from an agent against the deployed pair.

Reverse for rollback: web first (Vercel revert), then MCP (Railway redeploy of previous).

### Source of truth

`luisa-sys/lyra/CLAUDE.md` → "MCP-main lockstep policy". This file is intentionally short — the full reviewer checklist, kicks-in-when conditions, and rationale live in the main repo. Keep this section in sync if the canonical one changes.

## Deployment

- This repo deploys to Railway at [mcp.checklyra.com](http://mcp.checklyra.com) (prod) and [mcp-dev.checklyra.com](http://mcp-dev.checklyra.com) (dev)
- Railway auto-deploys from `main` branch via the Railway GitHub App
- Push to main only after tests pass
- Production MCP server points to production Supabase; dev MCP server points to dev Supabase (see Gotcha #6)
- Current test floor: **217 tests** (13 suites). Note: the `MCP Server - Project Structure > compiled output exists` test requires `npx tsc` to have run first (it asserts `dist/index.js` exists). CI's "TypeScript build" step satisfies this; locally you must `npx tsc` before `npm test` or that one test fails.

### Railway settings — DO NOT CHANGE WITHOUT READING BUGS-18

Both Railway services (`lyra-mcp-server` and `lyra-mcp-dev`) are configured with:

- **Source Repo**: `luisa-sys/lyra-mcp-server`, branch `main`, auto-deploy ON.
- **Wait for CI**: **OFF**. This is load-bearing. Do not flip it back on.
- **GitHub App scope**: this single repo only (not "All repositories"), so a future repo-rename in this org won't quietly grant Railway write access to unrelated repos.

**Why Wait for CI must stay off:** With it ON, Railway waits for every GitHub-posted check_suite (Vercel/Cloudflare/Supabase/etc.) to resolve before deploying. Any third-party app that posts a check_suite but never resolves it (broken webhook, app uninstalled, etc.) wedges Railway indefinitely. That's the "phantom check_suite" outage we hit in May 2026 and tracked under BUGS-18. With it OFF, Railway deploys on push and the `post-merge-deploy-smoke.yml` workflow asserts the live `build_sha` matches main HEAD within ~10 min — so any deploy regression is still caught fast, without depending on third-party check resolution.

**Why this is safe:** PR-side CI (`test.yml` triggered on `pull_request`) is the actual quality gate. By the time something reaches main, CI passed. The merge-commit CI run is redundant for the deploy decision.

### Deploy verification

After any change to Railway settings, the source repo connection, or the build pipeline:

```bash
# Should return the current main HEAD SHA
curl -s https://mcp.checklyra.com/.well-known/mcp.json | jq -r .build_sha
git rev-parse origin/main
```

The two values must match within ~3 min of any push to main. If they don't, the `post-merge-deploy-smoke.yml` GitHub Action will fail loud within ~10 min — see BUGS-18 for the runbook.

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
