// src/queue/drip/drip.types.ts

import type { SequenceKey } from './drip.schedule';

export interface DripJobData {
  /** applications.id — the UUID, used for every FK and lookup. */
  applicationUuid: string;
  sequenceKey: SequenceKey;
  stepNumber: number;
  /** §7.3 template key, e.g. `bank_verification_4`. */
  templateKey: string;
}

export interface DripEmailDetails {
  /** The 6-digit business application_id shown to the borrower. */
  applicationId: string;
  /** applications.id — recorded on email_log. */
  applicationUuid: string;
  firstName: string;
  email: string;
  loanAmount: number;
  /**
   * The one-time verification link for this send, when the step has one.
   *
   * Bank verification is authenticated by this token now, so the CTA cannot be
   * built from applicationId — a six-character reference is not a credential,
   * and the URL it used to produce lands on an explainer telling the borrower
   * to open the very email they just clicked from.
   */
  actionUrl?: string;
}
