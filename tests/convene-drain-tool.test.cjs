/**
 * KAN-209 P5 part 2 — lyra_drain_invite_queue tool structural tests.
 */

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'convene-drain-tool.ts'),
  'utf8'
);

describe('Convene drain tool — structure (KAN-209)', () => {
  test('file exists + wired into index', () => {
    expect(src).toBeTruthy();
    const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    expect(idx).toMatch(/import\s*\{\s*registerConveneDrainTool\s*\}/);
    expect(idx).toMatch(/registerConveneDrainTool\(server\)/);
  });

  test('lyra_drain_invite_queue is registered', () => {
    expect(src).toMatch(/server\.registerTool\(\s*['"]lyra_drain_invite_queue['"]/);
  });

  test('requires api_key', () => {
    expect(src).toMatch(/api_key:\s*z\.string/);
  });

  test('authenticates before calling lyra (fail-fast)', () => {
    expect(src).toMatch(/authenticateApiKey\(input\.api_key\)/);
    expect(src).toMatch(/auth\.authenticated/);
  });

  test('POSTs to /api/convene/admin/drain-queue on the lyra side', () => {
    expect(src).toMatch(/\/api\/convene\/admin\/drain-queue/);
    expect(src).toMatch(/method:\s*['"]POST['"]/);
  });

  test('forwards user API key as Bearer (so lyra can re-validate + scope to user)', () => {
    expect(src).toMatch(/Authorization:\s*`Bearer \$\{input\.api_key\}`/);
  });

  test('does NOT directly call Resend or send emails (lyra side handles that)', () => {
    expect(src).not.toMatch(/resend\.com|api\.resend|RESEND_API_KEY/i);
  });

  test('emits _data_notice on success path (prompt-injection guard)', () => {
    expect(src).toMatch(/_data_notice/);
  });

  test('handles non-JSON response from lyra gracefully', () => {
    expect(src).toMatch(/non-JSON response/);
  });

  test('returns the lyra summary verbatim under summary key', () => {
    expect(src).toMatch(/summary:\s*body\.summary/);
  });
});
