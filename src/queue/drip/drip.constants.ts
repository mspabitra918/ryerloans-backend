// src/queue/drip/drip.constants.ts
//
// Queue identity and the §7.2 cancellation ruleset.
//
// The timing grid itself lives in drip.schedule.ts. This file deliberately does
// NOT carry a second, offset-based schedule: the brief has exactly one grid, and
// two competing definitions of it is how the sequences drift apart.

import { ApplicationStatus } from '../../applications/dto/application-enums';
import type { SequenceKey } from './drip.schedule';

export const DRIP_QUEUE_NAME = 'application-drip';

/**
 * Deterministic job id. BullMQ dedupes on this, so re-running the scheduler for
 * an application is idempotent rather than duplicating every step.
 *
 * Separator is "-" and not ":" — BullMQ reserves the colon for its own key
 * namespacing and rejects custom ids that contain one.
 */
export function dripJobId(
  applicationId: string,
  sequenceKey: SequenceKey,
  stepNumber: number,
): string {
  return `drip-${applicationId}-${sequenceKey}-${stepNumber}`;
}

/**
 * Linear progress rank for the §6 state machine. Terminal states are excluded
 * and handled separately — they are exits, not positions on the ladder.
 */
const STATUS_RANK: Partial<Record<ApplicationStatus, number>> = {
  [ApplicationStatus.RECEIVED]: 0,
  [ApplicationStatus.PENDING_CALL]: 1,
  [ApplicationStatus.IN_REVIEW]: 2,
  [ApplicationStatus.BANK_VERIFICATION_PENDING]: 3,
  [ApplicationStatus.BANK_VERIFICATION_COMPLETE]: 4,
  [ApplicationStatus.AGREEMENT_SENT]: 5,
  [ApplicationStatus.AGREEMENT_SIGNED]: 6,
  [ApplicationStatus.VERIFICATION_DEPOSIT_SENT]: 7,
  [ApplicationStatus.VERIFICATION_DEPOSIT_CONFIRMED]: 8,
  [ApplicationStatus.UNDERWRITING]: 9,
  [ApplicationStatus.APPROVED]: 10,
  [ApplicationStatus.FUNDED]: 11,
};

const TERMINAL_STATUSES: ApplicationStatus[] = [
  ApplicationStatus.DECLINED,
  ApplicationStatus.WITHDRAWN,
  ApplicationStatus.EXPIRED,
  ApplicationStatus.FUNDED,
];

function rankOf(status: ApplicationStatus): number | null {
  return STATUS_RANK[status] ?? null;
}

/**
 * The state of the world at send time, as far as cancellation is concerned.
 * Every field is evaluated when the job runs, never when it is scheduled —
 * that is the whole point of §7.2.
 */
export interface CancellationContext {
  status: ApplicationStatus;
  calledIn: boolean;
  bankVerified: boolean;
  /** Borrower is on the suppression list (unsubscribe / bounce / complaint). */
  suppressed?: boolean;
  suppressionReason?: string | null;
}

export interface CancellationDecision {
  shouldCancel: boolean;
  /** Written to email_sequences.cancel_trigger so the "why" is provable. */
  cancelTrigger?: string;
}

/**
 * Decide whether a queued step should still go out (§7.2).
 *
 * Cancels for ALL sequences on unsubscribe, hard bounce, spam complaint, and on
 * any terminal application state. Then applies the per-sequence rules.
 */
export function evaluateCancellation(
  sequenceKey: SequenceKey,
  context: CancellationContext,
): CancellationDecision {
  const { status, calledIn, bankVerified, suppressed, suppressionReason } =
    context;

  // --- All sequences -------------------------------------------------------
  if (suppressed) {
    return {
      shouldCancel: true,
      cancelTrigger: suppressionReason
        ? `suppressed:${suppressionReason}`
        : 'suppressed',
    };
  }

  if (TERMINAL_STATUSES.includes(status)) {
    return { shouldCancel: true, cancelTrigger: `status:${status}` };
  }

  const rank = rankOf(status);

  // --- Call-in reminders ---------------------------------------------------
  // Cancel on the admin "Mark as Called In" button, or once the application
  // advances past in_review.
  if (sequenceKey === 'call_in') {
    if (calledIn) {
      return { shouldCancel: true, cancelTrigger: 'called_in' };
    }
    if (rank !== null && rank > STATUS_RANK[ApplicationStatus.IN_REVIEW]!) {
      return { shouldCancel: true, cancelTrigger: `status:${status}` };
    }
    return { shouldCancel: false };
  }

  // --- Bank verification reminders -----------------------------------------
  // Cancel once the account is verified (admin flag or Plaid webhook success),
  // or once the application reaches bank_verification_complete.
  if (bankVerified) {
    return { shouldCancel: true, cancelTrigger: 'bank_verified' };
  }
  if (
    rank !== null &&
    rank >= STATUS_RANK[ApplicationStatus.BANK_VERIFICATION_COMPLETE]!
  ) {
    return { shouldCancel: true, cancelTrigger: `status:${status}` };
  }

  return { shouldCancel: false };
}

/**
 * Which sequences a given status change should cancel. Used by the application
 * service to tear queued jobs down eagerly instead of waiting for each job to
 * wake up and cancel itself.
 */
export function sequencesCancelledBy(status: ApplicationStatus): SequenceKey[] {
  if (TERMINAL_STATUSES.includes(status)) {
    return ['call_in', 'bank_verification'];
  }

  const rank = rankOf(status);
  if (rank === null) return [];

  const cancelled: SequenceKey[] = [];

  if (rank > STATUS_RANK[ApplicationStatus.IN_REVIEW]!) {
    cancelled.push('call_in');
  }
  if (rank >= STATUS_RANK[ApplicationStatus.BANK_VERIFICATION_COMPLETE]!) {
    cancelled.push('bank_verification');
  }

  return cancelled;
}
