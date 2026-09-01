import {
  IsInt,
  IsString,
  IsBoolean,
  IsNotEmpty,
  IsIn,
  Min,
  Max,
  MaxLength,
  MinLength,
} from 'class-validator';

import {
  DISPLAY_NAME_PREFERENCES,
  type DisplayNamePreference,
} from '../review.constants';

/**
 * §11 step 2 — what the borrower actually fills in.
 *
 * Note what is not here: the display name itself. The borrower picks one of the
 * three §11 formats and the server renders it from the funded application, so
 * the name published beside a "Verified borrower" badge is the name on the
 * loan.
 */
export class SubmitReviewDto {
  @IsInt()
  @Min(1)
  @Max(5)
  rating: number;

  @IsString()
  @IsNotEmpty()
  @MinLength(10)
  @MaxLength(2000)
  review_text: string;

  @IsIn(DISPLAY_NAME_PREFERENCES)
  display_name_preference: DisplayNamePreference;

  /**
   * §11: "explicit checkbox consenting to public display". A review submitted
   * without it is kept and shown to moderators, but can never be published —
   * the publish path refuses it rather than quietly treating silence as yes.
   */
  @IsBoolean()
  consent_to_publish: boolean;
}
