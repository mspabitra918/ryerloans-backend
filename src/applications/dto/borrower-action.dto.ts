import {
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

/**
 * The one-time link, as it arrives from the borrower's email.
 *
 * 32 random bytes in base64url is 43 characters; the bounds keep an oversized
 * body from reaching the hash-and-lookup path at all.
 */
class TokenDto {
  @IsString()
  @Length(20, 200)
  declare token: string;
}

export class CompleteBankVerificationDto extends TokenDto {
  /** Returned by Plaid Link on success; absent when verified out of band. */
  @IsOptional()
  @IsString()
  @Length(1, 100)
  declare plaid_item_id?: string;
}

export class SignAgreementDto extends TokenDto {
  /**
   * The typed signature. E-SIGN requires an act the signer intends as their
   * signature, so this is captured verbatim into the audit note rather than
   * being a checkbox.
   */
  @IsString()
  @Length(2, 120)
  declare full_name: string;
}

export class ConfirmDepositDto extends TokenDto {
  /*
   * Whole cents, 1-99. Dollars-as-floats would make an exact-match check
   * fail for a borrower who typed exactly what their statement shows.
   */
  @IsInt()
  @Min(1)
  @Max(99)
  declare amount_1_cents: number;

  @IsInt()
  @Min(1)
  @Max(99)
  declare amount_2_cents: number;
}

/**
 * The two steps a borrower may re-open for themselves from the §6.2 tracker.
 *
 * Agreement signature is deliberately absent. An Application ID plus an email
 * address is a lookup, not a credential, and it is not a bar we are willing to
 * put an E-SIGN signature behind — that link still only comes by email.
 */
export const SELF_SERVICE_PURPOSES = [
  'bank_verification',
  'deposit_confirmation',
] as const;

export type SelfServicePurpose = (typeof SELF_SERVICE_PURPOSES)[number];

/**
 * §6.2 "do this now": the tracker asks for a live link for the step it is
 * already showing as outstanding, using the same two fields the borrower typed
 * to see the tracker at all.
 */
export class RequestActionLinkDto {
  @IsString()
  @Length(6, 6)
  declare application_id: string;

  @IsEmail()
  declare email: string;

  @IsIn(SELF_SERVICE_PURPOSES)
  declare purpose: SelfServicePurpose;
}
