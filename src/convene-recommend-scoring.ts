/**
 * Convene recommendation scoring — DUPLICATED from lyra/src/lib/recommend/convene/
 * for KAN-207 (Phase 3) MCP tools.
 *
 * ────────────────────────────────────────────────────────────────────────
 * DRIFT RISK
 * ────────────────────────────────────────────────────────────────────────
 * This file is a verbatim copy of the scoring logic that lives in the lyra
 * repo at:
 *   - src/lib/recommend/convene/types.ts
 *   - src/lib/recommend/convene/score-attendee.ts
 *
 * Why duplicated: the MCP server (this repo) can't import TypeScript from the
 * lyra repo. Shared package or HTTP delegation would be the longer-term fix.
 * For v1, manual lockstep — any change to weights/factors/keywords MUST be
 * made in both places. That lockstep is now CHECKED, not merely asked for:
 * `scripts/check-convene-scoring-drift.cjs` (KAN-426) compares the scoring
 * constants and the numeric fingerprint of every scoring function in this file
 * against the lyra copy on every PR, and fails the build on any difference.
 *
 * Keep this file's `WEIGHTS` and `TRIBE_KEYWORDS_BY_INTENT` constants in sync
 * with the lyra-side definitions verbatim.
 * ────────────────────────────────────────────────────────────────────────
 */

export type GatheringType =
  | 'coffee' | 'lunch' | 'dinner' | 'drinks' | 'party' | 'kids_party'
  | 'meeting' | 'date' | 'walk' | 'cinema' | 'other';

export interface AttendeeContext {
  intent: GatheringType;
  gatheringStartISO?: string;
  existingInviteeContactIds: string[];
}

export interface RelationshipSignals {
  totalInvites: number;
  totalAccepted: number;
  totalAttended: number;
  totalDeclined: number;
  totalSilent: number;
  totalNoShows: number;
  lastAttendedAt: string | null;
  lastInvitedAt: string | null;
  gatheringTypeDiversity: number;
  gatheringTypesSeen: string[];
}

export interface AttendeeCandidate {
  contactId: string;
  displayName: string;
  city: string | null;
  hasLinkedProfile: boolean;
  tribeNames: string[];
  signals?: RelationshipSignals;
}

export interface AttendeeScore {
  contactId: string;
  score: number;
  reasons: string[];
  breakdown: {
    tribeFit: number;
    recency: number;
    responseHistory: number;
    typeFit: number;
    diversity: number;
  };
  excluded?: boolean;
  excludedReason?: string;
}

export function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

export function weightedAverage(
  breakdown: Record<string, number>,
  weights: Record<string, number>
): number {
  let totalWeight = 0;
  let totalScore = 0;
  for (const key of Object.keys(breakdown)) {
    const w = weights[key] ?? 0;
    totalWeight += w;
    totalScore += clamp01(breakdown[key]) * w;
  }
  return totalWeight > 0 ? clamp01(totalScore / totalWeight) : 0;
}

const WEIGHTS = {
  tribeFit: 0.30,
  recency: 0.20,
  responseHistory: 0.25,
  typeFit: 0.15,
  diversity: 0.10,
};

const TRIBE_KEYWORDS_BY_INTENT: Record<GatheringType, string[]> = {
  coffee: ['friends', 'colleagues', 'uni', 'school', 'book', 'mums', 'parents'],
  lunch: ['friends', 'colleagues', 'team'],
  dinner: ['friends', 'family', 'date'],
  drinks: ['friends', 'colleagues', 'uni'],
  party: ['friends', 'family', 'birthday'],
  kids_party: ['parents', 'school', 'class', 'mums', 'dads'],
  meeting: ['colleagues', 'team', 'mentors'],
  date: ['date'],
  walk: ['friends', 'family', 'dog'],
  cinema: ['friends', 'family', 'date'],
  other: [],
};

function scoreTribeFit(candidate: AttendeeCandidate, intent: GatheringType): { score: number; reason: string | null } {
  if (candidate.tribeNames.length === 0) return { score: 0.3, reason: null };
  const keywords = TRIBE_KEYWORDS_BY_INTENT[intent];
  if (keywords.length === 0) return { score: 0.4, reason: null };
  const hitTribes = candidate.tribeNames.filter((t) => keywords.some((k) => t.toLowerCase().includes(k)));
  if (hitTribes.length === 0) return { score: 0.25, reason: null };
  return {
    score: clamp01(0.6 + 0.2 * Math.min(hitTribes.length, 2)),
    reason: `In tribe(s) ${hitTribes.join(', ')} — fits the "${intent}" intent`,
  };
}

function scoreRecency(signals: RelationshipSignals | undefined, nowMs: number): { score: number; reason: string | null } {
  if (!signals || !signals.lastAttendedAt) return { score: 0.5, reason: 'Never attended together — neutral baseline' };
  const daysSince = (nowMs - new Date(signals.lastAttendedAt).getTime()) / 86400_000;
  if (daysSince < 7) return { score: 0.3, reason: `Seen ${Math.round(daysSince)} days ago — recent, avoid over-asking` };
  if (daysSince < 14) return { score: 0.5, reason: 'Seen within the last fortnight' };
  if (daysSince < 30) return { score: 0.85, reason: `Seen ${Math.round(daysSince)} days ago — sweet spot for follow-up` };
  if (daysSince < 180) return { score: 1.0, reason: `Last gathered ${Math.round(daysSince)} days ago` };
  if (daysSince < 365) return { score: 0.75, reason: `Haven't gathered in ${Math.round(daysSince)} days — overdue` };
  return { score: 0.55, reason: `Last gathered >1 year ago — long gap` };
}

function scoreResponseHistory(signals: RelationshipSignals | undefined): { score: number; reason: string | null } {
  if (!signals || signals.totalInvites === 0) return { score: 0.5, reason: null };
  const accepts = signals.totalAccepted + signals.totalAttended;
  const negatives = signals.totalDeclined + signals.totalSilent + signals.totalNoShows;
  const ratio = accepts / Math.max(1, accepts + negatives);
  if (signals.totalNoShows > 2) return { score: 0.2, reason: `${signals.totalNoShows} no-shows — flaky reputation` };
  if (ratio > 0.8 && signals.totalInvites >= 3) return { score: 1.0, reason: `Reliable — accepted ${Math.round(ratio * 100)}% of past invites` };
  if (ratio > 0.5) return { score: 0.7 + (ratio - 0.5) * 0.6, reason: null };
  return { score: clamp01(0.3 + ratio * 0.4), reason: `Lower attendance rate (${Math.round(ratio * 100)}%)` };
}

function scoreTypeFit(signals: RelationshipSignals | undefined, intent: GatheringType): { score: number; reason: string | null } {
  if (!signals || signals.gatheringTypesSeen.length === 0) return { score: 0.4, reason: null };
  if (signals.gatheringTypesSeen.includes(intent)) return { score: 0.95, reason: `You've done "${intent}" together before` };
  if (signals.gatheringTypesSeen.length >= 2) return { score: 0.7, reason: 'Range of past gathering types' };
  return { score: 0.5, reason: null };
}

function scoreDiversity(signals: RelationshipSignals | undefined): { score: number; reason: string | null } {
  if (!signals || signals.totalInvites === 0) return { score: 1.0, reason: null };
  if (signals.totalInvites > 5) return { score: 0.55, reason: `Invited ${signals.totalInvites} times before — consider mixing it up` };
  return { score: 0.85, reason: null };
}

export function scoreAttendee(
  candidate: AttendeeCandidate,
  context: AttendeeContext,
  nowMs: number = Date.now()
): AttendeeScore {
  if (context.existingInviteeContactIds.includes(candidate.contactId)) {
    return {
      contactId: candidate.contactId,
      score: 0,
      reasons: ['Already on the invite list'],
      breakdown: { tribeFit: 0, recency: 0, responseHistory: 0, typeFit: 0, diversity: 0 },
      excluded: true,
      excludedReason: 'already_invited',
    };
  }

  const tribeFit = scoreTribeFit(candidate, context.intent);
  const recency = scoreRecency(candidate.signals, nowMs);
  const responseHistory = scoreResponseHistory(candidate.signals);
  const typeFit = scoreTypeFit(candidate.signals, context.intent);
  const diversity = scoreDiversity(candidate.signals);

  const breakdown = {
    tribeFit: tribeFit.score,
    recency: recency.score,
    responseHistory: responseHistory.score,
    typeFit: typeFit.score,
    diversity: diversity.score,
  };

  const reasons = [tribeFit.reason, recency.reason, responseHistory.reason, typeFit.reason, diversity.reason]
    .filter((r): r is string => Boolean(r));

  return {
    contactId: candidate.contactId,
    score: weightedAverage(breakdown, WEIGHTS),
    reasons,
    breakdown,
  };
}

export const _internal = { WEIGHTS, TRIBE_KEYWORDS_BY_INTENT };
