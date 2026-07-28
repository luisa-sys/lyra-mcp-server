/**
 * Convene venue recommendation scoring — DUPLICATED from
 * lyra/src/lib/recommend/convene/score-venue.ts for KAN-207 Phase 3.
 *
 * ────────────────────────────────────────────────────────────────────────
 * DRIFT RISK — same caveat as convene-recommend-scoring.ts.
 * Keep WEIGHTS + TYPE_FIT_BY_INTENT + helpers in lockstep with the lyra-side
 * src/lib/recommend/convene/score-venue.ts. Any factor change MUST land in
 * both repos.
 * ────────────────────────────────────────────────────────────────────────
 */

import { clamp01, weightedAverage, type GatheringType } from './convene-recommend-scoring.js';

export interface VenueContext {
  intent: GatheringType;
  anchor: string | null;
  maxTravelMinutes?: number;
  capacityRequired: number;
  required: { accessibility?: string[]; dietary?: string[] };
  preferred: { priceTier?: 1 | 2 | 3 | 4; cuisine?: string };
}

export interface VenueCandidate {
  venueId: string;
  name: string;
  venueType: string;
  city: string | null;
  postcode: string | null;
  lat: number | null;
  lng: number | null;
  priceTier: number | null;
  capacityEstimate: number | null;
  accessibilityFlags: string[];
  dietaryFlags: string[];
  externalRating: number | null;
  priorVisits?: number;
  lastVisitedAt?: string | null;
  hostRating?: number | null;
}

export interface VenueScore {
  venueId: string;
  score: number;
  reasons: string[];
  breakdown: {
    typeFit: number;
    distance: number;
    dietaryFit: number;
    capacity: number;
    openingHours: number;
    priceTier: number;
    accessibility: number;
    priorVisits: number;
    diversityPenalty: number;
    externalRating: number;
  };
  hardFilterFailed?: 'accessibility' | 'capacity' | 'dietary';
}

const WEIGHTS = {
  typeFit: 0.20,
  distance: 0.20,
  dietaryFit: 0.10,
  capacity: 0.05,
  openingHours: 0.05,
  priceTier: 0.05,
  accessibility: 0.05,
  priorVisits: 0.10,
  diversityPenalty: 0.10,
  externalRating: 0.10,
};

const TYPE_FIT_BY_INTENT: Record<GatheringType, Set<string>> = {
  coffee: new Set(['cafe']),
  lunch: new Set(['cafe', 'restaurant']),
  dinner: new Set(['restaurant', 'home']),
  drinks: new Set(['bar', 'pub', 'restaurant']),
  party: new Set(['event_space', 'bar', 'home', 'restaurant']),
  kids_party: new Set(['soft_play', 'park', 'event_space', 'home']),
  meeting: new Set(['cafe', 'office', 'event_space']),
  date: new Set(['restaurant', 'bar', 'cafe', 'cinema']),
  walk: new Set(['park']),
  cinema: new Set(['cinema']),
  other: new Set([]),
};

function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export function scoreVenue(candidate: VenueCandidate, context: VenueContext, nowMs: number = Date.now()): VenueScore {
  // Hard filters — return early with hardFilterFailed set.
  if (candidate.capacityEstimate != null && candidate.capacityEstimate < context.capacityRequired) {
    return {
      venueId: candidate.venueId,
      score: 0,
      reasons: [`Capacity ${candidate.capacityEstimate} < required ${context.capacityRequired}`],
      breakdown: zeroBreakdown(),
      hardFilterFailed: 'capacity',
    };
  }

  const requiredAccessibility = context.required.accessibility ?? [];
  const missingAcc = requiredAccessibility.filter((r) => !candidate.accessibilityFlags.includes(r));
  if (missingAcc.length > 0) {
    return {
      venueId: candidate.venueId,
      score: 0,
      reasons: [`Missing accessibility: ${missingAcc.join(', ')}`],
      breakdown: zeroBreakdown(),
      hardFilterFailed: 'accessibility',
    };
  }

  // Dietary hard-filter: zero overlap with required = hard fail.
  const requiredDietary = context.required.dietary ?? [];
  if (requiredDietary.length > 0) {
    const overlap = requiredDietary.filter((r) => candidate.dietaryFlags.includes(r));
    if (overlap.length === 0) {
      return {
        venueId: candidate.venueId,
        score: 0,
        reasons: [`No dietary match for ${requiredDietary.join(', ')}`],
        breakdown: zeroBreakdown(),
        hardFilterFailed: 'dietary',
      };
    }
  }

  const factors = {
    typeFit: scoreTypeFit(candidate, context.intent),
    distance: scoreDistance(candidate, context),
    dietaryFit: scoreDietary(candidate, context),
    capacity: scoreCapacity(candidate, context),
    openingHours: scoreOpeningHours(),
    priceTier: scorePriceTier(candidate, context),
    accessibility: scoreAccessibilityFit(candidate, context),
    priorVisits: scorePriorVisits(candidate),
    diversityPenalty: scoreDiversityPenalty(candidate, nowMs),
    externalRating: scoreExternalRating(candidate),
  };

  const breakdown = {
    typeFit: factors.typeFit.score,
    distance: factors.distance.score,
    dietaryFit: factors.dietaryFit.score,
    capacity: factors.capacity.score,
    openingHours: factors.openingHours.score,
    priceTier: factors.priceTier.score,
    accessibility: factors.accessibility.score,
    priorVisits: factors.priorVisits.score,
    diversityPenalty: factors.diversityPenalty.score,
    externalRating: factors.externalRating.score,
  };

  const reasons = Object.values(factors)
    .map((f) => f.reason)
    .filter((r): r is string => Boolean(r));

  return {
    venueId: candidate.venueId,
    score: weightedAverage(breakdown, WEIGHTS),
    reasons,
    breakdown,
  };
}

function zeroBreakdown() {
  return {
    typeFit: 0,
    distance: 0,
    dietaryFit: 0,
    capacity: 0,
    openingHours: 0,
    priceTier: 0,
    accessibility: 0,
    priorVisits: 0,
    diversityPenalty: 0,
    externalRating: 0,
  };
}

function scoreTypeFit(c: VenueCandidate, intent: GatheringType) {
  const goodTypes = TYPE_FIT_BY_INTENT[intent];
  if (goodTypes.size === 0) return { score: 0.5, reason: null };
  if (goodTypes.has(c.venueType)) return { score: 1.0, reason: `${c.venueType} suits "${intent}"` };
  return { score: 0.25, reason: `${c.venueType} is unusual for "${intent}"` };
}

function scoreDistance(c: VenueCandidate, ctx: VenueContext): { score: number; reason: string | null } {
  if (!ctx.anchor) return { score: 0.5, reason: null };
  const latlng = ctx.anchor.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (latlng && c.lat != null && c.lng != null) {
    const km = haversineKm(parseFloat(latlng[1]), parseFloat(latlng[2]), c.lat, c.lng);
    if (km < 1) return { score: 1.0, reason: 'Walking distance' };
    if (km < 3) return { score: 0.9, reason: `${km.toFixed(1)}km from anchor` };
    if (km < 8) return { score: 0.7, reason: `${km.toFixed(1)}km from anchor` };
    if (km < 20) return { score: 0.45, reason: `${km.toFixed(0)}km — a journey` };
    return { score: 0.15, reason: `${km.toFixed(0)}km — quite far` };
  }
  const cOut = (c.postcode || '').split(' ')[0]?.toUpperCase() ?? '';
  const aOut = ctx.anchor.split(' ')[0]?.toUpperCase() ?? '';
  if (cOut && aOut) {
    if (cOut === aOut) return { score: 0.95, reason: `Same postcode (${cOut})` };
    if (cOut.slice(0, 2) === aOut.slice(0, 2)) return { score: 0.65, reason: `Same postcode area (${cOut.slice(0, 2)})` };
  }
  return { score: 0.4, reason: null };
}

function scoreDietary(c: VenueCandidate, ctx: VenueContext) {
  const req = ctx.required.dietary ?? [];
  if (req.length === 0) return { score: 1.0, reason: null };
  const matches = req.filter((r) => c.dietaryFlags.includes(r));
  if (matches.length === req.length) return { score: 1.0, reason: `Caters to ${req.join(' + ')}` };
  if (matches.length === 0) return { score: 0.2, reason: `Doesn't advertise ${req.join(', ')} options` };
  return { score: 0.3 + (0.7 * matches.length) / req.length, reason: null };
}

function scoreCapacity(c: VenueCandidate, ctx: VenueContext) {
  if (c.capacityEstimate == null) return { score: 0.6, reason: null };
  const slack = c.capacityEstimate - ctx.capacityRequired;
  if (slack < 0) return { score: 0, reason: 'Too small' };
  if (slack < 3) return { score: 0.7, reason: 'Just-right size' };
  if (slack < 20) return { score: 1.0, reason: 'Comfortable size' };
  return { score: 0.6, reason: 'Might feel empty' };
}

function scoreOpeningHours(): { score: number; reason: string | null } {
  // Placeholder: real implementation will consult opening_hours JSON against
  // the proposed slot. For v1 we treat as neutral.
  return { score: 0.6, reason: null };
}

function scoreAccessibilityFit(candidate: VenueCandidate, context: VenueContext): { score: number; reason: string | null } {
  const required = context.required.accessibility ?? [];
  if (required.length === 0) return { score: 1.0, reason: null };
  const missing = required.filter((r) => !candidate.accessibilityFlags.includes(r));
  if (missing.length === 0) return { score: 1.0, reason: `Accessibility: ${required.join(', ')} ✓` };
  // Hard filter is handled in scoreVenue; this only fires if caller chose
  // to keep the candidate anyway.
  return { score: 0.0, reason: `Missing: ${missing.join(', ')}` };
}

function scorePriceTier(c: VenueCandidate, ctx: VenueContext) {
  const pref = ctx.preferred.priceTier;
  if (pref == null || c.priceTier == null) return { score: 0.6, reason: null };
  const diff = Math.abs(c.priceTier - pref);
  if (diff === 0) return { score: 1.0, reason: `Price tier matches (${'£'.repeat(pref)})` };
  if (diff === 1) return { score: 0.7, reason: null };
  return { score: 0.35, reason: 'Off-budget price tier' };
}

function scorePriorVisits(c: VenueCandidate) {
  const visits = c.priorVisits ?? 0;
  if (visits === 0) return { score: 0.6, reason: null };
  if (visits === 1) return { score: 0.85, reason: "You've been here before" };
  if (visits < 4) return { score: 1.0, reason: `Familiar — ${visits} past visits` };
  return { score: 0.7, reason: `Frequent (${visits} past visits) — consider somewhere new` };
}

function scoreDiversityPenalty(c: VenueCandidate, nowMs: number) {
  if (!c.lastVisitedAt) return { score: 1.0, reason: null };
  const daysSince = (nowMs - new Date(c.lastVisitedAt).getTime()) / 86400_000;
  if (daysSince < 7) return { score: 0.3, reason: `Visited ${Math.round(daysSince)} days ago — try somewhere new` };
  if (daysSince < 21) return { score: 0.6, reason: `Recent (${Math.round(daysSince)} days ago)` };
  return { score: 1.0, reason: null };
}

function scoreExternalRating(c: VenueCandidate) {
  if (c.hostRating != null) {
    return { score: clamp01(c.hostRating / 5), reason: c.hostRating >= 4 ? `Your rating: ${c.hostRating}/5` : null };
  }
  if (c.externalRating == null) return { score: 0.55, reason: null };
  return {
    score: clamp01(c.externalRating / 5),
    reason: c.externalRating >= 4.5 ? `Highly rated (${c.externalRating}/5)` : null,
  };
}

export const _internal = { WEIGHTS, TYPE_FIT_BY_INTENT, haversineKm };
