import { MatchRoundStatus, ServiceIssueReason, ServiceRequestStatus } from '@prisma/client';
import { MAX_AUTO_MATCH_ROUNDS } from '../match-rounds/match-round-transitions';
import {
  evaluateServiceIssueEligibility,
  PromisedSchedule,
  ReasonAvailability,
} from './service-issue-eligibility';

/**
 * Why the customer cannot report right now — a code the screen maps to its
 * own sentence (or to nothing at all, when the feature is off).
 */
export type ServiceIssueUnavailableReason =
  | 'FEATURE_DISABLED'
  | 'NOT_MATCHED'
  | 'SCHEDULE_MISSING'
  | 'NOT_YET_AVAILABLE';

export type CustomerServiceIssueView = {
  canReport: boolean;
  /** The round a report would close; the screen sends it back as `roundId`. */
  roundId: string | null;
  availableReasons: ServiceIssueReason[];
  reasons: ReasonAvailability[];
  nextOpensOn: string | null;
  unavailableReason: ServiceIssueUnavailableReason | null;
  /** A match with no promised days: the support path, never this form. */
  supportOnly: boolean;
  /** A report now would end automatic matching (Round 3): MATCH_REVIEW, not a new round. */
  maxAutoRoundsReached: boolean;
  /** What a report would do: reopen the request, or hand it to the team. */
  consequence: 'REOPEN' | 'ADMIN_REVIEW' | null;
};

/**
 * REL-002 Faz 3 — the service-issue action as the customer screen reads it,
 * from the same eligibility the endpoint enforces. Pure; the clock is the
 * server's.
 */
export function customerServiceIssueView(input: {
  enabled: boolean;
  status: ServiceRequestStatus;
  matchedOfferId: string | null;
  current: {
    id: string;
    roundNumber: number;
    status: MatchRoundStatus;
    matchedOfferId: string | null;
    schedule: PromisedSchedule;
  };
  now: Date;
}): CustomerServiceIssueView {
  const lastAutoRound = input.current.roundNumber >= MAX_AUTO_MATCH_ROUNDS;
  const closed: CustomerServiceIssueView = {
    canReport: false,
    roundId: null,
    availableReasons: [],
    reasons: [],
    nextOpensOn: null,
    unavailableReason: null,
    supportOnly: false,
    maxAutoRoundsReached: lastAutoRound,
    consequence: null,
  };

  if (!input.enabled) {
    return { ...closed, unavailableReason: 'FEATURE_DISABLED' };
  }
  const matched =
    input.status === ServiceRequestStatus.MATCHED &&
    input.current.status === MatchRoundStatus.MATCHED &&
    input.matchedOfferId !== null &&
    input.current.matchedOfferId === input.matchedOfferId;
  if (!matched) {
    return { ...closed, unavailableReason: 'NOT_MATCHED' };
  }

  const eligibility = evaluateServiceIssueEligibility(input.current.schedule, input.now);
  if (eligibility.supportOnly) {
    return { ...closed, unavailableReason: 'SCHEDULE_MISSING', supportOnly: true };
  }

  return {
    canReport: eligibility.availableReasons.length > 0,
    roundId: input.current.id,
    availableReasons: eligibility.availableReasons,
    reasons: eligibility.reasons,
    nextOpensOn: eligibility.nextOpensOn,
    unavailableReason: eligibility.availableReasons.length > 0 ? null : 'NOT_YET_AVAILABLE',
    supportOnly: false,
    maxAutoRoundsReached: lastAutoRound,
    consequence: lastAutoRound ? 'ADMIN_REVIEW' : 'REOPEN',
  };
}
