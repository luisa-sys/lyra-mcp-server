import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getSupabase } from './supabase.js';
import { authenticateApiKey, getProfileForUser } from './auth.js';
import { requireFeatures, requireAgeVerifiedToPublish } from './feature-entitlements.js';
import { sanitiseText, sanitiseUrl } from './sanitise.js';
import { moderateAndAudit } from './moderation-audit.js';

/**
 * Helper: authenticate and get profile ID from API key.
 * Returns an error response if auth fails.
 */
async function authAndProfile(apiKey: string | undefined) {
  if (!apiKey) {
    throw new Error('API key required. Generate one at checklyra.com/dashboard/settings');
  }
  const auth = await authenticateApiKey(apiKey);
  if (!auth.authenticated || !auth.userId) {
    throw new Error(auth.error || 'Authentication failed');
  }
  const profile = await getProfileForUser(auth.userId);
  if (!profile.profileId) {
    throw new Error(profile.error || 'No profile found');
  }
  // KAN-317: every profile-write tool requires the per-user 'mcp' entitlement.
  await requireFeatures(auth.userId, ['mcp']);
  return { userId: auth.userId, profileId: profile.profileId, slug: profile.slug };
}

function errorResponse(msg: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }] };
}

/**
 * SEC-17 / F-15: never surface a raw DB/PostgREST error to the MCP client — the
 * message can leak column names, constraint names, SQL fragments and internal
 * schema. Log the real error server-side; return a generic, safe message.
 */
function clientError(error: unknown, context: string) {
  console.error(`[mcp][${context}] database error:`, error);
  return errorResponse('The request could not be completed. Please check your input and try again.');
}


function okResponse(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerWriteTools(server: McpServer) {

  // ── Tool: Update Profile Fields ─────────────────────────────
  server.registerTool(
    'lyra_update_profile',
    {
      title: 'Update Lyra Profile',
      description:
        'Update profile fields like display name, headline, bio, city, country. Requires API key authentication.',
      inputSchema: {
        api_key: z.string().optional().describe('Lyra API key (lyra_…). Optional — can also be sent via Authorization: Bearer <key>, which most MCP clients do via their connector setup.'),
        display_name: z.string().optional().describe('Display name'),
        headline: z.string().optional().describe('Short headline/tagline'),
        bio_short: z.string().optional().describe('Short bio (max 300 chars)'),
        city: z.string().optional().describe('City'),
        country: z.string().optional().describe('Country code (e.g. GB, US)'),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ api_key, ...fields }) => {
      let auth: { userId: string; profileId: string; slug: string | undefined };
      try { auth = await authAndProfile(api_key as string); } catch (e: any) { return errorResponse(e.message); }

      // Sanitise text fields
      const updates: Record<string, string> = {};
      if (fields.display_name) updates.display_name = sanitiseText(fields.display_name, 100);
      if (fields.headline) updates.headline = sanitiseText(fields.headline, 200);
      if (fields.bio_short) updates.bio_short = sanitiseText(fields.bio_short, 300);
      if (fields.city) updates.city = sanitiseText(fields.city, 100);
      if (fields.country) updates.country = sanitiseText(fields.country, 5);

      if (Object.keys(updates).length === 0) return errorResponse('No fields to update');

      // KAN-242 + KAN-244 — content moderation + audit log. Mirrors the
      // web-app server-action policy. All profile fields are 'public'.
      for (const [key, val] of Object.entries(updates)) {
        const mod = await moderateAndAudit({
          text: val,
          fieldType: 'public',
          field: `profiles.${key}`,
          profileId: auth.profileId,
        });
        if (!mod.ok) return errorResponse(mod.error);
      }

      const sb = getSupabase();
      const { error } = await sb.from('profiles').update(updates).eq('id', auth.profileId);
      if (error) return clientError(error, 'write-tools');

      return okResponse({ success: true, updated: Object.keys(updates), slug: auth.slug });
    }
  );

  // ── Tool: Add Profile Item ──────────────────────────────────
  server.registerTool(
    'lyra_add_item',
    {
      title: 'Add Profile Item',
      description:
        'Add a like, dislike, gift idea, boundary, or other item to a Lyra profile. Requires API key.',
      inputSchema: {
        api_key: z.string().optional().describe('Lyra API key (lyra_…). Optional — can also be sent via Authorization: Bearer <key>, which most MCP clients do via their connector setup.'),
        category: z.enum(['gift_ideas', 'gifts_to_avoid', 'likes', 'dislikes', 'helpful_to_know', 'boundaries'])
          .describe('Item category'),
        title: z.string().describe('Item title (e.g. "Dark chocolate", "No surprise visits")'),
        description: z.string().optional().describe('Optional extra detail'),
      },
      annotations: { destructiveHint: false },
    },
    async ({ api_key, category, title, description }) => {
      let auth: { userId: string; profileId: string; slug: string | undefined };
      try { auth = await authAndProfile(api_key as string); } catch (e: any) { return errorResponse(e.message); }

      // KAN-242 + KAN-244 — content moderation + audit log on item text fields.
      const sanitisedTitle = sanitiseText(title, 200);
      const sanitisedDesc = description ? sanitiseText(description, 1000) : null;
      const titleMod = await moderateAndAudit({
        text: sanitisedTitle,
        fieldType: 'public',
        field: 'profile_items.title',
        profileId: auth.profileId,
      });
      if (!titleMod.ok) return errorResponse(titleMod.error);
      if (sanitisedDesc) {
        const descMod = await moderateAndAudit({
          text: sanitisedDesc,
          fieldType: 'public',
          field: 'profile_items.description',
          profileId: auth.profileId,
        });
        if (!descMod.ok) return errorResponse(descMod.error);
      }

      const sb = getSupabase();
      const { data, error } = await sb.from('profile_items').insert({
        profile_id: auth.profileId,
        category,
        title: sanitisedTitle,
        description: sanitisedDesc,
      }).select('id').single();

      if (error) return clientError(error, 'write-tools');
      return okResponse({ success: true, id: data.id, category, title });
    }
  );

  // ── Tool: Remove Profile Item ───────────────────────────────
  server.registerTool(
    'lyra_remove_item',
    {
      title: 'Remove Profile Item',
      description: 'Remove an item from a Lyra profile by ID. Requires API key.',
      inputSchema: {
        api_key: z.string().optional().describe('Lyra API key (lyra_…). Optional — can also be sent via Authorization: Bearer <key>, which most MCP clients do via their connector setup.'),
        item_id: z.string().describe('Item UUID to remove'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ api_key, item_id }) => {
      let auth: { userId: string; profileId: string; slug: string | undefined };
      try { auth = await authAndProfile(api_key as string); } catch (e: any) { return errorResponse(e.message); }

      const sb = getSupabase();
      const { error } = await sb.from('profile_items')
        .delete()
        .eq('id', item_id)
        .eq('profile_id', auth.profileId);
      if (error) return clientError(error, 'write-tools');
      return okResponse({ success: true, removed: item_id });
    }
  );

  // ── Tool: Add School ────────────────────────────────────────
  server.registerTool(
    'lyra_add_school',
    {
      title: 'Add School Affiliation',
      description: 'Add a school connection to a Lyra profile. Affiliations are HIDDEN from the public profile and search by default — pass show_on_profile=true to make this one visible. Requires API key.',
      inputSchema: {
        api_key: z.string().optional().describe('Lyra API key (lyra_…). Optional — can also be sent via Authorization: Bearer <key>, which most MCP clients do via their connector setup.'),
        school_name: z.string().describe('School name'),
        school_location: z.string().optional().describe('Location'),
        relationship: z.enum(['parent', 'student', 'alumni', 'staff', 'other']).optional().describe('Relationship to school'),
        description: z.string().optional().describe('Optional free-text note about this affiliation (shown only when show_on_profile is true)'),
        show_on_profile: z.boolean().optional().describe('Whether this affiliation is visible on the public profile and in search. Defaults to false (hidden).'),
      },
      annotations: { destructiveHint: false },
    },
    async ({ api_key, school_name, school_location, relationship, description, show_on_profile }) => {
      let auth: { userId: string; profileId: string; slug: string | undefined };
      try { auth = await authAndProfile(api_key as string); } catch (e: any) { return errorResponse(e.message); }

      // KAN-242 + KAN-244 — moderation + audit. Affiliations render publicly
      // ONLY when show_on_profile is true, but we moderate regardless so
      // unsafe text never lands in the DB even on a hidden row.
      const sanitisedName = sanitiseText(school_name, 200);
      const sanitisedLoc = school_location ? sanitiseText(school_location, 200) : null;
      const sanitisedDesc = description ? sanitiseText(description, 1000) : null;
      const nameMod = await moderateAndAudit({
        text: sanitisedName,
        fieldType: 'public',
        field: 'school_affiliations.school_name',
        profileId: auth.profileId,
      });
      if (!nameMod.ok) return errorResponse(nameMod.error);
      if (sanitisedLoc) {
        const locMod = await moderateAndAudit({
          text: sanitisedLoc,
          fieldType: 'public',
          field: 'school_affiliations.school_location',
          profileId: auth.profileId,
        });
        if (!locMod.ok) return errorResponse(locMod.error);
      }
      if (sanitisedDesc) {
        const descMod = await moderateAndAudit({
          text: sanitisedDesc,
          fieldType: 'public',
          field: 'school_affiliations.description',
          profileId: auth.profileId,
        });
        if (!descMod.ok) return errorResponse(descMod.error);
      }

      const sb = getSupabase();
      const { data, error } = await sb.from('school_affiliations').insert({
        profile_id: auth.profileId,
        school_name: sanitisedName,
        school_location: sanitisedLoc,
        relationship: relationship || 'parent',
        description: sanitisedDesc,
        // Hidden by default — only show when the caller explicitly opts in.
        show_on_profile: show_on_profile === true,
      }).select('id').single();

      if (error) return clientError(error, 'write-tools');
      return okResponse({ success: true, id: data.id, school_name, show_on_profile: show_on_profile === true });
    }
  );

  // ── Tool: Update School Affiliation ─────────────────────────
  // June-2026 redesign: affiliations are hidden by default. This tool
  // lets a user reveal/hide an existing affiliation and edit its
  // description/relationship without removing and re-adding it.
  server.registerTool(
    'lyra_update_school',
    {
      title: 'Update School Affiliation',
      description:
        'Update an existing school affiliation: toggle whether it is shown on the public profile and in search (show_on_profile), edit its description, or change the relationship. Requires API key.',
      inputSchema: {
        api_key: z.string().optional().describe('Lyra API key (lyra_…). Optional — can also be sent via Authorization: Bearer <key>, which most MCP clients do via their connector setup.'),
        school_id: z.string().describe('School affiliation UUID to update'),
        relationship: z.enum(['parent', 'student', 'alumni', 'staff', 'other']).optional().describe('Relationship to school'),
        description: z.string().optional().describe('Free-text note about this affiliation (shown only when show_on_profile is true). Pass an empty string to clear it.'),
        show_on_profile: z.boolean().optional().describe('Whether this affiliation is visible on the public profile and in search.'),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ api_key, school_id, relationship, description, show_on_profile }) => {
      let auth: { userId: string; profileId: string; slug: string | undefined };
      try { auth = await authAndProfile(api_key as string); } catch (e: any) { return errorResponse(e.message); }

      const updates: Record<string, unknown> = {};
      if (relationship !== undefined) updates.relationship = relationship;
      if (show_on_profile !== undefined) updates.show_on_profile = show_on_profile;
      if (description !== undefined) {
        const sanitisedDesc = sanitiseText(description, 1000);
        if (sanitisedDesc.length > 0) {
          const descMod = await moderateAndAudit({
            text: sanitisedDesc,
            fieldType: 'public',
            field: 'school_affiliations.description',
            profileId: auth.profileId,
          });
          if (!descMod.ok) return errorResponse(descMod.error);
        }
        updates.description = sanitisedDesc.length > 0 ? sanitisedDesc : null;
      }

      if (Object.keys(updates).length === 0) return errorResponse('No fields to update');

      const sb = getSupabase();
      // Ownership-scoped: only the caller's own affiliation rows.
      const { data, error } = await sb.from('school_affiliations')
        .update(updates)
        .eq('id', school_id)
        .eq('profile_id', auth.profileId)
        .select('id')
        .maybeSingle();
      if (error) return clientError(error, 'write-tools');
      if (!data) return errorResponse('School affiliation not found for this profile');
      return okResponse({ success: true, id: data.id, updated: Object.keys(updates) });
    }
  );

  // ── Tool: Update Manual of Me ───────────────────────────────
  // June-2026 redesign: profile_manual_of_me gained good_to_know and
  // boundaries alongside the original four free-text fields. This is the
  // first MCP write path for this 1-1 table — upsert on profile_id.
  server.registerTool(
    'lyra_update_manual_of_me',
    {
      title: 'Update Manual of Me',
      description:
        "Update the user's \"Manual of Me\" — their working-style notes. Fields: communication_style (\"How I find communication easier\"), working_preferences (\"If you ever come to my house\"), energises_me (\"What gives me energy\"), drains_me (\"What drains me\"), good_to_know (\"Good to know about me\"), boundaries (\"My boundaries\"). Pass only the fields you want to set; pass an empty string to clear a field. Requires API key.",
      inputSchema: {
        api_key: z.string().optional().describe('Lyra API key (lyra_…). Optional — can also be sent via Authorization: Bearer <key>, which most MCP clients do via their connector setup.'),
        communication_style: z.string().optional().describe('How I find communication easier'),
        working_preferences: z.string().optional().describe('If you ever come to my house'),
        energises_me: z.string().optional().describe('What gives me energy'),
        drains_me: z.string().optional().describe('What drains me'),
        good_to_know: z.string().optional().describe('Good to know about me'),
        boundaries: z.string().optional().describe('My boundaries'),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ api_key, ...fields }) => {
      let auth: { userId: string; profileId: string; slug: string | undefined };
      try { auth = await authAndProfile(api_key as string); } catch (e: any) { return errorResponse(e.message); }

      const FIELD_KEYS = [
        'communication_style',
        'working_preferences',
        'energises_me',
        'drains_me',
        'good_to_know',
        'boundaries',
      ] as const;

      // Sanitise + (when non-empty) moderate every provided field. Empty
      // string clears the field. Manual-of-Me renders on the public
      // profile, so fieldType is 'public' — mirrors the other write tools.
      const updates: Record<string, string | null> = {};
      for (const key of FIELD_KEYS) {
        const raw = (fields as Record<string, string | undefined>)[key];
        if (raw === undefined) continue;
        const clean = sanitiseText(raw, 2000);
        if (clean.length > 0) {
          const mod = await moderateAndAudit({
            text: clean,
            fieldType: 'public',
            field: `profile_manual_of_me.${key}`,
            profileId: auth.profileId,
          });
          if (!mod.ok) return errorResponse(mod.error);
        }
        updates[key] = clean.length > 0 ? clean : null;
      }

      if (Object.keys(updates).length === 0) return errorResponse('No fields to update');

      const sb = getSupabase();
      // 1-1 table keyed by profile_id — upsert so first-time callers create
      // the row and subsequent callers update it.
      const { error } = await sb.from('profile_manual_of_me')
        .upsert({ profile_id: auth.profileId, ...updates }, { onConflict: 'profile_id' });
      if (error) return clientError(error, 'write-tools');
      return okResponse({ success: true, updated: Object.keys(updates), slug: auth.slug });
    }
  );

  // ── Tool: Add Link ──────────────────────────────────────────
  server.registerTool(
    'lyra_add_link',
    {
      title: 'Add External Link',
      description: 'Add a wishlist, shop, or link to a Lyra profile. Requires API key.',
      inputSchema: {
        api_key: z.string().optional().describe('Lyra API key (lyra_…). Optional — can also be sent via Authorization: Bearer <key>, which most MCP clients do via their connector setup.'),
        title: z.string().describe('Link title'),
        url: z.string().describe('URL (must start with http:// or https://)'),
        link_type: z.enum(['wishlist', 'retailer', 'article', 'general']).optional(),
      },
      annotations: { destructiveHint: false },
    },
    async ({ api_key, title, url, link_type }) => {
      let auth: { userId: string; profileId: string; slug: string | undefined };
      try { auth = await authAndProfile(api_key as string); } catch (e: any) { return errorResponse(e.message); }

      const cleanUrl = sanitiseUrl(url);
      if (!cleanUrl) return errorResponse('Invalid URL — must start with http:// or https://');

      // KAN-242 + KAN-244 — moderation + audit on link title (URL already
      // sanitiseUrl-restricted).
      const sanitisedLinkTitle = sanitiseText(title, 200);
      const titleMod = await moderateAndAudit({
        text: sanitisedLinkTitle,
        fieldType: 'public',
        field: 'external_links.title',
        profileId: auth.profileId,
      });
      if (!titleMod.ok) return errorResponse(titleMod.error);

      const sb = getSupabase();
      const { data, error } = await sb.from('external_links').insert({
        profile_id: auth.profileId,
        title: sanitisedLinkTitle,
        url: cleanUrl,
        link_type: link_type || 'general',
      }).select('id').single();

      if (error) return clientError(error, 'write-tools');
      return okResponse({ success: true, id: data.id, title, url: cleanUrl });
    }
  );

  // ── Tool: Publish/Unpublish Profile ─────────────────────────
  server.registerTool(
    'lyra_publish_profile',
    {
      title: 'Publish or Unpublish Profile',
      description: 'Set a Lyra profile to published (visible to everyone) or unpublished (hidden). Requires API key.',
      inputSchema: {
        api_key: z.string().optional().describe('Lyra API key (lyra_…). Optional — can also be sent via Authorization: Bearer <key>, which most MCP clients do via their connector setup.'),
        published: z.boolean().describe('true to publish, false to unpublish'),
      },
      annotations: { destructiveHint: false, idempotentHint: true },
    },
    async ({ api_key, published }) => {
      let auth: { userId: string; profileId: string; slug: string | undefined };
      try { auth = await authAndProfile(api_key as string); } catch (e: any) { return errorResponse(e.message); }

      // KAN-282/KAN-319: publishing over MCP is age-gated when the env switch is on.
      if (published) {
        try { await requireAgeVerifiedToPublish(auth.userId); } catch (e: any) { return errorResponse(e.message); }
      }

      const sb = getSupabase();
      const { error } = await sb.from('profiles')
        .update({ is_published: published })
        .eq('id', auth.profileId);

      if (error) return clientError(error, 'write-tools');
      return okResponse({ success: true, published, slug: auth.slug });
    }
  );

  // ── Tool: Remove School ─────────────────────────────────────
  server.registerTool(
    'lyra_remove_school',
    {
      title: 'Remove School Affiliation',
      description: 'Remove a school affiliation by ID. Requires API key.',
      inputSchema: {
        api_key: z.string().optional().describe('Lyra API key (lyra_…). Optional — can also be sent via Authorization: Bearer <key>, which most MCP clients do via their connector setup.'),
        school_id: z.string().describe('School affiliation UUID to remove'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ api_key, school_id }) => {
      let auth: { userId: string; profileId: string; slug: string | undefined };
      try { auth = await authAndProfile(api_key as string); } catch (e: any) { return errorResponse(e.message); }

      const sb = getSupabase();
      const { error } = await sb.from('school_affiliations')
        .delete().eq('id', school_id).eq('profile_id', auth.profileId);
      if (error) return clientError(error, 'write-tools');
      return okResponse({ success: true, removed: school_id });
    }
  );

  // ── Tool: Remove Link ───────────────────────────────────────
  server.registerTool(
    'lyra_remove_link',
    {
      title: 'Remove External Link',
      description: 'Remove an external link by ID. Requires API key.',
      inputSchema: {
        api_key: z.string().optional().describe('Lyra API key (lyra_…). Optional — can also be sent via Authorization: Bearer <key>, which most MCP clients do via their connector setup.'),
        link_id: z.string().describe('Link UUID to remove'),
      },
      annotations: { destructiveHint: true },
    },
    async ({ api_key, link_id }) => {
      let auth: { userId: string; profileId: string; slug: string | undefined };
      try { auth = await authAndProfile(api_key as string); } catch (e: any) { return errorResponse(e.message); }

      const sb = getSupabase();
      const { error } = await sb.from('external_links')
        .delete().eq('id', link_id).eq('profile_id', auth.profileId);
      if (error) return clientError(error, 'write-tools');
      return okResponse({ success: true, removed: link_id });
    }
  );

  // ── Tool: Get Onboarding Coaching ───────────────────────────
  server.registerTool(
    'lyra_get_onboarding_coaching',
    {
      title: 'Get Onboarding Coaching',
      description:
        'Get guidance on how to help a user build their Lyra profile. Returns the recommended questions and flow for AI companions to gather profile information conversationally.',
      inputSchema: {
        api_key: z.string().optional().describe('Lyra API key (lyra_…). Optional — can also be sent via Authorization: Bearer <key>, which most MCP clients do via their connector setup.'),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ api_key }) => {
      let auth: { userId: string; profileId: string; slug: string | undefined };
      try { auth = await authAndProfile(api_key as string); } catch (e: any) { return errorResponse(e.message); }

      const coaching = {
        introduction: "Help the user build their Lyra profile through natural conversation. Ask about each section below, then use the write tools to save their answers.",
        sections: [
          { order: 1, tool: 'lyra_update_profile', ask: "What's your name, a short headline about yourself, and where are you based?" },
          { order: 2, tool: 'lyra_update_profile', ask: "Can you write a short bio? Just a sentence or two about who you are." },
          { order: 3, tool: 'lyra_add_school', ask: "Are you connected to any schools? As a parent, student, alumni, or staff?" },
          { order: 4, tool: 'lyra_add_item', ask: "What do you like? Hobbies, interests, favourite things?" },
          { order: 5, tool: 'lyra_add_item', ask: "Anything you dislike or want people to avoid?" },
          { order: 6, tool: 'lyra_add_item', ask: "What are some good gift ideas for you? Things you'd actually want?" },
          { order: 7, tool: 'lyra_add_item', ask: "Any gifts people should definitely NOT get you?" },
          { order: 8, tool: 'lyra_add_item', ask: "Any boundaries or things that are helpful for people to know?" },
          { order: 9, tool: 'lyra_update_manual_of_me', ask: "Tell me about your Manual of Me: how you find communication easier, what gives you energy, what drains you, what's good to know about you, and your boundaries." },
          { order: 10, tool: 'lyra_add_link', ask: "Do you have any wishlists or favourite shops you'd like to link?" },
          { order: 11, tool: 'lyra_publish_profile', ask: "Your profile is ready! Would you like to publish it so people can find you?" },
        ],
        tips: [
          "Be conversational — don't ask all questions at once",
          "After each answer, use the appropriate write tool to save it",
          "Users can skip any section",
          "Multiple items per category are encouraged",
        ],
      };

      return okResponse(coaching);
    }
  );

} // end registerWriteTools
