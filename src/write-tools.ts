import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getSupabase } from './supabase.js';
import { authenticateApiKey, getProfileForUser } from './auth.js';
import { sanitiseText, sanitiseUrl } from './sanitise.js';

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
  return { userId: auth.userId, profileId: profile.profileId, slug: profile.slug };
}

function errorResponse(msg: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: msg }) }] };
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
        api_key: z.string().describe('Lyra API key (starts with lyra_)'),
        display_name: z.string().optional().describe('Display name'),
        headline: z.string().optional().describe('Short headline/tagline'),
        bio_short: z.string().optional().describe('Short bio (max 300 chars)'),
        city: z.string().optional().describe('City'),
        country: z.string().optional().describe('Country code (e.g. GB, US)'),
      },
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

      const sb = getSupabase();
      const { error } = await sb.from('profiles').update(updates).eq('id', auth.profileId);
      if (error) return errorResponse(error.message);

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
        api_key: z.string().describe('Lyra API key'),
        category: z.enum(['gift_ideas', 'gifts_to_avoid', 'likes', 'dislikes', 'helpful_to_know', 'boundaries'])
          .describe('Item category'),
        title: z.string().describe('Item title (e.g. "Dark chocolate", "No surprise visits")'),
        description: z.string().optional().describe('Optional extra detail'),
      },
    },
    async ({ api_key, category, title, description }) => {
      let auth: { userId: string; profileId: string; slug: string | undefined };
      try { auth = await authAndProfile(api_key as string); } catch (e: any) { return errorResponse(e.message); }

      const sb = getSupabase();
      const { data, error } = await sb.from('profile_items').insert({
        profile_id: auth.profileId,
        category,
        title: sanitiseText(title, 200),
        description: description ? sanitiseText(description, 1000) : null,
      }).select('id').single();

      if (error) return errorResponse(error.message);
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
        api_key: z.string().describe('Lyra API key'),
        item_id: z.string().describe('Item UUID to remove'),
      },
    },
    async ({ api_key, item_id }) => {
      let auth: { userId: string; profileId: string; slug: string | undefined };
      try { auth = await authAndProfile(api_key as string); } catch (e: any) { return errorResponse(e.message); }

      const sb = getSupabase();
      const { error } = await sb.from('profile_items')
        .delete()
        .eq('id', item_id)
        .eq('profile_id', auth.profileId);
      if (error) return errorResponse(error.message);
      return okResponse({ success: true, removed: item_id });
    }
  );

  // ── Tool: Add School ────────────────────────────────────────
  server.registerTool(
    'lyra_add_school',
    {
      title: 'Add School Affiliation',
      description: 'Add a school connection to a Lyra profile. Requires API key.',
      inputSchema: {
        api_key: z.string().describe('Lyra API key'),
        school_name: z.string().describe('School name'),
        school_location: z.string().optional().describe('Location'),
        relationship: z.enum(['parent', 'student', 'alumni', 'staff', 'other']).optional().describe('Relationship to school'),
      },
    },
    async ({ api_key, school_name, school_location, relationship }) => {
      let auth: { userId: string; profileId: string; slug: string | undefined };
      try { auth = await authAndProfile(api_key as string); } catch (e: any) { return errorResponse(e.message); }

      const sb = getSupabase();
      const { data, error } = await sb.from('school_affiliations').insert({
        profile_id: auth.profileId,
        school_name: sanitiseText(school_name, 200),
        school_location: school_location ? sanitiseText(school_location, 200) : null,
        relationship: relationship || 'parent',
      }).select('id').single();

      if (error) return errorResponse(error.message);
      return okResponse({ success: true, id: data.id, school_name });
    }
  );

  // ── Tool: Add Link ──────────────────────────────────────────
  server.registerTool(
    'lyra_add_link',
    {
      title: 'Add External Link',
      description: 'Add a wishlist, shop, or link to a Lyra profile. Requires API key.',
      inputSchema: {
        api_key: z.string().describe('Lyra API key'),
        title: z.string().describe('Link title'),
        url: z.string().describe('URL (must start with http:// or https://)'),
        link_type: z.enum(['wishlist', 'retailer', 'article', 'general']).optional(),
      },
    },
    async ({ api_key, title, url, link_type }) => {
      let auth: { userId: string; profileId: string; slug: string | undefined };
      try { auth = await authAndProfile(api_key as string); } catch (e: any) { return errorResponse(e.message); }

      const cleanUrl = sanitiseUrl(url);
      if (!cleanUrl) return errorResponse('Invalid URL — must start with http:// or https://');

      const sb = getSupabase();
      const { data, error } = await sb.from('external_links').insert({
        profile_id: auth.profileId,
        title: sanitiseText(title, 200),
        url: cleanUrl,
        link_type: link_type || 'general',
      }).select('id').single();

      if (error) return errorResponse(error.message);
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
        api_key: z.string().describe('Lyra API key'),
        published: z.boolean().describe('true to publish, false to unpublish'),
      },
    },
    async ({ api_key, published }) => {
      let auth: { userId: string; profileId: string; slug: string | undefined };
      try { auth = await authAndProfile(api_key as string); } catch (e: any) { return errorResponse(e.message); }

      const sb = getSupabase();
      const { error } = await sb.from('profiles')
        .update({ is_published: published })
        .eq('id', auth.profileId);

      if (error) return errorResponse(error.message);
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
        api_key: z.string().describe('Lyra API key'),
        school_id: z.string().describe('School affiliation UUID to remove'),
      },
    },
    async ({ api_key, school_id }) => {
      let auth: { userId: string; profileId: string; slug: string | undefined };
      try { auth = await authAndProfile(api_key as string); } catch (e: any) { return errorResponse(e.message); }

      const sb = getSupabase();
      const { error } = await sb.from('school_affiliations')
        .delete().eq('id', school_id).eq('profile_id', auth.profileId);
      if (error) return errorResponse(error.message);
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
        api_key: z.string().describe('Lyra API key'),
        link_id: z.string().describe('Link UUID to remove'),
      },
    },
    async ({ api_key, link_id }) => {
      let auth: { userId: string; profileId: string; slug: string | undefined };
      try { auth = await authAndProfile(api_key as string); } catch (e: any) { return errorResponse(e.message); }

      const sb = getSupabase();
      const { error } = await sb.from('external_links')
        .delete().eq('id', link_id).eq('profile_id', auth.profileId);
      if (error) return errorResponse(error.message);
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
        api_key: z.string().describe('Lyra API key'),
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
          { order: 9, tool: 'lyra_add_link', ask: "Do you have any wishlists or favourite shops you'd like to link?" },
          { order: 10, tool: 'lyra_publish_profile', ask: "Your profile is ready! Would you like to publish it so people can find you?" },
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
