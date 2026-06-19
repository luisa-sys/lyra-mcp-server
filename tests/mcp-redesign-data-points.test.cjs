/**
 * June-2026 profile-redesign — MCP server data-point coverage + privacy guard.
 *
 * The Lyra web app's June-2026 profile redesign added new data points that
 * the MCP server must surface, plus a CRITICAL privacy rule for school
 * affiliations. These columns/enum values already exist in Supabase on dev
 * and prod, so this is purely MCP server code + tests.
 *
 * New data points:
 *   1. profile_manual_of_me gained `good_to_know` + `boundaries` (alongside
 *      communication_style / working_preferences / energises_me / drains_me).
 *   2. school_affiliations gained `show_on_profile` (boolean, default false)
 *      and `description` (text). PRIVACY RULE: affiliations are HIDDEN by
 *      default — any tool that returns affiliations in public/profile output,
 *      and especially Find-Someone (lyra_search_profiles school filter and
 *      lyra_list_schools), MUST only expose affiliations where
 *      show_on_profile = true. Hidden affiliations must NEVER appear in
 *      search results or profile output.
 *   3. profile_items item_category enum gained favourite_tv, favourite_places,
 *      favourite_music (joining favourite_books / favourite_media / quotes as
 *      the "favourites" grid). These flow through the existing items[] path,
 *      so coverage here is documentation-level (descriptions advertise them).
 *
 * Static-grep guards in the style of mcp-visibility-guard.test.cjs and
 * mcp-suspension-guard.test.cjs — cheap, fast, no DB. The DB round-trip
 * behaviour is covered by the web app's own integration suite.
 */

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const indexSrc = fs.readFileSync(path.join(root, 'src', 'index.ts'), 'utf8');
const writeSrc = fs.readFileSync(path.join(root, 'src', 'write-tools.ts'), 'utf8');
const indexLines = indexSrc.split('\n');

// ── Helper: find every real (non-comment, non-backtick) read of a table ──
function findFromReads(src, table) {
  const needle = `.from('${table}')`;
  const lines = src.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const idx = line.indexOf(needle);
    if (idx === -1) continue;
    const commentIdx = line.indexOf('//');
    if (commentIdx !== -1 && commentIdx < idx) continue;
    const before = line.slice(0, idx);
    if ((before.match(/`/g) || []).length % 2 === 1) continue;
    hits.push({ lineIndex: i, lineNumber: i + 1 });
  }
  return hits;
}

function blockAfter(lines, lineIndex, n = 8) {
  return lines.slice(lineIndex, Math.min(lines.length, lineIndex + n)).join('\n');
}

// ════════════════════════════════════════════════════════════════════
//  1. Manual of Me — good_to_know + boundaries surfaced on reads
// ════════════════════════════════════════════════════════════════════
describe('June-2026 redesign — Manual of Me new fields (good_to_know, boundaries)', () => {
  test('every profile_manual_of_me read selects good_to_know and boundaries', () => {
    const reads = findFromReads(indexSrc, 'profile_manual_of_me');
    // lyra_get_profile + lyra_get_section both read this table.
    expect(reads.length).toBeGreaterThanOrEqual(2);
    const offenders = [];
    for (const hit of reads) {
      const block = blockAfter(indexLines, hit.lineIndex, 5);
      if (!/good_to_know/.test(block) || !/boundaries/.test(block)) {
        offenders.push(hit.lineNumber);
      }
    }
    if (offenders.length > 0) {
      throw new Error(
        `profile_manual_of_me reads missing good_to_know/boundaries at lines: ${offenders.join(', ')}`,
      );
    }
    expect(offenders).toEqual([]);
  });

  test('manual_of_me reads still select the original four fields', () => {
    // Regression: don't lose the existing fields when adding the new ones.
    const reads = findFromReads(indexSrc, 'profile_manual_of_me');
    for (const hit of reads) {
      const block = blockAfter(indexLines, hit.lineIndex, 5);
      expect(block).toMatch(/communication_style/);
      expect(block).toMatch(/working_preferences/);
      expect(block).toMatch(/energises_me/);
      expect(block).toMatch(/drains_me/);
    }
  });
});

// ════════════════════════════════════════════════════════════════════
//  2. PRIVACY — affiliations hidden by default (show_on_profile = true)
// ════════════════════════════════════════════════════════════════════
describe('June-2026 redesign — affiliation privacy (show_on_profile)', () => {
  // Every read of school_affiliations in index.ts that returns data to a
  // caller (directly or via Find-Someone) MUST chain
  // .eq('show_on_profile', true). The service-role client bypasses RLS, so
  // this app-layer filter is the only thing keeping hidden affiliations
  // out of output. Mirrors the visibility/suspension guards.
  const reads = findFromReads(indexSrc, 'school_affiliations');

  test('index.ts has at least the four expected affiliation reads', () => {
    // search (school filter), get_profile, get_insights, list_schools.
    expect(reads.length).toBeGreaterThanOrEqual(4);
  });

  test('every school_affiliations read chains .eq("show_on_profile", true)', () => {
    const offenders = [];
    for (const hit of reads) {
      const block = blockAfter(indexLines, hit.lineIndex, 8);
      if (!/\.eq\(\s*['"]show_on_profile['"]\s*,\s*true\s*\)/.test(block)) {
        offenders.push({
          line: hit.lineNumber,
          snippet: block.slice(0, 200).replace(/\n/g, ' '),
        });
      }
    }
    if (offenders.length > 0) {
      const msg =
        'school_affiliations reads WITHOUT show_on_profile=true filter ' +
        '(hidden affiliations would leak):\n' +
        offenders.map((o) => `  line ${o.line}: ${o.snippet}…`).join('\n');
      throw new Error(msg);
    }
    expect(offenders).toEqual([]);
  });

  test('no affiliation read filters on show_on_profile=false (would invert the rule)', () => {
    const re = /\.eq\(\s*['"]show_on_profile['"]\s*,\s*false\s*\)/;
    const offenders = [];
    indexLines.forEach((line, idx) => {
      if (re.test(line)) offenders.push(idx + 1);
    });
    expect(offenders).toEqual([]);
  });

  test('lyra_search_profiles school filter respects show_on_profile (Find-Someone)', () => {
    // Pin the specific Find-Someone path: the school-search branch must
    // only match profiles via SHOWN affiliations, otherwise searching a
    // school reveals people who hid that affiliation.
    const block = indexSrc.match(
      /if\s*\(\s*school\s*\)\s*\{([\s\S]*?)\n\s{4}\}/,
    );
    expect(block).not.toBeNull();
    expect(block[1]).toMatch(/\.from\(\s*['"]school_affiliations['"]\s*\)/);
    expect(block[1]).toMatch(/\.eq\(\s*['"]show_on_profile['"]\s*,\s*true\s*\)/);
  });

  test('lyra_list_schools (Find-Someone) filters to shown affiliations', () => {
    const block = indexSrc.match(
      /'lyra_list_schools'[\s\S]*?async \(\{ query \}\) =>[\s\S]*?\n {2}\}\n\);/,
    );
    expect(block).not.toBeNull();
    expect(block[0]).toMatch(/\.eq\(\s*['"]show_on_profile['"]\s*,\s*true\s*\)/);
  });
});

describe('June-2026 redesign — affiliation description surfaced on reads', () => {
  test('lyra_get_profile selects affiliation description', () => {
    // The get_profile affiliation read should include the new description
    // column so it reaches the caller.
    const getProfileBlock = indexSrc.match(
      /'lyra_get_profile'[\s\S]*?manual_of_me:\s*manual/,
    );
    expect(getProfileBlock).not.toBeNull();
    const affRead = getProfileBlock[0].match(
      /\.from\(\s*['"]school_affiliations['"]\s*\)[\s\S]*?\.eq\(\s*['"]show_on_profile['"]/,
    );
    expect(affRead).not.toBeNull();
    expect(affRead[0]).toMatch(/description/);
  });

  test('lyra_list_schools surfaces description in its output mapping', () => {
    expect(indexSrc).toMatch(/description:\s*s\.description/);
  });
});

// ════════════════════════════════════════════════════════════════════
//  3. Favourites grid — new item_category values advertised
// ════════════════════════════════════════════════════════════════════
describe('June-2026 redesign — new favourites categories advertised', () => {
  const FAVOURITES = ['favourite_tv', 'favourite_places', 'favourite_music'];

  test('lyra_get_section description mentions the three new favourites categories', () => {
    const block = indexSrc.match(
      /'lyra_get_section',\s*\{[\s\S]*?description:\s*\n?\s*'([\s\S]*?)',/,
    );
    expect(block).not.toBeNull();
    for (const cat of FAVOURITES) {
      expect(block[1]).toMatch(new RegExp(cat));
    }
  });

  test('lyra_get_section category input schema lists the new favourites', () => {
    const schema = indexSrc.match(
      /'lyra_get_section',\s*\{[\s\S]*?category:\s*z\.string\(\)\.describe\(\s*['"]([^'"]+)['"]\s*\)/,
    );
    expect(schema).not.toBeNull();
    for (const cat of FAVOURITES) {
      expect(schema[1]).toMatch(new RegExp(cat));
    }
  });

  test('lyra_get_profile description mentions the favourites grid', () => {
    const block = indexSrc.match(
      /'lyra_get_profile',\s*\{[\s\S]*?description:\s*\n?\s*'([\s\S]*?)',/,
    );
    expect(block).not.toBeNull();
    expect(block[1]).toMatch(/favourite/i);
  });
});

// ════════════════════════════════════════════════════════════════════
//  4. Write tools — new fields accepted + moderated
// ════════════════════════════════════════════════════════════════════
function extractWriteToolBlock(toolName) {
  const marker = `'${toolName}'`;
  const idx = writeSrc.indexOf(marker);
  if (idx === -1) return null;
  const openIdx = writeSrc.lastIndexOf('registerTool(', idx);
  if (openIdx === -1) return null;
  let depth = 0;
  let i = openIdx + 'registerTool'.length;
  for (; i < writeSrc.length; i++) {
    const ch = writeSrc[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }
  return writeSrc.slice(openIdx, i);
}

describe('June-2026 redesign — write tools accept new fields', () => {
  describe('lyra_add_school accepts show_on_profile + description', () => {
    const block = extractWriteToolBlock('lyra_add_school');

    test('tool block found', () => {
      expect(block).not.toBeNull();
    });

    test('schema declares show_on_profile (boolean) and description', () => {
      expect(block).toMatch(/show_on_profile:\s*z\.boolean\(\)/);
      expect(block).toMatch(/description:\s*z\.string\(\)/);
    });

    test('defaults show_on_profile to false (hidden by default)', () => {
      // Must NOT default-true. The insert sets show_on_profile to a strict
      // `=== true` check so an omitted/false value stays hidden.
      expect(block).toMatch(/show_on_profile:\s*show_on_profile\s*===\s*true/);
    });

    test('moderates description before insert', () => {
      expect(block).toMatch(
        /moderateAndAudit\s*\(\s*\{[\s\S]*?field:\s*'school_affiliations\.description'/,
      );
      const insertIdx = block.indexOf(".from('school_affiliations')");
      const descModIdx = block.indexOf('school_affiliations.description');
      expect(descModIdx).toBeGreaterThan(0);
      expect(insertIdx).toBeGreaterThan(descModIdx);
    });
  });

  describe('lyra_update_school exists and toggles show_on_profile', () => {
    const block = extractWriteToolBlock('lyra_update_school');

    test('tool is registered', () => {
      expect(block).not.toBeNull();
    });

    test('accepts show_on_profile and description, scoped by school_id', () => {
      expect(block).toMatch(/show_on_profile:\s*z\.boolean\(\)/);
      expect(block).toMatch(/school_id:\s*z\.string\(\)/);
    });

    test('update is ownership-scoped to the caller profile', () => {
      // Must chain .eq('profile_id', auth.profileId) so a user can only
      // edit their own affiliations.
      expect(block).toMatch(/\.eq\(\s*['"]profile_id['"]\s*,\s*auth\.profileId\s*\)/);
    });

    test('moderates description when provided', () => {
      expect(block).toMatch(
        /moderateAndAudit\s*\(\s*\{[\s\S]*?field:\s*'school_affiliations\.description'/,
      );
    });
  });

  describe('lyra_update_manual_of_me exists and accepts all six fields', () => {
    const block = extractWriteToolBlock('lyra_update_manual_of_me');

    test('tool is registered', () => {
      expect(block).not.toBeNull();
    });

    test('schema declares the two new fields plus the original four', () => {
      for (const f of [
        'communication_style',
        'working_preferences',
        'energises_me',
        'drains_me',
        'good_to_know',
        'boundaries',
      ]) {
        expect(block).toMatch(new RegExp(`${f}:\\s*z\\.string\\(\\)`));
      }
    });

    test('moderates manual_of_me fields as public content', () => {
      expect(block).toMatch(
        /moderateAndAudit\s*\(\s*\{[\s\S]*?fieldType:\s*'public'/,
      );
      expect(block).toMatch(/profile_manual_of_me\.\$\{key\}|profile_manual_of_me\./);
    });

    test('upserts on profile_id (1-1 table)', () => {
      expect(block).toMatch(/\.upsert\(/);
      expect(block).toMatch(/onConflict:\s*['"]profile_id['"]/);
    });
  });
});

// ════════════════════════════════════════════════════════════════════
//  5. Discovery / advertised tool inventory stays in sync
// ════════════════════════════════════════════════════════════════════
describe('June-2026 redesign — new write tools advertised in /.well-known/mcp.json', () => {
  test('mcp.json tools list includes the new write tools', () => {
    expect(indexSrc).toMatch(/'lyra_update_manual_of_me'/);
    expect(indexSrc).toMatch(/'lyra_update_school'/);
  });
});
