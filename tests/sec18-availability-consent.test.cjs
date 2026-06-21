/**
 * SEC-18 (F-07) — lyra_get_shared_availability must only fan out a linked
 * profile's busy-times when the profile owner has opted in
 * (profiles.share_availability_with_contacts = true). This pins the consent
 * filter so it can't be silently removed.
 */

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'convene-availability-tool.ts'), 'utf8');

describe('SEC-18 busy-time consent gate (convene-availability-tool)', () => {
  test('selects the consent column from profiles', () => {
    expect(src).toMatch(/share_availability_with_contacts/);
    expect(src).toMatch(/\.select\(['"]id, user_id, share_availability_with_contacts['"]\)/);
  });

  test('only maps consenting profiles into the availability fan-out', () => {
    // The profileToUser.set must be guarded by the consent flag.
    expect(src).toMatch(/share_availability_with_contacts === true[\s\S]{0,120}profileToUser\.set/);
  });

  test('still excludes suspended profiles', () => {
    expect(src).toMatch(/\.eq\(['"]is_suspended['"],\s*false\)/);
  });
});
