import { IsBoolean, IsIn, IsNotEmpty, IsOptional } from 'class-validator';

import {
  REVIEW_REJECTION_REASON_KEYS,
  type ReviewRejectionReason,
} from '../review.constants';

/**
 * §11 step 3 — publish or reject, and nothing else.
 *
 * There is deliberately no field for the review text: editing a borrower's
 * words is what the FTC rule on altered reviews is about, so the API offers no
 * way to do it and the portal has no box to type into.
 */
export class ModerateReviewDto {
  @IsBoolean()
  @IsNotEmpty()
  approve: boolean;

  /** Required when rejecting; refused when publishing. */
  @IsOptional()
  @IsIn(REVIEW_REJECTION_REASON_KEYS)
  reason?: ReviewRejectionReason;
}
