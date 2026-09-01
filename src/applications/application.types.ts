import type { AdminContext } from '../audit-log/audit-log.service';

/** The lender's own calendar; "today" means the same thing everywhere. */
export const ADMIN_TIMEZONE = 'America/Los_Angeles';

/** Support number quoted in borrower-facing copy. */
export const SUPPORT_PHONE_DIGITS = '7472005220';
export const SUPPORT_PHONE_DISPLAY = '(747) 200-5220';

/** Provenance captured at submit (§8.3 Provenance panel). */
export interface RequestMetadata {
  ipAddress: string;
  ipCountry?: string | null;
  ipRegion?: string | null;
  userAgent?: string | null;
  referrer?: string | null;
}

/**
 * Per §8.4 every admin action button is audited, and every one of them sends an
 * email that the admin may override.
 *
 * The same shape carries the §6.1 borrower-driven edges. Those arrive with
 * `admin.adminUserId === null` and `admin.actorType === 'borrower'`: the
 * borrower authenticated with a one-time link, not a session, and the audit
 * row has to say so rather than borrowing an employee's name. Use
 * `borrowerActionOptions()` to build one — it sets the email overrides to
 * something a borrower cannot influence.
 */
export interface AdminActionOptions {
  admin: AdminContext;

  /**
   * §8.4 "do not send email" override. Defaults to sending. When false, a
   * reason is mandatory and is written to both audit_log and email_log.
   */
  sendEmail?: boolean;
  emailOverrideReason?: string;

  /**
   * §8.4 "edit before sending". When present it replaces the generated subject
   * and body for this one send; the substitution is recorded in audit_log.
   */
  emailSubjectOverride?: string;
  emailBodyOverride?: string;

  /** Free-text note recorded against the audit entry. */
  note?: string;
}

/**
 * Options for an action the borrower performed themselves.
 *
 * The §8.4 email overrides ("edit before sending", "do not send") are
 * deliberately absent: those are admin discretion exercised through a
 * confirmation modal, and a borrower-facing endpoint must not be able to
 * suppress or rewrite the notice its own action generates.
 */
export function borrowerActionOptions(
  ipAddress: string,
  note?: string,
): AdminActionOptions {
  return {
    admin: { adminUserId: null, actorType: 'borrower', ipAddress },
    sendEmail: true,
    note,
  };
}

/**
 * Options for an action the server took on its own schedule.
 *
 * The §11 day-7 review request is the first of these: no admin pressed
 * anything, so the audit row says `system` rather than borrowing the name of
 * whoever happened to fund the loan. The email overrides are absent for the
 * same reason they are absent from the borrower variant — there is nobody to
 * exercise that discretion.
 */
export function systemActionOptions(note?: string): AdminActionOptions {
  return {
    admin: { adminUserId: null, actorType: 'system', ipAddress: '127.0.0.1' },
    sendEmail: true,
    note,
  };
}

/**
 * The admin id for an action that genuinely requires one — anything writing a
 * NOT NULL `*_by` column. Borrower-driven actions never reach these paths, and
 * this turns a would-be constraint violation into a clear error.
 */
export function requireAdminId(options: AdminActionOptions): string {
  const id = options.admin.adminUserId;

  if (!id) {
    throw new Error(
      'This action must be performed by a signed-in admin; it was invoked ' +
        `with actor "${options.admin.actorType ?? 'admin'}".`,
    );
  }

  return id;
}

/** Cohort window for the §8.5 dashboard. */
export type DashboardRange = 'today' | 'week' | 'month' | 'all';

export const DASHBOARD_RANGES: readonly DashboardRange[] = [
  'today',
  'week',
  'month',
  'all',
];

/** §8.4 Request Documents checklist. */
export const DOCUMENT_TYPES = [
  'id',
  'paystub',
  'bank_statement',
  'proof_of_address',
  'void_check',
] as const;

export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  id: 'Government-issued ID',
  paystub: 'Most recent paystub',
  bank_statement: 'Bank statement',
  proof_of_address: 'Proof of address',
  void_check: 'Void check',
};

/**
 * ECOA adverse action reason codes (Regulation B, Appendix C). Declines must
 * pick from this list — a free-text reason is not a compliant notice.
 */
export const ECOA_REASON_CODES: Record<string, string> = {
  insufficient_income: 'Income insufficient for amount of credit requested',
  excessive_obligations: 'Excessive obligations in relation to income',
  unable_to_verify_income: 'Unable to verify income',
  length_of_employment: 'Length of employment',
  temporary_or_irregular_employment: 'Temporary or irregular employment',
  unable_to_verify_employment: 'Unable to verify employment',
  insufficient_credit_file: 'Insufficient number of credit references provided',
  no_credit_file: 'No credit file',
  limited_credit_experience: 'Limited credit experience',
  delinquent_credit_obligations:
    'Delinquent past or present credit obligations',
  garnishment_or_lien:
    'Garnishment, attachment, foreclosure, repossession or suit',
  bankruptcy: 'Bankruptcy',
  unable_to_verify_residence: 'Unable to verify residence',
  length_of_residence: 'Length of residence',
  temporary_residence: 'Temporary residence',
  unable_to_verify_bank_account: 'Unable to verify bank account',
  insufficient_deposit_history: 'Insufficient deposit relationship history',
  value_or_type_of_collateral: 'Value or type of collateral not sufficient',
  credit_application_incomplete: 'Credit application incomplete',
  state_not_served: 'We do not lend in the applicant’s state of residence',
  duplicate_application: 'Duplicate of an application already on file',
};
