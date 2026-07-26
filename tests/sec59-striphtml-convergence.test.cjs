/**
 * SEC-59 stripHtml convergence (2026-07-14): user-MCP `sanitiseText` must strip
 * HTML with the same looped fixed-point algorithm as the web app's KAN-171
 * `stripHtml`, not the old single-pass `replace(/<[^>]*>/g, '')` which is
 * defeated by nested-tag bypasses like `<scr<script>ipt>` (removing the inner
 * `<script>` leaves an outer `<script>` intact — CodeQL
 * js/incomplete-multi-character-sanitization, high; CWE-020/080/116).
 *
 * Importing the compiled ESM dist from a .cjs test is not viable in this repo
 * (see the note in oauth-jwt-validator.test.cjs / sec09-search-sanitise.test.cjs),
 * so this is a structural guard in the same style as mcp-phase2 and sec09: it
 * pins the presence of the convergent algorithm and its wiring. The behavioural
 * assertions on the identical algorithm (nested/interleaved/malformed-tag cases)
 * live in the lyra repo's tests/unit/sanitise.test.ts.
 */
const fs = require('fs');
const path = require('path');

const sanitiseSrc = fs.readFileSync(
  path.join(__dirname, '../src/sanitise.ts'),
  'utf8',
);

describe('SEC-59 — stripHtml convergence in user-MCP sanitiseText', () => {
  test('stripHtml is exported', () => {
    expect(sanitiseSrc).toContain('export function stripHtml');
  });

  test('stripHtml loops the tag regex to a fixed point (nested-tag-bypass safe)', () => {
    // The single-pass `.replace(/<[^>]*>/g, '')` is only bypass-safe when applied
    // repeatedly until the string stops changing.
    expect(sanitiseSrc).toContain('replace(/<[^>]*>/g');
    expect(sanitiseSrc).toMatch(/do\s*\{/);
    expect(sanitiseSrc).toContain('while (current !== prev)');
  });

  test('sanitiseText delegates HTML stripping to stripHtml', () => {
    const body = sanitiseSrc.slice(
      sanitiseSrc.indexOf('export function sanitiseText'),
    );
    expect(body).toContain('stripHtml(input)');
  });

  test('sanitiseText normalises internal whitespace', () => {
    const body = sanitiseSrc.slice(
      sanitiseSrc.indexOf('export function sanitiseText'),
    );
    expect(body).toContain('replace(/\\s+/g');
  });

  test('sanitiseText still enforces the max length bound', () => {
    const body = sanitiseSrc.slice(
      sanitiseSrc.indexOf('export function sanitiseText'),
    );
    expect(body).toContain('substring(0, maxLength)');
  });
});
