import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  Min,
} from 'class-validator';

import { ApplicationStatus } from './application-enums';
import { DOCUMENT_TYPES, ECOA_REASON_CODES } from '../application.types';

/**
 * Shared body for every §8.4 admin action button.
 *
 * "Every button opens a confirmation modal showing the exact email that will be
 * sent, with an 'edit before sending' option and a 'do not send email' override
 * that requires a reason (logged)."
 */
export class AdminActionDto {
  /**
   * Set false to invoke the "do not send email" override. Omitted means send.
   */
  @IsOptional()
  @IsBoolean()
  declare send_email?: boolean;

  /**
   * Mandatory when send_email is false. Enforced in the service (rather than
   * with a conditional validator) so the same rule applies to every caller.
   */
  @IsOptional()
  @IsString()
  @Length(3, 500)
  declare email_override_reason?: string;

  /** §8.4 "edit before sending". */
  @IsOptional()
  @IsString()
  @Length(3, 255)
  declare email_subject?: string;

  @IsOptional()
  @IsString()
  @Length(3, 20000)
  declare email_body?: string;

  /** Free-text note stored against the audit_log entry. */
  @IsOptional()
  @IsString()
  @Length(1, 1000)
  declare note?: string;
}

/**
 * §8.4: "Destructive actions (Decline, Fund) require typing the Application ID
 * to confirm." Checked server-side as well as in the modal — a confirmation
 * that only exists in the browser confirms nothing about what reached the API.
 */
export class ConfirmedActionDto extends AdminActionDto {
  @IsString()
  @Length(6, 6)
  declare confirm_application_id: string;
}

export class ApproveApplicationDto extends AdminActionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(120)
  declare term_months: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(999.99)
  declare apr: number;

  /** Optional counter-offer for less than the borrower requested. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  declare amount?: number;
}

export class DeclineApplicationDto extends ConfirmedActionDto {
  /** ECOA adverse action reason codes — at least one is required. */
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(4)
  @IsIn(Object.keys(ECOA_REASON_CODES), { each: true })
  declare reason_codes: string[];
}

export class FundApplicationDto extends ConfirmedActionDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  declare funded_amount: number;
}

export class UpdateStatusDto extends AdminActionDto {
  @IsIn(Object.values(ApplicationStatus))
  declare status: ApplicationStatus;
}

export class RequestDocumentsDto extends AdminActionDto {
  @IsArray()
  @ArrayNotEmpty()
  @IsIn(DOCUMENT_TYPES as unknown as string[], { each: true })
  declare doc_types: string[];
}

/**
 * §8.4 "Send Verification Deposit".
 *
 * The amounts are what the borrower is later asked to reproduce off their own
 * statement, so the admin records what was actually sent. Whole cents: §0.3's
 * legitimate reading is Ryer sending pennies to prove account ownership, and a
 * three-figure "micro" deposit is a typo that costs real money.
 */
export class SendVerificationDepositDto extends AdminActionDto {
  @IsInt()
  @Min(1)
  @Max(99)
  declare amount_1_cents: number;

  @IsInt()
  @Min(1)
  @Max(99)
  declare amount_2_cents: number;
}

/** §8.4 Edit Application. */
export class EditApplicationDto extends AdminActionDto {
  /** Field name -> new value. Only the whitelisted fields are accepted. */
  @IsObject()
  declare changes: Record<string, unknown>;

  /**
   * Required when the change touches SSN or bank account details, which
   * §8.4 restricts to super_admin with a mandatory reason.
   */
  @IsOptional()
  @IsString()
  declare password?: string;
}

export class ResendEmailDto extends AdminActionDto {
  @IsUUID()
  declare email_log_id: string;
}
