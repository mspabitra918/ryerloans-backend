import {
  IsString,
  IsEmail,
  IsBoolean,
  IsInt,
  IsOptional,
  IsDateString,
  Length,
  Matches,
  Min,
  Max,
  IsEnum,
  ValidateIf,
  Equals,
} from 'class-validator';
import {
  AccountAgeBand,
  AccountType,
  CurrentBalanceBand,
  EmploymentStatus,
  LoanPurpose,
  PayFrequency,
} from './application-enums';

// -----------------------------------------------------------------------------
// DTO
// -----------------------------------------------------------------------------

export class CreateApplicationDto {
  // ==========================================
  // Step 1 — Loan Request
  // ==========================================

  @IsInt()
  @Min(2000, { message: 'Minimum loan amount is $2,000' })
  @Max(25000, { message: 'Maximum loan amount is $25,000' })
  declare amount_requested: number;

  @IsEnum(LoanPurpose)
  declare loan_purpose: LoanPurpose;

  @ValidateIf((o) => o.loan_purpose === LoanPurpose.OTHER_PERSONAL_EXPENSES)
  @IsString()
  @Length(10, 200, {
    message:
      'Description must be between 10 and 200 characters when Other Personal Expenses is selected',
  })
  declare loan_purpose_other?: string;

  // ==========================================
  // Step 2 — Personal Details
  // ==========================================

  @IsString()
  @Matches(/^[a-zA-Z\s'-]+$/, {
    message:
      'First name can only contain letters, hyphens, apostrophes, and spaces',
  })
  @Length(1, 80)
  declare first_name: string;

  @IsString()
  @Matches(/^[a-zA-Z\s'-]+$/, {
    message:
      'Last name can only contain letters, hyphens, apostrophes, and spaces',
  })
  @Length(1, 80)
  declare last_name: string;

  @IsEmail()
  declare email: string;

  @IsString()
  @Matches(/^\+?[1-9]\d{1,14}$|^\(\d{3}\)\s\d{3}-\d{4}$|^\d{10}$/, {
    message: 'Phone number must be a valid contact number',
  })
  declare phone: string;

  @IsDateString()
  declare dob: string;

  @IsString()
  @Matches(
    /^(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}$|^(?!000|666|9\d\d)(?!00)\d{2}(?!0000)\d{7}$/,
    {
      message: 'SSN contains invalid area/group/serial range numbers',
    },
  )
  declare ssn: string;

  @IsOptional()
  @IsString()
  declare dl_number?: string;

  @IsOptional()
  @IsString()
  @Length(2, 2)
  declare dl_state?: string;

  @IsString()
  @Length(1, 200)
  declare street_address: string;

  @IsOptional()
  @IsString()
  declare address_line_2?: string;

  @IsString()
  @Length(1, 100)
  declare city: string;

  @IsString()
  @Length(2, 2)
  declare state: string;

  @IsString()
  @Matches(/^\d{5}(-\d{4})?$/, {
    message: 'ZIP code must be 5 digits or 5+4 format',
  })
  declare zip: string;

  @IsOptional()
  @IsInt()
  declare years_at_address?: number;

  @IsOptional()
  @IsString()
  declare housing_status?: string;

  @IsOptional()
  @IsInt()
  declare monthly_housing_cost?: number;

  // ==========================================
  // Step 3 — Employment & Income
  // ==========================================

  @IsEnum(EmploymentStatus)
  declare employment_status: EmploymentStatus;

  @ValidateIf((o) =>
    [
      EmploymentStatus.FULL_TIME,
      EmploymentStatus.PART_TIME,
      EmploymentStatus.SELF_EMPLOYED,
    ].includes(o.employment_status),
  )
  @IsString()
  declare employer_name?: string;

  @IsOptional()
  @IsString()
  declare job_title?: string;

  @IsOptional()
  @IsInt()
  declare employment_length_mo?: number;

  @IsOptional()
  @IsString()
  declare employer_phone?: string;

  @IsEnum(PayFrequency)
  declare pay_frequency: PayFrequency;

  @IsOptional()
  @IsDateString()
  declare next_pay_date?: string;

  @IsInt()
  @Min(0)
  declare net_monthly_income: number;

  @IsOptional()
  @IsString()
  declare income_source?: string;

  @IsBoolean()
  declare owns_vehicle: boolean;

  @ValidateIf((o) => o.owns_vehicle === true)
  @IsInt()
  declare vehicle_year?: number;

  @ValidateIf((o) => o.owns_vehicle === true)
  @IsString()
  declare vehicle_make?: string;

  @ValidateIf((o) => o.owns_vehicle === true)
  @IsString()
  declare vehicle_model?: string;

  @ValidateIf((o) => o.owns_vehicle === true)
  @IsBoolean()
  declare vehicle_paid_off?: boolean;

  // ==========================================
  // Step 4 — Banking
  // ==========================================

  @IsString()
  declare bank_name: string;

  @IsEnum(AccountType)
  declare account_type: AccountType;

  @IsString()
  @Matches(/^\d{9}$/, { message: 'Routing number must be exactly 9 digits' })
  declare routing_number: string;

  @IsString()
  @Length(4, 17, { message: 'Account number must be between 4 and 17 digits' })
  declare account_number: string;

  @IsEnum(AccountAgeBand)
  declare account_age_months: AccountAgeBand;

  @IsEnum(CurrentBalanceBand)
  declare current_balance_band: CurrentBalanceBand;

  @IsOptional()
  @IsBoolean()
  declare direct_deposit?: boolean;

  // ==========================================
  // Step 5 — Review & Consent Audit
  // ==========================================

  @Equals(true, {
    message: 'E-Sign Consent is required to submit your application',
  })
  declare consent_esign: boolean;

  @IsDateString()
  declare consent_esign_at: string;

  @Equals(true, {
    message: 'Privacy Policy agreement is required to submit your application',
  })
  declare consent_privacy: boolean;

  @Equals(true, {
    message: 'Credit Pull Authorization is required to submit your application',
  })
  declare consent_credit_pull: boolean;

  // TCPA marketing consent is optional per FCC guidelines (cannot be a loan condition)
  @IsOptional()
  @IsBoolean()
  declare consent_tcpa?: boolean;

  @IsOptional()
  @IsDateString()
  declare consent_tcpa_at?: string;

  @IsOptional()
  @IsString()
  declare consent_tcpa_text?: string;

  // ==========================================
  // Provenance & Metadata
  // ==========================================

  @IsOptional()
  @IsString()
  declare referrer?: string;

  @IsOptional()
  @IsString()
  declare utm_source?: string;

  @IsOptional()
  @IsString()
  declare utm_medium?: string;

  @IsOptional()
  @IsString()
  declare utm_campaign?: string;

  @IsOptional()
  @IsString()
  declare landing_page?: string;

  @IsOptional()
  @IsDateString()
  declare form_started_at?: string;
}
