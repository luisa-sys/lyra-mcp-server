/**
 * Google Places + Distance Matrix adapter — KAN-207 (Phase 3).
 *
 * Talks to the new Places API (v1) which uses POST with field masks instead
 * of the legacy GET. Two endpoints used:
 *   - POST https://places.googleapis.com/v1/places:searchText
 *   - POST https://places.googleapis.com/v1/places:searchNearby
 *
 * Returns parsed Place rows we can map into our VenueCandidate type.
 * Caching the results into `public.venues` is the caller's responsibility
 * (so repeat searches are cheap and we accumulate a venue catalogue).
 *
 * Env: GOOGLE_PLACES_API_KEY (set on Railway).
 */

import type { GatheringType } from './convene-recommend-scoring.js';

const PLACES_BASE = 'https://places.googleapis.com/v1';

const DEFAULT_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.location',
  'places.types',
  'places.primaryType',
  'places.priceLevel',
  'places.rating',
  'places.userRatingCount',
  'places.businessStatus',
].join(',');

/** Map our internal gathering intent → Places primaryTypes to search for. */
const SEARCH_TYPES_BY_INTENT: Record<GatheringType, string[]> = {
  coffee: ['cafe'],
  lunch: ['cafe', 'restaurant'],
  dinner: ['restaurant'],
  drinks: ['bar', 'pub'],
  party: ['bar', 'event_venue', 'restaurant'],
  kids_party: ['amusement_park', 'park', 'playground'],
  meeting: ['cafe'],
  date: ['restaurant', 'bar', 'cafe'],
  walk: ['park'],
  cinema: ['movie_theater'],
  other: [],
};

/** Reverse-map Places types → our internal venue_type enum. */
function mapPlaceTypeToVenueType(primaryType: string | undefined, types: string[]): string {
  const t = (primaryType ?? '').toLowerCase();
  const all = [t, ...types.map((x) => x.toLowerCase())];
  if (all.some((x) => x === 'cafe' || x === 'coffee_shop')) return 'cafe';
  if (all.some((x) => x === 'bar' || x === 'pub' || x === 'nightclub')) return all.includes('pub') ? 'pub' : 'bar';
  if (all.some((x) => x === 'restaurant' || x === 'food')) return 'restaurant';
  if (all.some((x) => x === 'park' || x === 'playground')) return 'park';
  if (all.some((x) => x === 'movie_theater' || x === 'cinema')) return 'cinema';
  if (all.some((x) => x === 'museum')) return 'museum';
  if (all.some((x) => x === 'amusement_park')) return 'soft_play';
  if (all.some((x) => x === 'event_venue')) return 'event_space';
  return 'other';
}

/** Map Places priceLevel (PRICE_LEVEL_FREE..PRICE_LEVEL_VERY_EXPENSIVE) → 1..4. */
function mapPriceLevel(p: string | undefined): number | null {
  switch (p) {
    case 'PRICE_LEVEL_FREE':
    case 'PRICE_LEVEL_INEXPENSIVE':
      return 1;
    case 'PRICE_LEVEL_MODERATE':
      return 2;
    case 'PRICE_LEVEL_EXPENSIVE':
      return 3;
    case 'PRICE_LEVEL_VERY_EXPENSIVE':
      return 4;
    default:
      return null;
  }
}

export interface PlacesSearchInput {
  intent: GatheringType;
  /** Free-text query supplement (e.g. "wine bar", "soft play with playground"). */
  keyword?: string;
  /** Anchor — lat,lng OR postcode. lat/lng preferred for distance-bounded search. */
  anchor?: string | null;
  /** Search radius in metres (default 3000 ≈ ~30min walk / 5min drive). Max 50000. */
  radiusM?: number;
  /** Min Places rating to consider (default 3.5). */
  minRating?: number;
  /** Cap on results returned (default 8, max 20). Saves API quota. */
  maxResults?: number;
}

export interface ParsedPlace {
  /** Google Place ID (used as our `venues.google_place_id`). */
  googlePlaceId: string;
  name: string;
  venueType: string;
  city: string | null;
  postcode: string | null;
  country: string;
  lat: number | null;
  lng: number | null;
  priceTier: number | null;
  capacityEstimate: number | null;
  accessibilityFlags: string[];
  dietaryFlags: string[];
  externalRating: number | null;
  externalRatingCount: number | null;
  businessStatus: string | null;
  rawTypes: string[];
}

/**
 * Search Places via either Text Search (when no precise lat/lng) or Nearby
 * Search (when lat/lng anchor available). Returns parsed candidates ready
 * for scoring.
 */
export async function searchPlaces(input: PlacesSearchInput): Promise<ParsedPlace[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    throw new Error('Server misconfiguration: GOOGLE_PLACES_API_KEY not set on the MCP server');
  }

  const intentTypes = SEARCH_TYPES_BY_INTENT[input.intent];
  const includedTypes = intentTypes.length > 0 ? intentTypes : undefined;

  const latlng = input.anchor?.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  const radiusM = Math.min(input.radiusM ?? 3000, 50000);
  const maxResults = Math.min(input.maxResults ?? 8, 20);

  let endpoint: string;
  let body: unknown;

  if (latlng) {
    // Nearby search — precise location available
    endpoint = `${PLACES_BASE}/places:searchNearby`;
    body = {
      languageCode: 'en',
      regionCode: 'GB',
      maxResultCount: maxResults,
      includedTypes,
      rankPreference: 'POPULARITY',
      locationRestriction: {
        circle: {
          center: { latitude: parseFloat(latlng[1]), longitude: parseFloat(latlng[2]) },
          radius: radiusM,
        },
      },
    };
  } else {
    // Text search — postcode or free-text only
    endpoint = `${PLACES_BASE}/places:searchText`;
    const queryParts: string[] = [];
    if (input.keyword) queryParts.push(input.keyword);
    if (intentTypes.length > 0) queryParts.push(intentTypes[0]);
    if (input.anchor) queryParts.push(`near ${input.anchor}`);
    body = {
      textQuery: queryParts.join(' ').trim() || (intentTypes[0] ?? 'gathering venue'),
      languageCode: 'en',
      regionCode: 'GB',
      pageSize: maxResults,
      includedType: intentTypes[0],
      minRating: input.minRating ?? 3.5,
    };
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': apiKey,
      'X-Goog-FieldMask': DEFAULT_FIELD_MASK,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Google Places search failed (${res.status}): ${text.slice(0, 200)}`);
  }

  const json = (await res.json()) as { places?: GooglePlace[] };
  return (json.places ?? []).map(parsePlace);
}

interface GooglePlace {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  addressComponents?: { types: string[]; longText?: string; shortText?: string }[];
  location?: { latitude: number; longitude: number };
  types?: string[];
  primaryType?: string;
  priceLevel?: string;
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
}

function parsePlace(p: GooglePlace): ParsedPlace {
  const components = p.addressComponents ?? [];
  const city = components.find((c) => c.types.includes('postal_town') || c.types.includes('locality'))?.longText ?? null;
  const postcode = components.find((c) => c.types.includes('postal_code'))?.longText ?? null;
  const country = components.find((c) => c.types.includes('country'))?.shortText ?? 'GB';

  return {
    googlePlaceId: p.id,
    name: p.displayName?.text ?? '(unnamed)',
    venueType: mapPlaceTypeToVenueType(p.primaryType, p.types ?? []),
    city,
    postcode,
    country,
    lat: p.location?.latitude ?? null,
    lng: p.location?.longitude ?? null,
    priceTier: mapPriceLevel(p.priceLevel),
    // Places doesn't surface capacity; left null. Future: heuristic from venue type.
    capacityEstimate: null,
    accessibilityFlags: [],
    dietaryFlags: [],
    externalRating: p.rating ?? null,
    externalRatingCount: p.userRatingCount ?? null,
    businessStatus: p.businessStatus ?? null,
    rawTypes: p.types ?? [],
  };
}

export const _internal = { SEARCH_TYPES_BY_INTENT, mapPlaceTypeToVenueType, mapPriceLevel };
