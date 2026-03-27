import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import express from 'express';
import { z } from 'zod';
import { getSupabase } from './supabase.js';

const server = new McpServer({
  name: 'lyra-mcp-server',
  version: '1.0.0',
});

// ── Tool: Search Profiles ───────────────────────────────────────

server.registerTool(
  'lyra_search_profiles',
  {
    title: 'Search Lyra Profiles',
    description:
      'Search for Lyra profiles by name, location, or keyword. Returns matching published profiles.',
    inputSchema: {
      query: z.string().optional().describe('Search term — matches name, headline, bio, city'),
      school: z.string().optional().describe('Filter by school name'),
      limit: z.number().optional().default(10).describe('Max results (default 10)'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query, school, limit }) => {
    const sb = getSupabase();
    let q = sb.from('profiles').select('slug, display_name, headline, city, country').eq('is_published', true);

    if (query) {
      q = q.or(`display_name.ilike.%${query}%,headline.ilike.%${query}%,bio_short.ilike.%${query}%,city.ilike.%${query}%`);
    }

    const { data: profiles, error } = await q.limit(limit || 10);
    if (error) return { content: [{ type: 'text', text: JSON.stringify({ error: error.message }) }] };

    let results = profiles || [];

    if (school) {
      const { data: schoolProfiles } = await sb
        .from('school_affiliations')
        .select('profile_id, school_name')
        .ilike('school_name', `%${school}%`);

      const profileIds = new Set((schoolProfiles || []).map((s) => s.profile_id));
      // Need to fetch profile IDs to filter — join via profile_id
      const { data: allProfiles } = await sb
        .from('profiles')
        .select('id, slug, display_name, headline, city, country')
        .eq('is_published', true);

      results = (allProfiles || []).filter((p) => profileIds.has(p.id));
    }

    return {
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
    };
  }
);

// ── Tool: Get Profile ───────────────────────────────────────────

server.registerTool(
  'lyra_get_profile',
  {
    title: 'Get Lyra Profile',
    description:
      'Get a complete published Lyra profile by slug or name. Returns all public sections including bio, preferences, gift ideas, boundaries, schools, and links.',
    inputSchema: {
      slug: z.string().optional().describe('Profile slug (e.g. "luisa-380956df")'),
      name: z.string().optional().describe('Display name to search for'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ slug, name }) => {
    const sb = getSupabase();

    let profileSlug = slug;
    if (!profileSlug && name) {
      const { data } = await sb
        .from('profiles')
        .select('slug')
        .ilike('display_name', `%${name}%`)
        .eq('is_published', true)
        .limit(1)
        .single();
      profileSlug = data?.slug;
    }

    if (!profileSlug) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Profile not found. Provide a slug or name.' }) }] };
    }

    const { data: profile, error } = await sb
      .from('profiles')
      .select('*')
      .eq('slug', profileSlug)
      .eq('is_published', true)
      .single();

    if (error || !profile) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Profile '${profileSlug}' not found or not published.` }) }] };
    }

    const { data: items } = await sb
      .from('profile_items')
      .select('category, title, description, visibility')
      .eq('profile_id', profile.id)
      .eq('visibility', 'public');

    const { data: schools } = await sb
      .from('school_affiliations')
      .select('school_name, school_location, relationship')
      .eq('profile_id', profile.id);

    const { data: links } = await sb
      .from('external_links')
      .select('title, url, link_type')
      .eq('profile_id', profile.id);

    const result = {
      slug: profile.slug,
      display_name: profile.display_name,
      headline: profile.headline,
      bio: profile.bio_short,
      location: { city: profile.city, country: profile.country },
      schools: schools || [],
      items: items || [],
      links: links || [],
    };

    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  }
);

// ── Tool: Get Section ───────────────────────────────────────────

server.registerTool(
  'lyra_get_section',
  {
    title: 'Get Profile Section',
    description:
      'Get a specific section of a Lyra profile — for example just gift ideas, likes, dislikes, or boundaries. Categories: gift_ideas, likes, dislikes, boundaries, hobbies, allergies.',
    inputSchema: {
      slug: z.string().describe('Profile slug'),
      category: z.string().describe('Item category: gift_ideas, likes, dislikes, boundaries, hobbies, allergies'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ slug, category }) => {
    const sb = getSupabase();
    const { data: profile } = await sb
      .from('profiles')
      .select('id, display_name')
      .eq('slug', slug)
      .eq('is_published', true)
      .single();

    if (!profile) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Profile '${slug}' not found or not published.` }) }] };
    }

    const { data: items } = await sb
      .from('profile_items')
      .select('title, description, url')
      .eq('profile_id', profile.id)
      .eq('category', category)
      .eq('visibility', 'public')
      .order('sort_order');

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          profile: profile.display_name,
          category,
          items: items || [],
          count: (items || []).length,
        }, null, 2),
      }],
    };
  }
);

// ── Tool: Recommend Gifts ───────────────────────────────────────

server.registerTool(
  'lyra_recommend_gifts',
  {
    title: 'Get Gift Ideas',
    description:
      'Get gift ideas and wishlists from a Lyra profile. Returns the person\'s stated gift preferences, likes, and interests to help you choose the perfect gift.',
    inputSchema: {
      slug: z.string().describe('Profile slug'),
      budget: z.string().optional().describe('Optional budget range, e.g. "under £20", "£20-50", "luxury"'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ slug, budget }) => {
    const sb = getSupabase();
    const { data: profile } = await sb
      .from('profiles')
      .select('id, display_name, headline')
      .eq('slug', slug)
      .eq('is_published', true)
      .single();

    if (!profile) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Profile '${slug}' not found or not published.` }) }] };
    }

    const { data: giftIdeas } = await sb
      .from('profile_items')
      .select('title, description, url')
      .eq('profile_id', profile.id)
      .eq('category', 'gift_ideas')
      .eq('visibility', 'public')
      .order('sort_order');

    const { data: likes } = await sb
      .from('profile_items')
      .select('title, description')
      .eq('profile_id', profile.id)
      .eq('category', 'likes')
      .eq('visibility', 'public');

    const { data: dislikes } = await sb
      .from('profile_items')
      .select('title, description')
      .eq('profile_id', profile.id)
      .eq('category', 'dislikes')
      .eq('visibility', 'public');

    const { data: boundaries } = await sb
      .from('profile_items')
      .select('title, description')
      .eq('profile_id', profile.id)
      .eq('category', 'boundaries')
      .eq('visibility', 'public');

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          profile: profile.display_name,
          headline: profile.headline,
          gift_ideas: giftIdeas || [],
          likes: likes || [],
          dislikes: dislikes || [],
          boundaries: boundaries || [],
          note: budget ? `Budget filter requested: ${budget}. Gift ideas are not yet tagged with prices — the AI companion should use the links and descriptions to estimate suitability.` : undefined,
        }, null, 2),
      }],
    };
  }
);

// ── Tool: Get Insights ──────────────────────────────────────────

server.registerTool(
  'lyra_get_insights',
  {
    title: 'Get Profile Insights',
    description:
      'Get a summary of what a person is like based on their Lyra profile — their interests, personality signals, and preferences. Useful for understanding someone before meeting them or choosing a gift.',
    inputSchema: {
      slug: z.string().describe('Profile slug'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ slug }) => {
    const sb = getSupabase();
    const { data: profile } = await sb
      .from('profiles')
      .select('id, display_name, headline, bio_short, city, country')
      .eq('slug', slug)
      .eq('is_published', true)
      .single();

    if (!profile) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: `Profile '${slug}' not found or not published.` }) }] };
    }

    const { data: items } = await sb
      .from('profile_items')
      .select('category, title, description')
      .eq('profile_id', profile.id)
      .eq('visibility', 'public');

    const { data: schools } = await sb
      .from('school_affiliations')
      .select('school_name, relationship')
      .eq('profile_id', profile.id);

    const grouped: Record<string, string[]> = {};
    for (const item of items || []) {
      if (!grouped[item.category]) grouped[item.category] = [];
      grouped[item.category].push(item.title + (item.description ? ` — ${item.description}` : ''));
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          profile: profile.display_name,
          headline: profile.headline,
          bio: profile.bio_short,
          location: profile.city ? `${profile.city}, ${profile.country}` : profile.country,
          schools: (schools || []).map((s) => `${s.school_name} (${s.relationship})`),
          preferences_summary: grouped,
          total_items: (items || []).length,
        }, null, 2),
      }],
    };
  }
);

// ── Tool: List Schools ──────────────────────────────────────────

server.registerTool(
  'lyra_list_schools',
  {
    title: 'List School Affiliations',
    description:
      'Search for schools across Lyra profiles. Find people who attended or are connected to a specific school.',
    inputSchema: {
      query: z.string().optional().describe('School name to search for'),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query }) => {
    const sb = getSupabase();

    let q = sb
      .from('school_affiliations')
      .select('school_name, school_location, relationship, profiles!inner(slug, display_name, is_published)')
      .eq('profiles.is_published', true);

    if (query) {
      q = q.ilike('school_name', `%${query}%`);
    }

    const { data, error } = await q.limit(20);
    if (error) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: error.message }) }] };
    }

    const results = (data || []).map((s: any) => ({
      school: s.school_name,
      location: s.school_location,
      relationship: s.relationship,
      profile_slug: s.profiles?.slug,
      profile_name: s.profiles?.display_name,
    }));

    return {
      content: [{ type: 'text', text: JSON.stringify(results, null, 2) }],
    };
  }
);

// ── Transport Setup ─────────────────────────────────────────────

const TRANSPORT = process.env.MCP_TRANSPORT || 'http';

if (TRANSPORT === 'stdio') {
  // stdio transport for local development and Claude Desktop
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('Lyra MCP Server running on stdio');
} else {
  // HTTP transport for remote access (Railway, etc.)
  const app = express();
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', server: 'lyra-mcp-server', version: '1.0.0' });
  });

  app.post('/mcp', async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    res.on('close', () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  // Handle GET and DELETE for SSE streams (required by spec)
  app.get('/mcp', async (_req, res) => {
    res.writeHead(405).end(JSON.stringify({ error: 'Method not allowed. Use POST for MCP requests.' }));
  });

  app.delete('/mcp', async (_req, res) => {
    res.writeHead(405).end(JSON.stringify({ error: 'Method not allowed. Stateless server — no sessions to delete.' }));
  });

  const PORT = parseInt(process.env.PORT || '3001', 10);
  app.listen(PORT, () => {
    console.log(`Lyra MCP Server listening on http://localhost:${PORT}/mcp`);
    console.log(`Health check: http://localhost:${PORT}/health`);
  });
}
