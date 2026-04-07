# CLAUDE.md — Project Instructions for Claude

This file contains instructions and policies that Claude must follow when working on this repository.

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
- Changing test selectors or locators (CSS selectors, text matchers, aria labels)
- Weakening a test (e.g. changing `toBe` to `toContain`, `toBeVisible` to `toBeAttached`, exact match to regex)
- Removing a test file
- Changing the test environment or configuration (jest.config, playwright.config) in ways that affect test behaviour

### What Claude CAN do without sign-off:

- Fix the application code so the existing test passes as-is
- Add new tests (net new coverage is always welcome)
- Fix test infrastructure that doesn't change assertions (e.g. installing a missing dependency, adding a mock for a new import)

### Process for intentional content changes:

When Claude is deliberately changing site content (e.g. updating a tagline, adding a page), it must:

1. Make the code change
2. Run the tests — they will fail because the content changed
3. List every failing test with the old expected value and the new value
4. Ask for sign-off: "These N tests need updating because the content intentionally changed. May I update them?"
5. Only update the tests after receiving explicit approval

This policy applies to all test types: unit (Jest), E2E (Playwright), smoke, integration, and any future test suites.
