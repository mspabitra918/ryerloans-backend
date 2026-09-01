import { BadRequestException } from '@nestjs/common';

import { ApplicationStatus } from './dto/application-enums';

/**
 * The §6 state machine, as data.
 *
 * It lived as a private field on the 2,000-line application service, which made
 * it invisible to everything else that needed it — the dashboard, the drip
 * cancellation rules and the admin UI each re-derived their own idea of the
 * pipeline order. One table, exported.
 */
/**
 * Exits available from every live state, in addition to that state's own
 * forward step. §6: "Any state → withdrawn (borrower request) or expired
 * (45 days inactive)."
 *
 * Decline is deliberately NOT one of them. §6.1 draws it as a single branch
 * off `underwriting`, so that is where it lives — a decision reached at the
 * point the file is actually underwritten, not an exit hatch from the whole
 * pipeline.
 *
 * The cost of reading it that way is real and worth naming: several ECOA
 * reason codes describe a file visible long before underwriting — an unserved
 * state of residence, a bank account that cannot be verified. Those now have
 * to be walked to `underwriting` before they can be declined with a notice,
 * or closed as `withdrawn`, which sends no adverse action notice and starts no
 * Regulation B clock. Exact-SSN duplicates are unaffected: intake blocks them
 * before a row exists (see ApplicationIntakeService.recordBlockedAttempt), so
 * they were never declined through this path.
 */
const UNIVERSAL_EXITS = [
  ApplicationStatus.WITHDRAWN,
  ApplicationStatus.EXPIRED,
  ApplicationStatus.DECLINED, //An application can be declined from any non-terminal status.
] as const;

export const ALLOWED_TRANSITIONS: Readonly<
  Record<ApplicationStatus, readonly ApplicationStatus[]>
> = {
  [ApplicationStatus.RECEIVED]: [
    ApplicationStatus.PENDING_CALL,
    ...UNIVERSAL_EXITS,
  ],
  /*
   * §6.1 draws two edges out of pending_call: the admin "Mark as Called In"
   * step to in_review, and a bypass straight to bank_verification_pending for
   * the borrower who never calls.
   *
   * The bypass is not an edge case. §7.1 starts the bank verification drip on
   * day 0, in parallel with the call-in drip, so the borrower is invited to
   * verify while the file is still pending_call. Without this edge that
   * borrower had nowhere to go: the verification could be requested but the
   * status could never follow it.
   */
  [ApplicationStatus.PENDING_CALL]: [
    ApplicationStatus.IN_REVIEW,
    ApplicationStatus.BANK_VERIFICATION_PENDING,
    ...UNIVERSAL_EXITS,
  ],
  [ApplicationStatus.IN_REVIEW]: [
    ApplicationStatus.BANK_VERIFICATION_PENDING,
    ...UNIVERSAL_EXITS,
  ],
  [ApplicationStatus.BANK_VERIFICATION_PENDING]: [
    ApplicationStatus.BANK_VERIFICATION_COMPLETE,
    ...UNIVERSAL_EXITS,
  ],
  [ApplicationStatus.BANK_VERIFICATION_COMPLETE]: [
    ApplicationStatus.AGREEMENT_SENT,
    ...UNIVERSAL_EXITS,
  ],
  [ApplicationStatus.AGREEMENT_SENT]: [
    ApplicationStatus.AGREEMENT_SIGNED,
    ...UNIVERSAL_EXITS,
  ],
  [ApplicationStatus.AGREEMENT_SIGNED]: [
    ApplicationStatus.VERIFICATION_DEPOSIT_SENT,
    ...UNIVERSAL_EXITS,
  ],
  [ApplicationStatus.VERIFICATION_DEPOSIT_SENT]: [
    ApplicationStatus.VERIFICATION_DEPOSIT_CONFIRMED,
    ...UNIVERSAL_EXITS,
  ],
  [ApplicationStatus.VERIFICATION_DEPOSIT_CONFIRMED]: [
    ApplicationStatus.UNDERWRITING,
    ...UNIVERSAL_EXITS,
  ],
  /*
   * The one state a decision is made from. §6.1 branches both ways from here:
   * `approved` carries on to funding, `declined` is terminal and starts the
   * 90-day reapply clock.
   */
  [ApplicationStatus.UNDERWRITING]: [
    ApplicationStatus.APPROVED,
    ApplicationStatus.DECLINED,
    ...UNIVERSAL_EXITS,
  ],
  /*
   * Approved is finalized through the dedicated Fund action, but the borrower
   * can still walk away and the file can still go stale (§6).
   *
   * Declined is not reachable from here either: the borrower has already been
   * sent an offer at stated terms, so withdrawing it is a rescission, not an
   * adverse action on an application. Re-deciding an approval needs its own
   * path and its own notice.
   */
  [ApplicationStatus.APPROVED]: [ApplicationStatus.FUNDED, ...UNIVERSAL_EXITS],

  // Terminal states.
  [ApplicationStatus.DECLINED]: [],
  [ApplicationStatus.FUNDED]: [],
  [ApplicationStatus.WITHDRAWN]: [],
  [ApplicationStatus.EXPIRED]: [],
};

/** States that have come to rest and can no longer move. */
export const TERMINAL_STATUSES: readonly ApplicationStatus[] = [
  ApplicationStatus.DECLINED,
  ApplicationStatus.FUNDED,
  ApplicationStatus.WITHDRAWN,
  ApplicationStatus.EXPIRED,
];

/** Pipeline order, used for funnels and for rendering progress. */
export const PIPELINE_ORDER: readonly ApplicationStatus[] = [
  ApplicationStatus.RECEIVED,
  ApplicationStatus.PENDING_CALL,
  ApplicationStatus.IN_REVIEW,
  ApplicationStatus.BANK_VERIFICATION_PENDING,
  ApplicationStatus.BANK_VERIFICATION_COMPLETE,
  ApplicationStatus.AGREEMENT_SENT,
  ApplicationStatus.AGREEMENT_SIGNED,
  ApplicationStatus.VERIFICATION_DEPOSIT_SENT,
  ApplicationStatus.VERIFICATION_DEPOSIT_CONFIRMED,
  ApplicationStatus.UNDERWRITING,
  ApplicationStatus.APPROVED,
  ApplicationStatus.FUNDED,
];

export function isTerminal(status: ApplicationStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(
  from: ApplicationStatus,
  to: ApplicationStatus,
): boolean {
  return (ALLOWED_TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Throwing variant, so a caller cannot forget to check the boolean. The message
 * names both states because "invalid transition" alone is useless in a support
 * ticket.
 */
export function assertTransition(
  from: ApplicationStatus,
  to: ApplicationStatus,
): void {
  if (from === to) {
    throw new BadRequestException(`Application is already in ${to} status.`);
  }

  if (!canTransition(from, to)) {
    throw new BadRequestException(
      `Cannot change application status from "${from}" to "${to}". ` +
        `Allowed from "${from}": ${
          ALLOWED_TRANSITIONS[from]?.join(', ') || 'none (terminal state)'
        }.`,
    );
  }
}

/** Title-cased label for a status, e.g. `bank_verification_pending`. */
export function humanizeStatus(status: string): string {
  return status
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
