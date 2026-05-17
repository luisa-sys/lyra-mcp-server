/**
 * KAN-209 P5 — invite MCP tools structural tests.
 */

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(
  path.join(__dirname, '..', 'src', 'convene-invite-tools.ts'),
  'utf8'
);

describe('Convene invite tools — structure (KAN-209)', () => {
  test('file exists + wired into index', () => {
    expect(src).toBeTruthy();
    const idx = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    expect(idx).toMatch(/import\s*\{\s*registerConveneInviteTools\s*\}/);
    expect(idx).toMatch(/registerConveneInviteTools\(server\)/);
  });

  describe('lyra_send_invite', () => {
    test('is registered', () => {
      expect(src).toMatch(/server\.registerTool\(\s*['"]lyra_send_invite['"]/);
    });
    test('requires api_key + gathering_id + invitee_id', () => {
      expect(src).toMatch(/api_key:\s*z\.string/);
      expect(src).toMatch(/gathering_id:\s*z\.string\(\)\.uuid/);
      expect(src).toMatch(/invitee_id:\s*z\.string\(\)\.uuid/);
    });
    test('generates rsvp_token via randomBytes base64url', () => {
      expect(src).toMatch(/randomBytes\(\d+\)\.toString\(['"]base64url['"]\)/);
    });
    test('persists message with delivery_status="queued"', () => {
      expect(src).toMatch(/delivery_status:\s*['"]queued['"]/);
    });
    test('writes both events_log and consent_log audit entries', () => {
      expect(src).toMatch(/gathering_invite_sent[\s\S]*?gathering_invite_sent/);
    });
    test('does NOT directly call Resend (send deferred to lyra-side worker)', () => {
      expect(src).not.toMatch(/resend\.com|api\.resend/i);
    });
    test('returns rsvp_url + send_pending=true', () => {
      expect(src).toMatch(/rsvp_url:/);
      expect(src).toMatch(/send_pending:\s*true/);
    });
    test('filters gathering by host_user_id', () => {
      expect(src).toMatch(/\.eq\(['"]host_user_id['"],\s*userId\)/);
    });
    test('rejects invites on cancelled or completed gatherings', () => {
      expect(src).toMatch(/cancelled[\s\S]{0,50}completed|completed[\s\S]{0,50}cancelled/);
      expect(src).toMatch(/Cannot invite to a/);
    });
    test('token TTL bounded 1-180 days', () => {
      // Multi-line zod chain — accept whitespace between min/max.
      expect(src).toMatch(/\.min\(1\)[\s\S]{0,20}\.max\(180\)/);
    });
  });

  describe('lyra_record_rsvp', () => {
    test('is registered', () => {
      expect(src).toMatch(/server\.registerTool\(\s*['"]lyra_record_rsvp['"]/);
    });
    test('filters gathering by host_user_id', () => {
      // appears twice (one per tool) — at least one must match in the record section
      const start = src.indexOf("'lyra_record_rsvp'");
      const block = src.slice(start);
      expect(block).toMatch(/\.eq\(['"]host_user_id['"],\s*userId\)/);
    });
    test('audits the rsvp_recorded event with from/to status', () => {
      const start = src.indexOf("'lyra_record_rsvp'");
      const block = src.slice(start);
      expect(block).toMatch(/rsvp_recorded/);
      expect(block).toMatch(/from_status:\s*invitee\.status/);
      expect(block).toMatch(/to_status:\s*input\.new_status/);
    });
    test('new_status enum includes all expected values', () => {
      expect(src).toMatch(/'accepted'/);
      expect(src).toMatch(/'declined'/);
      expect(src).toMatch(/'tentative'/);
      expect(src).toMatch(/'attended'/);
      expect(src).toMatch(/'no_show'/);
    });
  });

  describe('prompt-injection guard', () => {
    test('both tools emit _data_notice', () => {
      const notices = (src.match(/_data_notice/g) || []).length;
      expect(notices).toBeGreaterThanOrEqual(2);
    });
  });
});
