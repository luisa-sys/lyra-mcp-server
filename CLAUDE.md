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

All work must be tracked in Jira. **KAN** for design/deployment, **BUGS** for bug tracking, and **SEC** (Security & Risk — team-managed) for all security and risk findings: vulnerabilities, data-protection/compliance, ops-resilience and governance. Route any security or risk-audit work to **SEC**, not KAN/BUGS.

- The second-line **Lyra Risk Register** (Confluence space TWC) is the index of findings; the Jira epic **SEC-1** ("2026-06 Second-line Risk & Security Audit") is their tracking home.
- **Transition IDs** (for `transitionJiraIssue`) — ⚠️ **they differ per project, and a wrong id fails SILENTLY**:

  | project | To Do | In Progress | In Review | Done |
  |---|---|---|---|---|
  | **SEC** | `11` | `21` | — | `31` |
  | **BUGS** | `21` | `31` | — | `41` |
  | **KAN** | `11` | `21` | `31` | `41` |

  **Verify every transition by reading the status back.** `transitionJiraIssue` returns HTTP
  success for an id that is valid-but-not-the-one-you-meant, so passing KAN `21` to a ticket
  that is already In Progress transitions In Progress → In Progress and changes nothing. No
  error, no warning, and the ticket silently stays where it was. Corrected 2026-08-14, after
  this line's previous text (`cf. KAN 21/41`) caused exactly that no-op during the backlog
  audit — `21` is KAN's **In Progress**, not its To Do.

Every KAN/SEC Task/Story description MUST include all six sections:

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
- Current test floor: **785 tests** (46 suites). **Measured 2026-08-21** via `npx tsc && npm test` on the KAN-356 leg A branch off `main` `550dfae`. Up 17 from 768/45 — `tests/kan356-cross-user-isolation.test.cjs`, the **first RUNTIME cross-user isolation test in this repo** (KAN-356 finding mcp-quality-4). Both halves measured, not inferred: the new suite reads 17 standing alone and the full run reads 785. ⚠️ **The finding is what a source scan cannot see.** `tests/mcp-ownership-guard.test.cjs` proves a filter STRING is present near a `.from()`; it cannot prove the VALUE bound to it is the caller's, and its own header concedes that every child table is waved through on an `// ownership-ok:` comment. Mutation-proven 4 ways, each asserted applied and each restore byte-exact via `cmp`. **The two that matter are the ones where the static guard stays 57/57 GREEN:** (M1) deleting only the `if (!gathering) return …` early return from `lyra_get_gathering` — every `.eq()` string still textually present — makes user B's request issue all three child-table queries against user A's gathering; (M4) deleting `.eq('owner_user_id', userId)` from the `oauth_connections` lookup in `convene-availability-tool.ts` is invisible to the guard **because the `// ownership-ok:` comment above it exempts it** — so whose Google calendar you read was protected by a comment asserting the very filter that could be removed. A second observation worth keeping: under M1 the handler also throws on `gathering.venue_id`, so a test asserting only on RETURNED DATA would have gone red for the wrong reason (a TypeError, not a leak). The assertion that makes it unambiguous is the one on the REQUESTS ISSUED. Previously **768 tests** (45 suites), measured 2026-08-14 on the SEC-46 Phase A/B branch off `main` `34f6d07`. Up 16 from 752/44 — `tests/sec46-revocation-audience.test.cjs`, the **first behavioural test of `validateOAuthAccessToken` in this repo**. ⚠️ That gap is worth understanding before adding OAuth tests: `jest.config.cjs` matches only `*.test.cjs` while the package is `"type": "module"`, so a `.cjs` test cannot `require()` the compiled ESM in `dist/`, and every prior OAuth suite is therefore a source-text grep. `oauth-jwt-validator.test.cjs` asserts `expect(src).toMatch(/OAUTH_REVOCATION_CHECK/)`, which stays green with the whole revocation block deleted so long as a comment mentions the name — and a real fail-open lived under that tick. The way through is NOT to widen `testMatch` (a jest-config change needs sign-off and alters how all 45 suites execute) but an `.mjs` subprocess harness under `tests/support/` driven by `execFileSync`, per `lyra/CLAUDE.md` → "Writing a test that can actually fail". `tests/support/oauth-jwt-harness.mjs` is the worked example: it points the real supabase-js client at a local HTTP stub, so the assertions cover the actual PostgREST query shape rather than a hand-stubbed chain that would agree with whatever the code did. Previously 752/44 on the KAN-354 sec17-widening branch off `main` `4930561`. Up 19 from 733/44 — `tests/sec17-error-leak.test.cjs` went from a hard-coded 2-file corpus (6 tests) to one derived from the tree (25 tests), covering all 11 tool modules instead of 2. No suite added; same file. Founder-signed-off under the Test Integrity Policy as a coverage **expansion**, and mutation-proven on `convene-lifecycle-tools.ts` — a module that had no coverage at all before. Previously 733/44, **measured 2026-08-12** on `main` `10406a0` during the Weekly Health + Regression routine, itself down 1 test from 734/44 (2026-08-09, `main` `3a6a1ea`) — traced to PR [#147](https://github.com/luisa-sys/lyra-mcp-server/pull/147) (fix/SEC-83), which retired the `ACCESS_MODEL_V2` dual path and repointed its tests from pinning the old implementation shape to pinning the invariant instead; that commit's own message records `733/733 tests, build clean`, so this is expected drift, not a silent deletion. Re-measure and update this line whenever it drifts — a floor far below reality (this one was **217/13**, over 3x stale) cannot detect a regression that deletes hundreds of tests. Note: the `MCP Server - Project Structure > compiled output exists` test requires `npx tsc` to have run first (it asserts `dist/index.js` exists). CI's "TypeScript build" step satisfies this; locally you must `npx tsc` before `npm test` or that one test fails.

### OAuth resource-server env vars (SEC-46) — two of these are now security decisions

| Var | Default | What it does |
|---|---|---|
| `OAUTH_REVOCATION_CHECK` | **ON** (`'0'` disables) | Looks the `jti` up in `oauth_access_tokens` on every authenticated tool call and refuses a revoked token, an unknown one, **or a failed lookup**. |
| `OAUTH_AUDIENCE_CHECK` | **OFF** (`'1'` enables) | Enforces `aud` against `MCP_RESOURCE_URL`. Ships inert; logs mismatches instead. |
| `MCP_RESOURCE_URL` | source literal | **Was** a metadata string for the RFC 9728 document. It is now an authorization input, so it must be set explicitly and correctly per service. |
| `LYRA_SITE_URL` | `https://checklyra.com` | The expected issuer. A security control riding a source default — set it explicitly. |

**The two defaults point in opposite directions on purpose.**

Revocation is **default-on** because it was `=== '1'` and set on *no* service, so `revoked_at` was written by `/oauth/revoke` and read by nobody: revocation only bit at expiry, up to an hour later. `'0'` survives as a kill-switch because the check adds a database read to the hot path and **fails closed** — an incident needs a way to shed that dependency without a deploy. Drill it on dev before you need it on prod.

Audience is **default-off** because the authorization server still mints `aud = client_id`, not `aud = <resource>`. Enforcing today would 401 every existing connector. The sequence is: ship this observing → land the AS change so tokens carry the resource → watch Railway logs for `[oauth][SEC-46] audience mismatch` → flip `OAUTH_AUDIENCE_CHECK=1` only after they have been quiet for at least one access-token TTL.

⚠️ **Why the audience check is hand-rolled rather than `jwtVerify`'s `audience:` option**, which would be one line shorter: jose **throws** on mismatch, so there is no observe mode and no way to measure the blast radius before committing. The measurement is the de-risking, and it is the whole reason this ships in two phases.

**The cross-resource replay this closes** is the one worth remembering: `lyra-admin-mcp-server` verifies against the *same* JWKS with issuer only, so one token is accepted by both resource servers today. Once audience is enforced on both, a consumer token minted through the ordinary consent screen can no longer reach admin tools — see SEC-48.

### `ACCESS_MODEL_V2` — schema-gated rollout (KAN-328) — set per-service, NOT in code

Both Railway services deploy the SAME `main` code, so an environment flag — not the
branch — decides whether the new access model is active. `ACCESS_MODEL_V2=true` makes
gated tools require the caller to be `user_status='live'` AND not suspended, and switches
per-feature defaults to the `access_tier` tier model (test features on for `beta`, off for
`prod`; GA features always on). Default (unset/false) preserves the legacy KAN-317
behaviour and reads ONLY `id, age_status` from `profiles`.

**Critical ordering — never turn the flag on before the columns exist.** The flag makes the
server read `profiles.user_status` / `access_tier` / `is_suspended`. A `profiles` table
without those columns will error every gated tool call. The KAN-327 migration adds them.

1. Dev Supabase already has the columns → set `ACCESS_MODEL_V2=true` on **lyra-mcp-dev**, redeploy, verify.
2. Production Supabase gets the columns only when the web team promotes the KAN-327 migration to prod. Set `ACCESS_MODEL_V2=true` on **lyra-mcp-server** ONLY AFTER that. Until then leave it off (prod keeps current behaviour, safely).
3. The GUI's `registry.ts` must adopt the same tier model for true parity (parent epic KAN-326). The flag is a transition mechanism — removable once prod is migrated and the legacy columns are dropped (KAN-326 Phase C).

**SEC-83 — the suspension refusal is now FLAG-INDEPENDENT.** A suspended caller is
refused on every gated write/convene tool regardless of `ACCESS_MODEL_V2`. Under v2,
`profileForUser` already selects `is_suspended`; under v1 the legacy select still omits
it (prod-safe), so `requireFeatures` does a best-effort standalone `is_suspended` lookup
(`callerIsSuspended`) that DEGRADES to not-suspended — with a `console.warn` — on any env
whose `profiles` table predates the KAN-327 column, rather than erroring every call. So on
prod today the gate is inert-but-safe; it activates automatically the moment the KAN-327
column lands. Only the *suspension* half is unconditional — the live/waitlist service gate
(`hasLiveAccess`) stays behind the flag.

### Railway settings — DO NOT CHANGE WITHOUT READING BUGS-18

Both Railway services (`lyra-mcp-server` and `lyra-mcp-dev`) are configured with:

- **Source Repo**: `luisa-sys/lyra-mcp-server`, branch `main`, auto-deploy ON.
- **Wait for CI**: **OFF**. This is load-bearing. Do not flip it back on.
- **GitHub App scope**: this single repo only (not "All repositories"), so a future repo-rename in this org won't quietly grant Railway write access to unrelated repos.

**Why Wait for CI must stay off:** With it ON, Railway waits for every GitHub-posted check_suite (Vercel/Cloudflare/Supabase/etc.) to resolve before deploying. Any third-party app that posts a check_suite but never resolves it (broken webhook, app uninstalled, etc.) wedges Railway indefinitely. That's the "phantom check_suite" outage we hit in May 2026 and tracked under BUGS-18. With it OFF, Railway deploys on push and the `post-merge-deploy-smoke.yml` workflow asserts the live `build_sha` matches main HEAD within ~10 min — so any deploy regression is still caught fast, without depending on third-party check resolution.

> **⚠️ Recurrence — BUGS-54 (2026-06-23).** This outage happened again. "Wait for CI" was manually toggled back **ON** (owner error) on the two `lyra-mcp-server` services during the SEC-33 rollout. Merge `75d9404` to `main` then produced **SKIPPED** Railway deploys on both dev and prod, the servers stayed on the prior build `684f4e8`, and `post-merge-deploy-smoke` went red. The tell-tale: the sibling `lyra-admin-mcp-server` (Wait-for-CI OFF) deployed the equivalent merge fine — so it is a per-service *trigger* setting, not a code fault, and the Railway status is `SKIPPED` (a trigger decision), not `WAITING`/`FAILED`. **Fix: set "Wait for CI" OFF on the affected service, then redeploy.** This is the *first* thing to check whenever Railway deploys show `SKIPPED`. Keep it OFF on **every** Railway service that deploys these MCP repos — currently `lyra-mcp-server` (prod, project `elegant-tranquility`), `lyra-mcp-dev` (dev, project `overflowing-laughter`), and `lyra-admin-mcp-server` (project `resilient-commitment`). At the Railway GraphQL API this is `deploymentTriggers.checkSuites` — it must be `false`. Treat the toggle as do-not-touch; if it must ever change, expect the SKIPPED-deploy outage and revert.

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
